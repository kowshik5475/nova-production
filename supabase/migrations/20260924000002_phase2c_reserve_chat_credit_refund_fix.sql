-- Phase 2C: fix reserve_chat_credit double-refund of released chat credits.
--
-- Bug:
--   release_chat_credit already refunds +1 and sets state='released' (row kept).
--   reserve_chat_credit then refunded count(released) again before deleting those
--   rows — so every provider-error release followed by the next reserve minted
--   a free AI credit.
--
-- Correct behavior:
--   1) Convert stale reserved (>5m) → released and refund ONLY those rows
--      (they were never refunded by release_chat_credit).
--   2) Delete all released rows WITHOUT refunding rows already released via
--      release_chat_credit.
--   3) Lock wallet, check balance, decrement for the new reservation.
--
-- Supersedes migration 20260920000012 for reserve_chat_credit only.

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
  v_stale_refund int := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  -- Check for existing request with this key
  select * into v_request
    from public.chat_requests
    where user_id = v_user_id and idempotency_key = p_idempotency_key;

  if found then
    select public.wallet.earned_coins, public.wallet.ai_credits
      into v_wallet.earned_coins, v_wallet.ai_credits
      from public.wallet where user_id = v_user_id;

    -- completed/reserved → return as-is; released → fall through to re-reserve
    if v_request.state <> 'released' then
      return query select v_request.id, v_wallet.ai_credits, v_wallet.earned_coins, v_request.state;
      return;
    end if;
  end if;

  -- Convert stale reserved (>5 minutes) → released; count only these for refund.
  with converted as (
    update public.chat_requests
      set state = 'released'
      where user_id = v_user_id
        and chat_requests.state = 'reserved'
        and created_at < now() - interval '5 minutes'
      returning id
  )
  select count(*)::int into v_stale_refund from converted;

  if v_stale_refund > 0 then
    update public.wallet
      set ai_credits = public.wallet.ai_credits + v_stale_refund,
          updated_at = now()
      where user_id = v_user_id;
  end if;

  -- Delete released rows. Rows already refunded by release_chat_credit are
  -- removed here without a second refund; stale rows were refunded above.
  delete from public.chat_requests
    where user_id = v_user_id and public.chat_requests.state = 'released';

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
    set ai_credits = public.wallet.ai_credits - 1, updated_at = now()
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
