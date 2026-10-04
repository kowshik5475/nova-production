# NOVA AI Play — Upgrade Audit

Phase A deliverable. Written **before** any destructive change, from a full read of
the repository (React sources, Supabase migrations, Edge Functions, RPCs, RLS
policies, tests, styles, docs, package manifest).

Target direction: **NOVA — General-Purpose AI Assistant + Optional Interactive
Game Ecosystem.** AI first, games optional, progression supports the experience,
economy never dominates the UI.

---

## 1. Current architecture

```
Browser (React 19 + TypeScript + Vite)
  │  anon key + user JWT only
  ├── supabase-js  → PostgREST (RLS-filtered reads), Auth, Storage, RPCs
  └── fetch/invoke → Supabase Edge Functions (Deno)
                        │  GEMINI_API_KEY (server secret)
                        └── SECURITY DEFINER RPCs → PostgreSQL (authoritative)
```

* Single-page React app, no router library; page state lives in `src/app/App.tsx`.
* Plain CSS (`src/index.css` + `src/styles/theme.css`), no UI framework.
* Dependencies: `@supabase/supabase-js`, `react`, `react-dom`, `react-markdown`
  (dev: vite, typescript, oxlint, `@vitejs/plugin-react`).
* Lint = `oxlint`, build = `tsc -b && vite build`. No JS test runner in
  `package.json`; tests live in `supabase/tests/*.test.ts` and run with
  `node --experimental-strip-types`.
* Two visually separate worlds: dark NOVA shell (`--nova-*`) and light,
  scoped game environments (`--tt-*`, `--sudoku-*`) bound through
  `.game-environment` aliases.

### Frontend files (as audited)

| File | Role |
|---|---|
| `src/app/App.tsx` | Auth gates, sidebar nav, page switch, toasts, post-game hand-off |
| `src/app/auth.tsx` | Sign in / sign up / forgot password / set new password |
| `src/app/onboarding.tsx` | First-run display name capture |
| `src/app/home.tsx` + `home-data.ts` | Dashboard: level/XP/streak/wallet, activity, achievements |
| `src/app/chat.tsx` | Single flat chat: history, streaming, retry, post-game prompt |
| `src/app/tictactoe.tsx` | Tic-Tac-Toe client |
| `src/app/sudoku.tsx` | Sudoku client (3 hard-coded puzzles) |
| `src/app/wallet-view.tsx` | Balances, exchange, transaction history |
| `src/app/profile.tsx` | Profile, game stats, achievements, leaderboard, delete account |
| `src/app/MarkdownText.tsx` | Minimal react-markdown wrapper (no code copy, no tables) |
| `src/app/types.ts`, `utils.ts`, `hooks/useToasts.ts` | Shared types/helpers |
| `src/lib/supabase.ts` | `useSupabaseSession` (auth + recovery detection) |
| `src/lib/supabase/{client,useProfile,wallet}.ts` | Client, profile hook, wallet hook |

### Database (24 migrations, applied in filename order)

* `20260920_00_core_tables.sql` — profiles, wallet, wallet_transactions, games,
  game_sessions, game_results, game_progress, achievements, user_achievements,
  leaderboard, audit_log + indexes.
* `20260920000001..14` — auth trigger, chat + credit reservation, economy,
  atomic game completion RPCs, hardening, backfill, ambiguity fixes.
* `20260924000001..7` — P0 RLS hardening, reserve refund fix, display name RPC,
  achievements v1, streak v1, streak achievements v1.
* `20260925000001` — `leaderboard_ranked` read-only view.

### Edge Functions (5)

`process-tictactoe`, `process-sudoku`, `nova-chat`, `exchange-nova-coins`,
`delete-account`, plus `_shared/{cors,recent_activity,tictactoe_validate}.ts`.

### RPCs (live)

`handle_new_user` (trigger), `exchange_nova_coins`, `reserve_chat_credit`,
`finalize_chat_credit`, `release_chat_credit`, `get_chat_history`,
`get_chat_request_state`, `complete_tictactoe_game`, `complete_sudoku_game`,
`update_own_display_name`, `touch_user_streak` (internal only).
View: `leaderboard_ranked`.

### Tests (16 files)

`phase2a_attack_verification.sql`, `phase2b_*`, `phase2c_reliability`,
`phase4_wallet_history_rls`, `phase5_password_reset`, `phase6_display_name`,
`phase7_*`, `phase8_onboarding`, `phase9_achievements`, `phase10_streak`,
`phase11_streak_achievements`, `phase12_leaderboard`,
`phase13_reward_chat_reentry`, `phase14_dynamic_home`.

---

## 2. Existing capabilities

* Email/password auth with session restore, recovery-link detection, forced
  password reset before app usage, anti-enumeration password-reset responses.
* Onboarding gate driven by empty `display_name`.
* Server-authoritative wallet (`wallet` + `wallet_transactions` ledger).
* Atomic coin → credit exchange with idempotency (`exchange_requests`).
* AI credit reservation state machine:
  `reserve_chat_credit` → provider call → `finalize_chat_credit` /
  `release_chat_credit`, with stale-reservation cleanup and retry replay via
  `get_chat_request_state`.
* Atomic, idempotent game completion RPCs (Tic-Tac-Toe, Sudoku) that write
  results, wallet, game_progress, profile XP/level, achievements and streak in
  one transaction.
* Server-derived Tic-Tac-Toe outcome (board validation in the Edge Function).
* Server-side Sudoku solution validation against known puzzles.
* Server-authoritative daily streak (`touch_user_streak`, UTC calendar date).
* Achievement catalog + `user_achievements` awarded only inside definer RPCs.
* Read-only global XP leaderboard view (`leaderboard_ranked`) with `is_me`.
* Post-game → chat re-entry: client passes only a session UUID; the Edge
  Function re-derives outcome/reward/progression under RLS.
* Password reset, account deletion (typed `DELETE` confirmation, service-role
  Edge Function), display-name update RPC.
* Demo mode when Supabase env is absent.
* Responsive breakpoints (680 / 1023) and a documented 60/30/10 colour system.

## 3. Existing security guarantees

Verified by reading policies and RPC bodies (and covered by existing tests):

* `profiles`, `wallet`, `wallet_transactions`, `game_results`, `game_progress`,
  `user_achievements`, `audit_log`, `chat_messages`, `chat_requests`:
  **SELECT own only** — no client INSERT/UPDATE/DELETE policies.
* `game_sessions`: client **INSERT own + SELECT own** only; status transitions
  happen only inside SECURITY DEFINER RPCs.
* All `using(true)` “admin” policies dropped (m03 + m06).
* Defensive CHECK constraints: non-negative wallet balances, non-negative
  progress counters, `xp >= 0`, `level >= 1`, one `game_results` per session.
* Every RPC: `SECURITY DEFINER`, `SET search_path = public`,
  `revoke all … from public`, `grant execute … to authenticated`, identity from
  `auth.uid()` only (no target-user parameter anywhere).
* Gemini key only in `x-goog-api-key` inside the Edge Function; never logged,
  never returned, never in the bundle.
* CORS allowlist with local-dev origins + `CORS_ALLOWED_ORIGINS`.
* Structured logs that never contain prompt content or secrets.
* Idempotency keys for chat, exchange, and every game completion
  (session id is the game idempotency key).

## 4. Existing database model (condensed)

```
auth.users ──< profiles(id PK, display_name, level, xp, streak, last_activity_date)
            ──< wallet(user_id PK, earned_coins, ai_credits)
            ──< wallet_transactions(user_id, type, currency, amount, source, reference_id)
            ──< chat_messages(user_id, role, content, created_at)      ← FLAT, no threads
            ──< chat_requests(user_id, idempotency_key, state, …)
            ──< exchange_requests / game_completions (idempotency ledgers)
            ──< game_sessions(user_id, game_id, status, session_data, started_at)
            ──< game_results(session_id unique, user_id, game_id, outcome, score, …)
            ──< game_progress(user_id, game_id, games_played, games_won, …)
            ──< user_achievements(user_id, achievement_id)
games(id PK catalog) · achievements(id PK catalog) · leaderboard_ranked(view)
```

`games` already registers **four** games: `sudoku`, `tictactoe`, `ball-run`,
`water-sort` — but only the first two exist anywhere in the product.

## 5. Existing AI flow

```
chat.tsx → POST /functions/v1/nova-chat { message, idempotencyKey, gameSessionId? }
  → auth.getUser
  → get_chat_request_state (replay completed reply)
  → load profile/game_progress/wallet (player context)
  → reserve_chat_credit
  → optional one-time gameSessionId → buildRecentActivity (server re-derived)
  → get_chat_history (last 10, whole account)
  → Gemini streamGenerateContent (SSE)
  → finalize_chat_credit (persist 2 messages + ledger + streak + achievement)
  → done{wallet}   |   any failure → release_chat_credit
```

Single model env var: `GEMINI_MODEL` (default `gemini-3.6-flash`).
Single mode: text. No threads, no attachments, no export, no modes.

## 6. Existing game flow

```
client → Edge(action:'start') → INSERT game_sessions(STARTED)
      → play locally
      → Edge(action:'complete', payload) → validate → complete_*_game RPC
      → result + rewards + progress + achievements + streak, one transaction
```

Tic-Tac-Toe: board validated, outcome derived server-side.
Sudoku: board validated against the known solution server-side.

## 7. Existing economy flow

`reserve → finalize/release` for AI credits; `exchange_nova_coins(10, key)` for
coins → credits; `GAME_REWARD` rows written by completion RPCs. All authoritative,
all idempotent, all ledgered.

## 8. Existing progression flow

`profiles.xp/level/streak` + `game_progress` written only by definer RPCs.
Leaderboard derived from `profiles.xp` in a read-only view. Achievements awarded
only inside definer RPCs / `touch_user_streak`.

## 9. Missing capabilities (gap analysis)

| # | Gap | Target phase |
|---|---|---|
| 1 | Home is game-first (“YOUR PERSONAL PLAY SPACE”, two game cards, “Play/Earn/Exchange/Chat” flow) | B |
| 2 | Nav is `home · play · sudoku · chat · wallet · profile` — games are top-level modes | B |
| 3 | Chat is one flat per-account history; no conversation model, no sidebar, no rename/delete | C, D |
| 4 | No conversation survives as a unit; `get_chat_history` returns the last N across the account | C, D |
| 5 | Player context is injected into **every** request as a leading user turn (context contamination) | E |
| 6 | No vision / image / voice modes; no attachment model; no storage usage anywhere in the app | F, G, H |
| 7 | Markdown renderer lacks headings, tables, links, language label, copy button | Q |
| 8 | No conversation export | Q |
| 9 | `ball-run` and `water-sort` are catalog rows only — no UI, no completion, no validation | I, J, K |
| 10 | No Games Hub grouping | I |
| 11 | No Progression page (level/XP/streak/achievements/leaderboard are split across Home + Profile) | N |
| 12 | Personalization is a hard-coded `getInsight()` string in Profile; NOVA has no rule-based personalization | M |
| 13 | Leaderboard sits inside Profile and reads like a core feature | N |
| 14 | Wallet copy does not separate “NOVA Coins (progression)” from “AI Credits (consumption)” clearly | O |
| 15 | Profile does not show email or game activity beyond TTT/Sudoku | P |
| 16 | No `ARCHITECTURE.md` / `DATABASE.md` / `AI_SYSTEM.md` / `SECURITY.md` / `GAME_SYSTEM.md` / `TESTING.md` | S |

## 10. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Chat thread migration rewrites message ownership | Loss of history if wrong | Additive migration: new table + nullable `conversation_id` + one-time backfill; nothing is deleted |
| `finalize_chat_credit` signature change | Old signature lingers → PostgREST ambiguity | Explicit `drop function` before `create or replace` (pattern already used in m06/m07) |
| Client-supplied conversation id on chat | Cross-user history leak | Conversation id stored at **reserve** time, ownership re-checked in SQL; messages written only by definer RPC |
| Multimodal requests weaken the credit state machine | Double spend / lost credits | Reuse the exact reserve→finalize/release chain; mode + conversation recorded on the request row |
| Large base64 in PostgreSQL | Bloat, cost | Storage bucket + metadata row; only a path is stored |
| New games become “trust the client” | Forged rewards | Same session architecture; server-derived, capped, idempotent completion |
| Model names hardcoded | Broken provider calls | `GEMINI_TEXT_MODEL` / `GEMINI_VISION_MODEL` / `GEMINI_IMAGE_MODEL` / `GEMINI_TTS_MODEL` env vars with safe fallbacks |
| This environment has **no Supabase CLI access token** | New migrations cannot be pushed from here | Migrations authored as reviewed SQL; runtime DB tests **self-skip with an explicit message** when the tables are absent, and static/unit coverage runs regardless |
| Scope creep | Unmaintainable student project | No new runtime dependencies; no router/Redux/queues; React + TS + CSS + Supabase only |

## 11. Migration plan

All new schema work is **additive** and lands in new files (historical
migrations are never rewritten):

1. `20260930000001_chat_conversations.sql`
   * `chat_conversations(id, user_id, title, created_at, updated_at, last_message_at)`
   * `chat_messages.conversation_id` (nullable) + `mode` + index
   * one-time backfill: one conversation per user that already has messages,
     messages assigned in `created_at` order, timestamps/content untouched
   * RLS: owner-only SELECT/INSERT/UPDATE/DELETE on conversations;
     `chat_messages` keeps **SELECT own only** (still server-written)
   * RPCs: `create_chat_conversation`, `rename_chat_conversation`,
     `delete_chat_conversation`, `get_conversation_messages`,
     `get_chat_conversations` — all `auth.uid()`-scoped, definer, revoked from
     `public`
   * `reserve_chat_credit(key, conversation_id)` stores the conversation on the
     request; `finalize_chat_credit` writes messages into it
   * `get_chat_history` retained unchanged for backward compatibility
2. `20260930000002_chat_attachments_and_modes.sql`
   * `chat_attachments` metadata table + `chat_requests.mode`
   * private Storage bucket `chat-attachments` + owner-scoped storage policies
3. `20260930000003_games_hub_ballrun_watersort.sql`
   * `complete_ball_run_game`, `complete_water_sort_game` (server-derived,
     capped, idempotent, streak + achievements inside the same transaction)
   * achievement catalog rows for the two new games
4. `20260930000004_personalization_signals.sql`
   * read-only helper view for the rule-based personalization block
     (no new client write path)

Then Edge Functions (`nova-chat` multimodal + threads, `process-ball-run`,
`process-water-sort`), then frontend.

## 12. Files expected to change

**New**

```
supabase/migrations/2026093000000{1..4}_*.sql
supabase/functions/process-ball-run/index.ts
supabase/functions/process-water-sort/index.ts
supabase/functions/_shared/{ballrun_validate,watersort_validate,chat_modes,game_catalog}.ts
src/app/{games,progression,ballrun,watersort,conversation-list,export}.tsx|ts
src/lib/supabase/conversations.ts
supabase/tests/upgrade_*.test.ts
ARCHITECTURE.md DATABASE.md AI_SYSTEM.md SECURITY.md GAME_SYSTEM.md TESTING.md
FINAL_UPGRADE_REPORT.md
```

**Modified**

```
src/app/App.tsx        navigation + page routing + game hub state
src/app/home.tsx       AI-first home
src/app/home-data.ts   personalization/activity mappers
src/app/chat.tsx       threads, sidebar, modes, attachments, export
src/app/MarkdownText.tsx  full markdown + code copy
src/app/types.ts       Page/Conversation/ChatMessage types
src/app/profile.tsx    account-focused profile
src/app/wallet-view.tsx   coin vs credit explanation
src/app/tictactoe.tsx / sudoku.tsx   hub back-link, shared completion contract
src/lib/supabase/wallet.ts  (unchanged behaviour, minor typing)
src/index.css, src/styles/theme.css  shell, sidebar, hub, new game environments
supabase/functions/nova-chat/index.ts
supabase/functions/_shared/recent_activity.ts
README.md / TESTING_CHECKLIST.md as needed
```

**Explicitly preserved (do not touch behaviour)**: auth flow, RLS hardening
migrations, achievements, streak, leaderboard view, wallet ledger, credit
reservation state machine, account deletion, password reset, onboarding.
