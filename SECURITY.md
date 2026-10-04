# NOVA AI Play — Security

Threat model and the controls actually implemented, read from the migrations,
Edge Functions, client sources and test suite. File paths are cited for every
control. A final section lists known limitations honestly.

---

## 1. Threat model

| | |
|---|---|
| **Assets** | `wallet` balances (NOVA Coins, AI Credits), `wallet_transactions` ledger, `profiles` XP/level/streak, `game_progress`, `user_achievements`, chat history, private attachments in Storage, the `GEMINI_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` secrets |
| **Adversaries** | anonymous visitors; an authenticated user attacking their own rows (forging rewards, minting credits, spoofing history); an authenticated user attacking another user's rows; a third party reading data cross-origin; a malicious/compromised client bundle |
| **Trust boundary** | `CLIENT → AUTH → RPC / EDGE → SERVER VALIDATION → DB TRANSACTION` (`supabase/migrations/20260924000001_phase2a_p0_rls_hardening.sql`). The browser is untrusted: it may read its own rows and start sessions, and nothing else. |
| **Not in scope** | Supabase/Google platform security, physical access, denial of service |

## 2. Authentication and keys

- **Email/password** via Supabase Auth (`src/lib/supabase.ts`: sign in, sign
  up, `resetPasswordForEmail`, `updateUser`, recovery detection). Password
  reset responses are deliberately non-enumerating; the recovery flag lives in
  `sessionStorage` only.
- **Anon key in the browser** — `src/lib/supabase/client.ts` is built solely
  from `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`; without them the app
  runs in demo mode with a `null` client.
- **Service-role key** appears in exactly one place:
  `supabase/functions/delete-account/index.ts`, read from
  `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')` *after* the caller's JWT has been
  verified. No file under `src/` references `SERVICE_ROLE` (asserted by
  `supabase/tests/upgrade_multimodal_storage.test.ts` M5, and confirmed by
  grep).
- **Every Edge Function** (`nova-chat`, `process-tictactoe`, `process-sudoku`,
  `process-ball-run`, `process-water-sort`, `exchange-nova-coins`,
  `delete-account`) rejects requests without an `Authorization` header (401),
  verifies it with `auth.getUser()` against an anon-key client, and then
  performs all database work through that client — so RLS and `auth.uid()`
  still apply to the function's own queries.

## 3. Row-level security — every table

Final state after all migrations (policies created in
`20260920_00_core_tables.sql`, admin policies dropped in
`20260920000003_nova_economy.sql` + `20260920000006_hardening.sql`, write
policies narrowed in `20260924000001_phase2a_p0_rls_hardening.sql`, thread
policies in `20260930000001_chat_conversations.sql`).

| Table | Effective policy | Notes |
|-------|------------------|-------|
| `profiles` | SELECT own (`auth.uid() = id`) | no client INSERT/UPDATE/DELETE; admin SELECT dropped in m03 |
| `wallet` | SELECT own | balances mutated only by definer RPCs |
| `wallet_transactions` | SELECT own | ledger is server-written only |
| `games` | public SELECT | read-only catalog |
| `game_sessions` | INSERT own + SELECT own | no client UPDATE/DELETE; status transitions happen only inside definer RPCs (phase 2a §1.1) |
| `game_results` | SELECT own | no client INSERT (phase 2a §4 rationale) |
| `game_progress` | SELECT own | counters were client-writable before phase 2a |
| `achievements` | public SELECT | read-only catalog |
| `user_achievements` | SELECT own | no client INSERT/UPDATE/DELETE (phase 2a §1.3) |
| `leaderboard` | public SELECT | legacy table; admin `FOR ALL using(true)` dropped in m06 |
| `audit_log` | SELECT own | admin SELECT dropped in m06; no writer exists in this codebase |
| `chat_messages` | SELECT own | client INSERT removed in phase 2a §1.4 — only `finalize_chat_credit` writes |
| `chat_requests` | SELECT own | client INSERT removed in phase 2a §1.5 — only `reserve_chat_credit` writes |
| `chat_conversations` | SELECT own | no client INSERT/UPDATE/DELETE; CRUD only via definer RPCs |
| `exchange_requests` | RLS enabled, zero user policies | definer-only table |
| `game_completions` | RLS enabled, zero user policies | definer-only idempotency ledger |
| `storage.objects` (bucket `chat-attachments`) | owner-folder INSERT / SELECT / DELETE | see §8 |
| `leaderboard_ranked` (view) | `grant select` to `anon`, `authenticated`, `service_role` | read-only projection, see §5 |

Anonymous callers get nothing from own-row policies: `auth.uid()` is `NULL`, so
every `auth.uid() = <owner>` predicate is false (phase 2a §"Anonymous access").
Catalog tables are intentionally public-SELECT.

Defensive CHECK constraints (`20260924000001_phase2a_p0_rls_hardening.sql` and
`20260920000003_nova_economy.sql`):

- `wallet.earned_coins >= 0`, `wallet.ai_credits >= 0`
- `game_progress.games_played/games_won/total_xp >= 0`
- `profiles.xp >= 0`, `profiles.level >= 1`
- `game_results` unique on `session_id` (one result per session)
- `wallet_transactions.type` ∈ `AI_USAGE | GAME_REWARD | DAILY_LOGIN |
  OTHER_VALIDATED_REWARD | COIN_EXCHANGE`, `currency` ∈ `NOVA_COIN | AI_CREDIT`
- `chat_messages.mode` ∈ the four chat modes; `media_kind` ∈
  `image_input | image_output | audio_output`
- `chat_requests.state` ∈ `reserved | completed | released`

## 4. RPC security

Every live RPC follows the same pattern (verified across
`supabase/migrations/*.sql`; summarised in phase 2a §3):

- `language plpgsql security definer set search_path = public`
- identity from `auth.uid()` only — **no RPC accepts a target user id**
- `if v_user_id is null then raise exception 'Authentication required'`
- `revoke all on function … from public` + `grant execute … to authenticated`
  (`update_own_display_name` additionally `revoke … from anon`)

| RPC | Purpose |
|-----|---------|
| `handle_new_user` (trigger) | creates `profiles` + `wallet` on sign-up |
| `reserve_chat_credit(uuid, uuid, text)` | debits 1 credit, opens reservation, validates thread ownership and mode |
| `finalize_chat_credit(uuid, text, text, text, text, text)` | persists both messages + ledger, marks completed, auto-titles thread, touches streak, awards `first_ai_chat` |
| `release_chat_credit(uuid)` | refunds and marks released (idempotent) |
| `get_chat_history(integer, uuid)` | own messages only; `NULL` conversation = legacy whole-account path |
| `get_chat_request_state(uuid)` | idempotent replay lookup, scoped to the caller and reservation |
| `create_chat_conversation(text)` / `rename_chat_conversation(uuid, text)` / `delete_chat_conversation(uuid)` / `get_chat_conversations(integer)` | thread CRUD, ownership from `auth.uid()` |
| `exchange_nova_coins(integer, uuid)` | fixed amount (`= 10`), wallet `FOR UPDATE`, idempotency via `exchange_requests` |
| `complete_tictactoe_game(uuid, text, uuid)` | atomic completion + rewards |
| `complete_sudoku_game(uuid, integer, uuid)` | atomic completion + rewards |
| `complete_ball_run_game(uuid, uuid)` | atomic completion, server-derived score |
| `complete_water_sort_game(uuid, integer, uuid)` | atomic completion, move-count-derived score |
| `update_own_display_name(text)` | updates **only** `display_name` for `auth.uid()` (length 1–50) |
| `touch_user_streak()` | internal only — `revoke all … from public, anon, authenticated` (`20260924000006_phase10_streak_v1.sql`), re-issued by `20260924000007_phase11_streak_achievements_v1.sql` |
| `leaderboard_ranked` (view) | read-only: `rank`, `display_name`, `xp`, `level`, `is_me`; `where xp > 0` |

The view is explicitly **not** `security_invoker`: it is owned by postgres and
granted `SELECT` only, so it deliberately publishes display name + XP + level
for profiles with `xp > 0` and exposes no id, email or wallet field
(`20260925000001_phase12_leaderboard_v1.sql`).

## 5. Economy integrity

- **Server-side awarding only.** Every mutation of `wallet`,
  `wallet_transactions`, `game_progress`, `profiles.xp/level/streak` and
  `user_achievements` happens inside a `SECURITY DEFINER` RPC body. The client
  performs **zero** `.insert()`, `.update()` or `.delete()` calls anywhere in
  `src/` (the only match for those patterns is `URLSearchParams.delete`), and
  no RLS policy grants client write access to those tables.
- **Atomicity.** Each completion RPC runs as one function body = one
  transaction: idempotency insert → session lock → result → wallet → progress →
  profile → achievements → streak. Any failure rolls the whole thing back.
- **Idempotency ledgers.**
  - `game_completions (user_id, idempotency_key) UNIQUE` — one completion per
    key; the Edge Functions use the session id as the stable key.
  - `exchange_requests (user_id, idempotency_key) UNIQUE`.
  - `chat_requests (user_id, idempotency_key) UNIQUE` with a
    `reserved/completed/released` state machine.
  Re-running a completed key returns current state and awards nothing.
- **Balance invariants.** Non-negative CHECKs on both wallet columns mean a
  bad path fails loudly instead of corrupting a balance.
- **Exchange is fixed-rate.** `exchange_nova_coins` raises
  `Exchange amount must be exactly 10 NOVA Coins` for any other amount; the
  Edge Function hard-codes `p_coin_amount: 10`
  (`supabase/functions/exchange-nova-coins/index.ts`).

## 6. Chat credit reservation

`reserve_chat_credit` → provider → `finalize_chat_credit` /
`release_chat_credit` (`supabase/migrations/20260920000002_chat_messages_and_credit_reservation.sql`,
state machine added in `20260920000006_hardening.sql`, refund fix in
`20260924000002_phase2c_reserve_chat_credit_refund_fix.sql`, thread-aware
version in `20260930000001_chat_conversations.sql`):

- Reserve locks the wallet row `FOR UPDATE`, requires `ai_credits >= 1`,
  debits exactly 1, and records the reservation with the mode and (validated)
  conversation id.
- Finalize is idempotent (`state = 'completed'` → return), writes the two
  messages and the `AI_USAGE / -1 / AI_CREDIT` ledger row, and only then marks
  the request completed.
- Release is idempotent and refuses to refund a `completed` request, so a
  double release cannot mint a credit.
- Stale `reserved` rows older than 5 minutes are converted and refunded inside
  the next `reserve_chat_credit`; rows already released by
  `release_chat_credit` are deleted **without** a second refund (the original
  version of that cleanup minted free credits — fixed in the phase 2c
  migration).
- Because `chat_messages` and `chat_requests` have no client INSERT policy, a
  browser cannot forge `role = 'assistant'` history or create a reservation
  without paying (the phase 2a §1.4/§1.5 rationale).

## 7. Game completion validation — server-derived vs client-trusted

The **Edge Functions** do the real validation; the **RPCs** enforce
ownership, session state, idempotency and reward bounds. Both layers are
directly reachable by any authenticated user, so it matters exactly where each
check lives.

| Game | Derived on the server (Edge Function) | Trusted if the RPC is called directly |
|------|----------------------------------------|----------------------------------------|
| Tic-Tac-Toe | `process-tictactoe` validates the board and derives `outcome` (`_shared/tictactoe_validate.ts`): both-win, wrong mark counts, bad cell values and impossible states are rejected — "never trust a client winner claim" | `complete_tictactoe_game(p_outcome)` **trusts `p_outcome`** (only checks it ∈ `win/loss/draw`). A direct RPC call skips board validation. |
| Sudoku | `process-sudoku` compares all 81 cells against the known solution for the chosen puzzle before calling the RPC | `complete_sudoku_game(p_puzzle_id)` only checks `p_puzzle_id ∈ (0,1,2)` + session ownership/status and then awards a win — the board is never re-checked in SQL |
| Water Sort | `process-water-sort` replays the claimed move list against the puzzle stored in `session_data` and only pays when the replay is legal **and** solved; the RPC re-checks `p_move_count` ∈ 1..400 and derives the score band from it | `complete_water_sort_game(p_move_count)` **trusts `p_move_count`** (bounded): no replay, no puzzle requirement |
| Ball Run | `process-ball-run` compares the client claim against the server clock and rejects claims that do not match (`claimMatchesServer`) | `complete_ball_run_game` derives score/outcome from `started_at` → `now()` with a 5 s minimum and a 120 s window, but needs no proof of play |

Common bounds that hold on **both** paths:

- identity from `auth.uid()`; the session must belong to the caller, be
  `game_id`-correct and `status = 'STARTED'`;
- one reward per session (`game_completions` unique key, plus an explicit
  `game_results` existence check and the DB unique constraint on
  `session_id`);
- `started_at` is server-stamped by a `BEFORE INSERT` trigger so a client
  cannot backdate a run (`20260930000004_game_sessions_server_stamped_started_at.sql`);
- reward constants (10/25 TTT, 20/40 Sudoku, 15/30 Ball Run win, 15/35 Water
  Sort) are literals inside the RPC — a caller can never choose an amount.

**Honest summary:** the game Edge Functions are thin, authenticated wrappers
around RPCs that are themselves granted to `authenticated`. Anything the Edge
Function does not re-check (TTT outcome, Sudoku board, Water Sort move list)
is enforced only by the convention that clients call the Edge Function. The
damage is bounded — one session, one payout, fixed constants — but a scripted
caller can complete their own sessions without actually playing.

## 8. Attachments and Storage isolation

`supabase/migrations/20260930000002_chat_attachments_storage.sql`:

- bucket `chat-attachments` is **private** (`public = false`,
  `file_size_limit = 5242880`, `allowed_mime_types` = png/jpeg/webp/gif);
- three owner-scoped policies requiring
  `(storage.foldername(name))[1] = auth.uid()::text` for INSERT, SELECT and
  DELETE — a path must live in the uploader's own folder;
- the Edge Function re-validates every path with `isOwnerPath()` /
  `checkImageAttachment()` (`supabase/functions/_shared/chat_modes.ts`):
  no `..`, no absolute path, no empty segment, no prefix trick
  (`<uid>x/…`), MIME allow-list, size ≤ 5 MB;
- generated media is written by the function itself via
  `mediaObjectPath(ownerId, ext)`, which sanitises the extension and always
  targets the owner folder;
- reads in the UI use short-lived signed URLs created by the owner
  (`src/app/chat.tsx`, 3600 s) — no public URLs exist;
- `supabase/tests/upgrade_multimodal_storage.test.ts` (M2, M6) proves
  cross-user upload/sign/delete fail in both directions at runtime.

## 9. Edge Functions: CORS and key isolation

`supabase/functions/_shared/cors.ts`:

- allow-list from `CORS_ALLOWED_ORIGINS` (comma-separated) **plus** a fixed set
  of local-dev origins (`localhost`/`127.0.0.1` on 5173/4173/3000);
- `Access-Control-Allow-Origin` is echoed only when the `Origin` header is on
  the allow-list; otherwise no CORS header is returned and an `OPTIONS`
  preflight is answered **403**;
- production origins must be set as secrets — nothing is hard-coded
  (`DEPLOYMENT.md` §4).

Key isolation: model names and the provider key are read from the Edge runtime
environment only; `nova-chat` contains no DDL and never references the
service-role key (asserted in `upgrade_multimodal_storage.test.ts` M4).

## 10. Personal identity in prompts

- The prompt receives display name, level, XP, streak, per-game statistics and
  wallet balances — **never** email, user id, auth metadata or session tokens.
  `buildRecentActivity()` is explicitly "identity-free" and forbids user id,
  email, password, token and balance fields
  (`supabase/functions/_shared/recent_activity.ts` header;
  `supabase/tests/phase13_reward_chat_reentry.test.ts` asserts the derived
  context contains no `@`, `user_id`, `ai_credits`, `earned_coins`, …).
- The request body cannot smuggle identity in: `ChatRequestBody` is a fixed
  allow-list of six routing fields, and `nova-chat` destructures the body
  exactly once (phase 13 static assertion).
- Structured logs carry `requestId` / `userId` for operations but never
  message content, conversation history or secrets
  (`supabase/functions/nova-chat/index.ts` `log()` / `logErr()`).

## 11. Account deletion

`supabase/functions/delete-account/index.ts` (Phase 7):

1. POST only, CORS-checked, `Authorization` required and verified with
   `auth.getUser()` — the user id comes from the JWT, never the body.
2. Body must contain `confirmation === 'DELETE'` (the UI requires typing
   `DELETE`; `src/app/profile.tsx`).
3. Only then is the service-role client created, and it calls
   `admin.auth.admin.deleteUser(user.id)` — self-deletion only. A "not found"
   result is treated as success so a retry after a lost response stays
   idempotent.
4. Scope: deleting the `auth.users` row cascades to personal rows through
   existing FKs (`profiles`, `wallet`, `wallet_transactions`, `chat_messages`,
   `chat_requests`, `chat_conversations`, `exchange_requests`,
   `game_completions`, `game_sessions` → `game_results`, `game_progress`,
   `user_achievements`, `leaderboard`); `audit_log.user_id` is
   `ON DELETE SET NULL`. Global catalogs (`games`, `achievements`) are
   untouched — asserted live by `supabase/tests/phase7_account_deletion.test.ts`
   (tests H, I, K).
5. Missing service key returns a generic 503 `Deletion unavailable` without
   leaking internals.

## 12. Environment variable handling

- The repository's `.env` holds exactly two keys — `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY` — matching `.env.example`. No provider key and no
  service-role key is present (asserted by `upgrade_multimodal_storage.test.ts`
  M5).
- Server secrets live in the Supabase Edge runtime: `GEMINI_API_KEY`,
  `GEMINI_TEXT_MODEL`, `GEMINI_MODEL`, `GEMINI_VISION_MODEL`,
  `GEMINI_IMAGE_MODEL`, `GEMINI_TTS_MODEL`, `GEMINI_TTS_SAMPLE_RATE`,
  `CORS_ALLOWED_ORIGINS`, plus the platform-provided `SUPABASE_URL`,
  `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
- Vite only inlines `VITE_*` variables, so the anon key is the strongest
  credential the bundle can contain — and it is designed to be public.

## 13. Known limitations

1. **Completion RPCs are directly callable.** `complete_tictactoe_game`,
   `complete_sudoku_game`, `complete_water_sort_game` and
   `complete_ball_run_game` are `grant execute … to authenticated` and trust
   their outcome / puzzle / move-count / timing parameters (§7). Validation
   lives in the Edge Functions, not in the database. Impact is bounded to one
   payout per session at fixed constants, but a scripted caller can farm
   sessions without playing.
2. **Clients may insert their own `game_sessions` rows.** RLS deliberately
   allows own-row INSERT (the Edge `start` path needs it), so a user can
   create sessions with arbitrary `session_data`; rewards still require a
   completion RPC.
3. **Ball Run has no anti-idle proof.** The server clock window (5 s–120 s)
   prevents backdating and instant cash-in, but a session left open for 60 s
   and then completed via the RPC pays out with no demonstrated play.
4. **No application-layer rate limiting.** There is no throttling in any Edge
   Function or client; only Supabase Auth's built-in email/password rate
   limits apply. Credit cost (1 per chat message) is the only economic brake.
5. **`leaderboard_ranked` publishes display names.** It grants `SELECT` to
   `anon` and is not `security_invoker`, so display name, XP and level of any
   profile with `xp > 0` are world-readable. This is a deliberate product
   choice, documented in `20260925000001_phase12_leaderboard_v1.sql`.
6. **`audit_log` has no writer.** The table exists with SELECT-own RLS, but no
   function in this repository inserts rows into it.
7. **Account deletion does not remove Storage objects.** `delete-account`
   deletes the auth user only; images already uploaded to `chat-attachments`
   are orphaned rather than deleted (FKs do not cover Storage).
8. **CORS is a browser control.** The origin allow-list stops cross-origin
   browser calls; a non-browser client can still call the endpoints, which is
   why every function requires a valid JWT and every RPC derives identity from
   `auth.uid()`.
9. **Legacy whole-account history path remains.** `get_chat_history` with a
   `NULL` conversation id still returns the account's last N messages; it is
   kept for backward compatibility (`20260930000001_chat_conversations.sql` §7)
   and is what `nova-chat` uses for unthreaded requests.
10. **No automated secret scanning or CI gate.** Enforcement is the test suite
    in `supabase/tests/` plus `npm run lint` / `npm run build`, all run
    manually (see `TESTING.md`).
