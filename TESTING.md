# NOVA AI Play — Testing

How to run the automated suite, what each file covers, and how the static
checks relate to the runtime checks. Manual UI cases live in
`TESTING_CHECKLIST.md`.

---

## 1. What exists

| Kind | Location | Runner | Needs a live project? |
|------|----------|--------|-----------------------|
| Static assertions | inside most `supabase/tests/*.test.ts` (`test('static. …')`) | `node --experimental-strip-types` | no — `readFileSync` over migrations, Edge Functions and `src/` |
| Pure unit tests | `supabase/tests/phase2b_ttt_validate.test.ts`, `supabase/tests/phase5_password_reset.test.ts` | same | no — no `fetch` in either file |
| Runtime security / lifecycle tests | the other 15 `*.test.ts` files | same | **yes** — anon REST, RPCs and Edge Functions on the linked project |
| Attack script | `supabase/tests/phase2a_attack_verification.sql` | `supabase db query --linked -f …` | yes — prints PASS/FAIL per scenario |
| Manual UI cases | `TESTING_CHECKLIST.md` | human | yes |
| Lint / build | `npm run lint`, `npm run build` | oxlint / `tsc -b && vite build` | no |

17 test files, 322 `test(...)` cases in total. There is **no** `npm test`
script — each file is run directly (see §3).

## 2. Prerequisites

1. **Node with type stripping** — every file is invoked as
   `node --experimental-strip-types supabase/tests/<file>.test.ts` (Node 22.6+;
   files use `import.meta.dirname` and `.ts` imports).
2. **`.env` at the repo root** with the two names every suite regex-parses:

   ```
   VITE_SUPABASE_URL=https://<project>.supabase.co
   VITE_SUPABASE_ANON_KEY=<anon key>
   ```

   Missing values make the runtime suites fail in `before()` before any test
   runs. This matches `.env.example`.
3. **A linked Supabase project** — suites that read/write SQL shells out to
   the CLI (`supabase db query --linked -f <tmp>`), so `supabase link` must
   have been run and the project must already contain the current migrations
   (RLS, RPCs, seeds). On this repo the CLI is invoked through `npx`.
4. **Deployed Edge Functions** for suites that call them:
   `nova-chat`, `process-tictactoe`, `process-sudoku`, `process-ball-run`,
   `process-water-sort`, `exchange-nova-coins`, `delete-account`.
5. **Prerequisite SQL** (applied once, manually):
   `supabase db query --linked -f supabase/tests/phase7_setup_temp_user.sql`
   before running `phase7_account_deletion.test.ts`. That file seeds the
   disposable `phase7del@example.test` user; the test signs in with it but
   never creates it (avoids Supabase's email-signup rate limit). It deletes the
   row again on every run.

## 3. Running the suite

From the repo root:

```bash
node --experimental-strip-types supabase/tests/phase2b_runtime.test.ts
```

Each file's own header line repeats the exact command:

```
// Run: node --experimental-strip-types supabase/tests/<file>.test.ts
```

Run them all:

```bash
for f in supabase/tests/*.test.ts; do node --experimental-strip-types "$f"; done
```

**Windows notes** (this project's development environment):

- Use `npm.cmd run lint` / `npm.cmd run build` — plain `npm` is blocked by
  execution policy.
- `npx.ps1` may be blocked; the suites already work around this:
  `phase7_account_deletion.test.ts` calls `cmd /c npx --yes supabase db query
  --linked -f <tmp>`, the others call `npx.cmd supabase db query --linked -f
  <tmp>` directly (`execFileSync`).
- `upgrade_multimodal_storage.test.ts` M5 and `phase7_account_deletion.test.ts`
  E read `.env` as raw text, so Windows CRLF/encoding is irrelevant, but the
  two variable names must match exactly.

**Artifacts**: temporary SQL written for `supabase db query` lands in the OS
temp dir (`%TEMP%` / `process.env.TEMP`), named `phase10-…`, `upgconv-…`,
`upgsvc-…`, `upgmm-…`, `phase11/12/13/14-<pid>-<ts>-<seq>.sql` — all deleted in
`finally`. The exception is `phase7_account_deletion.test.ts`, which writes
`supabase/tests/.phase7-<pid>.sql`; delete any stray `.phase7-*.sql` in
`supabase/tests/` if a run is interrupted.

## 4. Test catalogue

`static` = source-regex assertions; `runtime` = live REST/RPC/Edge calls.
Prerequisites column flags anything beyond §2.

| File | Tests | Type | Covers | Prerequisite |
|------|------:|------|--------|--------------|
| `phase2b_ttt_validate.test.ts` | 16 | unit | `_shared/tictactoe_validate.ts` board rules (both-win, wrong counts, bad cells, turn parity) + `isOwnerPath` + `_shared/cors.ts` allow-list behaviour | none (Deno shimmed to `process.env`) |
| `phase5_password_reset.test.ts` | 16 | static | forgot-password UI reachability, non-enumerating responses, recovery flag in `sessionStorage` only, no password/token logging, no schema changes | none |
| `phase2b_runtime.test.ts` | 18 | runtime + static | live TTT Edge: valid wins, invalid boards, cross-user/unauthenticated rejection, idempotent + concurrent duplicate completion, CORS preflight accept/reject, provider key never in response/URL/logs | linked project, deployed `process-tictactoe` |
| `phase2c_reliability.test.ts` | 15 | runtime + static | duplicate/retry and concurrent award safety (TTT, Sudoku, exchange), reserve→release→reserve never double-refunds, release idempotency, zero-credit reserve fails cleanly, structured logs without history dumps, sticky client idempotency key | linked project, deployed game/exchange functions |
| `phase4_wallet_history_rls.test.ts` | 4 | runtime | own-only `wallet_transactions`, no cross-user read, anonymous denied, client INSERT blocked | linked project |
| `phase6_display_name.test.ts` | 17 | runtime + static | `validateDisplayName` rules, `update_own_display_name` narrows the write to `display_name`, cross-user/anonymous/XP/level/streak tampering blocked, no broad `profiles` UPDATE policy | linked project |
| `phase7_account_deletion.test.ts` | 12 | runtime + static | self-delete only (JWT identity), wrong confirmation / anonymous rejected, personal rows cascade while `games`/`achievements` survive, `audit_log` set null, old session invalidated, idempotent re-delete, no service-role in `src/` | §2 item 5 **and** `phase7_setup_temp_user.sql` |
| `phase8_onboarding.test.ts` | 24 | runtime + static | onboarding gate order and rules (null/empty/whitespace name), reuse of `update_own_display_name`, no client `profiles` UPDATE, anonymous RPC denial, refresh does not re-trigger, demo mode unaffected | linked project |
| `phase9_achievements.test.ts` | 27 | runtime + static | 5-row catalog seed idempotent, no callable award RPC, awards only inside the 4 authoritative RPCs with their guard conditions, cross-user/anonymous insert/update/delete blocked, exchange awards once | linked project |
| `phase10_streak.test.ts` | 30 | runtime + static | `touch_user_streak` identity from `auth.uid()`, UTC date + `FOR UPDATE`, not granted to `authenticated`/`anon`, called by all 4 RPCs after success only, same-day/next-day/missed-day/concurrency behaviour, failures do not count, streak survives refresh/re-login | linked project; temporarily overrides `profiles.last_activity_date` and restores it |
| `phase11_streak_achievements.test.ts` | 28 | runtime + static | `streak_3/7/14` seed + CHECK compatibility, awards only inside `touch_user_streak`, no duplicate/replay/concurrency double-award, failed/abandoned activity awards nothing, no direct client write to `user_achievements`, Phase 9 still works | linked project; same date fixture as Phase 10 |
| `phase12_leaderboard.test.ts` | 38 | runtime + static | read-only `leaderboard_ranked` view: public fields only, never email/auth metadata/wallet/chat data, no INSERT/UPDATE/DELETE, ranking derived from `profiles.xp`, tie order, top-N, current-user rank, deleted/demo users excluded | linked project; creates and removes 5 disposable users and one seeded legacy row |
| `phase13_reward_chat_reentry.test.ts` | 24 | runtime + static | post-game context derivation (win/loss/draw/sudoku), RLS scoping of every input table, spoofed body fields change nothing, one-time in-memory carrier, context is identity/balance-free, re-entry never mints credits, `recent_activity` is pure and allow-listed | linked project, deployed `nova-chat`; provider may be absent (suite degrades to 4xx/5xx assertions) |
| `phase14_dynamic_home.test.ts` | 25 | runtime + static | Home reads only allow-listed tables, no local XP/streak/wallet/achievement math, no polling, no new client writes, abandoned sessions not shown as activity, empty states, cross-user isolation, Phase 13 hand-off still works | linked project |
| `upgrade_conversations.test.ts` | 12 | runtime + static | thread CRUD round-trip through the definer RPCs, 60-char title normalisation, cross-user list/rename/delete denied, no client DML on `chat_conversations`/`chat_messages`, reserve→finalize persists exactly one exchange once, foreign-conversation reserve rejected, mode allow-list, auto-title protection, legacy `get_chat_history(p_limit)` path | linked project, deployed `nova-chat` |
| `upgrade_games_security.test.ts` | 9 | runtime + static | Ball Run server-stamped `started_at`, 5 s/120 s window, forged claims rejected, cross-user completion blocked at Edge *and* RPC; Water Sort replay-only payout with a real BFS solution; TTT RPC refuses foreign sessions; forged results/rewards/balances blocked; anonymous blocked | linked project, deployed game functions |
| `upgrade_multimodal_storage.test.ts` | 7 | runtime + static | `normalizeMode` allow-list, owner-folder-only attachment paths, shared limits, `nova-chat` wires the gates and keeps models configurable, **no service/Gemini key in the bundle or `.env`**, private `chat-attachments` isolation in both directions, `finalize_chat_credit` media metadata | linked project, deployed `nova-chat`, two disposable users |
| `phase2a_attack_verification.sql` | 18 scenarios | SQL script | S1, S2, S3/S3b, S4a–S4h, S8/S8b, S9a–S9d attack probes against migration `20260924000001`: cross-user wallet/profile reads and writes, client INSERT/UPDATE denial on `game_results`, `game_progress`, `user_achievements`, `chat_requests`, `chat_messages`, session status and deletion, the permitted own-session INSERT, negative/fractional exchange amounts, and four anonymous probes — each row logs `PASS`/`FAIL` into `phase2a_log` | linked project; apply with `supabase db query --linked -f` |

Run the static-only files first — they take under a second and catch contract
drift before you spend time on the linked project.

## 5. Lint and build

```bash
npm.cmd run lint     # oxlint (exit 0; warnings are tolerated — set-state-in-effect, purity, exhaustive-deps)
npm.cmd run build    # tsc -b && vite build
```

`lint` exits 0 today with warnings only (`.oxlintrc.json` configures oxlint
1.81). `build` is the TypeScript gate — run both before handing work off.
Configuration: `dev` = `vite`, `preview` = `vite preview` (`package.json`).

## 6. Manual UI verification

`TESTING_CHECKLIST.md` covers the flows no suite exercises end-to-end in a
browser: authentication, wallet display, exchange toasts, Tic-Tac-Toe and
Sudoku play, chat credit gating and retry/dismiss, profile stats and NOVA
Insight, demo mode. Walk it after any UI change.

## 7. What the automated suite does not prove

- **No CI.** Nothing runs these files on push; they must be invoked manually
  (§3).
- **Fixtures mutate the linked project.** Phases 10/11 temporarily rewrite
  streak dates, Phase 12 creates disposable users and one legacy leaderboard
  row, Phase 7 needs its temp user seeded first. Suites snapshot and restore in
  `before()`/`after()`, so avoid running two of them concurrently against the
  same project.
- **Provider-dependent behaviour is tolerated, not asserted.** Phase 13 accepts
  a guarded 4xx/5xx from `nova-chat` when the Gemini key is unset; only the
  `start.recentActivity` block is asserted on a live 200.
- **The browser itself is not driven.** No Playwright/puppeteer — UI flows are
  checked manually (§6).
- **Known gaps stay documented.** What the RLS/RPC design deliberately does not
  protect (direct completion-RPC calls, no rate limiting, Storage orphans after
  deletion) is listed in `SECURITY.md` §13 rather than asserted by a test.
