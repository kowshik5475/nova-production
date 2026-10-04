-- NOVA 2.0: persistent AI chat with secure credit reservation.
-- chat_messages stores user and assistant messages.
-- reserve_chat_credit / finalize_chat_credit / release_chat_credit
-- implement a reserve → call AI → finalize-or-release pattern.

-- ── chat_messages ──────────────────────────────────────────────
create table if not exists public.chat_messages (
  id         uuid default gen_random_uuid() primary key,
  user_id    uuid references auth.users on delete cascade not null,
  role       text not null check (role in ('user', 'assistant')),
  content    text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
alter table public.chat_messages enable row level security;

create policy "Users can read own messages"
  on public.chat_messages for select
  using (auth.uid() = user_id);

create policy "Users can insert own messages"
  on public.chat_messages for insert
  with check (auth.uid() = user_id);

create index if not exists idx_chat_messages_user_created
  on public.chat_messages (user_id, created_at desc);

-- ── chat_requests ─────────────────────────────────────────────
-- Tracks AI credit reservations. Each row represents one reserve → finalize/release cycle.
create table if not exists public.chat_requests (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  idempotency_key uuid not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique (user_id, idempotency_key)
);
alter table public.chat_requests enable row level security;

create policy "Users can read own chat requests"
  on public.chat_requests for select
  using (auth.uid() = user_id);

create policy "Users can insert own chat requests"
  on public.chat_requests for insert
  with check (auth.uid() = user_id);

-- ── reserve_chat_credit ────────────────────────────────────────
-- Atomically locks the wallet, checks balance, decrements ai_credits,
-- and inserts a chat_requests row (idempotent).
-- Returns the reserved request id so the edge function can finalize or release.

create or replace function public.reserve_chat_credit(
  p_idempotency_key uuid
) returns table (
  request_id uuid,
  ai_credits integer,
  earned_coins integer
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

  -- Idempotent: if this key was already reserved, return current state
  select * into v_request
    from public.chat_requests
    where user_id = v_user_id and idempotency_key = p_idempotency_key;

  if found then
    select earned_coins, ai_credits into v_wallet.earned_coins, v_wallet.ai_credits
      from public.wallet where user_id = v_user_id;
    return query select v_request.id, v_wallet.ai_credits, v_wallet.earned_coins;
    return;
  end if;

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
  insert into public.chat_requests (user_id, idempotency_key)
    values (v_user_id, p_idempotency_key)
    returning * into v_request;

  return query select v_request.id, v_wallet.ai_credits, v_wallet.earned_coins;
end;
$$;

revoke all on function public.reserve_chat_credit(uuid) from public;
grant execute on function public.reserve_chat_credit(uuid) to authenticated;

-- ── finalize_chat_credit ───────────────────────────────────────
-- Persists the user and assistant messages, then cleans up the reservation.
-- Only call after a successful AI response.

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
    raise exception 'Chat request not found or already finalized';
  end if;

  -- Persist messages
  insert into public.chat_messages (user_id, role, content)
    values
      (v_user_id, 'user',      p_user_content),
      (v_user_id, 'assistant', p_assistant_content);

  -- Record the wallet transaction
  insert into public.wallet_transactions (user_id, type, amount, currency, source, reference_id)
    values (v_user_id, 'AI_USAGE', -1, 'AI_CREDIT', 'AI_CHAT', p_request.id::text);

  -- Clean up reservation
  delete from public.chat_requests where id = p_request_id;
end;
$$;

revoke all on function public.finalize_chat_credit(uuid, text, text) from public;
grant execute on function public.finalize_chat_credit(uuid, text, text) to authenticated;

-- ── release_chat_credit ────────────────────────────────────────
-- Reverses the credit reservation on failure. Refunds the credit and
-- removes the reservation row.

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

  -- Refund the credit
  update public.wallet
    set ai_credits = ai_credits + 1, updated_at = now()
    where user_id = v_user_id;

  -- Remove reservation
  delete from public.chat_requests where id = p_request_id;
end;
$$;

revoke all on function public.release_chat_credit(uuid) from public;
grant execute on function public.release_chat_credit(uuid) to authenticated;

-- ── get_chat_history ───────────────────────────────────────────
-- Returns the last N messages for the authenticated user.

create or replace function public.get_chat_history(p_limit integer default 50)
returns table (
  id         uuid,
  role       text,
  content    text,
  created_at timestamp with time zone
)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  return query
    select cm.id, cm.role, cm.content, cm.created_at
    from public.chat_messages cm
    where cm.user_id = v_user_id
    order by cm.created_at asc
    limit p_limit;
end;
$$;

revoke all on function public.get_chat_history(integer) from public;
grant execute on function public.get_chat_history(integer) to authenticated;
