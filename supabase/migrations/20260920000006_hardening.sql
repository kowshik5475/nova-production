-- NOVA 2.0: deployment hardening.
-- 1. Drop remaining admin using(true) policies that expose user data.
-- 2. Rewrite chat RPCs with state-aware idempotency (reserved/completed/released).
-- 3. Add stale reservation cleanup.

-- ════════════════════════════════════════════════════════════════
-- 1. DROP INSECURE ADMIN POLICIES
-- ════════════════════════════════════════════════════════════════

-- These were created in core_tables.sql but never dropped by prior migrations.
-- They allow any authenticated user to read/modify all rows in these tables.

drop policy if exists "Admins can read all achievements"  on public.user_achievements;
drop policy if exists "Admins can manage leaderboard"      on public.leaderboard;
drop policy if exists "Admins can read all audit log"      on public.audit_log;

-- ════════════════════════════════════════════════════════════════
-- 2. CHAT REQUEST STATE COLUMN
-- ════════════════════════════════════════════════════════════════

alter table public.chat_requests
  add column if not exists state text not null default 'reserved'
  check (state in ('reserved', 'completed', 'released'));

-- ════════════════════════════════════════════════════════════════
-- 3. STATE-AWARE RESERVE_CHAT_CREDIT
-- ════════════════════════════════════════════════════════════════
-- On retry with the same idempotency_key:
--   - completed → return stored reply (via get_chat_request_state)
--   - released  → re-reserve a new credit
--   - reserved  → return existing reservation (may be stale)
-- Before reserving, clean up any stale reserved requests (>5 min old).

-- DROP + CREATE required: PostgreSQL cannot change OUT/return parameters
-- with CREATE OR REPLACE. Migration 2 created this with 3 columns;
-- migration 6 adds the 4th (state text).
drop function if exists public.reserve_chat_credit(uuid);

create or replace function public.reserve_chat_credit(
  p_idempotency_key uuid
) returns table (
  request_id uuid,
  ai_credits integer,
  earned_coins integer,
  state text
)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_wallet  public.wallet%rowtype;
  v_request public.chat_requests%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  -- Check for existing request with this key
  select * into v_request
    from public.chat_requests
    where user_id = v_user_id and idempotency_key = p_idempotency_key;

  if found then
    -- Return current wallet state alongside request state
    select earned_coins, ai_credits into v_wallet.earned_coins, v_wallet.ai_credits
      from public.wallet where user_id = v_user_id;

    -- If completed, the edge function should return the stored reply
    -- If reserved, this is an in-progress or stale request
    -- If released, we can re-reserve below
    if v_request.state <> 'released' then
      return query select v_request.id, v_wallet.ai_credits, v_wallet.earned_coins, v_request.state;
      return;
    end if;
    -- state = 'released': fall through to re-reserve
  end if;

  -- Clean up stale reserved requests (>5 minutes old)
  update public.chat_requests
    set state = 'released'
    where user_id = v_user_id
      and state = 'reserved'
      and created_at < now() - interval '5 minutes';

  -- Refund any stale released reservations
  update public.wallet
    set ai_credits = ai_credits + (
      select count(*)::int from public.chat_requests
      where user_id = v_user_id and state = 'released'
    ), updated_at = now()
    where user_id = v_user_id
      and exists (select 1 from public.chat_requests where user_id = v_user_id and state = 'released');

  delete from public.chat_requests
    where user_id = v_user_id and state = 'released';

  -- Lock wallet row
  select * into v_wallet
    from public.wallet
    where user_id = v_user_id
    for update;

  if not found then
    raise exception 'Wallet not found';
  end if;

  if v_wallet.ai_credits < 1 then
    raise exception 'Insufficient AI Credits';
  end if;

  -- Decrement credit
  update public.wallet
    set ai_credits = ai_credits - 1, updated_at = now()
    where user_id = v_user_id
    returning * into v_wallet;

  -- Record reservation
  insert into public.chat_requests (user_id, idempotency_key, state)
    values (v_user_id, p_idempotency_key, 'reserved')
    returning * into v_request;

  return query select v_request.id, v_wallet.ai_credits, v_wallet.earned_coins, v_request.state;
end;
$$;

revoke all on function public.reserve_chat_credit(uuid) from public;
grant execute on function public.reserve_chat_credit(uuid) to authenticated;

-- ════════════════════════════════════════════════════════════════
-- 4. GET_CHAT_REQUEST_STATE
-- ════════════════════════════════════════════════════════════════
-- Returns the state and stored reply for a completed request.
-- Used by the edge function on retry.

create or replace function public.get_chat_request_state(
  p_idempotency_key uuid
) returns table (
  request_id uuid,
  state text,
  assistant_reply text
)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_request public.chat_requests%rowtype;
  v_msg     public.chat_messages%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select * into v_request
    from public.chat_requests
    where user_id = v_user_id and idempotency_key = p_idempotency_key;

  if not found then
    return query select null::uuid, null::text, null::text;
    return;
  end if;

  -- If completed, find the assistant message that was persisted
  if v_request.state = 'completed' then
    select content into v_msg.content
      from public.chat_messages
      where user_id = v_user_id
        and role = 'assistant'
        and created_at >= v_request.created_at
      order by created_at desc
      limit 1;
  end if;

  return query select v_request.id, v_request.state, v_msg.content;
end;
$$;

revoke all on function public.get_chat_request_state(uuid) from public;
grant execute on function public.get_chat_request_state(uuid) to authenticated;

-- ════════════════════════════════════════════════════════════════
-- 5. FINALIZE_CHAT_CREDIT (updated: set state instead of delete)
-- ════════════════════════════════════════════════════════════════

create or replace function public.finalize_chat_credit(
  p_request_id   uuid,
  p_user_content text,
  p_assistant_content text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_request public.chat_requests%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select * into v_request
    from public.chat_requests
    where id = p_request_id and user_id = v_user_id
    for update;

  if not found then
    raise exception 'Chat request not found';
  end if;

  if v_request.state = 'completed' then
    return; -- already finalized (idempotent)
  end if;

  -- Persist messages
  insert into public.chat_messages (user_id, role, content)
    values
      (v_user_id, 'user',      p_user_content),
      (v_user_id, 'assistant', p_assistant_content);

  -- Record the wallet transaction
  insert into public.wallet_transactions (user_id, type, amount, currency, source, reference_id)
    values (v_user_id, 'AI_USAGE', -1, 'AI_CREDIT', 'AI_CHAT', p_request.id::text);

  -- Mark completed (keep row for idempotent retry)
  update public.chat_requests set state = 'completed' where id = p_request_id;
end;
$$;

revoke all on function public.finalize_chat_credit(uuid, text, text) from public;
grant execute on function public.finalize_chat_credit(uuid, text, text) to authenticated;

-- ════════════════════════════════════════════════════════════════
-- 6. RELEASE_CHAT_CREDIT (updated: set state instead of delete)
-- ════════════════════════════════════════════════════════════════

create or replace function public.release_chat_credit(
  p_request_id uuid
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_request public.chat_requests%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select * into v_request
    from public.chat_requests
    where id = p_request_id and user_id = v_user_id
    for update;

  if not found then
    return; -- already released or never existed
  end if;

  if v_request.state = 'released' then
    return; -- already released (idempotent)
  end if;

  if v_request.state = 'completed' then
    return; -- already finalized, do not refund
  end if;

  -- Refund the credit
  update public.wallet
    set ai_credits = ai_credits + 1, updated_at = now()
    where user_id = v_user_id;

  -- Mark released
  update public.chat_requests set state = 'released' where id = p_request_id;
end;
$$;

revoke all on function public.release_chat_credit(uuid) from public;
grant execute on function public.release_chat_credit(uuid) to authenticated;

-- ════════════════════════════════════════════════════════════════
-- 7. GET_CHAT_HISTORY (unchanged, kept for reference)
-- ════════════════════════════════════════════════════════════════

-- get_chat_history is unchanged from the prior migration.
-- It remains a SECURITY DEFINER function with explicit search_path.

-- ════════════════════════════════════════════════════════════════
-- 8. CLEANUP: REMOVE spend_nova_chat_credit
-- ════════════════════════════════════════════════════════════════
-- spend_nova_chat_credit was defined in 20260920_nova_economy.sql
-- but is never used. The authoritative credit-charging path is:
-- reserve_chat_credit → finalize_chat_credit / release_chat_credit.

drop function if exists public.spend_nova_chat_credit(uuid);
