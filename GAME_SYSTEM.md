# NOVA AI Play — Game System

The four games, what each one pays, and exactly which side of the trust
boundary each check sits on. Companion documents: `DATABASE.md` (schema and
RPCs), `SECURITY.md` (threat model), `AI_SYSTEM.md` (chat behaviour).

---

## 1. Trust boundary

The browser may read its own rows and start a session. Nothing else.

Completion RPCs — `complete_tictactoe_game`, `complete_sudoku_game`,
`complete_ball_run_game`, `complete_water_sort_game` — are
`grant execute … to authenticated`, so they are callable directly through
PostgREST without going through an Edge Function. What the Edge Function
re-checks and what the RPC accepts on trust:

| Game | Edge Function derives | RPC trusts if called directly |
|---|---|---|
| Tic-Tac-Toe | final board → outcome (`_shared/tictactoe_validate.ts`) | `p_outcome` (only checked ∈ `win`/`loss`/`draw`) |
| Sudoku | all 81 cells vs the known solution for the chosen puzzle | `p_puzzle_id` (only checked ∈ `0,1,2`) — awards a win |
| Ball Run | server clock from `started_at`, plus a ±3 s `claimMatchesServer` check on the client's claim | nothing timing-related beyond what it derives itself: the RPC recomputes elapsed from `started_at` → `now()` |
| Water Sort | full replay of the move list against the puzzle stored in `session_data` | `p_move_count` (only checked ∈ `1..400`) — awards a win |

`session_data.started_at` cannot be backdated: a `BEFORE INSERT` trigger
(`stamp_session_started_at`, `20260930000004`) overwrites any client value
with `now()`. Clients may insert their own `game_sessions` rows (RLS allows
own-row INSERT), but the row's start time is server-stamped.

Bounds that hold on **both** paths: identity from `auth.uid()`; the session
must belong to the caller, carry the matching `game_id` and be
`status = 'STARTED'`; one reward per session (`game_completions (user_id,
idempotency_key) UNIQUE` + an explicit `game_results` existence check + the
unique constraint on `game_results.session_id`); and the reward constants are
literals in the SQL, never parameters.

**Plain summary:** a scripted caller can complete their own sessions without
playing. The damage is bounded to one session, one payout, at fixed constants.

## 2. Game hub

`src/app/games.tsx` renders four cards from the `GAMES` array:

| # | Game | Genre | Reward copy on the card |
|---|---|---|---|
| 01 | Tic-Tac-Toe | STRATEGY | Win to earn 10 NOVA Coins + 25 XP |
| 02 | Sudoku | LOGIC | Solve to earn 20 NOVA Coins + 40 XP |
| 03 | Ball Run | REFLEX | Survive 60s to earn 15 NOVA Coins + 30 XP |
| 04 | Water Sort | PUZZLE | Solve to earn 15 NOVA Coins + 35 XP |

The card button reads `session ? 'Play now' : 'Sign in to play'`; `onSelect`
runs either way. The catalog rows behind these names are seeded in
`games` (`20260920_00_core_tables.sql`) with `category` and `difficulty`
values that the hub re-states as genre labels.

## 3. Shared session lifecycle

Every game follows the same two-call shape (`src/app/*.tsx`):

1. `supabase.functions.invoke('<process-…>', { action: 'start', … })` inserts
   a `game_sessions` row under the caller's JWT and returns `sessionId` plus
   server-generated inputs.
2. Play happens entirely in the browser; no economy table is written.
3. `invoke(..., { action: 'complete', sessionId, …claim })` → validation →
   RPC → one transaction.

The RPC body always writes, in order:

`game_completions` → lock `game_sessions FOR UPDATE` → `game_results` →
`game_sessions.status = 'COMPLETED'` → `game_progress` → `wallet` +
`wallet_transactions` (when coins are awarded) → `profiles.xp/level` →
`user_achievements` → `touch_user_streak()` (which updates
`profiles.streak` and `last_activity_date`).

Idempotency key = the session id, minted at `start` and passed as
`p_idempotency_key`, so a retried completion returns the original result with
`awarded_coins = 0, awarded_xp = 0`.

## 4. Tic-Tac-Toe

- **Player action.** 3×3 grid; the player is X against NOVA's AI opponent.
  The client keeps the board in state and calls `completeGame` on win, loss
  or draw (`src/app/tictactoe.tsx`).
- **Start.** `process-tictactoe` with `{ action: 'start' }` →
  `game_id = 'tictactoe'`.
- **Completion path.** `{ action: 'complete', sessionId, board }` →
  `_shared/tictactoe_validate.ts` `validateTttBoard()` derives the outcome
  from the board: it rejects bad cell values, wrong mark counts, two winners
  and non-terminal full-board states, and returns `win` (X wins), `loss`
  (O wins) or `draw`. The client's winner claim is never read.
- **Rewards.** Win → 10 coins + 25 XP. **Loss and draw → 0 coins and 0 XP**
  (`v_awarded_coins`/`v_awarded_xp` stay at their `0` defaults); no
  `wallet_transactions` row is written, but `games_played` still increments
  and `games_won` does not.
- **Rows written.** `game_completions`, `game_results` (outcome only — no
  `score`), `game_sessions`, `game_progress`, and on a win `wallet` +
  `wallet_transactions` (`GAME_REWARD`, `source = 'TICTACTOE_WIN'`),
  `profiles.xp/level`, `user_achievements`.
- **Achievements.** `first_game` and `first_ttt_win` are inserted **only when
  the outcome is `win`** (`20260924000006_phase10_streak_v1.sql`).
- **Streak.** `touch_user_streak()` runs on every completion, win or not.
- **Idempotency.** `complete_tictactoe_game(uuid, text, uuid)`; Edge passes
  the session id as the key.
- **Trust.** Edge derives the outcome; the RPC trusts `p_outcome`.

## 5. Sudoku

- **Player action.** Three curated puzzles; the client fills cells (with
  pencil marks) and submits the finished grid (`src/app/sudoku.tsx`).
- **Start.** `process-sudoku` with `{ action: 'start', puzzleId }` (or a
  random id when omitted) → session row. The puzzle id is not stored in
  `session_data`; the client echoes it back on `complete`.
- **Completion path.** `{ action: 'complete', sessionId, puzzleId, board }` →
  the Edge Function compares all 81 cells against the known solution for that
  puzzle (`PUZZLES` in `supabase/functions/process-sudoku/index.ts`) and
  rejects a wrong grid.
- **Rewards.** Always a win: 20 coins + 40 XP, `source = 'SUDOKU_WIN'`.
- **Rows written.** Same set as Tic-Tac-Toe, with `outcome = 'win'` written
  unconditionally and `game_progress` incremented with `games_won = 1`.
- **Achievements.** `first_game` and `first_sudoku`, unconditionally.
- **Streak.** Touched on every completion.
- **Idempotency.** `complete_sudoku_game(uuid, integer, uuid)`; `p_puzzle_id`
  must be 0, 1 or 2 or the RPC raises `'Invalid puzzle ID'`.
- **Trust.** Edge validates the board; the RPC only validates the puzzle id
  and then awards the win. The chosen puzzle is not bound to the session
  (`session_data` is empty for Sudoku), so the claim must still match one of
  the three known solutions.

## 6. Ball Run

- **Player action.** Lane-switching survival run; the goal is 60 s
  (`src/app/ballrun.tsx`). The client sends `survivedMs`.
- **Start.** `process-ball-run` inserts the session with
  `session_data = { seed }` and returns `{ sessionId, winMs: 60000, maxMs:
  120000 }`.
- **Completion path.** The Edge Function reads `started_at` and calls
  `evaluateRun(startedAtMs, Date.now())` (`_shared/ballrun_validate.ts`):
  `< 5000 ms` → rejected, `> 120000 ms` → rejected, otherwise
  `score = min(100, floor(elapsed/1000))` and
  `outcome = elapsed >= 60000 ? 'win' : 'loss'`. The client's `survivedMs` is
  only compared with `claimMatchesServer` (±3000 ms) and never used as the
  score.
- **Rewards.** Win → 15 coins + 30 XP (`source = 'BALL_RUN_WIN'`).
  Loss (5 s ≤ elapsed < 60 s) → **5 XP and 0 coins**; the wallet row is
  locked but not updated and no ledger row is written.
- **Rows written.** `game_completions`, `game_results`
  (`score`, `duration = elapsed_ms/1000`, `outcome`), `game_sessions`,
  `game_progress`, `profiles`, `user_achievements`; plus `wallet` and
  `wallet_transactions` on a win only.
- **Achievements.** `first_game` and `first_ball_run`, unconditionally — a
  loss still awards them.
- **Streak.** Touched on every completion.
- **Idempotency.** `complete_ball_run_game(uuid, uuid)`; the RPC itself
  recomputes `elapsed_ms` from `started_at` and enforces the same 5 s / 120 s
  window, raising `'Run too short to count'` / `'Session expired'`.
- **Trust.** The server clock is authoritative on both paths; the RPC needs
  no client timing input at all. It cannot tell an idle session from a played
  one (see `SECURITY.md` §13.3).

## 7. Water Sort

- **Player action.** Pour coloured water between tubes until each tube holds
  one colour (`src/app/watersort.tsx`).
- **Start.** `process-water-sort` generates the puzzle from a seed
  (`mulberry32` in `_shared/watersort_validate.ts`), proves it solvable
  within `SOLVE_NODE_BUDGET = 40_000` nodes, stores `tubes`, `colors` and
  `par` in `session_data`, and returns them to the client. The client never
  chooses the puzzle.
- **Completion path.** `{ action: 'complete', sessionId, moves }` → the Edge
  Function replays the submitted move list against the stored puzzle
  (`MAX_MOVES = 400`, tube capacity 4) and passes `replay.moves` — not the
  raw client number — to the RPC.
- **Rewards.** Always a win: 15 coins + 35 XP (`source = 'WATER_SORT_WIN'`).
- **Score.** `greatest(20, least(100, 100 - greatest(0, p_move_count - v_par)
  * 3))` where `v_par = coalesce(session_data.par, 30)`. Fewer moves than par
  scores 100; each move over par costs 3 points, floored at 20.
- **Rows written.** Same set as Sudoku, with `game_results.moves =
  p_move_count` and `outcome = 'win'`.
- **Achievements.** `first_game` and `first_water_sort`, unconditionally.
- **Streak.** Touched on every completion.
- **Idempotency.** `complete_water_sort_game(uuid, integer, uuid)`;
  `p_move_count` must be 1–400.
- **Trust.** Edge replays the moves; the RPC trusts `p_move_count` (bounded)
  and derives the score band from it — a direct call skips the replay.

## 8. Progression surfaces

### XP and level

`level = floor(xp / 100) + 1`, computed inside every completion RPC when
`profiles.xp` is updated (`level = floor((v_profile.xp + v_awarded_xp) / 100)
+ 1`). The UI shows the same formula as a bar: `xp % 100` percent filled and
`100 - (xp % 100)` XP to the next level (`src/app/progression.tsx`,
`src/app/profile.tsx`).

XP comes only from the four completion RPCs; chat messages award no XP. Per-game
`total_xp` accumulates in `game_progress`.

### Streaks

`touch_user_streak()` (`20260924000006_phase10_streak_v1.sql`) runs inside
every completion RPC, `finalize_chat_credit` and `exchange_nova_coins`:

- the day is `(timezone('utc', now()))::date` — no per-user timezone;
- the profile row is locked `FOR UPDATE`;
- gap ≥ 2 days → streak restarts at 1; previous day → `+1`; same day → no
  change;
- `profiles.last_activity_date` and `streak` are updated;
- it then awards every catalog achievement with `target_type = 'streak'` and
  `target_value <= streak`.

`20260924000007_phase11_streak_achievements_v1.sql` seeds `streak_3`,
`streak_7` and `streak_14`. `touch_user_streak()` is revoked from `public`,
`anon` and `authenticated` — it is callable only from other definer functions.

### Achievements

Catalog table `achievements`, earned rows in `user_achievements` with
composite PK `(user_id, achievement_id)` and `ON CONFLICT DO NOTHING`. Clients
have SELECT-own only; every insert happens inside a definer RPC.

| Achievement | Awarded by | Condition |
|---|---|---|
| `first_game` | TTT / Sudoku / Ball Run / Water Sort completion | TTT: **win only**; the other three: any completion |
| `first_ttt_win` | `complete_tictactoe_game` | win |
| `first_sudoku` | `complete_sudoku_game` | any completion |
| `first_ball_run` | `complete_ball_run_game` | any completion |
| `first_water_sort` | `complete_water_sort_game` | any completion |
| `first_ai_chat` | `finalize_chat_credit` | first completed message |
| `first_coin_exchange` | `exchange_nova_coins` | first exchange |
| `streak_3` / `streak_7` / `streak_14` | `touch_user_streak()` | streak ≥ 3 / 7 / 14 |

Seeded in `20260924000005_phase9_achievements_v1.sql` (five),
`20260924000007_phase11_streak_achievements_v1.sql` (three) and
`20260930000003_games_ballrun_watersort.sql` (two) — 10 rows in total.

### Leaderboard

The `leaderboard_ranked` view (`20260925000001_phase12_leaderboard_v1.sql`)
returns `rank`, `display_name`, `xp`, `level`, `is_me` for profiles with
`xp > 0`. The client reads it read-only with `LEADERBOARD_LIMIT = 50`
(`src/app/profile.tsx`), on both the progression and profile screens. The
legacy `leaderboard` table is not read by the app.

### Where it renders

`src/app/progression.tsx` shows `LEVEL`, the XP bar, `DAY STREAK`, the
achievement tally (`earned / total`) and the leaderboard, and loads
`game_progress`, `achievements` (joined to `user_achievements`),
`game_results` and `wallet_transactions` in parallel. `src/app/profile.tsx`
shows the same level block, per-game stats and the leaderboard.

## 9. Post-game hand-off to Chat

A one-time reference from a completed game into the chat thread.

- **Type.** `PostGameContext` in `src/app/types.ts` is
  `{ sessionId, game }`, where `game` is one of the four game keys. It carries
  only a reference to the player's own session — no reward values.
- **Set.** Each game renders a "continue" button once `completedSessionId` is
  known; clicking it calls `onContinueToChat(sessionId)` → `continueToChat`
  in `App.tsx` → `setPostGame({ sessionId, game })` and `setPage('chat')`.
- **Storage.** In-memory `useState` in `App.tsx`, with the comment that it
  "survives navigation but never persists across a refresh, so old context
  cannot repeat". There is no storage write anywhere for it.
- **Consumed once.** `src/app/chat.tsx` snapshots `postGame` into a local
  `context` when a message is sent, appends `gameSessionId` to the request
  body, and calls `onPostGameConsumed()` (→ `setPostGame(null)`) after the
  reply completes — on the SSE `done` event or on the JSON replay path. The
  next message carries no session reference. A failed send keeps the context
  because the reply never arrived.
- **UI.** A banner offers a canned prompt from `POST_GAME_SUGGESTION`, keyed
  by game. The comment in `chat.tsx` is explicit: it is UI-only, is never
  sent on its own, and never carries reward values.
- **Server side.** `nova-chat` re-derives everything. If `gameSessionId` is a
  UUID, it reads `game_sessions`, `game_results` and `wallet_transactions`
  for that id **under the caller's own RLS scope**, and
  `buildRecentActivity()` in `_shared/recent_activity.ts` turns them into a
  `game_completion` context restricted to an allow-list of
  `tictactoe | sudoku | ball-run | water-sort`. Nothing from the client body
  is trusted as history or reward data.

## 10. Demo mode

Without `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` the Supabase client is
`null` (`src/lib/supabase/client.ts`) and no session exists:

- Tic-Tac-Toe plays locally and `completeGame` returns early without a
  session; no RPC is called.
- Sudoku completes locally and labels the result "Demo — no rewards".
- Ball Run refuses to start ("Sign in to record a run.").
- Water Sort refuses to start ("Sign in to record a solve.").
- Progression numbers on the profile screen are static demo values.

See `ARCHITECTURE.md` §7 for the full demo/authenticated comparison.

## 11. Known limitations

1. **Validation lives in the Edge Functions.** All four completion RPCs are
   directly callable; Tic-Tac-Toe outcome, Sudoku board and Water Sort move
   list are not re-checked in SQL (§1).
2. **No anti-idle proof.** A Ball Run session left open for 60 s and then
   completed pays out with no demonstrated play.
3. **`games_played` counts attempts, not wins.** Tic-Tac-Toe losses and draws
   still increment it, so the win rate shown in `game_progress` is the only
   win/loss ratio available.
4. **Two achievements depend on a win, six do not.** `first_game` requires a
   Tic-Tac-Toe win but is granted by any Sudoku / Ball Run / Water Sort
   completion — the catalog treats "first game" differently per entry point.
5. **Streak days are UTC.** `touch_user_streak` uses the database UTC date, so
   a player active late in their own evening may not advance the streak.
6. **The hub's reward strings are copy, not configuration.** The amounts in
   `src/app/games.tsx` and the literals inside the RPCs are maintained
   separately; nothing checks they match.
