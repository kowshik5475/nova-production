# DEMO GUIDE — NOVA AI Play

## 1. Introduction

NOVA is an AI-first general-purpose assistant with an optional interactive game ecosystem. Players chat with NOVA (Gemini-powered, multimodal), earn NOVA Coins in optional games, and exchange those coins for AI conversation credits. Rewards, credits and chat history are enforced server-side, so clients cannot fabricate coins or credits.

## 2. AI-first experience

The core of NOVA is the conversational AI assistant. Players can:

- Create and manage threaded conversations
- Choose from four reply modes: Chat, See (image understanding), Draw (image generation), Speak (text-to-speech)
- Send messages with streamed Gemini replies
- Exchange 10 NOVA Coins for 1 AI Credit
- Conversation history persists server-side

## 3. Persistent conversation

- Threaded conversations with a sidebar for navigation
- Create, rename, and delete conversations
- Deep-link via `?conversation=` parameter
- Load history on page refresh
- Conversations persist across sessions when connected to Supabase

## 4. Game ecosystem

Games are optional and session-local in demo mode. Four games are available:

- **Tic-Tac-Toe** — 10 NOVA Coins + 25 XP for a win
- **Sudoku** — 20 NOVA Coins + 40 XP for completion
- **Ball Run** — 15 NOVA Coins + 30 XP, survive 60 seconds
- **Water Sort** — 15 NOVA Coins + 35 XP, sort colored tubes

Note: In demo mode, all games run entirely in-browser with session-local balances. Connected to Supabase, completions are server-validated and rewards are authoritative.

## 5. Progression

- **XP** — Earned per game completion, contributes to leveling
- **Levels** — Progress bar shows XP toward next level
- **Achievements** — Catalog of attainable goals, seeded via Supabase migrations
- **Streaks** — Track consecutive-day activity (server-authoritative via `touch_user_streak()` RPC)

## 6. Economy

- **NOVA Coins** — Earned in games (10/25 TTT, 20/40 Sudoku, 15/30 Ball Run win, 15/35 Water Sort)
- **AI Credits** — Consumed at 1 per chat message; obtained by exchanging 10 NOVA Coins → 1 Credit
- **Wallet** — Server-side balance (or session-local 20 coins / 0 credits in demo mode)
- **Transaction ledger** — Read-only ledger showing every balance change with impact (`+10 NOVA Coins`) and timestamp

## 7. Personalization

- **Display name** — Updated via `update_own_display_name()` RPC (length 1–50)
- **Level/XP/ streak** — Persisted server-side or session-local in demo
- **Achievements** — Unlocked through gameplay
- **Leaderboard** — Read-only `leaderboard_ranked` view: public projection with rank, display_name, XP, level, `is_me`

## 8. Security

- All wallet mutations go through `SECURITY DEFINER` RPCs with `search_path = public`
- RLS policies restrict SELECT/INSERT/UPDATE to `auth.uid()`-owned rows
- Gemini API key is server-side only — never exposed to the browser
- No browser client can directly modify `wallet`, `wallet_transactions`, `game_results`, or `game_progress`
- Idempotency keys prevent duplicate rewards
- Chat credit reservation/refund uses two-phase commit; stale reservations (>5 min) auto-cleaned

## 9. Closing

NOVA's novelty is the combination of an AI-first conversational experience with an optional game economy — where gameplay optionally feeds back into AI credit availability, and all rewards are server-authoritative.