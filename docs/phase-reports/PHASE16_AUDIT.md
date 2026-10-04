# NOVA — Phase 16 Audit

**Date:** 2026-10-02
**Scope:** Stabilization, verification & final production polish

---

## 1. Current feature status

| Feature | Status | Notes |
|---|---|---|
| AI-first Home | IMPLEMENTED | Hero, Start Chatting CTA, live stats, recent conversations, activity, game preview, personalization |
| Conversation threads | IMPLEMENTED | Sidebar, CRUD, rename, delete, resume, URL sync, export to Markdown |
| Vision mode | IMPLEMENTED | Image attachment, preview, server validation, Gemini vision model |
| Image generation | IMPLEMENTED | Prompt → Gemini → Storage → attachment metadata, credit reserve/finalize/release |
| TTS / Speech mode | ARCHITECTED | Behind capability flag; `GEMINI_TTS_MODEL` env var; graceful degradation |
| Games Hub | IMPLEMENTED | 4 games: Tic-Tac-Toe, Sudoku, Ball Run, Water Sort |
| Ball Run server validation | IMPLEMENTED | Server-stamped `started_at`, 5s/120s window, `claimMatchesServer` ±3s |
| Water Sort server validation | IMPLEMENTED | BFS puzzle generation, move replay, par-based scoring |
| Progression page | IMPLEMENTED | Level, XP, streak, achievements, game progress, leaderboard |
| Personalization engine | IMPLEMENTED | Rule-based, context-gated, server-derived signals |
| Game → AI re-entry | IMPLEMENTED | `PostGameContext` with session UUID only; server re-derives all context |
| Wallet | IMPLEMENTED | NOVA Coins vs AI Credits, atomic exchange, transaction history |
| Auth | IMPLEMENTED | Sign up/in/out, password reset, forced reset, account deletion |
| Responsive UI | IMPLEMENTED | Mobile sidebar drawer, touch controls, breakpoints |
| Markdown renderer | IMPLEMENTED | Headings, lists, tables, code blocks with copy button |

## 2. Current known limitations

1. **TTS not enabled by default** — requires `GEMINI_TTS_MODEL` and a Gemini model supporting audio output.
2. **Image generation requires config** — `GEMINI_IMAGE_MODEL` must be set; UI shows capability unavailable otherwise.
3. **Ball Run has no anti-idle proof** — server clock window prevents backdating but cannot prove active play.
4. **Water Sort RPC trusts `p_move_count`** — bounded 1–400 but no move replay in SQL; Edge Function does the replay.
5. **Completion RPCs are directly callable** — a scripted caller can invoke `complete_*_game` RPCs without the Edge Function. Damage bounded to fixed constants per session.
6. **No application-layer rate limiting** — only Supabase Auth rate limits apply.
7. **Storage objects orphaned after account deletion** — `delete-account` removes the auth user but not uploaded files.
8. **Single JS bundle** — no code splitting; all games ship in one bundle (~687 kB).
9. **Legacy `leaderboard` table unused** — retained for backward compatibility; the view is authoritative.
10. **`audit_log` has no writer** — table exists but no function inserts rows.

## 3. Current lint warnings

18 warnings across 7 files. Classification:

| File | Warning | Classification |
|---|---|---|
| `src/lib/supabase.ts:81` | `set-state-in-effect` | **C — Intentional**: `setLoading(false)` in effect is the standard pattern for async data fetching; the effect depends on `[]` and runs once |
| `src/lib/supabase/wallet.ts:57` | `set-state-in-effect` | **C — Intentional**: Same pattern; `fetchWallet` is called from effect on session change |
| `src/app/ballrun.tsx:168` | `immutability` (tick self-reference) | **B — Maintainability**: `tick` references itself in `requestAnimationFrame(tick)` inside `useCallback`. Works correctly but could use a named function expression |
| `src/app/sudoku.tsx:142` | `purity` (Math.random in render) | **C — Intentional**: `Math.random()` for puzzle selection is called inside `startSudokuGame`, not during render — false positive from the linter's flow analysis |
| `src/app/sudoku.tsx:175` | `set-state-in-effect` | **C — Intentional**: Auto-complete check effect; standard React pattern |
| `src/app/sudoku.tsx:199` | `exhaustive-deps` (unnecessary `supabase` dep) | **B — Maintainability**: `supabase` is a module-level import, not a reactive value |
| `src/app/sudoku.tsx:219` | `exhaustive-deps` (missing `placeSudokuNumber`, `clearSudokuCell`) | **B — Maintainability**: These are stable function declarations; the effect re-registers on board/selection change which is the intent |
| `src/app/profile.tsx:44` | `purity` (Date.now × 3) | **C — Intentional**: Demo mode static data; `Date.now()` is only called in the demo initial state, not during render |
| `src/app/profile.tsx:107` | `exhaustive-deps` (unnecessary `supabase` dep) | **B — Maintainability**: Same as sudoku |
| `src/app/profile.tsx:254` | `exhaustive-deps` (unnecessary `supabase` dep) | **B — Maintainability**: Same |
| `src/app/chat.tsx:701` | `refs` (ref access during render) | **A — Real bug risk**: `chatRetryRef.current` is read during render to conditionally show the Retry button. This works but violates React's render purity |
| `src/app/chat.tsx:199` | `set-state-in-effect` | **C — Intentional**: `refreshThreads` call after mount |
| `src/app/chat.tsx:266` | `exhaustive-deps` (unnecessary `supabase` dep) | **B — Maintainability**: Same |

**Summary:** 1 potential real issue (chat.tsx ref-in-render), 7 maintainability items, 10 intentional/false positives.

## 4. Current environment requirements

### Frontend (`.env`)
| Variable | Required | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | Yes (for non-demo) | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Yes (for non-demo) | Supabase anon key |

### Edge Function secrets
| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | Yes (for AI) | Gemini provider key |
| `GEMINI_TEXT_MODEL` | No | Text model (fallback: `GEMINI_MODEL` → `gemini-3.6-flash`) |
| `GEMINI_VISION_MODEL` | No | Vision model (fallback: `GEMINI_TEXT_MODEL`) |
| `GEMINI_IMAGE_MODEL` | No | Image generation model (fallback: `gemini-2.5-flash-image`) |
| `GEMINI_TTS_MODEL` | No | TTS model (fallback: `gemini-2.5-flash-preview-tts`) |
| `GEMINI_TTS_SAMPLE_RATE` | No | TTS sample rate (fallback: `24000`) |
| `CORS_ALLOWED_ORIGINS` | No | Comma-separated production origins |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes (for delete-account) | Service role key |

### Supabase project
- Linked project with all 30 migrations applied
- 7 Edge Functions deployed
- Storage bucket `chat-attachments` created (via migration)

## 5. Current Gemini configuration

All model names are environment-driven with safe fallbacks:

```
GEMINI_TEXT_MODEL → GEMINI_MODEL → 'gemini-3.6-flash'
GEMINI_VISION_MODEL → GEMINI_TEXT_MODEL
GEMINI_IMAGE_MODEL → 'gemini-2.5-flash-image'
GEMINI_TTS_MODEL → 'gemini-2.5-flash-preview-tts'
```

- Frontend never receives `GEMINI_API_KEY` — only Edge Functions access it.
- Model names are not hardcoded in the frontend.
- Missing `GEMINI_API_KEY` produces a clear 500 error: `AI provider not configured`.
- Unsupported models fail gracefully with credit release.

## 6. Current Supabase requirements

- **Postgres 15+** (uses `gen_salt('bf')`, `crypt`, `pg_rewrite` catalog)
- **Supabase Auth** (GoTrue) for user management
- **PostgREST** for RLS-scoped reads
- **Storage** for private attachments
- **Edge Functions** (Deno) for AI and game processing
- **30 migrations** must be applied in correct order (core tables first)

## 7. Potential runtime risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Completion RPC called directly without Edge Function | Medium | Low — bounded reward per session | Documented in SECURITY.md §13; fixed reward constants |
| Stale credit reservation after process crash | Low | Low — auto-refunded after 5 min | `reserve_chat_credit` stale cleanup |
| Storage objects orphaned after account deletion | Medium | Low — no data leak, just storage waste | Documented; could add cleanup to `delete-account` |
| No rate limiting on AI requests | Medium | Medium — credit cost is the only brake | Could add per-user rate limiting |
| Single bundle load time | Low | Low — 687 kB gzip 195 kB | Could code-split if needed |
| Ball Run idle session payout | Medium | Low — bounded reward | Server clock window; documented limitation |

## 8. Recommended fixes

1. **Fix `chat.tsx:701` ref-in-render** — use state instead of ref for retry visibility
2. **Remove unnecessary `supabase` from dependency arrays** — module-level import, not reactive
3. **Fix `ballrun.tsx:168` tick self-reference** — use named function expression
4. **Document remaining intentional warnings** — add comments or eslint-disable where appropriate
5. **Consider code splitting** — lazy-load game components to reduce initial bundle
6. **Add Storage cleanup to `delete-account`** — remove orphaned files on account deletion
