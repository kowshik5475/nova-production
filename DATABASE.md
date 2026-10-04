# NOVA AI Play — Database

Every table, RPC, policy, Storage bucket and migration in the Supabase
project, read from `supabase/migrations/`. Companion documents:
`ARCHITECTURE.md` (how the app is assembled), `GAME_SYSTEM.md` (game rules),
`SECURITY.md` (threat model).

---

## 1. Applying the migrations

`supabase/migrations/` contains **30 SQL files**. `README.md` instructs
`supabase db push` in filename order and lists the first 19 in a table; that
table is now incomplete (§8).

Filename (byte) order puts `20260920_00_core_tables.sql` at position **15**,
after `20260920000001`–`20260920000014`, because `_` sorts after `0`. Two of
the files that sort ahead of it depend on tables it creates:

- `20260920000003_nova_economy.sql` begins `alter table public.wallet_transactions …`
- `20260920000004_tictactoe_atomic_completion.sql` creates
  `game_completions … references public.game_sessions(id)`

Both target tables are created only in `20260920_00_core_tables.sql`. The
file set therefore assumes the core tables exist before those two files run —
it reads as a NOVA 2.0 series applied on top of an existing Phase-2 schema
(the core file's header says "Phase 2: Database", the numbered files say
"NOVA 2.0"). Apply `20260920_00_core_tables.sql` before the numbered
`202609200000NN` files when provisioning a fresh database.

## 2. Tables

16 application tables plus one view and one Storage bucket.

### Identity and economy

| Table | Key columns | Purpose |
|---|---|---|
| `profiles` | `id` → `auth.users`, `username`, `display_name`, `avatar_url`, `level`, `xp`, `streak`, `created_at`, `updated_at` | player identity and progression counters |
| `wallet` | `user_id` (PK), `ai_credits`, `earned_coins`, `updated_at` | authoritative balances |
| `wallet_transactions` | `user_id`, `type`, `currency`, `amount`, `source`, `reference_id`, `created_at` | append-only ledger |
| `exchange_requests` | `user_id`, `idempotency_key`, `created_at`, unique `(user_id, idempotency_key)` | idempotency ledger for coin → credit exchange |

`wallet_transactions.type` CHECK ∈ `AI_USAGE | GAME_REWARD | DAILY_LOGIN |
OTHER_VALIDATED_REWARD | COIN_EXCHANGE`; `currency` CHECK ∈
`NOVA_COIN | AI_CREDIT` (both added in
`20260920000003_nova_economy.sql`, backfilled from `type`). Non-negative
CHECKs on `wallet.earned_coins` / `wallet.ai_credits` and `profiles.xp` /
`profiles.level >= 1` come from `20260924000001_phase2a_p0_rls_hardening.sql`.

### Games

| Table | Key columns | Purpose |
|---|---|---|
| `games` | `id` (text PK), `name`, `slug`, `category`, `description`, `difficulty`, `estimated_duration`, `active`, `supports_ai` | read-only catalog, seeded with 4 rows (`sudoku`, `tictactoe`, `ball-run`, `water-sort`) in `20260920_00_core_tables.sql` |
| `game_sessions` | `id`, `user_id`, `game_id`, `started_at`, `completed_at`, `status`, `session_data` jsonb | one gameplay attempt |
| `game_results` | `session_id`, `user_id`, `game_id`, `score`, `duration`, `moves`, `accuracy`, `outcome`, unique `session_id` | one validated result per session |
| `game_progress` | `(user_id, game_id)` PK, `games_played`, `games_won`, `best_score`, `best_time`, `total_xp` | per-game counters |
| `game_completions` | `user_id`, `session_id`, `idempotency_key`, unique `(user_id, idempotency_key)` | one reward per session (`20260920000004`) |

`session_data` carries the server-generated game inputs: Ball Run's seed and
Water Sort's `tubes` / `colors` / `par`
(`20260930000003_games_ballrun_watersort.sql`). Tic-Tac-Toe and Sudoku
sessions are started with an empty `session_data`.

`started_at` is **server-stamped**: a `BEFORE INSERT` trigger
`stamp_session_started_at()` overwrites any client-supplied value with `now()`
(`20260930000004_game_sessions_server_stamped_started_at.sql`). Non-negative
CHECKs on the `game_progress` counters are in the phase 2a migration.

### Progression

| Table | Key columns | Purpose |
|---|---|---|
| `achievements` | `id` (text PK), `name`, `description`, `category`, `target_type`, `target_value`, `icon` | achievement catalog |
| `user_achievements` | `(user_id, achievement_id)` PK, `earned_at` | earned rows, written only by definer RPCs |
| `leaderboard` | `id`, `user_id`, `score`, `game_id` | **legacy, unused** — the UI reads the view, not this table |

CHECK constraints: `game_sessions.status` ∈ `STARTED | COMPLETED | ABANDONED`,
`game_results.outcome` ∈ `win | loss | draw | complete`, and
`achievements.target_type` ∈ `games_played | games_won | streak | xp |
first_game`.

The catalog holds 10 rows: `first_game`, `first_ttt_win`, `first_sudoku`,
`first_ai_chat`, `first_coin_exchange` (seeded in
`20260924000005_phase9_achievements_v1.sql`), `streak_3`, `streak_7`,
`streak_14` (`20260924000007_phase11_streak_achievements_v1.sql`), and
`first_ball_run`, `first_water_sort`
(`20260930000003_games_ballrun_watersort.sql`).

### Chat

| Table | Key columns | Purpose |
|---|---|---|
| `chat_conversations` | `id`, `user_id`, `title`, `created_at`, `updated_at`, `last_message_at` | thread header (`20260930000001`) |
| `chat_messages` | `id`, `user_id`, `conversation_id`, `role`, `content`, `mode`, `media_path`, `media_kind`, `created_at` | one chat transcript |
| `chat_requests` | `id`, `user_id`, `idempotency_key`, `conversation_id`, `mode`, `media_path`, `state`, unique `(user_id, idempotency_key)` | credit reservation state machine |

`chat_messages.role` CHECK ∈ `user | assistant`; `mode` CHECK ∈
`chat | vision | image | speech`; `media_kind` CHECK ∈
`image_input | image_output | audio_output`; `chat_requests.state` CHECK ∈
`reserved | completed | released` (`20260920000006_hardening.sql`).
`conversation_id` cascades on thread delete; on `chat_requests` it is
`ON DELETE SET NULL`. Explicit indexes: `idx_chat_conversations_user_activity`,
`idx_chat_messages_conversation_created (conversation_id, created_at asc)`,
`idx_chat_messages_user_created`. The three idempotency tables carry their own
`unique (user_id, idempotency_key)` constraints, which serve as the lookup
index.

### Audit

| Table | Key columns | Purpose |
|---|---|---|
| `audit_log` | `user_id` (nullable, `ON DELETE SET NULL`), `action`, `reference_id`, `metadata`, `created_at` | reserved for economic/security events — **no function in this repository writes to it** |

### Indexes

`20260920_00_core_tables.sql` creates `idx_*` indexes on every column the app
filters or sorts by (`profiles.username/updated_at`, `wallet.user_id`,
`wallet_transactions.user_id/type/created_at`, `games.category/active/slug`,
`game_sessions.user_id/game_id/status`, `game_results.session_id/user_id/
created_at`, `game_progress.user_id/game_id`,
`user_achievements.achievement_id`, `leaderboard.user_id/score`,
`audit_log.user_id/created_at`). `20260925000001` adds
`idx_profiles_xp_ranking`; `20260930000001` adds the conversation indexes.

## 3. Row-level security

RLS is enabled on every table. Final effective state:

| Table | Effective policy |
|---|---|
| `profiles`, `wallet`, `wallet_transactions`, `game_results`, `game_progress`, `game_sessions` | SELECT own (`auth.uid()` = owner); `game_sessions` also own INSERT |
| `games`, `achievements`, legacy `leaderboard` | public SELECT (read-only catalogs) |
| `chat_messages`, `chat_requests`, `chat_conversations` | SELECT own only |
| `user_achievements` | SELECT own only |
| `exchange_requests`, `game_completions` | RLS on, **zero** user policies — definer-only |
| `audit_log` | SELECT own |
| `storage.objects` (bucket `chat-attachments`) | owner-folder INSERT / SELECT / DELETE (§6) |
| view `leaderboard_ranked` | `grant select` to `anon`, `authenticated`, `service_role` |

History: initial policies (including an admin `using (true)` on each table)
were written in `20260920_00_core_tables.sql`; admin policies were dropped in
`20260920000003_nova_economy.sql`, `20260920000006_hardening.sql` and
`20260924000001_phase2a_p0_rls_hardening.sql`, which also removed the client
INSERT policies on `chat_messages` and `chat_requests` and narrowed
`game_sessions` / `game_progress` / `user_achievements` from `for all` to
read-only. Thread policies are in `20260930000001_chat_conversations.sql`.

Anonymous callers satisfy no own-row predicate (`auth.uid()` is `NULL`), so
they see only the three public catalogs.

## 4. RPCs

All are `language plpgsql security definer set search_path = public`, take
identity from `auth.uid()` only, raise `'Authentication required'` when it is
`NULL`, and are `revoke all … from public` + `grant execute … to
authenticated`. `touch_user_streak()` is additionally revoked from `anon` and
`authenticated` (internal only).

### Chat

| RPC | Signature | Guarantees |
|---|---|---|
| `reserve_chat_credit` | `(p_idempotency_key uuid, p_conversation_id uuid default null, p_mode text default null)` → `(request_id, ai_credits, earned_coins, state)` | locks the wallet `FOR UPDATE`, requires `ai_credits >= 1`, debits exactly 1, validates thread ownership and mode ∈ `chat/vision/image/speech`; an existing non-`released` row is returned as-is, a `released` row is re-reserved, stale `reserved` rows older than 5 min are converted and refunded, already-released rows are deleted without a second refund |
| `finalize_chat_credit` | `(p_request_id uuid, p_user_content text, p_assistant_content text, p_mode text default null, p_media_path text default null, p_media_kind text default null)` → `void` | idempotent (`state = 'completed'` returns immediately); writes the user and assistant rows, the `AI_USAGE / -1 / AI_CREDIT` ledger entry, the thread bookkeeping, then marks completed; validates `media_kind` ∈ the three allowed values; calls `touch_user_streak()` and awards `first_ai_chat` |
| `release_chat_credit` | `(p_request_id uuid)` → `void` | idempotent; refunds `+1` only when the request is neither `completed` nor `released`, then marks `released` — a double release cannot mint a credit |
| `get_chat_history` | `(p_limit integer default 50, p_conversation_id uuid default null)` → `(id, role, content, created_at, mode, media_path, media_kind)` | own messages only; `NULL` conversation returns the account's last `p_limit` rows (legacy path kept for unthreaded requests); rejects a conversation the caller does not own; takes the newest `p_limit` rows ordered `created_at desc, role ('user' first), id` — the role tie-break exists because `finalize_chat_credit` writes both rows with the same `now()` — then returns them ascending |
| `get_chat_request_state` | `(p_idempotency_key uuid)` → `(request_id, state, assistant_reply, media_path, media_kind)` | replay lookup scoped to the caller; matches this request's first assistant message at or after the request's start time |
| `create_chat_conversation` | `(p_title text default null)` → `(conversation_id, title)` | normalises the title (trim, collapsed whitespace, ≤ 60 chars, default `'New conversation'`) |
| `rename_chat_conversation` | `(p_conversation_id uuid, p_title text)` → `(conversation_id, title)` | ownership check + same normalisation |
| `delete_chat_conversation` | `(p_conversation_id uuid)` → `void` | ownership check; messages cascade |
| `get_chat_conversations` | `(p_limit integer default 50)` → `(conversation_id, title, created_at, updated_at, last_message_at, message_count)` | ordered by `coalesce(last_message_at, updated_at, created_at) desc` |
| `update_own_display_name` | `(p_display_name text)` → `text` | updates **only** `display_name` for `auth.uid()`; `btrim`, required, ≤ 50 chars; revoked from `anon` as well |

### Economy

| RPC | Signature | Guarantees |
|---|---|---|
| `exchange_nova_coins` | `(p_coin_amount integer, p_idempotency_key uuid)` → `(nova_coins, ai_credits)` | rejects any amount other than 10 (`'Exchange amount must be exactly 10 NOVA Coins'`); wallet row locked `FOR UPDATE`; idempotent via `exchange_requests (user_id, idempotency_key) UNIQUE`; writes paired `COIN_EXCHANGE` ledger rows (`-10 NOVA_COIN`, `+1 AI_CREDIT`, `reference_id` = idempotency key); awards `first_coin_exchange`; calls `touch_user_streak()` |

`spend_nova_chat_credit(uuid)` was created in
`20260920000003_nova_economy.sql` and **dropped** in
`20260920000006_hardening.sql` — the reservation flow replaced it.

### Game completion

| RPC | Signature | Guarantees |
|---|---|---|
| `complete_tictactoe_game` | `(p_session_id uuid, p_outcome text, p_idempotency_key uuid)` → `(earned_coins, ai_credits, awarded_coins, awarded_xp, profile_xp, profile_level, games_played, games_won)` | `p_outcome` must be `win`, `loss` or `draw` |
| `complete_sudoku_game` | `(p_session_id uuid, p_puzzle_id integer, p_idempotency_key uuid)` → same 8 columns | `p_puzzle_id` must be 0, 1 or 2 |
| `complete_ball_run_game` | `(p_session_id uuid, p_idempotency_key uuid)` → the 8 columns plus `score` | derives elapsed time from `started_at` → `now()`; 5 s minimum, 120 s window |
| `complete_water_sort_game` | `(p_session_id uuid, p_move_count integer, p_idempotency_key uuid)` → the 8 columns plus `score` | `p_move_count` must be 1–400 |

Shared guarantees, in one transaction per function body:

1. identity from `auth.uid()`; session must belong to the caller, carry the
   matching `game_id` and be `status = 'STARTED'` (else
   `'Invalid or unauthorized session'`);
2. idempotency — `game_completions (user_id, idempotency_key) UNIQUE`; a
   duplicate returns the current wallet/profile/progress with
   `awarded_coins = 0, awarded_xp = 0`;
3. session row locked `FOR UPDATE`; an existing `game_results` row raises
   `'Reward already claimed for this session'` (reinforced by the unique
   constraint on `game_results.session_id`);
4. reward constants are literals in the function body (10/25 Tic-Tac-Toe win,
   20/40 Sudoku, 15/30 Ball Run win, 15/35 Water Sort);
5. writes `game_results`, `wallet`, `wallet_transactions`, `game_progress`,
   `profiles.xp/level`, `user_achievements`, then `touch_user_streak()`.

### Internal

| Function | Notes |
|---|---|
| `handle_new_user()` | trigger on `auth.users` — inserts `profiles` (display name from metadata or the email prefix) and `wallet (0, 0)`; `20260920000007_backfill_profiles_wallet.sql` covers pre-existing users |
| `touch_user_streak()` | revoked from every role; called by both TTT/Sudoku completions, both new-game completions, `finalize_chat_credit` and `exchange_nova_coins` |
| `stamp_session_started_at()` | `BEFORE INSERT` trigger on `game_sessions` |

## 5. Views

`leaderboard_ranked` (`20260925000001_phase12_leaderboard_v1.sql`):
`rank`, `display_name`, `xp`, `level`, `is_me`, filtered `where xp > 0`, from
`idx_profiles_xp_ranking`. It is deliberately **not** `security_invoker` (owner
`postgres`, RLS bypassed) and is `grant select` to `anon`, `authenticated` and
`service_role`, so display name, XP and level are world-readable. The client
reads it in `src/app/profile.tsx` with `LEADERBOARD_LIMIT = 50`.

## 6. Storage

`20260930000002_chat_attachments_storage.sql`:

- bucket **`chat-attachments`**, `public = false`,
  `file_size_limit = 5242880` (5 MB), `allowed_mime_types` = png / jpeg /
  webp / gif;
- three policies on `storage.objects` for `authenticated`, each requiring
  `(storage.foldername(name))[1] = auth.uid()::text` — INSERT, SELECT and
  DELETE are all restricted to the owner's own folder.

Uploads are written by `src/app/chat.tsx` at
`` `${session.user.id}/${crypto.randomUUID()}.${extension}` ``; reads use
3600 s signed URLs. The Edge Function re-validates paths and MIME types
(`supabase/functions/_shared/chat_modes.ts`).

## 7. Money and credit flow

```
games ──► earned_coins ──► exchange 10 ──► ai_credits ──► chat
              ▲                                │            │
              └─── wallet_transactions ◄───────┴────────────┘
```

**Reserve → finalize → release** (`supabase/migrations/20260920000002_chat_messages_and_credit_reservation.sql`,
state machine in `20260920000006_hardening.sql`, refund fix in
`20260924000002`, thread-aware version in `20260930000001`):

1. `reserve_chat_credit` locks `wallet FOR UPDATE`, requires
   `ai_credits >= 1`, decrements by 1 and inserts a `chat_requests` row in
   `reserved`. Insufficient balance raises before any write.
2. Gemini produces the reply.
3. `finalize_chat_credit` writes both messages, appends the
   `AI_USAGE / -1 / AI_CREDIT` ledger row and marks the request `completed`.
   Any failure path calls `release_chat_credit`, which refunds `+1` unless the
   request is already `completed` or `released`.
4. Stale `reserved` rows older than 5 minutes are refunded inside the next
   `reserve_chat_credit`.

**Earning.** Coins and XP are written only inside the four completion RPCs,
as literals. Ledger rows use `type = 'GAME_REWARD'`, `currency = 'NOVA_COIN'`,
`source` = a per-game literal (`TICTACTOE_WIN`, `SUDOKU_WIN`, `BALL_RUN_WIN`,
`WATER_SORT_WIN`) and `reference_id` = the session id; `earned_coins` and
`ai_credits` both carry non-negative CHECKs, so an impossible debit fails
loudly.

**Exchange.** `exchange_nova_coins` is fixed-rate: exactly 10 coins for 1
credit, enforced in SQL and hard-coded as `p_coin_amount: 10` in
`supabase/functions/exchange-nova-coins`. Two ledger rows are written
(`-10 NOVA_COIN`, `+1 AI_CREDIT`) against the idempotency key.

## 8. Migration history

29 files, chronological by filename. `README.md`'s "Migration Order" table
stops at row 19 and so omits the last ten files listed below; its claim of
four Edge Functions is also stale — `supabase/functions/` contains seven.

| # | File | Concern |
|---|---|---|
| 1 | `20260920000001_auth_trigger_profiles_wallet.sql` | identity — `handle_new_user` trigger |
| 2 | `20260920000002_chat_messages_and_credit_reservation.sql` | chat — tables + reserve/finalize/release |
| 3 | `20260920000003_nova_economy.sql` | economy — `currency`/`type`, `exchange_requests`, exchange RPC; drops admin RLS |
| 4 | `20260920000004_tictactoe_atomic_completion.sql` | game — `game_completions` + Tic-Tac-Toe RPC |
| 5 | `20260920000005_sudoku_atomic_completion.sql` | game — Sudoku completion RPC |
| 6 | `20260920000006_hardening.sql` | hardening — chat state machine, stale cleanup, drops `spend_nova_chat_credit`, drops admin RLS |
| 7 | `20260920000007_backfill_profiles_wallet.sql` | identity — backfill |
| 8 | `20260920000008_fix_tictactoe_earned_coins.sql` | game — Tic-Tac-Toe column fix |
| 9 | `20260920000009_fix_tictactoe_games_columns.sql` | game — Tic-Tac-Toe column fix |
| 10 | `20260920000010_fix_exchange_coins_ambiguity.sql` | economy — column ambiguity fix |
| 11 | `20260920000011_fix_reserve_chat_credit_ambiguity.sql` | chat — signature fix |
| 12 | `20260920000012_fix_reserve_chat_credit_set_syntax.sql` | chat — `SET` syntax fix |
| 13 | `20260920000013_fix_finalize_chat_credit_request_variable.sql` | chat — variable fix |
| 14 | `20260920000014_fix_get_chat_history_order.sql` | chat — return most recent N |
| 15 | `20260920_00_core_tables.sql` | schema — 11 core tables, catalogs, indexes, initial RLS |
| 16 | `20260924000001_phase2a_p0_rls_hardening.sql` | RLS — client write policies removed, CHECKs added |
| 17 | `20260924000002_phase2c_reserve_chat_credit_refund_fix.sql` | chat — double-refund fix |
| 18 | `20260924000003_phase2c_sudoku_ambiguous_columns.sql` | game — Sudoku column fix |
| 19 | `20260924000004_phase6_update_own_display_name.sql` | identity — display-name RPC |
| 20 | `20260924000005_phase9_achievements_v1.sql` | progression — achievements + 5 catalog rows |
| 21 | `20260924000006_phase10_streak_v1.sql` | progression — `touch_user_streak`, `profiles.last_activity_date` |
| 22 | `20260924000007_phase11_streak_achievements_v1.sql` | progression — `streak_3/7/14` |
| 23 | `20260925000001_phase12_leaderboard_v1.sql` | progression — `leaderboard_ranked` view |
| 24 | `20260930000001_chat_conversations.sql` | chat — threads, message/request columns, thread RPCs |
| 25 | `20260930000002_chat_attachments_storage.sql` | storage — `chat-attachments` bucket + policies |
| 26 | `20260930000003_games_ballrun_watersort.sql` | game — Ball Run / Water Sort RPCs, 2 achievements |
| 27 | `20260930000004_game_sessions_server_stamped_started_at.sql` | game — `started_at` trigger |
| 28 | `20260930000005_fix_get_chat_history_ambiguity.sql` | chat — qualified-table alias fix (SQLSTATE 42702) |
| 29 | `20261001000001_chat_replay_scope_media.sql` | chat — replay scope + media columns |

## 9. Known limitations

1. **Apply-order assumption.** Two migrations that sort before
   `20260920_00_core_tables.sql` depend on tables it creates (§1); a fresh
   database provisioned strictly by filename order will not build without
   applying the core file first.
2. **`README.md` is out of date** on migrations (table ends at #19 of 29) and
   Edge Function count ("4" vs the seven present).
3. **`audit_log` has no writer.** No function in the repository inserts rows.
4. **Legacy `leaderboard` table is unused.** The app reads only the
   `leaderboard_ranked` view.
5. **`get_chat_history` still serves unthreaded reads.** Passing a `NULL`
   conversation id returns the whole account's last N messages; kept for
   backward compatibility and used by `nova-chat` for unthreaded requests.
6. **No migration guards for concurrent deploys.** Files use `create table if
   not exists`, `drop constraint if exists` and `create or replace`, so a
   partially applied run resumes rather than failing — but there is no
   version table or CI check that all 29 have run.
