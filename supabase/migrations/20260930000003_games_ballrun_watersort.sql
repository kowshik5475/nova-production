-- Upgrade Phase J/K — Ball Run and Water Sort completion RPCs.
--
-- Both follow the exact architecture of complete_tictactoe_game /
-- complete_sudoku_game: SECURITY DEFINER, identity from auth.uid() only,
-- session ownership + STARTED guard, one row per session, idempotency ledger,
-- rewards / progression / achievements / streak written in one transaction.
--
-- Ball Run  — the server derives the score from started_at → now(). The client
--             supplies no score, no duration and no outcome. A run only counts
--             while the session is younger than the 120s survival window, so a
--             session cannot be parked open and cashed in later.
--
-- Water Sort — the Edge Function replays the client's move list against the
--             puzzle stored in session_data and only reports whether the replay
--             produced a solved board plus the legal move count. This RPC
--             re-checks the move count range and derives rewards from it.

-- ── 1. Ball Run ────────────────────────────────────────────────
create or replace function public.complete_ball_run_game(
  p_session_id uuid,
  p_idempotency_key uuid
) returns table(
  earned_coins integer,
  ai_credits integer,
  awarded_coins integer,
  awarded_xp integer,
  profile_xp integer,
  profile_level integer,
  games_played integer,
  games_won integer,
  score integer
)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_wallet public.wallet%rowtype;
  v_session public.game_sessions%rowtype;
  v_profile public.profiles%rowtype;
  v_awarded_coins integer := 0;
  v_awarded_xp   integer := 0;
  v_elapsed_ms integer;
  v_score integer;
  v_outcome text;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
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
      coalesce((select gp.games_played from public.game_progress gp where gp.user_id = v_user_id and gp.game_id = 'ball-run'), 0),
      coalesce((select gp.games_won   from public.game_progress gp where gp.user_id = v_user_id and gp.game_id = 'ball-run'), 0),
      coalesce((select gr.score from public.game_results gr where gr.session_id = p_session_id), 0);
    return;
  end if;

  insert into public.game_completions (user_id, session_id, idempotency_key)
  values (v_user_id, p_session_id, p_idempotency_key);

  select * into v_session
    from public.game_sessions
    where id = p_session_id
      and user_id = v_user_id
      and game_id = 'ball-run'
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

  v_elapsed_ms := (extract(epoch from (now() - v_session.started_at)) * 1000)::integer;

  if v_elapsed_ms is null or v_elapsed_ms < 5000 then
    raise exception 'Run too short to count';
  end if;

  if v_elapsed_ms > 120000 then
    raise exception 'Session expired — start a new run';
  end if;

  -- Server-derived score: seconds survived, hard-capped at 100.
  v_score := least(100, greatest(1, v_elapsed_ms / 1000));
  v_outcome := case when v_elapsed_ms >= 60000 then 'win' else 'loss' end;

  if v_outcome = 'win' then
    v_awarded_coins := 15;
    v_awarded_xp    := 30;

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
    values (v_user_id, 'GAME_REWARD', v_awarded_coins, 'NOVA_COIN', 'BALL_RUN_WIN', p_session_id::text);
  else
    v_awarded_xp := 5;

    select * into v_wallet
      from public.wallet
      where user_id = v_user_id
      for update;

    if not found then
      raise exception 'Wallet not found';
    end if;
  end if;

  insert into public.game_results (session_id, user_id, game_id, score, duration, outcome)
  values (p_session_id, v_user_id, 'ball-run', v_score, v_elapsed_ms / 1000, v_outcome);

  update public.game_sessions
    set status = 'COMPLETED', completed_at = now()
    where id = p_session_id;

  insert into public.game_progress (user_id, game_id, games_played, games_won, best_score, total_xp, updated_at)
  values (v_user_id, 'ball-run', 1,
          case when v_outcome = 'win' then 1 else 0 end,
          v_score, v_awarded_xp, now())
  on conflict (user_id, game_id) do update set
    games_played = public.game_progress.games_played + 1,
    games_won    = public.game_progress.games_won + case when v_outcome = 'win' then 1 else 0 end,
    best_score   = greatest(coalesce(public.game_progress.best_score, 0), v_score),
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

  perform public.touch_user_streak();

  insert into public.user_achievements (user_id, achievement_id)
  values (v_user_id, 'first_game')
  on conflict do nothing;

  insert into public.user_achievements (user_id, achievement_id)
  values (v_user_id, 'first_ball_run')
  on conflict do nothing;

  return query select
    v_wallet.earned_coins,
    v_wallet.ai_credits,
    v_awarded_coins,
    v_awarded_xp,
    v_profile.xp,
    v_profile.level,
    coalesce((select gp.games_played from public.game_progress gp where gp.user_id = v_user_id and gp.game_id = 'ball-run'), 0),
    coalesce((select gp.games_won   from public.game_progress gp where gp.user_id = v_user_id and gp.game_id = 'ball-run'), 0),
    v_score;
end;
$$;

revoke all on function public.complete_ball_run_game(uuid, uuid) from public;
grant execute on function public.complete_ball_run_game(uuid, uuid) to authenticated;

-- ── 2. Water Sort ──────────────────────────────────────────────
create or replace function public.complete_water_sort_game(
  p_session_id uuid,
  p_move_count integer,
  p_idempotency_key uuid
) returns table(
  earned_coins integer,
  ai_credits integer,
  awarded_coins integer,
  awarded_xp integer,
  profile_xp integer,
  profile_level integer,
  games_played integer,
  games_won integer,
  score integer
)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_wallet public.wallet%rowtype;
  v_session public.game_sessions%rowtype;
  v_profile public.profiles%rowtype;
  v_awarded_coins integer := 0;
  v_awarded_xp   integer := 0;
  v_score integer;
  v_par integer;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_move_count is null or p_move_count < 1 or p_move_count > 400 then
    raise exception 'Invalid move count';
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
      coalesce((select gp.games_played from public.game_progress gp where gp.user_id = v_user_id and gp.game_id = 'water-sort'), 0),
      coalesce((select gp.games_won   from public.game_progress gp where gp.user_id = v_user_id and gp.game_id = 'water-sort'), 0),
      coalesce((select gr.score from public.game_results gr where gr.session_id = p_session_id), 0);
    return;
  end if;

  insert into public.game_completions (user_id, session_id, idempotency_key)
  values (v_user_id, p_session_id, p_idempotency_key);

  select * into v_session
    from public.game_sessions
    where id = p_session_id
      and user_id = v_user_id
      and game_id = 'water-sort'
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

  -- Efficiency band derived from the move count the server already verified.
  v_par := coalesce((v_session.session_data ->> 'par')::integer, 30);
  v_score := greatest(20, least(100, 100 - greatest(0, p_move_count - v_par) * 3));
  v_awarded_coins := 15;
  v_awarded_xp    := 35;

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
  values (v_user_id, 'GAME_REWARD', v_awarded_coins, 'NOVA_COIN', 'WATER_SORT_WIN', p_session_id::text);

  insert into public.game_results (session_id, user_id, game_id, score, moves, outcome)
  values (p_session_id, v_user_id, 'water-sort', v_score, p_move_count, 'win');

  update public.game_sessions
    set status = 'COMPLETED', completed_at = now()
    where id = p_session_id;

  insert into public.game_progress (user_id, game_id, games_played, games_won, best_score, total_xp, updated_at)
  values (v_user_id, 'water-sort', 1, 1, v_score, v_awarded_xp, now())
  on conflict (user_id, game_id) do update set
    games_played = public.game_progress.games_played + 1,
    games_won    = public.game_progress.games_won + 1,
    best_score   = greatest(coalesce(public.game_progress.best_score, 0), v_score),
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

  perform public.touch_user_streak();

  insert into public.user_achievements (user_id, achievement_id)
  values (v_user_id, 'first_game')
  on conflict do nothing;

  insert into public.user_achievements (user_id, achievement_id)
  values (v_user_id, 'first_water_sort')
  on conflict do nothing;

  return query select
    v_wallet.earned_coins,
    v_wallet.ai_credits,
    v_awarded_coins,
    v_awarded_xp,
    v_profile.xp,
    v_profile.level,
    coalesce((select gp.games_played from public.game_progress gp where gp.user_id = v_user_id and gp.game_id = 'water-sort'), 0),
    coalesce((select gp.games_won   from public.game_progress gp where gp.user_id = v_user_id and gp.game_id = 'water-sort'), 0),
    v_score;
end;
$$;

revoke all on function public.complete_water_sort_game(uuid, integer, uuid) from public;
grant execute on function public.complete_water_sort_game(uuid, integer, uuid) to authenticated;

-- ── 3. Achievement catalog rows ────────────────────────────────
-- target_type must satisfy the existing CHECK constraint in core tables.
-- Idempotent seed: ON CONFLICT DO NOTHING against the catalog primary key.
insert into public.achievements (id, name, description, category, target_type, target_value, icon)
values
  ('first_ball_run',  'First Run',      'Complete your first Ball Run',        'games', 'first_game', 1, '◆'),
  ('first_water_sort','Water Sorted',   'Solve your first Water Sort puzzle',  'games', 'first_game', 1, '❖')
on conflict (id) do nothing;
