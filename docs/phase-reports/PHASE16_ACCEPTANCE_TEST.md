# NOVA — Phase 16 Acceptance Test

**Purpose:** Manual end-to-end verification that all major flows work correctly
after the AI-first upgrade. Run each section and check PASS/FAIL.

---

## Setup

1. Ensure `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set in `.env`.
2. Ensure Edge Functions are deployed: `nova-chat`, `process-tictactoe`,
   `process-sudoku`, `process-ball-run`, `process-water-sort`,
   `exchange-nova-coins`, `delete-account`.
3. Ensure Gemini env vars are set: `GEMINI_API_KEY`, optionally
   `GEMINI_TEXT_MODEL`, `GEMINI_IMAGE_MODEL`, `GEMINI_TTS_MODEL`.
4. Run: `npm run build` to latest.

---

### 1. AI-FIRST HOME

| # | Action | Expected | PASS / FAIL |
|---|---|---|---|
| 1.1 | Open NOVA at `localhost:5173` | Home loads, NOVA identity shown | |
| 1.2 | Verify "Start Chatting" is primary CTA | Visually prominent, not secondary | |
| 1.3 | Verify "Explore Challenges" is secondary CTA | Visible but less prominent | |
| 1.4 | Verify live user stats show level/XP/streak/coins/credits | Values populated from Supabase, not hardcoded | |
| 1.5 | Verify "Recent conversations" section shows threads | Threads from `get_chat_conversations` RPC | |
| 1.6 | Verify "Recent activity" shows game completions/achievements | From server-authoritative data | |
| 1.7 | Verify personalization chip e.g. "Continue your current focus" | Rule-based, context-gated | |
| 1.8 | Refresh page | Home state persists (conversations, stats) | |
| 1.9 | Click "Explore Challenges" | Navigates to Games Hub | |

---

### 2. CHAT SYSTEM

| # | Action | Expected | PASS / FAIL |
|---|---|---|---|
| 2.1 | Click "Start Chatting" | Navigates to chat page | |
| 2.2 | Send a message "Hello NOVA" | Streaming SSE response appears | |
| 2.3 | Refresh page | Conversation persists (active thread from URL) | |
| 2.4 | Start a second conversation | New thread appears in sidebar | |
| 2.5 | Rename conversation | Title updates in sidebar and URL | |
| 2.6 | Delete conversation | Thread removed, messages gone | |
| 2.7 | Attempt to access another user's conversation UUID | DENIED (RLS enforcement) | |
| 2.8 | Export conversation to Markdown | File downloads with title, date, messages, responses, image refs | |
| 2.9 | Send a message that fails (network) | Retry available, no double-charge | |
| 2.10 | Retry failed message | Same idempotency key reused, credit restored if needed | |

---

### 3. VISION MODE

| # | Action | Expected | PASS / FAIL |
|---|---|---|---|
| 3.1 | Select "Vision" mode in chat composer | Mode tag updates to "See" | |
| 3.2 | Attach a valid image (PNG/JPEG/WebP/GIF ≤5MB) | Preview appears in composer | |
| 3.3 | Send prompt with image attached | Gemini vision response appears in chat | |
| 3.4 | Refresh page | Image attachment persists in conversation | |
| 3.5 | Attempt unsupported type (e.g., BMP) | Clear error, no credit leakage | |
| 3.6 | Attempt oversized image (>5MB) | Clear error, no credit leakage | |
| 3.7 | Vision mode without image | Rejects with "Attachments only supported in vision mode" | |

---

### 4. IMAGE GENERATION

| # | Action | Expected | PASS / FAIL |
|---|---|---|---|
| 4.1 | Select "Draw" mode in chat composer | Mode tag updates to "Draw" | |
| 4.2 | Enter a prompt describing an image | | |
| 4.3 | Send prompt | Gemini image generation starts | |
| 4.4 | On success | Generated image appears in chat bubble with "NOVA generated" label | |
| 4.5 | On failure | Credit released, user-friendly error shown | |
| 4.6 | Refresh page | Generated image metadata persists in conversation | |
| 4.7 | Image generation not configured (no `GEMINI_IMAGE_MODEL`) | UI clearly indicates capability unavailable, no fake success | |

---

### 5. TTS / SPEECH MODE

| # | Action | Expected | PASS / FAIL |
|---|---|---|---|
| 5.1 | Select "Speak" mode (if `GEMINI_TTS_MODEL` configured) | Mode tag updates to "Speak" | |
| 5.2 | Send a message | Text reply appears, then audio generates | |
| 5.3 | On TTS failure | Text still finalized, no `media` event | |
| 5.4 | If `GEMINI_TTS_MODEL` not configured | UI gracefully hides/disables TTS controls, no broken UI | |

---

### 5. GAMES HUB

| # | Action | Expected | PASS / FAIL |
|---|---|---|---|
| 6.1 | Navigate to Games Hub | All 4 games shown: Tic-Tac-Toe, Sudoku, Ball Run, Water Sort | |
| 6.2 | Click Tic-Tac-Toe | Game launches, board renders | |
| 6.3 | Click Sudoku | Game launches, puzzle renders | |
| 6.4 | Click Ball Run | Game launches, controls render | |
| 6.5 | Click Water Sort | Game launches, tubes render | |
| 6.6 | Play Tic-Tac-Toe → win | Reward: +10 NOVA Coins +25 XP, progression updates | |
| 6.7 | Play Tic-Tac-Toe → loss/draw | 0 coins, 0 XP, progression still increments games_played | |
| 6.8 | Play Sudoku | Reward: +20 NOVA Coins +40 XP | |
| 6.9 | Play Ball Run → survive 60s | Reward: +15 NOVA Coins +30 XP | |
| 6.10 | Play Ball Run → timeout <60s | 0 coins, +5 XP | |
| 6.11 | Play Water Sort | Reward: +15 NOVA Coins +35 XP | |
| 6.12 | Navigate from game → Games Hub → Home | No broken routes, state intact | |
| 6.13 | Complete any game, return to Chat | "Continue with NOVA" banner appears | |
| 6.14 | Click "Continue with NOVA" | Navigates to chat, AI receives server-derived game context | |

---

### 6. GAME SECURITY

| # | Action | Expected | PASS / FAIL |
|---|---|---|---|
| 7.1 | Attempt forged Tic-Tac-Toe result (direct RPC call) | RPC accepts `p_outcome` but Edge Function would reject bad board | |
| 7.2 | Attempt Sudoku with invalid board | Edge Function validates; RPC only checks puzzle ID | |
| 7.3 | Ball Run with impossible duration/server clock mismatch | Edge Function rejects; RPC derives from `started_at` | |
| 7.4 | Water Sort with impossible move count | Edge Function BFS replay validates; RPC bounds 1–400 | |
| 7.5 | Direct RPC completion without Edge Function | Reward constants enforced in SQL; one payout per session | |
| 7.6 | Another user's session UUID in "Continue with NOVA" | DENIED — server re-derives under caller's RLS | |

---

### 7. PROGRESSION

| # | Action | Expected | PASS / FAIL |
|---|---|---|---|
| 8.1 | View Progression page | Level, XP, XP-to-next, streak shown | |
| 8.2 | After completing a game | XP/coins increase, level may up-level | |
| 8.3 | Refresh page | Same authoritative values from Supabase | |
| 8.4 | Logout then Login | Same values restored from server | |
| 8.5 | Achievements section | Catalog shown, earned achievements marked | |
| 8.6 | Leaderboard section | `leaderboard_ranked` view shows top users | |

---

### 7. WALLET

| # | Action | Expected | PASS / FAIL |
|---|---|---|---|
| 9.1 | View Wallet page | NOVA Coins and AI Credits displayed separately | |
| 9.2 | Earn game reward | NOVA Coins increase | |
| 9.3 | Exchange 10 NOVA Coins → 1 AI Credit | Atomic: coins decrease, credits increase | |
| 9.4 | Duplicate exchange request | No double exchange (idempotency via `exchange_requests`) | |
| 9.5 | Invalid exchange amount | Rejected ("Exchange amount must be exactly 10 NOVA Coins") | |
| 9.6 | Insufficient coins | Rejected | |
| 9.7 | Another user's wallet | DENIED — RLS ownership enforcement | |

---

### 8. AUTHENTICATION

| # | Action | Expected | PASS / FAIL |
|---|---|---|---|
| 10.1 | Sign up new account | Account created, onboarding gate shown | |
| 10.2 | Complete onboarding (display name) | Gate cleared, app shell shown | |
| 10.3 | Login with credentials | Session restored, no auth flash | |
| 10.4 | Logout | Private data requests fail | |
| 10.5 | Login after logout | Session restored correctly | |
| 10.5 | Account deletion (type "DELETE" in confirmation) | Account removed, user-owned records cascade | |
| 10.6 | Password reset flow | Recovery link works, non-enumerating responses | |

---

### 9. MOBILE RESPONSIVE

| # | Action | Expected | PASS / FAIL |
|---|---|---|---|
| 11.1 | View at 320px (phone) | Navigation collapses, chat composer usable, no overflow | |
| 11.2 | View at 375px/390px (phone) | Same as above | |
| 11.3 | View at 768px (tablet) | Sidebar adjusted, games responsive | |
| 11.4 | View at 1024px (small desktop) | Full layout, no horizontal scroll | |
| 11.5 | View at 1440px+ (desktop) | Full layout, games visually independent | |
| 11.6 | Mobile: open chat composer | Text input not obscured, keyboard accessible | |
| 11.7 | Mobile: game controls | Touch-friendly, no clipped buttons | |

---

### 10. VISUAL CONSISTENCY

| # | Action | Expected | PASS / FAIL |
|---|---|---|---|
| 12.1 | Observe NOVA shell colors (60% neutral, 30% cyan/teal, 10% magenta) | Correct color distribution | |
| 12.2 | Observe Tic-Tac-Toe light independent environment | Game colors don't merge with dark shell | |
| 12.3 | Observe Sudoku light independent environment | Game colors don't merge with dark shell | |
| 12.4 | Observe Ball Run own visual environment | Distinct from NOVA shell | |
| 12.5 | Observe Water Sort own visual environment | Distinct from NOVA shell | |

---

### 11. ACCESSIBILITY

| # | Action | Expected | PASS / FAIL |
|---|---|---|---|
| 13.1 | Keyboard navigation through all controls | Focus visible, logical order | |
| 13.2 | Screen reader friendly labels | All buttons/form labeled | |
| 13.3 | Color contrast sufficient | Readable text and controls | |
| 13.4 | Reduced motion respect where practical | No unnecessary animation discomfort | |

---

### 12. PERFORMANCE

| # | Action | Expected | PASS / FAIL |
|---|---|---|---|
| 14.1 | `npm run build` completes | 0 errors, expected warnings only | |
| 14.2 | Initial bundle size | ~687 kB gzip (all four games in one bundle) | |
| 14.3 | No unnecessary API calls on mount | Supabase queries only when needed | |

---

## Summary

Count PASS and FAIL checkboxes above. All sections must PASS for Phase 16 to be
consider complete. Any FAIL item requires investigation and fix before signing off.