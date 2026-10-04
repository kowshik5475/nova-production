-- NOVA AI PLAY — PHASE 2A
-- P0 production security hardening: RLS + database integrity
-- ============================================================
-- Applied AFTER all prior migrations (00 … 000014).
-- Does not edit old migrations. Does not rename tables/columns.
-- Does not change RPC reward amounts, economy rules, AI, or UI.
--
-- GOAL
--   Close browser bypass paths around the intended architecture:
--     CLIENT → AUTH → RPC / EDGE → SERVER VALIDATION → DB TRANSACTION
--
-- SCOPE (P0 only)
--   1. Remove broad user write policies (FOR ALL / client INSERT)
--      that let authenticated users mutate server-authoritative data.
--   2. Add defensive CHECK constraints on wallet balances and
--      progression counters (do not conflict with legitimate RPC paths).
--   3. Enforce one game_results row per session at the DB level.
--
-- NOT IN SCOPE (Phase 2B+)
--   - Tic-Tac-Toe server-side outcome validation
--   - Client-supplied game idempotency keys in Edge Functions
--   - CORS restriction, Gemini key hygiene, log scrubbing
--   - Achievements / streaks / password reset product features
-- ============================================================

-- ────────────────────────────────────────────────────────────────
-- SECTION 1 — POLICY CHANGES
-- ────────────────────────────────────────────────────────────────
-- Final-state analysis (post m00–m14) and classification:
--
-- game_sessions
--   Before: "Users can manage own sessions" FOR ALL USING (auth.uid() = user_id)
--   Class:  DANGEROUS for UPDATE/DELETE; INSERT Required (Edge start);
--           SELECT useful for own-row diagnostics / future FE.
--   After:  INSERT own + SELECT own only. No client UPDATE/DELETE.
--   Note:   complete_* RPCs and Edge-only INSERT remain valid.
--           Session status transitions happen inside SECURITY DEFINER RPCs.
--
-- game_progress
--   Before: "Users can manage own progress" FOR ALL USING (auth.uid() = user_id)
--   Class:  DANGEROUS (client can set games_won / total_xp / games_played).
--           SELECT Required (Profile FE + nova-chat Edge context).
--           Writes are Server-only (complete_* RPCs, SECURITY DEFINER).
--   After:  SELECT own only.
--
-- user_achievements
--   Before: "Users can manage own achievements" FOR ALL USING (auth.uid() = user_id)
--   Class:  DANGEROUS (client can INSERT fake achievements).
--           SELECT Required (profile / future achievement UI reads).
--           Future award path will be Server-only (definer RPC/trigger).
--   After:  SELECT own only.
--
-- chat_messages
--   Before: SELECT own + INSERT own (WITH CHECK auth.uid() = user_id)
--   Class:  INSERT DANGEROUS (forge role='assistant' rows, spoof history).
--           SELECT Required (own history; FE also uses get_chat_history RPC).
--           Writes are Server-only (finalize_chat_credit, SECURITY DEFINER).
--   After:  SELECT own only. Client INSERT removed.
--
-- chat_requests
--   Before: SELECT own + INSERT own (WITH CHECK auth.uid() = user_id)
--   Class:  INSERT DANGEROUS (create state='reserved' without debit, then
--           call finalize_chat_credit → messages + AI_USAGE without reserve).
--           SELECT Required (own request state / retries).
--           Writes are Server-only (reserve/finalize/release, SECURITY DEFINER).
--   After:  SELECT own only. Client INSERT removed.
--
-- Reviewed — no change required (already correct after prior migrations):
--   profiles                 → SELECT own only (admin SELECT dropped m03)
--   wallet                   → SELECT own only (no client UPDATE; definer RPCs)
--   wallet_transactions      → SELECT own only (admin SELECT dropped m03)
--   game_results             → SELECT own only (no client INSERT; definer RPCs)
--   games / achievements     → public SELECT catalog (required)
--   leaderboard              → public SELECT; admin FOR ALL using(true) dropped m06
--   audit_log                → SELECT own; admin SELECT dropped m06
--   exchange_requests        → RLS on, zero user policies (definer only)
--   game_completions         → RLS on, zero user policies (definer only)
--   Remaining using(true) admin policies → dropped m03 + m06
--
-- Anonymous access: auth.uid() IS NULL on all own-row policies →
--   no rows visible/writable. Catalog tables intentionally public SELECT.
-- ────────────────────────────────────────────────────────────────

-- 1.1 game_sessions: narrow FOR ALL → INSERT + SELECT own
drop policy if exists "Users can manage own sessions" on public.game_sessions;

create policy "Users can insert own sessions"
  on public.game_sessions
  for insert
  with check (auth.uid() = user_id);

create policy "Users can read own sessions"
  on public.game_sessions
  for select
  using (auth.uid() = user_id);

-- 1.2 game_progress: narrow FOR ALL → SELECT own only
drop policy if exists "Users can manage own progress" on public.game_progress;

create policy "Users can read own progress"
  on public.game_progress
  for select
  using (auth.uid() = user_id);

-- 1.3 user_achievements: narrow FOR ALL → SELECT own only
drop policy if exists "Users can manage own achievements" on public.user_achievements;

create policy "Users can read own achievements"
  on public.user_achievements
  for select
  using (auth.uid() = user_id);

-- 1.4 chat_messages: remove client INSERT (definer finalize still writes)
drop policy if exists "Users can insert own messages" on public.chat_messages;
-- "Users can read own messages" (SELECT) remains — reviewed, required.

-- 1.5 chat_requests: remove client INSERT (definer reserve still writes)
drop policy if exists "Users can insert own chat requests" on public.chat_requests;
-- "Users can read own chat requests" (SELECT) remains — reviewed, required.

-- ────────────────────────────────────────────────────────────────
-- SECTION 2 — DATABASE CONSTRAINTS (invariants at the DB layer)
-- ────────────────────────────────────────────────────────────────
-- Do not conflict with legitimate application behavior:
--   - All wallet mutations go through SECURITY DEFINER RPCs that
--     already enforce balance >= needed amount before decrement.
--   - Game reward RPCs only add non-negative constants.
--   - exchange_nova_coins only runs when earned_coins >= 10.
--   - reserve_chat_credit only runs when ai_credits >= 1.
-- If migration fails on existing data, that indicates prior corruption
-- and should be investigated — do not weaken the constraint.

alter table public.wallet
  drop constraint if exists wallet_earned_coins_non_negative,
  drop constraint if exists wallet_ai_credits_non_negative,
  add constraint wallet_earned_coins_non_negative check (earned_coins >= 0),
  add constraint wallet_ai_credits_non_negative check (ai_credits >= 0);

alter table public.game_progress
  drop constraint if exists game_progress_games_played_non_negative,
  drop constraint if exists game_progress_games_won_non_negative,
  drop constraint if exists game_progress_total_xp_non_negative,
  add constraint game_progress_games_played_non_negative check (games_played >= 0),
  add constraint game_progress_games_won_non_negative check (games_won >= 0),
  add constraint game_progress_total_xp_non_negative check (total_xp >= 0);

alter table public.profiles
  drop constraint if exists profiles_xp_non_negative,
  drop constraint if exists profiles_level_positive,
  add constraint profiles_xp_non_negative check (xp >= 0),
  add constraint profiles_level_positive check (level >= 1);

-- One result per session (RPC already guards with exists; this is defense in depth).
-- Safe: complete_* raise if a result already exists for the session.
alter table public.game_results
  drop constraint if exists game_results_one_per_session,
  add constraint game_results_one_per_session unique (session_id);

-- ────────────────────────────────────────────────────────────────
-- SECTION 3 — RPCs REVIEWED (no body changes in this migration)
-- ────────────────────────────────────────────────────────────────
-- Reviewed — no change required for Phase 2A P0 scope:
--   handle_new_user                 (auth trigger, SECURITY DEFINER, search_path)
--   exchange_nova_coins             (auth.uid, amount=10, FOR UPDATE, idempotency)
--   complete_tictactoe_game         (auth.uid, session ownership, STARTED guard,
--                                    idempotency, single transaction)  *outcome
--                                    trust deferred to Phase 2B*
--   complete_sudoku_game            (auth.uid, session ownership, STARTED guard,
--                                    idempotency, single transaction; board
--                                    validated in Edge before RPC)
--   reserve_chat_credit             (auth.uid, state machine, FOR UPDATE, stale 5m)
--   finalize_chat_credit            (auth.uid + request ownership, idempotent)
--   release_chat_credit             (auth.uid + request ownership, idempotent)
--   get_chat_history                (auth.uid, recent-N then chrono)
--   get_chat_request_state          (auth.uid, idempotent retry helper)
--   spend_nova_chat_credit          (dropped in m06 — remains dropped)
--
-- All live RPCs: SECURITY DEFINER + SET search_path = public +
-- revoke all FROM public + grant execute TO authenticated.
-- None accept a target user_id parameter (ownership via auth.uid() only).

-- ============================================================
-- DOWN (manual reverse — not auto-applied by Supabase)
-- ============================================================
-- To revert policy narrowing (NOT recommended for production):
--
-- drop policy if exists "Users can insert own sessions" on public.game_sessions;
-- drop policy if exists "Users can read own sessions" on public.game_sessions;
-- create policy "Users can manage own sessions" on public.game_sessions
--   for all using (auth.uid() = user_id);
--
-- drop policy if exists "Users can read own progress" on public.game_progress;
-- create policy "Users can manage own progress" on public.game_progress
--   for all using (auth.uid() = user_id);
--
-- drop policy if exists "Users can read own achievements" on public.user_achievements;
-- create policy "Users can manage own achievements" on public.user_achievements
--   for all using (auth.uid() = user_id);
--
-- create policy "Users can insert own messages" on public.chat_messages
--   for insert with check (auth.uid() = user_id);
--
-- create policy "Users can insert own chat requests" on public.chat_requests
--   for insert with check (auth.uid() = user_id);
--
-- alter table public.wallet
--   drop constraint if exists wallet_earned_coins_non_negative,
--   drop constraint if exists wallet_ai_credits_non_negative;
-- alter table public.game_progress
--   drop constraint if exists game_progress_games_played_non_negative,
--   drop constraint if exists game_progress_games_won_non_negative,
--   drop constraint if exists game_progress_total_xp_non_negative;
-- alter table public.profiles
--   drop constraint if exists profiles_xp_non_negative,
--   drop constraint if exists profiles_level_positive;
-- alter table public.game_results
--   drop constraint if exists game_results_one_per_session;
