-- NOVA 2.0: auditable, authenticated coin-to-credit economy.
alter table public.wallet_transactions
  add column if not exists currency text not null default 'NOVA_COIN'
  check (currency in ('NOVA_COIN', 'AI_CREDIT'));

update public.wallet_transactions
  set currency = case when type = 'AI_USAGE' then 'AI_CREDIT' else 'NOVA_COIN' end;

alter table public.wallet_transactions drop constraint if exists wallet_transactions_type_check;
alter table public.wallet_transactions add constraint wallet_transactions_type_check
  check (type in ('AI_USAGE', 'GAME_REWARD', 'DAILY_LOGIN', 'OTHER_VALIDATED_REWARD', 'COIN_EXCHANGE'));

create table if not exists public.exchange_requests (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  idempotency_key uuid not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique (user_id, idempotency_key)
);
alter table public.exchange_requests enable row level security;

-- A transaction locks the wallet row, so the user can never spend the same coins twice.
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
    return query select earned_coins, ai_credits from public.wallet where user_id = v_user_id;
    return;
  end if;

  insert into public.exchange_requests (user_id, idempotency_key)
  values (v_user_id, p_idempotency_key);

  select * into v_wallet from public.wallet where user_id = v_user_id for update;
  if not found then raise exception 'Wallet not found'; end if;
  if v_wallet.earned_coins < p_coin_amount then raise exception 'Insufficient NOVA Coins'; end if;

  update public.wallet set earned_coins = earned_coins - p_coin_amount,
      ai_credits = ai_credits + 1, updated_at = now() where user_id = v_user_id
      returning * into v_wallet;
  insert into public.wallet_transactions (user_id, type, amount, currency, source, reference_id)
  values (v_user_id, 'COIN_EXCHANGE', -p_coin_amount, 'NOVA_COIN', 'COIN_EXCHANGE', p_idempotency_key::text),
         (v_user_id, 'COIN_EXCHANGE', 1, 'AI_CREDIT', 'COIN_EXCHANGE', p_idempotency_key::text);
  return query select v_wallet.earned_coins, v_wallet.ai_credits;
end;
$$;

revoke all on function public.exchange_nova_coins(integer, uuid) from public;
grant execute on function public.exchange_nova_coins(integer, uuid) to authenticated;

create or replace function public.spend_nova_chat_credit(p_idempotency_key uuid)
returns table(ai_credits integer)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_wallet public.wallet%rowtype;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  insert into public.chat_requests (user_id, idempotency_key) values (v_user_id, p_idempotency_key)
  on conflict (user_id, idempotency_key) do nothing;
  if not found then
    return query select w.ai_credits from public.wallet w where w.user_id = v_user_id;
    return;
  end if;
  select * into v_wallet from public.wallet where user_id = v_user_id for update;
  if not found or v_wallet.ai_credits < 1 then raise exception 'Insufficient AI Credits'; end if;
  update public.wallet set ai_credits = ai_credits - 1, updated_at = now() where user_id = v_user_id returning * into v_wallet;
  insert into public.wallet_transactions (user_id, type, amount, currency, source, reference_id)
  values (v_user_id, 'AI_USAGE', -1, 'AI_CREDIT', 'AI_CHAT', p_idempotency_key::text);
  return query select v_wallet.ai_credits;
end;
$$;
revoke all on function public.spend_nova_chat_credit(uuid) from public;
grant execute on function public.spend_nova_chat_credit(uuid) to authenticated;

drop policy if exists "Admins can read all profiles" on public.profiles;
drop policy if exists "Admins can read all wallets" on public.wallet;
drop policy if exists "Admins can read all transactions" on public.wallet_transactions;
drop policy if exists "Admins can read all sessions" on public.game_sessions;
drop policy if exists "Admins can read all results" on public.game_results;
drop policy if exists "Admins can read all progress" on public.game_progress;
