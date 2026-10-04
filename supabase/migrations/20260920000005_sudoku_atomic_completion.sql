-- NOVA 2.0: atomic Sudoku completion RPC.
-- Awards 20 NOVA Coins + 40 XP for a completed puzzle.
-- Validates server-side to prevent client-side reward manipulation.

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

  -- ── Idempotency guard ────────────────────────────────────
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
      coalesce((select games_played from public.game_progress where user_id = v_user_id and game_id = 'sudoku'), 0),
      coalesce((select games_won   from public.game_progress where user_id = v_user_id and game_id = 'sudoku'), 0);
    return;
  end if;

  insert into public.game_completions (user_id, session_id, idempotency_key)
  values (v_user_id, p_session_id, p_idempotency_key);

  -- ── Lock session row ──────────────────────────────────────
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

  -- ── Prevent duplicate result ──────────────────────────────
  if exists (select 1 from public.game_results where session_id = p_session_id) then
    raise exception 'Reward already claimed for this session';
  end if;

  -- ── Record game result (always completed on success) ──────
  insert into public.game_results (session_id, user_id, game_id, outcome)
  values (p_session_id, v_user_id, 'sudoku', 'win');

  -- ── Mark session completed ────────────────────────────────
  update public.game_sessions
    set status = 'COMPLETED', completed_at = now()
    where id = p_session_id;

  -- ── Award coins + XP ──────────────────────────────────────
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
    set earned_coins = earned_coins + v_awarded_coins,
        updated_at   = now()
    where user_id = v_user_id
    returning * into v_wallet;

  insert into public.wallet_transactions (user_id, type, amount, currency, source, reference_id)
  values (v_user_id, 'GAME_REWARD', v_awarded_coins, 'NOVA_COIN', 'SUDOKU_WIN', p_session_id::text);

  -- ── Update game_progress ──────────────────────────────────
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

  -- ── Update profile XP + level ─────────────────────────────
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

  -- ── Return updated state ──────────────────────────────────
  return query select
    v_wallet.earned_coins,
    v_wallet.ai_credits,
    v_awarded_coins,
    v_awarded_xp,
    v_profile.xp,
    v_profile.level,
    coalesce((select games_played from public.game_progress where user_id = v_user_id and game_id = 'sudoku'), 0),
    coalesce((select games_won   from public.game_progress where user_id = v_user_id and game_id = 'sudoku'), 0);
end;
$$;

revoke all on function public.complete_sudoku_game(uuid, integer, uuid) from public;
grant execute on function public.complete_sudoku_game(uuid, integer, uuid) to authenticated;
