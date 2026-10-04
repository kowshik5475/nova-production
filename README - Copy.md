# NOVA

**AI-First General-Purpose Assistant + Optional Interactive Game Ecosystem**

A browser-based mini-project built around NOVA, an AI companion. Players chat with NOVA (Gemini-powered, multimodal), earn NOVA Coins in an optional games hub, and exchange those coins for AI conversation credits. Rewards, credits and chat history are enforced server-side, so clients cannot fabricate coins or credits.

---

## Problem Statement

Most AI chat interfaces are one-dimensional: type a message, get a reply. NOVA adds a lightweight engagement layer: players earn coins in casual games, exchange those coins for AI chat credits, and receive replies grounded in their own game history. The system enforces fair rewards server-side.

## Core Experience

```text
USER
  ↓
TALK
  ↓
AI ASSISTANT
  ↓
OPTIONAL GAMES
  ↓
PROGRESSION / REWARDS
  ↓
PERSONALIZATION
  ↓
RETURN TO AI
```

**Performance (Phase 21 verified):**
- Initial JS: 133.29 kB gzip
- Total JS: ~210 kB gzip across 5 chunks
- Largest game chunk: Ball Run at 59.88 kB gzip
- 320/320 tests passing
- TypeScript: 0 errors, ESLint: 0 errors
- Production build: PASS

## Technologies

| Layer | Technology |
|-------|------------|
| Frontend | React 19, TypeScript 6, Vite 8, plain CSS (no Tailwind) |
| Auth & Database | Supabase (PostgreSQL, Auth, RLS, Storage, Edge Functions) |
| AI | Google Gemini (text `gemini-3.6-flash`, plus vision / image / TTS models) via Edge Function |
| Deployment | Static hosting (Vercel / Netlify / any static server) |

## Features

- **Authentication** — Email/password sign-up and sign-in, **forgot password** (reset email → set new password → continue), and sign-out from Profile.
- **Chat with NOVA** — Threaded conversations with a threads sidebar (create, rename, delete, deep-link via `?conversation=`), streamed replies, Markdown rendering, and Markdown export. Four reply modes: **Chat**, **See** (image understanding with attachments), **Draw** (image generation), **Speak** (text-to-speech). Attachments are size/type checked and stored in an owner-only bucket. Failed requests release the reserved credit, and retrying with the same idempotency key replays the stored reply instead of spending twice.
- **Games Hub** — One hub for four games: **Tic-Tac-Toe** (10 coins + 25 XP), **Sudoku** (20 + 40), **Ball Run** (15 + 30, survive 60 s), **Water Sort** (15 + 35, sort every tube). Completions are validated server-side and are idempotent.
- **Progression** — Streak, wallet overview, per-game progression, achievements, and recent activity on one page; leaderboard shared with Profile.
- **Wallet** — Balances, 10:1 coin exchange, and a read-only ledger where every row shows what changed, the balance impact (`+10 NOVA Coins`), and when.
- **Profile & Progress** — Level, XP bar, streak, per-game stats (including Ball Run and Water Sort), achievements, leaderboard, NOVA Insight, account email with sign-out, and account deletion (type `DELETE` to confirm).
- **Post-game chat hand-off** — After a server-confirmed Tic-Tac-Toe or Sudoku round you can continue to Chat; the session reference is carried in memory for exactly one message and is never persisted.
- **Demo Mode** — Runs entirely in-browser with no Supabase connection. Balances are session-local.

## Architecture

```
Browser (React)                 Supabase Edge Functions            PostgreSQL
     │                                  │                                │
     ├── sign up ─────────────────────> │ ── auth.users trigger ───────> │ profiles + wallet created
     ├── play Tic-Tac-Toe ────────────> │ process-tictactoe ──────────> │ complete_tictactoe_game RPC
     ├── play Sudoku ─────────────────> │ process-sudoku ─────────────> │ complete_sudoku_game RPC
     ├── play Ball Run ───────────────> │ process-ball-run ───────────> │ complete_ball_run_game RPC
     ├── play Water Sort ─────────────> │ process-water-sort ─────────> │ complete_water_sort_game RPC
     ├── exchange coins ──────────────> │ exchange-nova-coins ────────> │ exchange_nova_coins RPC
     ├── send chat ───────────────────> │ nova-chat ──────────────────> │ reserve → Gemini → finalize
     ├── load history ────────────────> │ (client direct) ────────────> │ get_chat_history RPC
     └── delete account ──────────────> │ delete-account ─────────────> │ cascade delete of personal rows
```

Deeper detail: [ARCHITECTURE.md](ARCHITECTURE.md) · [DATABASE.md](DATABASE.md) · [AI_SYSTEM.md](AI_SYSTEM.md) · [SECURITY.md](SECURITY.md) · [GAME_SYSTEM.md](GAME_SYSTEM.md) · [TESTING.md](TESTING.md)

## Folder Structure

```
nova-ai-play/
├── public/                          Static assets (favicon.svg, icons.svg)
├── src/
│   ├── app/
│   │   ├── App.tsx                  App shell: topbar, sidebar, page routing, toasts, post-game hand-off
│   │   ├── types.ts                 Shared TypeScript types
│   │   ├── utils.ts                 formatDate, getInsight helpers
│   │   ├── hooks/useToasts.ts       Toast notification state
│   │   ├── auth.tsx                 Auth gate (sign in / sign up / reset form)
│   │   ├── home.tsx                 Dashboard / home page
│   │   ├── chat.tsx                 Threaded AI chat: modes, attachments, export, retry
│   │   ├── export.ts                Conversation → Markdown export
│   │   ├── MarkdownText.tsx         Markdown renderer for replies
│   │   ├── games.tsx                Games hub (four game cards + reward lines)
│   │   ├── progression.tsx          Streak, wallet overview, game progression, achievements
│   │   ├── tictactoe.tsx            Tic-Tac-Toe game (self-contained)
│   │   ├── sudoku.tsx               Sudoku game (self-contained, 3 puzzles)
│   │   ├── ballrun.tsx              Ball Run reflex game
│   │   ├── watersort.tsx            Water Sort puzzle
│   │   ├── wallet-view.tsx          Balances, exchange, transaction ledger
│   │   └── profile.tsx              Profile, stats, achievements, leaderboard, danger zone
│   ├── lib/
│   │   ├── supabase.ts              useSupabaseSession hook
│   │   └── supabase/
│   │       ├── client.ts            Supabase client init
│   │       ├── wallet.ts            useWallet hook
│   │       ├── conversations.ts     Thread CRUD helpers
│   │       └── useProfile.ts        Profile + progression loader
│   ├── styles/theme.css             Design tokens (incl. ball-run / water-sort palettes)
│   ├── index.css                    All styles (plain CSS)
│   └── main.tsx                     Entry point
├── supabase/
│   ├── migrations/                  SQL migrations (29 files, apply in filename order)
│   ├── tests/                       Automated test suite (see TESTING.md)
│   └── functions/                   Edge Functions (Deno)
│       ├── nova-chat/               AI chat: streaming, modes, credit reservation
│       ├── process-tictactoe/       Tic-Tac-Toe session + reward
│       ├── process-sudoku/          Sudoku session + reward
│       ├── process-ball-run/        Ball Run session + reward
│       ├── process-water-sort/      Water Sort session + reward
│       ├── exchange-nova-coins/     Coin → credit exchange
│       ├── delete-account/          Account + personal-data deletion
│       └── _shared/                 CORS, chat modes, personalization, recent activity, validators
├── .env.example                     Environment variable template
├── ARCHITECTURE.md · DATABASE.md · AI_SYSTEM.md · SECURITY.md · GAME_SYSTEM.md · TESTING.md
├── UPGRADE_AUDIT.md                 Audit that drove this upgrade
├── DEPLOYMENT.md                    Step-by-step deployment guide
├── DEMO_SCRIPT.md                   Evaluator walkthrough script
└── TESTING_CHECKLIST.md             Manual test cases
```


## Supabase Setup

1. Create a project at [supabase.com/dashboard](https://supabase.com/dashboard).
2. Note your **Project URL** and **Anon Key** (Settings → API).
3. Optionally enable email confirmations in Authentication → Providers → Email.

## Gemini Secret Setup

```bash
supabase secrets set GEMINI_API_KEY=your-google-gemini-api-key
```

Get a key at [aistudio.google.com](https://aistudio.google.com/). The default model in code is `gemini-3.6-flash`.

## Migration Order

Apply migrations from `supabase/migrations/` in filename order (`supabase db push`).
The full 29-file table — file by file, with the object each one creates — is in
[DATABASE.md](DATABASE.md). Grouped:

| Files | Concern |
|-------|---------|
| `20260920_00_core_tables.sql` + `20260920000001_auth_trigger_profiles_wallet.sql` … `…000014_fix_get_chat_history_order.sql` | Core schema, auth provisioning, chat credit reservation, economy, atomic game completion RPCs, idempotency/ambiguity fixes |
| `20260924000001_phase2a_p0_rls_hardening.sql` … `20260925000001_phase12_leaderboard_v1.sql` | RLS hardening, reliability fixes, display name, account deletion, onboarding, achievements, streaks, leaderboard |
| `20260930000001_chat_conversations.sql` … `20260930000005_fix_get_chat_history_ambiguity.sql` | Conversation threads, attachment storage, Ball Run + Water Sort games, server-stamped start times |
| `20261001000001_chat_replay_scope_media.sql` | Idempotent replay returns the reply (and media) belonging to that request |

```bash
supabase db push
```

## Edge Function Deployment

There are **7** Edge Functions:

```bash
supabase functions deploy process-tictactoe
supabase functions deploy process-sudoku
supabase functions deploy process-ball-run
supabase functions deploy process-water-sort
supabase functions deploy nova-chat
supabase functions deploy exchange-nova-coins
supabase functions deploy delete-account
```

Optional model overrides (defaults are in `AI_SYSTEM.md`):

```bash
supabase secrets set GEMINI_TEXT_MODEL=gemini-3.6-flash GEMINI_VISION_MODEL=... GEMINI_IMAGE_MODEL=... GEMINI_TTS_MODEL=...
```

## Frontend Environment Variables

Create `.env` in the project root:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

Both are optional. If omitted, NOVA runs in **demo mode** (no server, session-local balances).

## Local Development

```bash
npm install
npm run dev
```

## Production Build

```bash
npm run build     # runs tsc -b && vite build
npm run preview   # preview the build locally
```

Deploy the `dist/` folder to any static host (Vercel, Netlify, GitHub Pages, etc.).

## Demo Mode

When `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are not set, NOVA enters demo mode:
- No authentication required
- All games work locally with the same logic
- Starting balance: 20 NOVA Coins, 0 AI Credits
- Exchange works locally (10 coins → 1 credit)
- Chat shows a canned response (no Gemini call)
- Balances reset on page refresh
- A "DEMO" badge appears in the top bar

## Testing

```bash
npm run lint                    # oxlint (warnings are tolerated, errors are not)
npm run build                   # tsc -b && vite build
node --experimental-strip-types supabase/tests/<file>.test.ts
```

The suite runs against a live Supabase project configured in `.env`
(`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`). 17 files, 322 tests.
Full run instructions, the per-file catalogue and the Phase 7 prerequisite are in
[TESTING.md](TESTING.md); manual UI cases are in [TESTING_CHECKLIST.md](TESTING_CHECKLIST.md).

## Documentation

### Root Documents (core references)

| Document | Contents |
|----------|----------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | App shell, client/server split, chat and game flows, known trade-offs |
| [DATABASE.md](DATABASE.md) | Every table, RPC, policy, bucket and migration |
| [AI_SYSTEM.md](AI_SYSTEM.md) | NOVA chat: modes, env vars, SSE contract, credits, failures |
| [SECURITY.md](SECURITY.md) | Threat model, RLS, economy integrity, trust boundaries, limitations |
| [GAME_SYSTEM.md](GAME_SYSTEM.md) | Four games, validators, rewards, progression, post-game hand-off |
| [TESTING.md](TESTING.md) | How to run the suite and what each file proves |
| [UPGRADE_AUDIT.md](UPGRADE_AUDIT.md) | The audit that drove this upgrade |
| [DEPLOYMENT.md](DEPLOYMENT.md) · [DEMO_SCRIPT.md](DEMO_SCRIPT.md) | Hosting steps · evaluator walkthrough |

### Organized Documentation

For a structured hierarchy, see the `docs/` directory:

| Section | Contents |
|---------|----------|
| [docs/phase-reports/](docs/phase-reports) | Chronological log of all development phases (Phase 16-21) |
| [docs/architecture/](docs/architecture) | Supplementary architecture and system design documents |
| [docs/security/](docs/security) | Security threat model and policy details |
| [docs/project/](docs/project) | Project status, release preparation, and version tracking |
| [docs/releases/](docs/releases) | Release notes and version history |
| [docs/development/](docs/development) | Development guides, setup, and operational guidelines |
| [docs/demo/](docs/demo) | Demo mode configuration and features |

## Security Notes

| Mechanism | Implementation |
|-----------|----------------|
| **Server-side rewards** | All coin/XP awards happen inside PostgreSQL `SECURITY DEFINER` RPCs. The client never directly modifies `wallet`, `wallet_transactions`, `game_results`, or `game_progress`. |
| **JWT identity** | Edge functions extract `auth.uid()` from the JWT. Every database query is scoped to the authenticated user. |
| **Atomic transactions** | Reward RPCs use a single `BEGIN/COMMIT` block: record result → update wallet → update progress → update profile. If any step fails, the entire transaction rolls back. |
| **Row-Level Security** | RLS policies on all tables restrict SELECT/INSERT/UPDATE to `auth.uid()`-owned rows. |
| **Idempotency** | `game_completions`, `wallet_transactions`, and `chat_messages` use idempotency keys. Duplicate requests return the original result without re-awarding. |
| **Credit reservation/refund** | Chat uses a two-phase commit: `reserve_chat_credit` → Gemini call → `finalize_chat_credit`. Any failure path releases the credit; stale reservations (>5 min) are auto-cleaned. |
| **Attachment isolation** | Chat attachments live in the `chat-attachments` bucket under owner folders; paths are validated against traversal, with MIME and 5 MB limits. |
| **API key isolation** | The Gemini API key is stored as a Supabase secret, never exposed to the browser. |

Known trust-boundary limitations are listed honestly in [SECURITY.md](SECURITY.md).

## Limitations

- **PWA formally deferred** per security review — no service worker or manifest implementation
- **Screen-reader testing** unavailable during audit — accessibility validation required post-launch
- **Ball Run largest game chunk** at 59.88 kB gzip — code splitting preserves overall bundle size but individual chunk size is notable
- **Direct RPC call risk** — `complete_tictactoe_game`, `complete_sudoku_game`, `complete_water_sort_game`, `complete_ball_run_game` trust their parameters; validation lives in Edge Functions, not database (bounded damage: one session, one payout, fixed constants)
- **No application-layer rate limiting** — only Supabase Auth email/password limits; credit cost (1 per chat message) is the only economic brake
- **`leaderboard_ranked` publishes display names** — grants SELECT to `anon`; not `security_invoker`, so display name, XP and level of any profile with `xp > 0` are world-readable (deliberate product choice)
- **`audit_log` has no writer** — table exists with SELECT-own RLS, but no function inserts rows into it
- **Account deletion does not remove Storage objects** — images already uploaded to `chat-attachments` are orphaned rather than deleted (FKs do not cover Storage)
- **Legacy whole-account history path** — `get_chat_history` with `NULL` conversation id still returns the account's last N messages; kept for backward compatibility
- **No automated secret scanning or CI gate** — enforcement is the test suite in `supabase/tests/` plus `npm run lint` / `npm run build`, run manually

## Demo

NOVA runs in demo mode when `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are not set. Demo mode is fully functional in-browser with no Supabase connection:

- No authentication required
- All games work locally with the same logic
- Starting balance: 20 NOVA Coins, 0 AI Credits
- Exchange works locally (10 coins → 1 credit)
- Chat shows a canned response (no Gemini call)
- Balances reset on page refresh
- A "DEMO" badge appears in the top bar
