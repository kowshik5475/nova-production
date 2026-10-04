# NOVA — Testing Checklist

Manual walkthrough for the upgraded build (AI-first assistant + games hub).
Automated coverage lives in `supabase/tests/` — see `TESTING.md` for how to run it.

Navigation under test: **home · chat · games · progression · wallet · profile**.

## 1. Authentication

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 1.1 | Sign up | Open app → click "Create an account" → enter email + password (6+ chars) → submit | Account created, redirected into app |
| 1.2 | Sign in | Sign out → enter credentials → click "Sign in" | Signed in, same session restored |
| 1.3 | Invalid credentials | Enter wrong password → sign in | Error message shown below the form |
| 1.4 | Short password | Enter password with < 6 chars → create account | Form validation prevents submission |
| 1.5 | Auth loading | Refresh the page | Spinner appears briefly, then app loads |
| 1.6 | Sign out from Profile | Profile → "Sign out" | Session ends, sign-in screen shown |

## 2. Navigation

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 2.1 | Sidebar items | Click each sidebar item: home, chat, games, progression, wallet, profile | Correct page renders, active item is highlighted |
| 2.2 | Brand click | Click "NOVA" in the top bar | Returns to home page |
| 2.3 | Home shortcuts | On home, use the game / chat shortcuts | Lands on the matching page |
| 2.4 | Games hub → game | Games → click a game card | Game renders with a back control returning to the hub |
| 2.5 | Deep link thread | Open Chat, select a thread, copy the URL → open it in a new tab | Same thread opens (`?conversation=`) |

## 3. Wallet

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 3.1 | Initial balance | Sign up / sign in | Wallet shows 0 coins, 0 AI credits |
| 3.2 | Wallet display | Click wallet in sidebar | NOVA Coins and AI Credits cards, exchange card |
| 3.3 | Syncing indicator | While wallet loads, observe the wallet page | "Syncing wallet…" text may appear briefly |
| 3.4 | History row content | After earning and spending, open Transaction History | Each row shows what changed, the balance impact (`+10 NOVA Coins`, `-1 AI Credits`) and when |
| 3.5 | History source | After a Tic-Tac-Toe win, a chat message and an exchange | Rows read "Tic-Tac-Toe win", "Chat with NOVA", "Coin exchange" |
| 3.6 | No duplicate rows | Trigger a history reload (exchange, then navigate away and back) | Every transaction id appears exactly once |

## 4. Coin Exchange

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 4.1 | Exchange with insufficient coins | Wallet shows 0 coins → click "Exchange 10 coins" | Button is disabled |
| 4.2 | Exchange success | Earn 10 coins → Wallet → click "Exchange 10 coins" | Toast: "Exchanged 10 coins → 1 AI credit". Credits +1, coins −10 |
| 4.3 | Double exchange | Click exchange twice quickly | Only one exchange processes |

## 5. Games Hub

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 5.1 | Hub contents | Open games | Cards for Tic-Tac-Toe, Sudoku, Ball Run, Water Sort with their reward lines |
| 5.2 | Coin balance line | Open games with a wallet | Line reports how many NOVA Coins you currently hold |
| 5.3 | Reward copy | Read each card | Tic-Tac-Toe 10 coins + 25 XP, Sudoku 20 + 40, Ball Run 15 + 30, Water Sort 15 + 35 |

## 6. Tic-Tac-Toe

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 6.1 | Start game | games → Tic-Tac-Toe | 3×3 board appears with the reward message |
| 6.2 | Player move | Click an empty cell | X appears in the cell |
| 6.3 | Computer move | After player moves | O appears in a different cell |
| 6.4 | Win | Win a round | Toast: "Won 10 coins + 25 XP". Wallet updates |
| 6.5 | Loss | Lose a round | No coins awarded, no toast |
| 6.6 | Draw | Play to a draw | Draw message, no coin reward |
| 6.7 | New round | Click "New round" | Board and status reset |
| 6.8 | Disabled during submit | Win → while the result is recorded | Cells are not clickable during submission |
| 6.9 | Post-game hand-off | After a server-confirmed win, use the "continue to chat" action | Chat opens with the suggestion chip pre-filling the composer (nothing is sent until you press Send) |

## 7. Sudoku

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 7.1 | Puzzle selection | Open Sudoku | Three puzzle cards with empty-cell counts |
| 7.2 | Start puzzle | Click a puzzle card | 9×9 grid, timer running, locked cells |
| 7.3 | Place number | Click empty cell → number pad | Number appears in cell |
| 7.4 | Clear cell | Click filled cell → × | Cell cleared |
| 7.5 | Keyboard input | Press 1–9 / Backspace / arrows | Place, clear, move selection |
| 7.6 | Conflict highlight | Place a duplicate in a row/column/box | Cell turns red |
| 7.7 | Mistake counter | Place an incorrect number | Counter increments |
| 7.8 | Puzzle completion | Fill the board correctly | Toast: "Puzzle solved! +20 coins +40 XP" |
| 7.9 | Quit / New puzzle | Use "Quit" and "New Puzzle" | Returns to the menu / resets the board |

## 8. Ball Run

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 8.1 | Start | games → Ball Run → start the run | Countdown/obstacle course begins; status line explains the 60-second goal |
| 8.2 | Survive 60s | Finish a full run | Toast: "Run cleared +15 coins +30 XP"; wallet and XP update |
| 8.3 | Early exit | Quit before 60s | No reward; status reports how long you survived |
| 8.4 | Back control | Use the back control | Returns to the games hub without losing progress elsewhere |

## 9. Water Sort

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 9.1 | Start | games → Water Sort | Tubes with mixed colours, move counter, reward line |
| 9.2 | Legal moves | Pour between tubes | Liquid moves only when the top colours match or the target is empty |
| 9.3 | Completion | Sort every tube to a single colour | Toast: "Puzzle solved +15 coins +35 XP"; move count shown |
| 9.4 | Reset | Restart the puzzle | Board and counter reset, no reward for the abandoned attempt |

## 10. Chat

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 10.1 | Chat screen | Click chat | Threads sidebar, composer, last active thread loads |
| 10.2 | Send with credits | Have 1+ credits → send a message | Streaming reply appears; credit decremented on completion |
| 10.3 | Send without credits | 0 credits | Composer disabled, placeholder tells you to exchange coins |
| 10.4 | New thread | Click "New chat" → send | A conversation is created and titled from your first message |
| 10.5 | Rename / delete thread | Use the thread row controls | Title updates / thread disappears; other threads untouched |
| 10.6 | Error + retry | Disconnect the network → send | Error bar with Retry; the prompt is restored and no duplicate bubble is added on retry |
| 10.7 | Error dismiss | Click "Dismiss" | Error bar disappears |
| 10.8 | History across refresh | Send messages → refresh → open Chat | Messages load from the server for that thread |
| 10.9 | Export | Click "Export" with ≥2 messages | A Markdown file downloads with the conversation |
| 10.10 | See (vision) mode | Attach an image → send | NOVA replies about the image; the attachment is stored in your own folder |
| 10.11 | Vision without image | See mode with no attachment | Sending is blocked: attach an image first |
| 10.12 | Draw mode | Select "Draw" → send | An image reply is rendered with its caption |
| 10.13 | Speak mode | Select "Speak" → send | Reply arrives with playable audio |
| 10.14 | Post-game re-entry | After a completed Tic-Tac-Toe/Sudoku round, continue to chat | Context is attached to your next message only; a following message carries no session reference |
| 10.15 | Demo mode chat | Chat without Supabase | Local echo: your message + canned NOVA response |

## 11. Progression

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 11.1 | Overview | Open progression | Streak, coins and credits cards render |
| 11.2 | Game progression | After playing each game | Per-game played/won/best rows are accurate |
| 11.3 | Achievements | Before/after milestones | Locked vs earned states with earned timestamps |
| 11.4 | Recent activity | After playing | Latest results with outcome labels |

## 12. Profile

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 12.1 | Profile load | Click profile | Display name, level, XP bar, balances, streak |
| 12.2 | Account email | Look under the stat cards | Signed-in email is shown with a Sign out button |
| 12.3 | Display name edit | Click Edit → change name → Save | Toast/status: "Display name updated."; invalid names are rejected |
| 12.4 | Tic-Tac-Toe stats | After playing | Played, Won, Win Rate, Losses/Draws |
| 12.5 | Sudoku stats | After playing Sudoku | Puzzles Solved, Played, Success Rate |
| 12.6 | Ball Run / Water Sort stats | After playing those games | "MORE GAME STATS" cards appear (hidden while you have never played) |
| 12.7 | Recent activity | After playing games | Last 5 results with Won/Lost/Draw and timestamps |
| 12.8 | Leaderboard | After earning XP | Your rank and the top 50 appear |
| 12.9 | NOVA Insight | Check profile | Insight text reflects your stats |
| 12.10 | Account deletion | Danger zone → type DELETE → confirm | Account and personal rows deleted; app returns to sign-in |

## 13. Error States

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 13.1 | Network failure | Disconnect network → play a game, exchange, or chat | Error toast/message, never a blank screen |
| 13.2 | Invalid session | Clear site data → refresh | Redirected to sign-in |
| 13.3 | Threads unavailable | Force a threads load failure | Sidebar shows its own error with a retry |

## 14. Demo Mode

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 14.1 | Demo activation | Run with no `.env` (or empty `VITE_SUPABASE_URL`) | App loads without sign-in; "DEMO" badge in top bar |
| 14.2 | Demo starting balance | Check wallet | 20 NOVA Coins, 0 AI Credits |
| 14.3 | Demo exchange | Wallet → exchange | Coins down 10, credits up 1 |
| 14.4 | Demo games | Play all four games | Games run locally; no server rewards are credited |
| 14.5 | Demo chat | Send a message | Local echo, no Gemini call |
| 14.6 | Demo footer | Read the footer | "Demo mode — balances are local to this browser session." |

---

## 10. Demo Mode

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 10.1 | Demo activation | Run with no `.env` file (or empty `VITE_SUPABASE_URL`) | App loads without sign-in screen. "DEMO" badge in top bar |
| 10.2 | Demo starting balance | Check wallet | 20 NOVA Coins, 0 AI Credits |
| 10.3 | Demo exchange | Go to Wallet → click "Exchange 10 coins" | 10 coins deducted, 1 AI credit added. Toast confirms |
| 10.4 | Demo games | Play all four games | Games run locally; no server rewards are credited |
| 10.5 | Demo balances | Check wallet after wins | Balances update locally. Refresh resets them |
| 10.6 | Demo chat | Send a message in chat (after exchanging for 1+ credit) | Local echo response (no server call) |
| 10.7 | Demo footer | Check footer text | Shows: "Demo mode — balances are local to this browser session." |

---

## Production Pre-Deployment Checklist

- [ ] All 30 migrations applied in order (`supabase db push` — see `DATABASE.md` for the table)
- [ ] All 7 Edge Functions deployed (`supabase functions deploy process-tictactoe process-sudoku process-ball-run process-water-sort nova-chat exchange-nova-coins delete-account`)
- [ ] `GEMINI_API_KEY` set in Supabase secrets (`GEMINI_TEXT_MODEL` / `GEMINI_VISION_MODEL` / `GEMINI_IMAGE_MODEL` / `GEMINI_TTS_MODEL` optional overrides)
- [ ] `.env` configured with production `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
- [ ] `npm run lint` exits 0 and `npm run build` completes without errors
- [ ] `supabase/tests/` suite green (apply `phase7_setup_temp_user.sql` before `phase7_account_deletion.test.ts`)
- [ ] `dist/` deployed to hosting provider
- [ ] Sign up / sign in works on the deployed URL
- [ ] Every game awards coins and XP after a server-confirmed completion
- [ ] Exchange converts coins to credits; chat sends a message and receives a Gemini response
- [ ] Chat threads, attachments and all four modes work on the deployed URL
- [ ] Demo mode still works when env vars are unset
- [ ] No secrets or API keys in the built JavaScript bundle
