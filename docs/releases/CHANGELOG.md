# CHANGELOG

All notable changes to NOVA AI Play will be documented in this file.

## [1.0.0] — RELEASE CANDIDATE

### Added

- **AI chat system** — Threaded conversations with four reply modes: Chat, See, Draw, Speak; Gemini streaming; credit reservation/refund; attachments in private `chat-attachments` bucket
- **Games Hub** — Four games: Tic-Tac-Toe (10 coins + 25 XP), Sudoku (20 + 40), Ball Run (15 + 30, 60s survive), Water Sort (15 + 35)
- **NOVA Coins economy** — Earned in games; 10:1 exchange rate to AI Credits; read-only transaction ledger
- **Progression system** — XP, levels, achievements (5 catalog rows), streaks (server-authoritative via `touch_user_streak()` RPC)
- **Wallet** — Balance display, 10:1 coin-to-credit exchange, transaction ledger with timestamp and impact
- **Profile** — Display name, level, XP bar, streak, per-game stats, achievements, leaderboard, account deletion (type `DELETE` to confirm)
- **Post-game chat hand-off** — Session reference carried in memory for exactly one message, never persisted
- **Demo mode** — Fully functional in-browser experience with no Supabase connection; session-local balances (20 coins, 0 credits); "DEMO" badge in top bar
- **Supabase migrations** — 31 SQL migrations applied in filename order; core schema, RLS hardening (phases 2a/2c), chat conversations, attachments, game sessions with server-stamped `started_at`
- **Edge Functions** — 7 functions: process-tictactoe, process-sudoku, process-ball-run, process-water-sort, nova-chat, exchange-nova-coins, delete-account
- **Row-Level Security** — All tables have RLS policies; owner-select patterns; catalog tables (games, achievements) public-SELECT
- **RPC security** — All `SECURITY DEFINER` with `search_path = public`; `revoke all from public` + `grant execute to authenticated`; `update_own_display_name` additionally `revoke from anon`
- **Idempotency** — `game_completions`, `exchange_requests`, `chat_requests` use UNIQUE constraints on `(user_id, idempotency_key)`; duplicate requests return original result without re-awarding
- **Credit reservation/refund** — Two-phase commit: `reserve_chat_credit` → Gemini call → `finalize_chat_credit`; idempotent; stale reservations (>5 min) auto-cleaned
- **Storage isolation** — `chat-attachments` bucket private; owner-folder path validation (`(storage.foldername(name))[1] = auth.uid()::text`); Edge Function `isOwnerPath()` / `checkImageAttachment()` validation; MIME allow-list (png/jpeg/webp/gif); 5 MB size limit
- **Architecture documentation** — ARCHITECTURE.md, DATABASE.md, AI_SYSTEM.md, SECURITY.md, GAME_SYSTEM.md
- **Testing suite** — 322 automated tests across 20 test files; 17 phase test suites; static, runtime, and attack verification tests

### Improved

- **Code splitting** — 5 JS chunks with manual chunks for each game (tictactoe, sudoku, ballrun, watersort); initial JS 133.29 kB gzip; total ~210 kB gzip
- **RLS hardening** — Phases 2a/2c hardened all public tables; defensive CHECK constraints on wallet/coin/Progress columns; `touch_user_streak()` revoked from public/anon/authenticated
- **Economy integrity** — CHECK constraints: `wallet.earned_coins >= 0`, `wallet.ai_credits >= 0`; `game_progress.games_played/games_won/total_xp >= 0`; `profiles.xp >= 0`, `profiles.level >= 1`; `game_results` unique on `session_id`; `wallet_transactions.type` allow-list
- **Attack verification** — Phase 2a `phase2a_attack_verification.sql` — 18 scenarios against cross-user wallet/profile reads/writes, client INSERT/UPDATE denials, session status and deletion, idempotency, negative/fractional exchange amounts, anonymous probes
- **Performance baseline** — Phase 21: 320/320 tests passing; TypeScript 0 errors; ESLint 0 errors (tolerated warnings); production build PASS

### Security

- **Server-side awards only** — All coin/XP awards happen inside PostgreSQL `SECURITY DEFINER` RPCs; client performs zero `.insert()`, `.update()`, or `.delete()` on `wallet`, `wallet_transactions`, `game_results`, or `game_progress`
- **JWT identity** — Edge functions extract `auth.uid()` from JWT; every database query scoped to authenticated user
- **Atomic transactions** — Reward RPCs use single `BEGIN/COMMIT` block; any failure rolls entire transaction back
- **API key isolation** — Gemini API key stored as Supabase secret; never exposed to browser (Vite only inlines `VITE_*` variables)
- **Attachment path validation** — No `..`, no absolute path, no empty segment, no prefix trick (`<uid>x/...`), MIME allow-list, size ≤ 5 MB; generated media targets owner folder via `mediaObjectPath(ownerId, ext)`
- **CORS** — Allow-list from `CORS_ALLOWED_ORIGINS` secret plus local-dev origins; `Access-Control-Allow-Origin` echoed only when `Origin` header is on allow-list; otherwise 403 on preflight

### Documentation

- **Phase reports** — 17 phase reports (Phase 16-21) organized into `docs/phase-reports/`
- **Documentation structure** — `docs/` directory with subfolders: `phase-reports/`, `architecture/`, `security/`, `project/`, `releases/`, `development/`, `demo/`
- **Release notes** — `docs/releases/v1.0.0.md`
- **Changelog** — `docs/releases/CHANGELOG.md`
- **Demo guide** — `docs/demo/DEMO_GUIDE.md`
- **README** — Updated with `"AI-First General-Purpose Assistant + Optional Interactive Game Ecosystem"` header; performance figures; limitations section

### Known limitations (v1.0.0)

- PWA formally deferred per security review
- Screen-reader testing unavailable during audit
- Direct RPC call risk (outcome/puzzle/timing trusted at RPC level, not DB)
- No application-layer rate limiting
- `leaderboard_ranked` publishes display names (deliberate product choice)
- `audit_log` has no writer
- Account deletion does not remove Storage objects
- Legacy whole-account history path remains
- No automated secret scanning or CI gate

### Known limitations (carried forward)

- **Ball Run largest game chunk** at 59.88 kB gzip
- **5 JS chunks** total (code splitting preserves overall size but individual chunks vary)