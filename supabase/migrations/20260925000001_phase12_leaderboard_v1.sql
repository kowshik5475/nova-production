-- NOVA AI PLAY — PHASE 12
-- Leaderboard V1: read-only, server-derived global XP ranking.
-- ============================================================
-- Read-only audit findings (Phase 12 §1):
--   * public.profiles.xp / .level are authoritative. The browser has
--     SELECT-own-only RLS on profiles (no INSERT/UPDATE/DELETE policy), and
--     every XP writer is a SECURITY DEFINER RPC or an edge function.
--   * public.leaderboard is a legacy table: 0 rows, no writers anywhere in
--     the application, RLS = public SELECT only (the admin FOR ALL policy was
--     dropped in 20260920000006_hardening.sql). It stays unused and unchanged.
--   * profiles RLS stops the browser from reading other users' rows, so the
--     global ranking must be computed in the database, not in React.
--
-- Ranking (deterministic, reproducible):
--   primary   : profiles.xp DESC  — authoritative global XP
--   tie-break : profiles.updated_at ASC — the authoritative timestamp the
--               server sets whenever a profile row changes, including every
--               XP-awarding RPC
--   final key : profiles.id ASC — stable deterministic key (never exposed)
-- No other metric is implied and no competitive meaning is claimed for the
-- tie-break.
--
-- Exposure: rank, display_name, xp, level plus an is_me marker so the caller
-- can read its own rank without the API exposing any id / user_id / email.
-- This view is not security_invoker: it is owned by postgres, which bypasses
-- RLS, and it is granted SELECT only — a read-only projection of public
-- leaderboard fields. profiles RLS itself is untouched.

create index if not exists idx_profiles_xp_ranking
  on public.profiles (xp desc, updated_at asc, id asc);

create or replace view public.leaderboard_ranked as
select
  row_number() over (
    order by p.xp desc, p.updated_at asc, p.id asc
  )::integer as rank,
  p.display_name,
  p.xp,
  p.level,
  coalesce(p.id = auth.uid(), false) as is_me
from public.profiles p
where p.xp > 0;  -- qualifying progression only: no XP, no rank ("No rank yet")

revoke all on public.leaderboard_ranked from public, anon, authenticated, service_role;
grant select on public.leaderboard_ranked to anon, authenticated, service_role;
