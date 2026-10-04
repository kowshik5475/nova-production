-- NOVA 2.0: fix ai_credits ambiguity in exchange_nova_coins.
-- The function's RETURNS TABLE declares an output variable named ai_credits,
-- which collides with the wallet.ai_credits column in UPDATE/SELECT statements.
-- Fix: qualify wallet column references as public.wallet.ai_credits.

create or replace function public.exchange_nova_coins(
  p_coin_amount integer,
  p_idempotency_key uuid
) returns table(nova_coins integer, ai_credits integer)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_wallet public.wallet%rowtype;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_coin_amount <> 10 then raise exception 'Exchange amount must be exactly 10 NOVA Coins'; end if;

  -- Idempotency: check for existing request before insert
  if exists (
    select 1 from public.exchange_requests
    where user_id = v_user_id and idempotency_key = p_idempotency_key
  ) then
    return query select earned_coins, public.wallet.ai_credits from public.wallet where user_id = v_user_id;
    return;
  end if;

  insert into public.exchange_requests (user_id, idempotency_key)
  values (v_user_id, p_idempotency_key);

  select * into v_wallet from public.wallet where user_id = v_user_id for update;
  if not found then raise exception 'Wallet not found'; end if;
  if v_wallet.earned_coins < p_coin_amount then raise exception 'Insufficient NOVA Coins'; end if;

  update public.wallet set earned_coins = earned_coins - p_coin_amount,
      ai_credits = public.wallet.ai_credits + 1, updated_at = now() where user_id = v_user_id
      returning * into v_wallet;
  insert into public.wallet_transactions (user_id, type, amount, currency, source, reference_id)
  values (v_user_id, 'COIN_EXCHANGE', -p_coin_amount, 'NOVA_COIN', 'COIN_EXCHANGE', p_idempotency_key::text),
         (v_user_id, 'COIN_EXCHANGE', 1, 'AI_CREDIT', 'COIN_EXCHANGE', p_idempotency_key::text);
  return query select v_wallet.earned_coins, v_wallet.ai_credits;
end;
$$;

revoke all on function public.exchange_nova_coins(integer, uuid) from public;
grant execute on function public.exchange_nova_coins(integer, uuid) to authenticated;
