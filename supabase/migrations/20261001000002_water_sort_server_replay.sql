-- Water Sort hardening: the win must be proven by a replay that happens in
-- SQL, not only in the Edge Function. Until now complete_water_sort_game()
-- trusted p_move_count from the caller, so an authenticated user could call
-- the RPC directly and claim 15 coins + 35 XP without solving anything.
--
-- The full move list is now a required argument (default null only so the
-- signature stays call-compatible for named-argument callers), replayed
-- against the puzzle the server stored in session_data at session start.
-- Bounds checks and the idempotent replay path keep their order, so existing
-- callers that only re-check a completed session are unaffected.

create or replace function public.water_sort_replay(
  p_tubes jsonb,
  p_moves jsonb
) returns integer
language plpgsql immutable set search_path = public as $$
declare
  v_state   jsonb := p_tubes;
  v_count   integer;
  v_i       integer;
  v_move    jsonb;
  v_from    integer;
  v_to      integer;
  v_src     jsonb;
  v_dst     jsonb;
  v_src_len integer;
  v_dst_len integer;
  v_top     integer;
  v_run     integer;
  v_movable integer;
  v_k       integer;
  v_tail    jsonb;
  v_tube    jsonb;
  v_tube_len integer;
  v_first   integer;
begin
  if p_tubes is null or jsonb_typeof(p_tubes) <> 'array' then
    raise exception 'Session has no puzzle';
  end if;
  if p_moves is null or jsonb_typeof(p_moves) <> 'array' then
    raise exception 'Move list required';
  end if;

  v_count := jsonb_array_length(p_moves);
  if v_count < 1 then
    raise exception 'Moves cannot be empty';
  end if;
  if v_count > 400 then
    raise exception 'Invalid move count';
  end if;

  -- Legal-move replay: same rules as the TypeScript validator
  -- (supabase/functions/_shared/watersort_validate.ts).
  for v_i in 0 .. v_count - 1 loop
    v_move := p_moves -> v_i;
    if v_move is null or jsonb_typeof(v_move) <> 'object'
       or v_move->>'from' is null or v_move->>'to' is null
       or v_move->>'from' !~ '^-?[0-9]+$'
       or v_move->>'to' !~ '^-?[0-9]+$' then
      raise exception 'move % is malformed', v_i;
    end if;

    v_from := (v_move->>'from')::integer;
    v_to   := (v_move->>'to')::integer;

    if v_from = v_to
       or v_from < 0 or v_to < 0
       or v_from >= jsonb_array_length(v_state)
       or v_to >= jsonb_array_length(v_state) then
      raise exception 'move % is illegal', v_i;
    end if;

    v_src := v_state -> v_from;
    v_dst := v_state -> v_to;
    if jsonb_typeof(v_src) <> 'array' or jsonb_typeof(v_dst) <> 'array' then
      raise exception 'move % is illegal', v_i;
    end if;

    v_src_len := jsonb_array_length(v_src);
    v_dst_len := jsonb_array_length(v_dst);
    if v_src_len = 0 or v_dst_len >= 4 then
      raise exception 'move % is illegal', v_i;
    end if;

    v_top := (v_src ->> (v_src_len - 1))::integer;
    if v_dst_len > 0 and (v_dst ->> (v_dst_len - 1))::integer <> v_top then
      raise exception 'move % is illegal', v_i;
    end if;

    v_run := 0;
    while v_run < v_src_len and (v_src ->> (v_src_len - 1 - v_run))::integer = v_top loop
      v_run := v_run + 1;
    end loop;

    v_movable := least(v_run, 4 - v_dst_len);
    if v_movable <= 0 then
      raise exception 'move % is illegal', v_i;
    end if;

    v_tail := coalesce((
      select jsonb_agg(elem order by ord)
      from jsonb_array_elements(v_src) with ordinality as piece(elem, ord)
      where ord > v_src_len - v_movable
    ), '[]'::jsonb);

    v_src := coalesce((
      select jsonb_agg(elem order by ord)
      from jsonb_array_elements(v_src) with ordinality as piece(elem, ord)
      where ord <= v_src_len - v_movable
    ), '[]'::jsonb);

    v_dst := v_dst || v_tail;

    v_state := coalesce((
      select jsonb_agg(
        case when ord - 1 = v_from then v_src
             when ord - 1 = v_to   then v_dst
             else tube
        end order by ord)
      from jsonb_array_elements(v_state) with ordinality as piece(tube, ord)
    ), '[]'::jsonb);
  end loop;

  -- Solved: every tube is empty, or full and single-coloured.
  for v_tube in
    select elem from jsonb_array_elements(v_state) as piece(elem)
  loop
    v_tube_len := jsonb_array_length(v_tube);
    if v_tube_len = 0 then
      continue;
    end if;
    if v_tube_len <> 4 then
      raise exception 'Puzzle is not solved yet';
    end if;
    v_first := (v_tube ->> 0)::integer;
    for v_k in 0 .. 3 loop
      if (v_tube ->> v_k)::integer <> v_first then
        raise exception 'Puzzle is not solved yet';
      end if;
    end loop;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.water_sort_replay(jsonb, jsonb) from public;
revoke all on function public.water_sort_replay(jsonb, jsonb) from anon;
revoke all on function public.water_sort_replay(jsonb, jsonb) from authenticated;

-- ── complete_water_sort_game now requires the replayed move list ──
drop function if exists public.complete_water_sort_game(uuid, integer, uuid);

create or replace function public.complete_water_sort_game(
  p_session_id uuid,
  p_move_count integer,
  p_idempotency_key uuid,
  p_moves jsonb default null
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

  -- The win is proven in SQL: replay the claimed moves against the stored
  -- puzzle before any reward row is written.
  if public.water_sort_replay(v_session.session_data -> 'tubes', p_moves) <> p_move_count then
    raise exception 'Move count does not match replay';
  end if;

  -- Efficiency band derived from the move count the server just verified.
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

revoke all on function public.complete_water_sort_game(uuid, integer, uuid, jsonb) from public;
grant execute on function public.complete_water_sort_game(uuid, integer, uuid, jsonb) to authenticated;
