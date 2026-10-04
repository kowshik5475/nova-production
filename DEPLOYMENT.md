# NOVA AI Play — Deployment Guide

## Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli) installed and linked to your project
- A [Google AI Studio](https://aistudio.google.com/) API key for Gemini
- Node.js 18+ for the frontend build

---

## 1. Create Supabase Project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) and create a new project.
2. Note your **Project URL** and **Anon Key** (Settings → API).
3. Optionally enable email confirmations in Authentication → Providers → Email.

## 2. Set Frontend Environment Variables

Create `.env` in the project root:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

Both are optional. If omitted, NOVA runs in demo mode.

## 3. Apply Database Migrations

Run migrations in order:

```bash
supabase db push
```

The migrations in `supabase/migrations/` are applied in filename order:

| # | File | Purpose |
|---|------|---------|
| 1 | `20260920000001_auth_trigger_profiles_wallet.sql` | Auto-provision profiles + wallet on signup |
| 2 | `20260920000002_chat_messages_and_credit_reservation.sql` | Chat messages + credit reservation RPC |
| 3 | `20260920000003_nova_economy.sql` | Exchange/spend RPCs, wallet transaction types |
| 4 | `20260920000004_tictactoe_atomic_completion.sql` | Atomic Tic-Tac-Toe reward RPC |
| 5 | `20260920000005_sudoku_atomic_completion.sql` | Atomic Sudoku reward RPC |
| 6 | `20260920000006_hardening.sql` | RLS fixes, state-aware idempotency, stale cleanup |
| 7 | `20260920000007_backfill_profiles_wallet.sql` | Backfill profiles/wallet for existing users |
| 8 | `20260920000008_fix_tictactoe_earned_coins.sql` | Fix TTT `earned_coins` ambiguity |
| 9 | `20260920000009_fix_tictactoe_games_columns.sql` | Fix TTT games column references |
| 10 | `20260920000010_fix_exchange_coins_ambiguity.sql` | Fix exchange coins ambiguity |
| 11 | `20260920000011_fix_reserve_chat_credit_ambiguity.sql` | Fix reserve chat credit ambiguity |
| 12 | `20260920000012_fix_reserve_chat_credit_set_syntax.sql` | Fix reserve chat credit SET syntax |
| 13 | `20260920000013_fix_finalize_chat_credit_request_variable.sql` | Fix finalize chat credit variable |
| 14 | `20260920000014_fix_get_chat_history_order.sql` | Return most recent N chat messages |
| 15 | `20260920_00_core_tables.sql` | Core schema: profiles, wallet, games, sessions, results, progress |
| 16 | `20260924000001_phase2a_p0_rls_hardening.sql` | Phase 2A: RLS on all public tables |
| 17 | `20260924000002_phase2c_reserve_chat_credit_refund_fix.sql` | Phase 2C: double-refund fix |
| 18 | `20260924000003_phase2c_sudoku_ambiguous_columns.sql` | Phase 2C: Sudoku ambiguous columns fix |
| 19 | `20260924000004_phase6_update_own_display_name.sql` | Phase 6: `update_own_display_name` RPC (display_name only) |

No Phase 7 migration: account deletion uses existing `ON DELETE CASCADE` FKs and the `delete-account` Edge Function.

## 4. Set Edge Function Secrets

```bash
supabase secrets set GEMINI_API_KEY=your-google-gemini-api-key
```

The default model in code is `gemini-3.6-flash`. To override it:

```bash
supabase secrets set GEMINI_MODEL=gemini-3.6-flash
```

Production origin allowlist (comma-separated; required before public deploy):

```bash
supabase secrets set CORS_ALLOWED_ORIGINS=https://your-production-origin.example
```

Local dev origins (`localhost` / `127.0.0.1` on ports 5173/4173/3000) are always allowed. Never hardcode production domains in `_shared/cors.ts`.

Deploy Edge Functions (includes `delete-account` for Phase 7 account deletion):

```bash
supabase functions deploy delete-account
```

`delete-account` uses the built-in `SUPABASE_SERVICE_ROLE_KEY` Edge secret (server-side only). Do **not** put the service-role key in `VITE_*` variables.

Verify secrets (names only):

```bash
supabase secrets list
```

## 5. Deploy Edge Functions

```bash
supabase functions deploy process-tictactoe
supabase functions deploy process-sudoku
supabase functions deploy nova-chat
supabase functions deploy exchange-nova-coins
```

## 6. Build and Deploy Frontend

```bash
npm install
npm run build
# Deploy dist/ to your hosting provider (Vercel, Netlify, etc.)
```

## 7. Go-Live Checklist

Complete this checklist before any public production deploy. Do **not** print secret values in logs or commits.

### A. Frontend host

- [ ] Create production `.env` on the host (or hosting env vars):

  ```
  VITE_SUPABASE_URL=https://your-project.supabase.co
  VITE_SUPABASE_ANON_KEY=your-anon-key
  ```

- [ ] Deploy `dist/` (`npm run build`) to the final static host.
- [ ] Confirm the site loads with a real session (not demo mode).

### B. Supabase secrets

- [ ] `GEMINI_API_KEY` is set and valid (`supabase secrets list` shows the name).
- [ ] `GEMINI_MODEL` matches intent (default in code: `gemini-3.6-flash`).
- [ ] `CORS_ALLOWED_ORIGINS` set to the exact production origin (scheme + host, no trailing path), e.g. `https://your-app.vercel.app`.
- [ ] Re-deploy Edge Functions after any secret or function change:

  ```bash
  supabase functions deploy process-tictactoe
  supabase functions deploy process-sudoku
  supabase functions deploy nova-chat
  supabase functions deploy exchange-nova-coins
  ```

### C. Supabase Auth

- [ ] Dashboard → Authentication → URL Configuration → **Site URL** = production origin.
- [ ] **Password reset redirects:** add the production origin under **Redirect URLs** (required for “Forgot password?” emails). Local dev: allow `http://localhost:5173` (and your Vite port) as Redirect URLs while developing.
- [ ] Password reset emails use the app origin as `redirectTo` (`window.location.origin`) — no hardcoded production domain in code.
- [ ] **Email confirmation** (choose one and document it for the team):
  - **Demo / course demo (recommended default):** leave email confirmation **disabled** so testers can sign up and enter immediately.
  - **Stricter production:** enable Authentication → Providers → Email → **Confirm email**; testers must click the confirm link before login.
- [ ] Decide support contact / SMTP sender name if enabling confirmation.
- [ ] Optional smoke: Forgot password → email link → set new password → Continue to NOVA (requires real inbox; not run in CI).

### D. Data hygiene

- [ ] Decide whether to keep or wipe test data before public launch (current linked project has test profiles / game_results / chat / wallet rows from development and Phase 2 tests).
- [ ] If wiping: delete test users in Auth dashboard (cascades remove profile/wallet/messages/results) or run a reviewed cleanup SQL — never ship leftover test accounts as “real” users.
- [ ] Confirm seed `games` rows: Tic-Tac-Toe + Sudoku are playable; Ball Run / Water Sort are catalog placeholders only (no UI) — optionally set `active=false` until built.

### E. Smoke test (manual, production origin)

1. Sign up on the production URL (or sign in).
2. Win Tic-Tac-Toe → +10 coins + 25 XP toast; topbar balance updates.
3. Wallet → Exchange 10 → 1 AI credit.
4. Chat → send a message → Gemini reply; credit decrements by 1.
5. Refresh → history loads; balances persist.
6. Complete Sudoku → +20 coins + 40 XP.
7. Force a chat failure (or disconnect) → credit released, not double-spent.
8. Log out / log in → same stats and wallet.

---

## 8. End-to-End Test

1. **Sign up** with a new email/password.
2. **Play Tic-Tac-Toe** — win a round to earn 10 NOVA Coins + 25 XP.
3. **Exchange** — click "Exchange 10 coins" on the Wallet page to get 1 AI Credit.
4. **Chat** — go to Chat, send a message. NOVA should respond with context-aware text.
5. **Retry** — disconnect network, send a message, verify credit is released. Reconnect, retry with the same prompt.
6. **History** — refresh the page, navigate to Chat. Past messages should load.
7. **Sudoku** — navigate to Sudoku, pick a puzzle, complete it, verify 20 NOVA Coins + 40 XP.

---

## Troubleshooting

### "Wallet not found" or "Wallet not created"

The `auth.users` trigger (`handle_new_user`) creates `profiles` + `wallet` rows on signup. If it was not applied:

```sql
-- Manually create for an existing user:
INSERT INTO public.profiles (id, display_name, level, xp)
VALUES ('user-uuid', 'Player', 1, 0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.wallet (user_id, earned_coins, ai_credits)
VALUES ('user-uuid', 0, 0)
ON CONFLICT (user_id) DO NOTHING;
```

### "Authentication required" / Invalid JWT

- Verify `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are correct in `.env`.
- Check that the user is signed in (top-right shows email, not sign-in form).
- Edge functions require the `Authorization: Bearer <jwt>` header — the Supabase JS client handles this automatically.

### "Insufficient AI Credits"

- Win a Tic-Tac-Toe round (10 coins), then exchange on the Wallet page (10 coins → 1 credit).
- Credits are consumed 1 per chat message.
- If credits appear stuck, check for stale reservations: the system auto-cleans reservations older than 5 minutes.

### Gemini API Errors (502)

- Verify `GEMINI_API_KEY` is set: `supabase secrets list`
- Check the key is valid at [aistudio.google.com](https://aistudio.google.com/)
- Check edge function logs: `supabase functions logs nova-chat`
- On Gemini failure, the credit is automatically released back to the user's wallet.

### Chat messages not persisting

- Check that the `chat_messages` table exists and RLS is enabled.
- Verify the user has SELECT + INSERT policies on `chat_messages`.
- Check edge function logs for `Finalize error`.

### Double-charge protection

All economic operations use idempotency keys:
- Game rewards: one reward per game session
- Coin exchange: one exchange per idempotency key
- Chat credits: one charge per idempotency key, with state tracking (reserved → completed/released)
- Stale reservations (>5 min) are automatically cleaned up on the next `reserve_chat_credit` call

---

## Architecture Overview

```
Browser                    Supabase Edge Functions         PostgreSQL
  │                              │                              │
  ├─ sign up ──────────────────> │ ── auth.users trigger ─────> │ profiles + wallet created
  ├─ play game ─────────────────> │ process-tictactoe ─────────> │ complete_tictactoe_game RPC
  ├─ play sudoku ───────────────> │ process-sudoku ────────────> │ complete_sudoku_game RPC
  ├─ exchange coins ────────────> │ exchange-nova-coins ───────> │ exchange_nova_coins RPC
  ├─ send chat ─────────────────> │ nova-chat ─────────────────> │ reserve → Gemini → finalize
  └─ load history ──────────────> │ (client direct) ───────────> │ get_chat_history RPC
```

**Security model:**
- All wallet mutations go through `SECURITY DEFINER` RPCs with `search_path = public`
- RLS policies restrict SELECT/INSERT to `auth.uid()`-owned rows
- No browser client can directly modify `wallet`, `wallet_transactions`, `game_results`, or `game_progress`
- Gemini API key is server-side only — never exposed to the browser
