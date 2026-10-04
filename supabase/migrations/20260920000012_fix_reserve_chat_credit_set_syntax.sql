-- NOVA 2.0: deploy corrected reserve_chat_credit with valid SET syntax.
-- Migration 11 was applied remotely with table-qualified SET LHS
-- (SET chat_requests.state = 'released') which violates PostgreSQL syntax.
-- This migration replaces the function with unqualified SET LHS
-- (SET state = 'released') and qualified column refs in RHS/WHERE.
-- Supersedes migrations 20260920000006 and 20260920000011 for this function.

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
    select public.wallet.earned_coins, public.wallet.ai_credits
      into v_wallet.earned_coins, v_wallet.ai_credits
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
  -- SET LHS must be unqualified; qualify table columns in RHS and WHERE.
  update public.chat_requests
    set state = 'released'
    where user_id = v_user_id
      and chat_requests.state = 'reserved'
      and created_at < now() - interval '5 minutes';

  -- Refund any stale released reservations
  update public.wallet
    set ai_credits = public.wallet.ai_credits + (
      select count(*)::int from public.chat_requests
      where user_id = v_user_id and public.chat_requests.state = 'released'
    ), updated_at = now()
    where user_id = v_user_id
      and exists (select 1 from public.chat_requests where user_id = v_user_id and public.chat_requests.state = 'released');

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
