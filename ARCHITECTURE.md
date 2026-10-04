# NOVA AI Play — Architecture

How the application is assembled: navigation, state, the client/server split,
the `src/` module layout, and the two main request flows (chat and game
completion). Every statement below is read from the source; file paths are
cited. Companion documents: `SECURITY.md` (threat model and controls),
`DATABASE.md` (schema, RPCs, RLS, migrations), `GAME_SYSTEM.md` (game rules
and progression).

---

## 1. Stack and entry points

| | |
|---|---|
| **UI** | React 19 + TypeScript, built by Vite (`npm run build` = `tsc -b && vite build`), plain CSS |
| **Server** | Supabase — Auth, Postgres with RLS, Storage, Edge Functions (Deno) |
| **AI** | Google Gemini, called only from `supabase/functions/nova-chat` |
| **Entry** | `src/main.tsx` renders `src/app/App.tsx` inside `React.StrictMode` |
| **Lint** | `npm run lint` → `oxlint` |

Runtime dependencies (`package.json`): `@supabase/supabase-js`, `react`,
`react-dom`, `react-markdown`, `remark-gfm`. There is no router library, no
state-management library, and no test script in `package.json` (the SQL test
suite under `supabase/tests/` is run separately, see `TESTING.md`).

Vite config (`vite.config.ts`) contains only the React plugin and the `@` →
`./src` alias. Nothing is lazy-loaded, so the production build is a single JS
bundle (§8).

## 2. Navigation

`NAV_ITEMS` in `src/app/App.tsx` defines the six pages, and a single
`useState<Page>` variable `page` drives which component renders. There is no
router — the sidebar buttons and every cross-page link call `openPage` /
`goTo`, which set state.

| `page` | Component | Notes |
|---|---|---|
| `home` | `src/app/home.tsx` | dashboard; quick actions deep-link into chat/games/wallet |
| `chat` | `src/app/chat.tsx` | conversation list + message pane + mode selector |
| `games` | `src/app/games.tsx` | hub; `selectedGame` picks which of the four games renders |
| `progression` | `src/app/progression.tsx` | level, streak, achievements, leaderboard |
| `wallet` | `src/app/wallet-view.tsx` | balances, exchange, transaction history |
| `profile` | `src/app/profile.tsx` | account, stats, insight, deletion |

`selectedGame` is a sibling state: when it is non-null the `games` page
renders `tictactoe`, `sudoku`, `ballrun` or `watersort` instead of the hub
(`GameKey` in `src/app/types.ts`). The back bar in `App.tsx` clears it.

**URL state.** The one piece of state mirrored into the browser URL is the
active chat thread. `readUrlConversation()` / `writeUrlConversation()` in
`src/app/chat.tsx` read and write `?conversation=<uuid>` with
`history.replaceState` (never `pushState`, so thread switching adds no history
entries), validating the value against a UUID regex. `activeId` is initialised
from the URL, and `home.tsx` `openConversation` writes the same parameter when
a deep link opens chat. Everything else — current page, selected game, post
game context, stream buffer — is component state only.

**Render gates.** `App.tsx` resolves in order: auth loading spinner →
password-recovery reset form → sign-in gate (Supabase configured but no
session) → profile loading spinner → profile error retry → onboarding (empty
`display_name`) → app shell. This ordering guarantees the shell never flashes
with unknown identity.

## 3. Client/server split

```
Browser (anon key + user JWT)
  ├─ PostgREST reads ──────── .from(...).select(...)   RLS-scoped, own rows
  ├─ RPCs ─────────────────── .rpc(...)                SECURITY DEFINER writes
  ├─ Storage ──────────────── upload / signed URL      owner folder only
  └─ Edge Functions ───────── functions.invoke(...)    JWT verified, 7 functions
                                    │
                                    ├─ Gemini (GEMINI_API_KEY, server-only)
                                    └─ RPCs (reserve → finalize / release, …)
```

- **Credentials in the browser** are exactly `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY` (`.env.example`, `src/lib/supabase/client.ts`).
  Both are public by design; nothing else is inlined because Vite only exposes
  `VITE_*`.
- **Server-only secrets** live in the Supabase Edge runtime: `GEMINI_API_KEY`,
  `GEMINI_TEXT_MODEL` / `GEMINI_MODEL` / `GEMINI_VISION_MODEL` /
  `GEMINI_IMAGE_MODEL` / `GEMINI_TTS_MODEL` / `GEMINI_TTS_SAMPLE_RATE`,
  `CORS_ALLOWED_ORIGINS`, and `SUPABASE_SERVICE_ROLE_KEY` (used only by
  `supabase/functions/delete-account`).
- **The client performs no writes.** `src/` contains no `.insert()`, `.update()`
  or `.upsert()` call — the only `.delete()` matches are `URLSearchParams.delete`
  (`src/app/chat.tsx`) and a `Map.delete` (`src/app/hooks/useToasts.ts`).
  Everything that changes state goes through a definer RPC or an Edge Function.
- **The seven Edge Functions** (`supabase/functions/`) are `nova-chat`,
  `process-tictactoe`, `process-sudoku`, `process-ball-run`,
  `process-water-sort`, `exchange-nova-coins`, `delete-account`, plus a
  `_shared/` directory of pure modules (`tictactoe_validate.ts`,
  `watersort_validate.ts`, `ballrun_validate.ts`, `recent_activity.ts`,
  `personalization.ts`, `chat_modes.ts`, `cors.ts`).
- **Read paths** are direct: the wallet, profile, progression and leaderboard
  screens query PostgREST with the user's JWT, so RLS already restricts results
  to the owner.

## 4. `src/` module layout

| Path | Responsibility |
|---|---|
| `src/main.tsx` | mounts `<App />` |
| `src/index.css` | all styling (imports `src/styles/theme.css`) |
| `src/app/App.tsx` | shell, navigation, gates, toast host, post-game state |
| `src/app/types.ts` | `Page`, `GameKey`, `ChatMode`, `PostGameContext`, DTO types |
| `src/app/auth.tsx` | sign-in / sign-up / reset / set-new-password form |
| `src/app/onboarding.tsx` | first-run display-name capture (`update_own_display_name`) |
| `src/app/home.tsx`, `home-data.ts` | dashboard, suggestion chips, deep links |
| `src/app/chat.tsx` | threads, URL sync, SSE rendering, attachments, retry |
| `src/app/MarkdownText.tsx` | markdown renderer used by chat bubbles |
| `src/app/games.tsx` | game hub cards and reward copy |
| `src/app/tictactoe.tsx`, `sudoku.tsx`, `ballrun.tsx`, `watersort.tsx` | the four games (self-contained, each owns its start/complete calls) |
| `src/app/progression.tsx` | level, streak, achievements, leaderboard section |
| `src/app/profile.tsx` | profile editing, stats, `Leaderboard` component, deletion |
| `src/app/wallet-view.tsx` | balances, exchange button, transaction history |
| `src/app/export.ts` | conversation → Markdown, file download |
| `src/app/utils.ts` | `formatDate`, `isValidEmail`, `validateDisplayName`, `getInsight` |
| `src/app/hooks/useToasts.ts` | toast queue with auto-dismiss |
| `src/lib/supabase.ts` | `useSupabaseSession` — auth state + password-reset detection |
| `src/lib/supabase/client.ts` | `supabase` client or `null` when env vars are absent |
| `src/lib/supabase/wallet.ts` | `useWallet` — balances, exchange, demo fallbacks |
| `src/lib/supabase/useProfile.ts` | `useProfile` — profile, per-game progress, achievements |
| `src/lib/supabase/conversations.ts` | thread CRUD via `create/rename/delete/get_chat_conversations` |

## 5. Chat flow

Sending a message (`src/app/chat.tsx` → `send()`):

1. **Idempotency key.** `chatRetryRef` holds `{ message, idempotencyKey }`.
   A new message mints `crypto.randomUUID()`; a failed message keeps its key,
   so a retry replays rather than double-charging.
2. **Optimistic user bubble** is appended locally and removed again in the
   `catch` block, so a retry does not duplicate it.
3. **Thread creation.** If no `activeId`, the client calls
   `create_chat_conversation` first (title = the message text) and sets the
   URL parameter.
4. **Request.** `POST ${VITE_SUPABASE_URL}/functions/v1/nova-chat` with
   `Authorization: Bearer <access_token>` and `apikey: <anon key>`, body
   `{ message, idempotencyKey, gameSessionId?, conversationId, mode,
   attachmentPath }`.
5. **Server.** `nova-chat` verifies the JWT, checks `get_chat_request_state`
   for a completed key (replay → plain JSON, no second Gemini call), reserves
   one AI credit via `reserve_chat_credit`, derives personalisation context
   from the caller's own rows, streams from Gemini, then calls
   `finalize_chat_credit`; any failure path calls `release_chat_credit`.
   Details in `AI_SYSTEM.md`; the credit state machine in `DATABASE.md`.
6. **Client rendering.** Two response shapes:
   - `content-type: application/json` → replay of a completed key; the stored
     reply is rendered directly.
   - otherwise an SSE stream of `data:` lines. `chunk` events accumulate into
     `streamingText`; a `media` event parks generated media; the `wallet` event
     is the `done` signal and finalises the bubble plus `wallet.refresh()`;
     a `message` event is an error. If the connection closes before `done`,
     the code throws and keeps the key so the retry is safe.
7. **Thread refresh** (`refreshThreads`) reloads the conversation list after
   each completed exchange.

History is loaded with `get_chat_history(p_limit = 50, p_conversation_id)`
(`HISTORY_LIMIT`). Media displayed in bubbles uses 3600 s signed URLs kept in
memory only (`mediaUrls` state).

## 6. Game completion flow

All four games share one two-call shape:

1. **Start** — `supabase.functions.invoke('<process-…>', { action: 'start' })`.
   The Edge Function inserts a `game_sessions` row under the caller's own JWT,
   mints the `sessionId`, and returns game-specific seed data (Sudoku puzzle,
   Water Sort tubes/par, Ball Run seed).
2. **Play** — entirely client-side. The client never writes the economy
   tables; it only keeps local board/lane/move state.
3. **Complete** — `invoke(..., { action: 'complete', sessionId, …claim })`.
   The Edge Function validates what it can (`_shared/*_validate.ts`, Sudoku's
   known solution, move replay for Water Sort, server clock for Ball Run),
   then calls the matching RPC: `complete_tictactoe_game`,
   `complete_sudoku_game`, `complete_ball_run_game` or
   `complete_water_sort_game`.
4. **RPC transaction** — idempotency insert into `game_completions` → lock the
   session `FOR UPDATE` → write `game_results` → update `wallet` +
   `wallet_transactions` → update `game_progress` → update `profiles.xp/level`
   → award achievements → `touch_user_streak()`. One function body, one
   transaction; any failure rolls back everything.
5. **UI** — the response's outcome/coins/XP drive the toast, and
   `completedSessionId` is stored so the "Continue to chat" button can hand
   the run off (§7).

The reward amounts are literals inside each RPC — a caller cannot choose an
amount. `GAME_SYSTEM.md` gives per-game rules and the full trust-boundary
table.

## 7. Demo versus authenticated mode

`isDemo = !supabase || !session` (`src/lib/supabase/wallet.ts`,
`src/lib/supabase/useProfile.ts`). Because `src/lib/supabase/client.ts`
returns `null` when `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are absent,
demo mode is reachable only when Supabase is not configured; when it is
configured but nobody is signed in, `App.tsx` shows `AuthGate` instead.

| | Authenticated | Demo |
|---|---|---|
| Data source | Postgres via PostgREST + RPCs | local component state |
| Wallet | `wallet` table, refetched after each action | starts at 20 coins / 0 credits, resets on refresh |
| Profile | `profiles` + `game_progress` | fixed `Player` (level 1, 40 XP) with static stats in `profile.tsx` |
| Chat | `nova-chat` → Gemini | `getDemoReply()` canned text; `wallet.spendCredit()` |
| Tic-Tac-Toe | session + `process-tictactoe` | plays locally; `completeGame` returns early without a session |
| Sudoku | session + `process-sudoku` | completes locally, labelled "Demo — no rewards" |
| Ball Run | session + `process-ball-run` | refuses to start ("Sign in to record a run.") |
| Water Sort | session + `process-water-sort` | refuses to start ("Sign in to record a solve.") |
| Exchange | `exchange-nova-coins` → `exchange_nova_coins` | local arithmetic in `useWallet` |
| Indicators | account button in topbar | `DEMO` badge + footer note in `App.tsx` |

The games hub button label (`session ? 'Play now' : 'Sign in to play'`) is
cosmetic — `onSelect` runs either way.

## 8. Known limitations and deliberate trade-offs

1. **No client-side routing.** Page state lives in `App.tsx`, so the browser
   back button does not leave a page and only `?conversation=` is shareable.
   Chosen for a single-shelf app; the active thread survives via the URL.
2. **Single JS bundle.** `vite.config.ts` has no manual chunks and nothing is
   `React.lazy`-loaded, so all four games ship in one bundle.
3. **Post-game context is in-memory.** `postGame` in `App.tsx` deliberately
   never persists, so a refresh drops the hand-off and old context cannot
   re-trigger. `PostGameContext` carries only `{ sessionId, game }` — no reward
   values ever travel client-side.
4. **Retry drops the optimistic bubble.** On failure the user's message is
   removed from state and restored only when the retry succeeds; a failed
   message is not written to history (the server never received it).
5. **`nova-chat` performs no table writes.** Thread CRUD runs client-side
   against the conversation RPCs and message persistence happens inside
   `finalize_chat_credit`; this keeps the function stateless but means history
   and thread ordering depend on those RPCs.
6. **Two visual systems.** `src/index.css` carries the NOVA dark palette
   (`--nova-*`) and each game's own light theme; styles are global CSS rather
   than scoped modules.
7. **No test runner in `package.json`.** UI code is checked by `npm run lint`
   and `npm run build`; database behaviour is covered by the SQL suite under
   `supabase/tests/`.
8. **Server-derived context is derived per request.** `nova-chat` re-reads the
   session, result and wallet rows on every message rather than caching them —
   correct but adds queries per request.
