-- Phase 10: Streak V1
-- Server-authoritative daily streak from successful activity only.
-- ============================================================
-- Audit findings addressed here:
--   profiles.streak existed (integer default 0) but was never updated.
--   No last_activity_date existed → required for consecutive-day logic.
--   No user timezone stored → V1 uses database UTC calendar date:
--     (timezone('utc'::text, now()))::date
--   Same convention used by every streak path.
--   No streak achievement catalog rows exist → achievements unchanged.
--
-- Active day (V1): at least one successful authoritative activity:
--   - complete_tictactoe_game (validated completion, any outcome)
--   - complete_sudoku_game
--   - finalize_chat_credit (state → completed only)
--   - exchange_nova_coins (after successful wallet write)
--
-- Helper touch_user_streak():
--   - identity from auth.uid() only (no user_id parameter)
--   - FOR UPDATE row lock prevents concurrent double-increment
--   - same-day re-entry is a no-op (idempotent)
--   - NOT granted to authenticated (callable only from definer RPCs)
-- ============================================================

-- ── 1. Schema: last_activity_date ────────────────────────────
alter table public.profiles
  add column if not exists last_activity_date date;

-- ── 2. Helper: touch_user_streak ─────────────────────────────
create or replace function public.touch_user_streak()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_today date := (timezone('utc'::text, now()))::date;
  v_last date;
  v_streak integer;
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;

  select last_activity_date, streak
    into v_last, v_streak
    from public.profiles
   where id = v_uid
     for update;

  if not found then
    raise exception 'Profile not found';
  end if;

  -- Same calendar day (or clock-skew future date): no double increment
  if v_last is not null and v_last >= v_today then
    return;
  end if;

  if v_last is null or v_last < v_today - 1 then
    -- First activity ever, or one+ days missed → restart at 1
    v_streak := 1;
  else
    -- v_last = previous UTC calendar day → consecutive
    v_streak := greatest(coalesce(v_streak, 0), 0) + 1;
  end if;

  update public.profiles
     set streak = v_streak,
         last_activity_date = v_today,
         updated_at = timezone('utc'::text, now())
   where id = v_uid;
end;
$$;

-- Internal only: no client EXECUTE. Owner (definer of parent RPCs) retains access.
revoke all on function public.touch_user_streak() from public;
revoke all on function public.touch_user_streak() from anon;
revoke all on function public.touch_user_streak() from authenticated;

-- ── 3. complete_tictactoe_game + streak ──────────────────────
-- Supersedes 20260924000005 for complete_tictactoe_game only.
create or replace function public.complete_tictactoe_game(
  p_session_id uuid,
  p_outcome text,
  p_idempotency_key uuid
) returns table(
  earned_coins integer,
  ai_credits integer,
  awarded_coins integer,
  awarded_xp integer,
  profile_xp integer,
  profile_level integer,
  games_played integer,
  games_won integer
)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_wallet public.wallet%rowtype;
  v_session public.game_sessions%rowtype;
  v_progress public.game_progress%rowtype;
  v_profile public.profiles%rowtype;
  v_awarded_coins integer := 0;
  v_awarded_xp   integer := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_outcome not in ('win', 'loss', 'draw') then
    raise exception 'outcome must be win, loss, or draw';
  end if;

  if exists (
    select 1 from public.game_completions
    where user_id = v_user_id and idempotency_key = p_idempotency_key
  ) then
    select w.earned_coins, w.ai_credits, p.xp, p.level
      into v_wallet.earned_coins, v_wallet.ai_credits, v_profile.xp, v_profile.level
      from public.wallet w
      join public.profiles p on p.id = v_user_id
      where w.user_id = v_user_id;
    return query select
      v_wallet.earned_coins, v_wallet.ai_credits,
      0, 0,
      v_profile.xp, v_profile.level,
      coalesce((select public.game_progress.games_played from public.game_progress where user_id = v_user_id and game_id = 'tictactoe'), 0),
      coalesce((select public.game_progress.games_won   from public.game_progress where user_id = v_user_id and game_id = 'tictactoe'), 0);
    return;
  end if;

  insert into public.game_completions (user_id, session_id, idempotency_key)
  values (v_user_id, p_session_id, p_idempotency_key);

  select * into v_session
    from public.game_sessions
    where id = p_session_id
      and user_id = v_user_id
      and game_id = 'tictactoe'
    for update;

  if not found then
    raise exception 'Invalid or unauthorized session';
  end if;

  if v_session.status <> 'STARTED' then
    raise exception 'Session already completed or abandoned';
  end if;

  if exists (select 1 from public.game_results where session_id = p_session_id) then
    raise exception 'Reward already claimed for this session';
  end if;

  insert into public.game_results (session_id, user_id, game_id, outcome)
  values (p_session_id, v_user_id, 'tictactoe', p_outcome);

  update public.game_sessions
    set status = 'COMPLETED', completed_at = now()
    where id = p_session_id;

  if p_outcome = 'win' then
    v_awarded_coins := 10;
    v_awarded_xp    := 25;

    select * into v_wallet
      from public.wallet
      where user_id = v_user_id
      for update;

    if not found then
      raise exception 'Wallet not found';
    end if;

    update public.wallet
      set earned_coins = public.wallet.earned_coins + v_awarded_coins,
          updated_at   = now()
      where user_id = v_user_id
      returning * into v_wallet;

    insert into public.wallet_transactions (user_id, type, amount, currency, source, reference_id)
    values (v_user_id, 'GAME_REWARD', v_awarded_coins, 'NOVA_COIN', 'TICTACTOE_WIN', p_session_id::text);
  end if;

  select * into v_progress
    from public.game_progress
    where user_id = v_user_id and game_id = 'tictactoe';

  insert into public.game_progress (user_id, game_id, games_played, games_won, total_xp, updated_at)
  values (
    v_user_id,
    'tictactoe',
    1,
    case when p_outcome = 'win' then 1 else 0 end,
    v_awarded_xp,
    now()
  )
  on conflict (user_id, game_id) do update set
    games_played = public.game_progress.games_played + 1,
    games_won    = public.game_progress.games_won + case when p_outcome = 'win' then 1 else 0 end,
    total_xp     = public.game_progress.total_xp + v_awarded_xp,
    updated_at   = now();

  select * into v_profile
    from public.profiles
    where id = v_user_id;

  update public.profiles
    set xp    = v_profile.xp + v_awarded_xp,
        level = floor((v_profile.xp + v_awarded_xp) / 100) + 1,
        updated_at = now()
    where id = v_user_id;

  v_profile.xp    := v_profile.xp + v_awarded_xp;
  v_profile.level := floor(v_profile.xp / 100) + 1;

  -- Phase 10: streak — any validated completion counts as an active day
  perform public.touch_user_streak();

  -- Phase 9: achievements (win only — not on loss/draw)
  if p_outcome = 'win' then
    insert into public.user_achievements (user_id, achievement_id)
    values (v_user_id, 'first_game')
    on conflict do nothing;

    insert into public.user_achievements (user_id, achievement_id)
    values (v_user_id, 'first_ttt_win')
    on conflict do nothing;
  end if;

  return query select
    v_wallet.earned_coins,
    v_wallet.ai_credits,
    v_awarded_coins,
    v_awarded_xp,
    v_profile.xp,
    v_profile.level,
    coalesce((select public.game_progress.games_played from public.game_progress where user_id = v_user_id and game_id = 'tictactoe'), 0),
    coalesce((select public.game_progress.games_won   from public.game_progress where user_id = v_user_id and game_id = 'tictactoe'), 0);
end;
$$;

revoke all on function public.complete_tictactoe_game(uuid, text, uuid) from public;
grant execute on function public.complete_tictactoe_game(uuid, text, uuid) to authenticated;

-- ── 4. complete_sudoku_game + streak ─────────────────────────
-- Supersedes 20260924000005 for complete_sudoku_game only.
create or replace function public.complete_sudoku_game(
  p_session_id uuid,
  p_puzzle_id integer,
  p_idempotency_key uuid
) returns table(
  earned_coins integer,
  ai_credits integer,
  awarded_coins integer,
  awarded_xp integer,
  profile_xp integer,
  profile_level integer,
  games_played integer,
  games_won integer
)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_wallet public.wallet%rowtype;
  v_session public.game_sessions%rowtype;
  v_progress public.game_progress%rowtype;
  v_profile public.profiles%rowtype;
  v_awarded_coins integer := 0;
  v_awarded_xp   integer := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_puzzle_id not in (0, 1, 2) then
    raise exception 'Invalid puzzle ID';
  end if;

  if exists (
    select 1 from public.game_completions
    where user_id = v_user_id and idempotency_key = p_idempotency_key
  ) then
    select w.earned_coins, w.ai_credits, p.xp, p.level
      into v_wallet.earned_coins, v_wallet.ai_credits, v_profile.xp, v_profile.level
      from public.wallet w
      join public.profiles p on p.id = v_user_id
      where w.user_id = v_user_id;
    return query select
      v_wallet.earned_coins, v_wallet.ai_credits,
      0, 0,
      v_profile.xp, v_profile.level,
      coalesce((select public.game_progress.games_played from public.game_progress where user_id = v_user_id and game_id = 'sudoku'), 0),
      coalesce((select public.game_progress.games_won   from public.game_progress where user_id = v_user_id and game_id = 'sudoku'), 0);
    return;
  end if;

  insert into public.game_completions (user_id, session_id, idempotency_key)
  values (v_user_id, p_session_id, p_idempotency_key);

  select * into v_session
    from public.game_sessions
    where id = p_session_id
      and user_id = v_user_id
      and game_id = 'sudoku'
    for update;

  if not found then
    raise exception 'Invalid or unauthorized session';
  end if;

  if v_session.status <> 'STARTED' then
    raise exception 'Session already completed or abandoned';
  end if;

  if exists (select 1 from public.game_results where session_id = p_session_id) then
    raise exception 'Reward already claimed for this session';
  end if;

  insert into public.game_results (session_id, user_id, game_id, outcome)
  values (p_session_id, v_user_id, 'sudoku', 'win');

  update public.game_sessions
    set status = 'COMPLETED', completed_at = now()
    where id = p_session_id;

  v_awarded_coins := 20;
  v_awarded_xp    := 40;

  select * into v_wallet
    from public.wallet
    where user_id = v_user_id
    for update;

  if not found then
    raise exception 'Wallet not found';
  end if;

  update public.wallet
    set earned_coins = public.wallet.earned_coins + v_awarded_coins,
        updated_at   = now()
    where user_id = v_user_id
    returning * into v_wallet;

  insert into public.wallet_transactions (user_id, type, amount, currency, source, reference_id)
  values (v_user_id, 'GAME_REWARD', v_awarded_coins, 'NOVA_COIN', 'SUDOKU_WIN', p_session_id::text);

  select * into v_progress
    from public.game_progress
    where user_id = v_user_id and game_id = 'sudoku';

  insert into public.game_progress (user_id, game_id, games_played, games_won, total_xp, updated_at)
  values (v_user_id, 'sudoku', 1, 1, v_awarded_xp, now())
  on conflict (user_id, game_id) do update set
    games_played = public.game_progress.games_played + 1,
    games_won    = public.game_progress.games_won + 1,
    total_xp     = public.game_progress.total_xp + v_awarded_xp,
    updated_at   = now();

  select * into v_profile
    from public.profiles
    where id = v_user_id;

  update public.profiles
    set xp    = v_profile.xp + v_awarded_xp,
        level = floor((v_profile.xp + v_awarded_xp) / 100) + 1,
        updated_at = now()
    where id = v_user_id;

  v_profile.xp    := v_profile.xp + v_awarded_xp;
  v_profile.level := floor(v_profile.xp / 100) + 1;

  -- Phase 10: streak
  perform public.touch_user_streak();

  -- Phase 9: achievements
  insert into public.user_achievements (user_id, achievement_id)
  values (v_user_id, 'first_game')
  on conflict do nothing;

  insert into public.user_achievements (user_id, achievement_id)
  values (v_user_id, 'first_sudoku')
  on conflict do nothing;

  return query select
    v_wallet.earned_coins,
    v_wallet.ai_credits,
    v_awarded_coins,
    v_awarded_xp,
    v_profile.xp,
    v_profile.level,
    coalesce((select public.game_progress.games_played from public.game_progress where user_id = v_user_id and game_id = 'sudoku'), 0),
    coalesce((select public.game_progress.games_won   from public.game_progress where user_id = v_user_id and game_id = 'sudoku'), 0);
end;
$$;

revoke all on function public.complete_sudoku_game(uuid, integer, uuid) from public;
grant execute on function public.complete_sudoku_game(uuid, integer, uuid) to authenticated;

-- ── 5. finalize_chat_credit + streak ─────────────────────────
-- Supersedes 20260924000005 for finalize_chat_credit only.
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
    return;
  end if;

  insert into public.chat_messages (user_id, role, content)
    values
      (v_user_id, 'user',      p_user_content),
      (v_user_id, 'assistant', p_assistant_content);

  insert into public.wallet_transactions (user_id, type, amount, currency, source, reference_id)
    values (v_user_id, 'AI_USAGE', -1, 'AI_CREDIT', 'AI_CHAT', v_request.id::text);

  update public.chat_requests set state = 'completed' where id = p_request_id;

  -- Phase 10: streak — only after successful finalize
  perform public.touch_user_streak();

  -- Phase 9: achievement — only after successful finalize
  insert into public.user_achievements (user_id, achievement_id)
  values (v_user_id, 'first_ai_chat')
  on conflict do nothing;
end;
$$;

revoke all on function public.finalize_chat_credit(uuid, text, text) from public;
grant execute on function public.finalize_chat_credit(uuid, text, text) to authenticated;

-- ── 6. exchange_nova_coins + streak ──────────────────────────
-- Supersedes 20260924000005 for exchange_nova_coins only.
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

  -- Phase 10: streak — only after successful exchange
  perform public.touch_user_streak();

  -- Phase 9: achievement — only after successful exchange
  insert into public.user_achievements (user_id, achievement_id)
  values (v_user_id, 'first_coin_exchange')
  on conflict do nothing;

  return query select v_wallet.earned_coins, v_wallet.ai_credits;
end;
$$;

revoke all on function public.exchange_nova_coins(integer, uuid) from public;
grant execute on function public.exchange_nova_coins(integer, uuid) to authenticated;
