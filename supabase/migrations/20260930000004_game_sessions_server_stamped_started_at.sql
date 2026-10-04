-- Upgrade Phase J hardening — game_sessions.started_at is server-stamped.
--
-- Ball Run derives eligibility, score and outcome from started_at alone, so a
-- client that could backdate the column at INSERT time would be able to claim
-- an instant win. Phase 2a already forbids UPDATE on game_sessions, but INSERT
-- of own rows stays intentionally open for the Edge start path (S4h), so the
-- timestamp is stamped here instead: every insert path — browser or Edge
-- Function — records the same server clock value.
--
-- Additive only: one BEFORE INSERT trigger. No column, policy, index or
-- function signature changes; rows that already exist are untouched.

create or replace function public.stamp_session_started_at() returns trigger
language plpgsql
as $fn$
begin
  new.started_at := now();
  return new;
end;
$fn$;

drop trigger if exists game_sessions_stamp_started_at on public.game_sessions;

create trigger game_sessions_stamp_started_at
  before insert on public.game_sessions
  for each row
  execute function public.stamp_session_started_at();
