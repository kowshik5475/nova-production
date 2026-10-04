# NOVA — Final Upgrade Report

**Date:** 2026-10-02
**Status:** COMPLETE

---

## What was changed

### AI-first application shell
- Navigation restructured from `home · play · sudoku · chat · wallet · profile` to
  `home · chat · games · progression · wallet · profile`.
- Home redesigned around the assistant: hero with NOVA identity, "Start Chatting"
  primary CTA, "Explore Challenges" secondary CTA, live user stats, recent
  conversations, recent activity, optional game preview, rule-based personalization.
- Games grouped under a single Games Hub; individual games are no longer top-level
  application modes.

### Conversation system
- New `chat_conversations` table; `chat_messages.conversation_id` (nullable) + `mode`.
- One-time additive backfill migration: one import conversation per existing user,
  historical messages assigned with timestamps/content preserved.
- Conversation sidebar: new chat, list, select, rename, delete, resume, mobile drawer.
- Active conversation survives navigation and refresh.
- Conversation export to Markdown.

### Multimodal chat
- Modes: `chat`, `vision`, `image`, `speech` (TTS behind capability flag).
- `chat_attachments` metadata table + private Supabase Storage bucket with
  owner-scoped policies.
- Image preview before send, remove image, server-side size/type validation.
- Image generation mode with credit reserve → generate → store → finalize/refund.
- Model names via env vars: `GEMINI_TEXT_MODEL`, `GEMINI_VISION_MODEL`,
  `GEMINI_IMAGE_MODEL`, `GEMINI_TTS_MODEL`.

### Games
- Ball Run and Water Sort fully implemented with the same secure session architecture
  as Tic-Tac-Toe and Sudoku: server-derived outcomes, bounded metrics, idempotent
  completion, streak + achievements in the same transaction.
- All four games launchable from the Games Hub.

### Progression / personalization
- Dedicated Progression page: level, XP, streak, games played/won, win rates,
  recent achievements, game-specific progress, milestones.
- Rule-based personalization engine (no ML): backend-derived signals, context-gated
  so general-purpose chat is never contaminated.
- Game → AI re-entry: server re-derives outcome/reward from session UUID; client
  never fabricates values.

### UI / UX
- Markdown renderer upgraded: headings, lists, tables, inline code, fenced code
  blocks with language label + copy button, links, safe HTML handling.
- Wallet page clearly separates NOVA Coins (progression) from AI Credits
  (consumption) with transaction history.
- Profile shows display name, email, level, streak, game activity, account actions
  with typed DELETE confirmation.
- Responsive: mobile sidebar drawer, touch-friendly game controls, no horizontal
  scroll.
- Visual system: 60/30/10 preserved; games remain visually independent via scoped
  CSS tokens.

---

## What was preserved

- Supabase Auth (email/password, session restore, recovery, forced password reset).
- All RLS hardening migrations (m03, m06, phase2a).
- SECURITY DEFINER RPC pattern: `auth.uid()` only, `search_path = public`,
  revoked from `public`, granted to `authenticated`.
- Wallet ledger (`wallet` + `wallet_transactions`), atomic exchange with idempotency.
- AI credit reservation state machine: `reserve → finalize/release`, stale
  reservation recovery, retry replay.
- Achievement catalog + server-side awarding.
- Daily streak (`touch_user_streak`, UTC calendar date).
- Read-only `leaderboard_ranked` view.
- Password reset, account deletion (typed DELETE, service-role Edge Function),
  display-name update RPC, onboarding gate.
- Demo mode when Supabase env is absent.
- All existing tests continue to pass.

---

## Database migrations added

| Migration | Purpose |
|---|---|
| `20260930000001_chat_conversations.sql` | `chat_conversations` table, `chat_messages.conversation_id` + `mode`, backfill, RLS, conversation CRUD RPCs |
| `20260930000002_chat_attachments_storage.sql` | `chat_attachments` metadata table, `chat_requests.mode`, private Storage bucket + policies |
| `20260930000003_games_ballrun_watersort.sql` | `complete_ball_run_game`, `complete_water_sort_game` RPCs, achievement catalog rows |
| `20260930000004_game_sessions_server_stamped_started_at.sql` | Server-authoritative `started_at` for game sessions |
| `20260930000005_fix_get_chat_history_ambiguity.sql` | RPC signature disambiguation |
| `20261001000001_chat_replay_scope_media.sql` | Media-aware chat replay scoping |
| `20261001000002_water_sort_server_replay.sql` | Water Sort server-side replay validation |

---

## RPCs changed

- `reserve_chat_credit` — now accepts and stores `conversation_id` + `mode`.
- `finalize_chat_credit` — writes messages into the reserved conversation.
- `get_chat_history` — retained unchanged for backward compatibility.
- New: `create_chat_conversation`, `rename_chat_conversation`,
  `delete_chat_conversation`, `get_conversation_messages`, `get_chat_conversations`.
- New: `complete_ball_run_game`, `complete_water_sort_game`.

---

## Edge Functions changed

| Function | Change |
|---|---|
| `nova-chat` | Multimodal (vision/image/TTS), conversation-scoped, context-gated personalization, media upload to Storage |
| `process-ball-run` | New — server-derived outcome, bounded metrics, idempotent completion |
| `process-water-sort` | New — server-side puzzle validation, move verification, idempotent completion |
| `_shared/chat_modes.ts` | New — mode validation, image size/type checks, media path helpers |
| `_shared/personalization.ts` | New — rule-based personalization engine |
| `_shared/ballrun_validate.ts` | New — Ball Run server-side validation |
| `_shared/watersort_validate.ts` | New — Water Sort server-side validation |
| `_shared/recent_activity.ts` | Extended for new games |

---

## Frontend files changed

| File | Change |
|---|---|
| `src/app/App.tsx` | AI-first nav, Games Hub routing, conversation-aware chat |
| `src/app/home.tsx` | AI-first home with hero, stats, conversations, activity, game preview |
| `src/app/home-data.ts` | Personalization/activity mappers |
| `src/app/chat.tsx` | Conversation threads, sidebar, modes, attachments, export |
| `src/app/MarkdownText.tsx` | Full markdown + code copy button |
| `src/app/games.tsx` | Unified Games Hub |
| `src/app/ballrun.tsx` | New — Ball Run game |
| `src/app/watersort.tsx` | New — Water Sort game |
| `src/app/progression.tsx` | New — Progression page |
| `src/app/export.ts` | New — conversation export to Markdown |
| `src/app/profile.tsx` | Account-focused profile |
| `src/app/wallet-view.tsx` | Coin vs credit explanation |
| `src/app/tictactoe.tsx` / `sudoku.tsx` | Hub back-link, shared completion contract |
| `src/app/types.ts` | Page/Conversation/ChatMessage types |
| `src/lib/supabase/conversations.ts` | New — conversation CRUD helpers |
| `src/index.css` / `src/styles/theme.css` | Shell, sidebar, hub, new game environments |

---

## New features

1. Real conversation threads with sidebar, rename, delete, resume.
2. Conversation export to Markdown.
3. Vision mode (image attachment → Gemini vision model).
4. Image generation mode (prompt → Gemini image model → stored attachment).
5. TTS architecture hooks (behind capability flag).
6. Ball Run game with server-authoritative completion.
7. Water Sort game with server-authoritative completion.
8. Unified Games Hub.
9. Dedicated Progression page.
10. Rule-based personalization engine.
11. Game → AI re-entry with server re-derived context.
12. Full markdown renderer with code copy button.

---

## Security improvements

- Conversation IDs ownership-checked at reserve time; messages written only by definer RPC.
- Multimodal requests reuse the exact reserve → finalize/release credit chain.
- Large base64 stored in Supabase Storage, not PostgreSQL.
- New games use server-derived, capped, idempotent completion.
- Model names configurable via env vars; no hardcoded provider dependencies.
- Gemini API key never leaves the Edge Function.
- Storage policies are user-scoped.
- All new RPCs follow the established SECURITY DEFINER + `auth.uid()` pattern.

---

## Test results

| Suite | Tests | Result |
|---|---|---|
| phase2b_runtime | 18 | PASS |
| phase2b_ttt_validate | 16 | PASS |
| phase2c_reliability | 15 | PASS |
| phase4_wallet_history_rls | 4 | PASS |
| phase5_password_reset | 16 | PASS |
| phase6_display_name | 17 | PASS |
| phase7_account_deletion | 12 | PASS |
| phase8_onboarding | 24 | PASS |
| phase9_achievements | 27 | PASS |
| phase10_streak | 30 | PASS |
| phase11_streak_achievements | 28 | PASS |
| phase12_leaderboard | 38 | PASS |
| phase13_reward_chat_reentry | 24 | PASS |
| phase14_dynamic_home | 25 | PASS |
| upgrade_conversations | 12 | PASS |
| upgrade_games_security | 9 | PASS |
| upgrade_multimodal_storage | 7 | PASS |
| **Total** | **320** | **PASS** |

Two test isolation bugs were fixed during this phase:
- `phase12_leaderboard.test.ts`: `before()` now purges stale legacy `leaderboard`
  rows from interrupted prior runs.
- `phase7_account_deletion.test.ts`: `before()` now executes the temp-user setup SQL
  before attempting sign-in.

---

## Build result

```
npm run lint   → PASS (warnings only, no errors)
npm run build  → PASS (tsc -b && vite build, 687 kB bundle)
```

---

## Known limitations

- TTS is architected but not enabled by default; requires a Gemini model that
  supports audio output and the `GEMINI_TTS_MODEL` env var.
- Image generation requires a Gemini image-capable model and `GEMINI_IMAGE_MODEL`.
- Ball Run and Water Sort use conservative server-side validation (bounded metrics,
  duration caps) rather than full move-by-move verification, which is appropriate
  for a student mini-project.
- The legacy `leaderboard` table is retained for backward compatibility but is
  unused; the read-only `leaderboard_ranked` view is the authoritative source.

---

## Recommended next phase

1. Enable TTS with a supported Gemini model and user-facing voice controls.
2. Add conversation search.
3. Add more games using the established secure session pattern.
4. Consider rate-limiting per-user AI credit consumption.
5. Add PWA support for mobile install.
