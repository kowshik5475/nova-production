# NOVA — Demo Script

**Target duration:** 3–5 minutes
**Goal:** Show the evaluator the complete user flow from sign-in through AI chat.

---

## Before You Start

- NOVA is running at your deployed URL (or `npm run dev` for local demo).
- If Supabase is configured, you will see a sign-in screen. If not, NOVA runs in demo mode automatically.
- Have a browser window open and ready.

---

## Step 1 — Sign In (30 s)

1. Open NOVA. You see the **sign-in screen** with the NOVA brand mark.
2. Click **"New here? Create an account"**.
3. Enter an email and password (min 6 characters). Click **Create account**.
4. You are now inside the app. The top bar shows your email and a **0 coins / 0 AI credits** balance.

> **What to say:** "NOVA uses Supabase for authentication. Accounts are created with email and password. On signup, a database trigger auto-creates a profile and wallet row — no manual provisioning needed."

---

## Step 2 — Play and Win Tic-Tac-Toe (45 s)

1. Click **Play** in the sidebar (or the "Play now" card on the home page).
2. You see a 3×3 board and the message *"Win a round against NOVA to earn 10 coins."*
3. Click a cell to place **X**. NOVA responds with **O**.
4. Play until you win (you can refresh and try again if needed).
5. On win: a **green toast** appears — *"Won 10 coins + 25 XP"*.
6. The balance in the top bar updates to **10 coins**.

> **What to say:** "The win is validated server-side. The edge function calls an atomic PostgreSQL RPC that checks the game session, records the result, and awards coins and XP in a single transaction. The client never directly modifies the wallet."

---

## Step 3 — Exchange Coins for an AI Credit (20 s)

1. Click **Wallet** in the sidebar.
2. You see your coin balance (10) and credit balance (0).
3. Click **"Exchange 10 coins"**.
4. A toast confirms: *"Exchanged 10 coins → 1 AI credit"*.
5. The credit balance updates to **1**.

> **What to say:** "The exchange rate is 10 coins = 1 credit. This is also a server-side atomic operation with idempotency protection — clicking twice won't double-spend."

---

## Step 4 — Chat with NOVA (45 s)

1. Click **Chat** in the sidebar.
2. The chat screen shows a welcome message from NOVA.
3. Type a message (e.g., *"What games can I play?"*) and click **Send**.
4. A "Thinking" animation appears briefly, then NOVA responds.
5. The credit balance drops to **0**.

> **What to say:** "Each message costs 1 AI credit. The system reserves the credit before calling Gemini, then finalizes it on success. If Gemini fails, the credit is automatically released back. Failed requests show a Retry button that reuses the same idempotency key — so you're never double-charged."

---

## Step 5 — Profile and Progress (30 s)

1. Click **Profile** in the sidebar.
2. You see: display name, level, XP bar, coin/credit balances, streak.
3. **Tic-Tac-Toe Stats** section shows: Played, Won, Win Rate, Losses/Draws.
4. **Recent Activity** shows your latest game results with timestamps.
5. **NOVA Insight** gives a personalized recommendation based on your stats.

> **What to say:** "The profile fetches data from three tables — profiles, game_progress, and game_results. The insight is generated client-side from your win rate and balance, suggesting what to do next."

---

## Step 6 — Sudoku (45 s)

1. Click **Sudoku** in the sidebar.
2. You see three puzzle cards, each showing the number of empty cells.
3. Click a puzzle to start. A 9×9 grid appears with a timer and mistake counter.
4. Click a cell, then use the **number pad** (or keyboard 1–9) to fill it.
5. Conflict detection highlights duplicates in red in real time.
6. Fill the entire board correctly. A toast appears: *"Puzzle solved! +20 coins +40 XP"*.

> **What to say:** "Sudoku uses three curated puzzles. The solution is stored server-side — the client never sees it during play. When the board is full, the edge function validates it against the known solution before awarding rewards. This prevents any client-side manipulation."

---

## Step 7 — Demo Mode (if applicable) (15 s)

If Supabase is not configured:

1. Point out the **DEMO** badge in the top bar.
2. The starting balance is **20 NOVA Coins, 0 AI Credits**.
3. Exchange works locally (10 coins → 1 credit). Try it on the Wallet page.
4. All games work. Wins show toast notifications.
5. Balances are session-local and reset on page refresh.
6. Chat shows a local echo response (no Gemini call).

> **What to say:** "Demo mode lets evaluators test the full UI without any backend setup. Just run `npm run dev` and everything works locally. The exchange is functional — you can earn coins from games, exchange them for credits, and see the full flow."

---

## Closing Summary

> "NOVA demonstrates a complete server-secured economy: games earn currency, currency buys AI access, and every economic operation is atomic, idempotent, and scoped to the authenticated user. The architecture separates frontend presentation from server-side business logic, with Supabase handling auth, database, and edge computing."

---

## Quick Reference — Keyboard Shortcuts

| Context | Key | Action |
|---------|-----|--------|
| Sudoku | 1–9 | Place number |
| Sudoku | 0, Backspace, Delete | Clear cell |
| Sudoku | Arrow keys | Move selection |
