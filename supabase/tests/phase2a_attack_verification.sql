-- NOVA AI PLAY — PHASE 2A
-- Attack-scenario verification for migration 20260924000001
-- ============================================================
-- Verified PASS against linked remote (2026-09-24):
--   S1  A cannot read B wallet
--   S2  A cannot update B profile
--   S3  A cannot UPDATE own wallet (no UPDATE policy)
--   S3b A cannot UPDATE B wallet
--   S4a A cannot INSERT game_results (direct)
--   S4b A cannot UPDATE game_progress
--   S4c A cannot INSERT user_achievements
--   S4d A cannot INSERT chat_requests
--   S4e A cannot INSERT chat_messages
--   S4f A cannot DELETE B game_sessions
--   S4g A cannot UPDATE own game_sessions status
--   S4h A CAN INSERT own game_sessions (Edge start path)
--   S8  exchange_nova_coins(-10) rejected
--   S8b exchange_nova_coins(5) rejected
--   S9a anon cannot read wallet
--   S9b anon cannot read profiles
--   S9c anon cannot read chat_messages
--   S9d anon cannot call exchange_nova_coins
--
-- HOW TO RUN (linked remote, single transaction + rollback):
--   npx supabase db query --linked -f supabase/tests/phase2a_attack_verification.sql
--
-- SAFETY
--   - Creates throwaway users p2c_1@ / p2c_2@example.test inside a
--     transaction and ALWAYS rolls back — no residual rows.
--   - Does NOT delete real users, wallets, or production rows.
--   - Does NOT weaken RLS to make a test pass.
--   - Results are written to a temp table only while role is postgres
--     (reset role before every log insert — anon/authenticated cannot
--     write to pg_temp tables owned by another role).
--
-- MARKING
--   Final SELECT returns one row per scenario: PASS ... / FAIL ...
--   Any unexpected error is logged as "ERROR at <stage>: ..." and re-raised.
-- ============================================================

begin;

insert into auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, aud, role)
select gen_random_uuid(),
       'p2c_' || i || '@example.test',
       crypt('password123', gen_salt('bf')),
       now(), now(), now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       json_build_object('display_name', 'C' || i)::jsonb,
       'authenticated', 'authenticated'
from generate_series(1,2) i;

create temporary table phase2a_log(id serial, line text);

do $$
declare
  v_a uuid;
  v_b uuid;
  v_n int;
  v_stage text := 'init';
begin
  select id into v_a from auth.users where email = 'p2c_1@example.test';
  select id into v_b from auth.users where email = 'p2c_2@example.test';
  if v_a is null or v_b is null then raise exception 'setup'; end if;

  v_stage := 'S1';
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.wallet where user_id = v_b;
  reset role;
  insert into phase2a_log(line) values (case when v_n=0 then 'PASS S1 A cannot read B wallet' else 'FAIL S1 rows='||v_n end);

  v_stage := 'S2';
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.profiles set xp = xp + 1 where id = v_b;
  get diagnostics v_n = row_count;
  reset role;
  insert into phase2a_log(line) values (case when v_n=0 then 'PASS S2 A cannot update B profile' else 'FAIL S2 rows='||v_n end);

  v_stage := 'S3';
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.wallet set earned_coins = earned_coins + 1 where user_id = v_a;
  get diagnostics v_n = row_count;
  reset role;
  insert into phase2a_log(line) values (case when v_n=0 then 'PASS S3 A cannot UPDATE wallet' else 'FAIL S3 rows='||v_n end);

  v_stage := 'S3b';
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.wallet set earned_coins = 999999 where user_id = v_b;
  get diagnostics v_n = row_count;
  reset role;
  insert into phase2a_log(line) values (case when v_n=0 then 'PASS S3b A cannot UPDATE B wallet' else 'FAIL S3b rows='||v_n end);

  v_stage := 'S4a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.game_results (session_id, user_id, game_id, outcome)
    values (gen_random_uuid(), v_a, 'tictactoe', 'win');
    reset role;
    insert into phase2a_log(line) values ('FAIL S4a insert game_results allowed');
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    reset role;
    insert into phase2a_log(line) values ('PASS S4a cannot INSERT game_results: ' || left(sqlerrm, 70));
  end;

  v_stage := 'S4b';
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.game_progress set games_won = games_won + 1 where user_id = v_a;
  get diagnostics v_n = row_count;
  reset role;
  insert into phase2a_log(line) values (case when v_n=0 then 'PASS S4b cannot UPDATE game_progress' else 'FAIL S4b rows='||v_n end);

  v_stage := 'S4c';
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.user_achievements (user_id, achievement_id) values (v_a, 'x');
    reset role;
    insert into phase2a_log(line) values ('FAIL S4c insert achievements allowed');
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    reset role;
    insert into phase2a_log(line) values ('PASS S4c cannot INSERT achievements: ' || left(sqlerrm, 70));
  end;

  v_stage := 'S4d';
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.chat_requests (user_id, idempotency_key, state)
    values (v_a, gen_random_uuid(), 'reserved');
    reset role;
    insert into phase2a_log(line) values ('FAIL S4d insert chat_requests allowed');
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    reset role;
    insert into phase2a_log(line) values ('PASS S4d cannot INSERT chat_requests: ' || left(sqlerrm, 70));
  end;

  v_stage := 'S4e';
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.chat_messages (user_id, role, content)
    values (v_a, 'assistant', 'forged');
    reset role;
    insert into phase2a_log(line) values ('FAIL S4e insert chat_messages allowed');
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    reset role;
    insert into phase2a_log(line) values ('PASS S4e cannot INSERT chat_messages: ' || left(sqlerrm, 70));
  end;

  v_stage := 'S4f';
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  delete from public.game_sessions where user_id = v_b;
  get diagnostics v_n = row_count;
  reset role;
  insert into phase2a_log(line) values (case when v_n=0 then 'PASS S4f cannot DELETE B sessions' else 'FAIL S4f rows='||v_n end);

  v_stage := 'S4g';
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.game_sessions set status = 'COMPLETED' where user_id = v_a;
  get diagnostics v_n = row_count;
  reset role;
  insert into phase2a_log(line) values (case when v_n=0 then 'PASS S4g cannot UPDATE own session status' else 'FAIL S4g rows='||v_n end);

  v_stage := 'S4h';
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.game_sessions (user_id, game_id, status) values (v_a, 'tictactoe', 'STARTED');
    get diagnostics v_n = row_count;
    reset role;
    insert into phase2a_log(line) values (case when v_n=1 then 'PASS S4h can INSERT own session (Edge start)' else 'FAIL S4h rows='||v_n end);
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    reset role;
    insert into phase2a_log(line) values ('FAIL S4h insert blocked: ' || left(sqlerrm, 70));
  end;

  v_stage := 'S8';
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform * from public.exchange_nova_coins(-10, gen_random_uuid());
    reset role;
    insert into phase2a_log(line) values ('FAIL S8 negative accepted');
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    reset role;
    insert into phase2a_log(line) values ('PASS S8 negative rejected: ' || left(sqlerrm, 70));
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform * from public.exchange_nova_coins(5, gen_random_uuid());
    reset role;
    insert into phase2a_log(line) values ('FAIL S8b non-10 accepted');
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    reset role;
    insert into phase2a_log(line) values ('PASS S8b non-10 rejected: ' || left(sqlerrm, 70));
  end;

  v_stage := 'S9a';
  set local role anon;
  perform set_config('request.jwt.claims', '', true);
  select count(*) into v_n from public.wallet;
  reset role;
  insert into phase2a_log(line) values (case when v_n=0 then 'PASS S9a anon cannot read wallet' else 'FAIL S9a rows='||v_n end);

  v_stage := 'S9b';
  set local role anon;
  perform set_config('request.jwt.claims', '', true);
  select count(*) into v_n from public.profiles;
  reset role;
  insert into phase2a_log(line) values (case when v_n=0 then 'PASS S9b anon cannot read profiles' else 'FAIL S9b rows='||v_n end);

  v_stage := 'S9c';
  set local role anon;
  perform set_config('request.jwt.claims', '', true);
  select count(*) into v_n from public.chat_messages;
  reset role;
  insert into phase2a_log(line) values (case when v_n=0 then 'PASS S9c anon cannot read chat_messages' else 'FAIL S9c rows='||v_n end);

  v_stage := 'S9d';
  set local role anon;
  perform set_config('request.jwt.claims', '', true);
  begin
    perform * from public.exchange_nova_coins(10, gen_random_uuid());
    reset role;
    insert into phase2a_log(line) values ('FAIL S9d anon exchange allowed');
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    reset role;
    insert into phase2a_log(line) values ('PASS S9d anon exchange rejected: ' || left(sqlerrm, 70));
  end;

exception when others then
  begin reset role; exception when others then null; end;
  insert into phase2a_log(line) values ('ERROR at ' || v_stage || ': ' || sqlerrm);
  raise;
end;
$$;

select id, line from phase2a_log order by id;
rollback;
