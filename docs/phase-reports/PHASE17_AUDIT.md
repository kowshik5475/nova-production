# NOVA — Phase 17 Audit

**Date:** 2026-10-02
**Scope:** Security Hardening, Performance & Deployment Readiness

---

## 1. Phase 16 Findings (Recap)

The Phase 16 audit identified 9 remaining limitations:

| # | Limitation | Priority |
|---|---|---|
| 1 | Completion RPCs can be directly called/farmed | Critical |
| 2 | No application-level per-user AI rate limiting | High |
| 3 | Storage objects orphaned after account deletion | High |
| 4 | All games in single ~687 kB bundle | Medium |
| 5 | TTS requires `GEMINI_TTS_MODEL` config | Medium |
| 6 | Image generation requires `GEMINI_IMAGE_MODEL` config | Medium |
| 7 | Manual accessibility audit not performed | Medium |
| 8 | Production CORS/domain configuration remains | High |
| 9 | PWA support remains optional | Low |

---

## 2. Current Security Architecture

### Game Completion Flow

```
CLIENT
  │
  ├─ Edge Function (process-*.ts)
  │     │
  │     ├─ validates what it can (_shared/*_validate.ts)
  │     └─ calls completion RPC (complete_*_game)
  │           │
  │           ├─ validates session ownership, idempotency, session state
  │           └─ writes game_results, wallet, wallet_transactions,
  │               game_progress, profiles.xp/level, user_achievements,
  │               touch_user_streak()
  │
  │ Reward constants are literals in RPC body (10/25 TTT, 20/40 Sudoku,
  │ 15/30 Ball Run win, 15/35 Water Sort)
  │
  │ One reward per session (game_completions UNIQUE + game_results.session_id constraint)
  │
  │ session_id server-stamped by BEFORE INSERT trigger
  │
V
EDGE FUNCTION
  │
  └─ performs strongest validation it can

CLIENT (direct RPC call — bypasses Edge Function)
  │
  └─ completion RPC trusts p_outcome/p_puzzle_id/p_move_count/timing
     — reward constants enforced in SQL
     — one reward per session constraints intact
     — direct call can farm sessions without playing
```

### AI Credit Flow

```
USER REQUEST
  │
  │ authenticate
  │
  ▼
reserve_chat_credit  →  debits 1 AI credit, records reservation
  │                   │
  │                   ▼
  │              Gemini provider call
  │                   │
  │                   ▼
  │           finalize_chat_credit  or  release_chat_credit
  │                   │
  │                   ▼
  │              AI_USAGE ledger entry + thread bookkeeping
  │
RATE LIMITING: NOT YET IMPLEMENTED — credit cost is the only brake
```

### Storage Architecture

- Bucket: `chat-attachments`, private (`public = false`)
- Owner-scoped policies: `(storage.foldername(name))[1] = auth.uid()::text`
- Edge Function validates every path with `isOwnerPath()` / `checkImageAttachment()`
- User folders: `{auth.uid()}/{uuid}.{ext}`
- Edge Function writes via `mediaObjectPath(ownerId, ext)`
- UI reads via 3600s signed URLs (in memory only)

### Account Deletion Flow

1. POST only, CORS-checked, `Authorization` required and verified
2. Body must contain `confirmation === 'DELETE'`
3. Service-role client created after JWT verification
4. `admin.auth.admin.deleteUser(user.id)` — self-deletion only
5. FK cascades remove personal rows: `profiles`, `wallet`, `wallet_transactions`,
   `chat_messages`, `chat_requests`, `chat_conversations`, `exchange_requests`,
   `game_completions`, `game_sessions` → `game_results`, `game_progress`,
   `user_achievements`, `leaderboard`
6. `audit_log.user_id` is `ON DELETE SET NULL`
7. Global catalogs (`games`, `achievements`) untouched

**Limitation:** Storage objects uploaded to `chat-attachments` are not deleted.

---

## 3. Current Game Completion Architecture

### Existing Security Properties (verified)

- Identity from `auth.uid()`; session must belong to caller, be `game_id`-correct and `status = 'STARTED'`
- One reward per session (`game_completions (user_id, idempotency_key) UNIQUE` + explicit `game_results` existence check + unique constraint on `game_results.session_id`)
- Reward constants are literals inside the RPC — a caller can never choose an amount
- `started_at` is server-stamped by `BEFORE INSERT` trigger so a client cannot backdate a run
- `touch_user_streak()` is revoked from `public`, `anon`, `authenticated` — callable only from other definer functions

### Current Vulnerability

Completion RPCs (`complete_tictactoe_game`, `complete_sudoku_game`, `complete_ball_run_game`, `complete_water_sort_game`) are `grant execute … to authenticated`, so they are callable directly through PostgREST without going through an Edge Function. Validation lives in the Edge Functions, not in the database.

### Specific Per-Game Direct-Call Vulnerabilities

| Game | RPC trusts if called directly | Edge Function derives |
|---|---|---|
| Tic-Tac-Toe | `p_outcome` (only checked ∈ `win`/`loss`/`draw`) | final board → outcome (`_shared/tictactoe_validate.ts`) |
| Sudoku | `p_puzzle_id` (only checked ∈ `0,1,2`) | all 81 cells vs the known solution for the chosen puzzle |
| Ball Run | nothing timing-related beyond what it derives itself | server clock from `started_at`, ±3s `claimMatchesServer` check |
| Water Sort | `p_move_count` (only checked ∈ `1..400`) | full replay of the move list against the puzzle stored in `session_data` |

---

## 4. Current AI Rate Limiting

**Status:** Not implemented.

The credit system (`reserve → provider → finalize/release`) provides economic braking, but there is no per-user request throttling. An authenticated user can make unlimited AI request attempts, each consuming a credit on failure and releasing it. The `stale reserved rows older than 5 minutes are converted and refunded` mechanism helps, but does not prevent rapid sequential requests.

**Required:** Application-level AI request throttling that happens before expensive provider calls.

---

## 5. Current Storage Cleanup on Account Deletion

**Limitation:** Account deletion removes the auth user but uploaded files remain in Supabase Storage. The `delete-account` Edge Function cascades FK deletions for database rows but does not touch Storage objects.

**Current Flow:** When account deletion occurs:
1. JWT identity verified
2. Service-role client created
3. `admin.auth.admin.deleteUser(user.id)` — self-deletion only
4. FK cascades remove personal database rows
5. Global catalogs (`games`, `achievements`) untouched
6. **Storage objects orphaned** — user's files in `chat-attachments` bucket remain

---

## 6. Current Bundle Structure

- All four games + chat + progression + wallet shipped in single Vite bundle
- gzip size: ~687 kB
- No code splitting — all game implementations loaded on app start
- Home/Chat experience loads game modules unnecessarily

**Expected improvement with code splitting:**
- Initial application bundle should be smaller
- Game modules loaded lazily after hub selection
- Tradeoff: lazy loading overhead vs. reduced initial load

---

## 7. TTS / Image Generation Configuration

- `GEMINI_TTS_MODEL` — falls back to `gemini-2.5-flash-preview-tts`; not enabled by default
- `GEMINI_IMAGE_MODEL` — falls back to `gemini-2.5-flash-image`; not enabled by default
- Both are read from Edge Function `Deno.env.get()`, never hardcoded in frontend
- When unset, UI gracefully disables the capability

---

## 8. Production CORS Configuration

- `CORS_ALLOWED_ORIGINS` — comma-separated production origins in Edge Function secrets
- Local dev origins always added by `cors.ts` (localhost:5173, :4173, :3000)
- Production must use explicit allowed origins; `Access-Control-Allow-Origin: *` not used for authenticated APIs
- Local development unaffected when `CORS_ALLOWED_ORIGINS` is unset

---

## 9. Planned Phase 17 Changes

| # | Change | Priority | Type |
|---|---|---|---|
| 1 | Game RPC hardening — prevent direct farming | Critical | Security |
| 2 | AI rate limiting — server-side per-user throttling | High | Performance/Security |
| 3 | Storage cleanup on account deletion | High | Security |
| 3 | Code splitting for games | Medium | Performance |
| 4 | Image generation verification | Medium | Feature validation |
| 5 | TTS verification | Medium | Feature validation |
| 5 | Accessibility audit | Medium | Quality |
| 6 | Production CORS documentation | Medium | Deployment |
| 7 | Environment security audit | High | Security |
| 8 | Database security audit | High | Security |
| 8 | Full regression testing | High | Quality |
| 9 | PWA (optional, safe only) | Low | Feature |

---

## 10. Exact Changes Planned

1. **Game RPC hardening** — implement internal authorization mechanism to prevent direct RPC farming
2. **AI rate limiting** — add PostgreSQL-backed per-user rate limiter with configurable windows
3. **Storage cleanup** — add Storage object deletion to `delete-account` Edge Function
4. **Code splitting** — lazy-load game components with `React.lazy` + `Suspense`
5. **Accessibility audit** — perform manual review, document fixes
6. **Production CORS** — document and configure production allowed origins
7. **Environment security audit** — verify no secrets in frontend, verify all secrets in Edge Functions
8. **Database security audit** — verify all RPCs follow SECURITY DEFINER pattern
9. **Full regression** — run all existing tests + new Phase 17 tests
10. **Final reports** — PHASE17_Security_Report.md, PHASE17_Performance_Report.md, PHASE17_Final_Report.md

---

## 11. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| RPC hardening breaks Edge Function flow | Edge Function path unchanged; hardening only affects direct RPC calls |
| Rate limiting blocks legitimate use | Configurable limits; reasonable defaults; cooldown after window |
| Storage cleanup causes data loss | Safe retry; only user's own files deleted; service-role used only in delete-account |
| Code splitting degrades UX | Lazy loading only after hub selection; useful fallback; refresh works |
| Accessibility fixes break visual design | Preserve NOVA design; only fix genuine issues; no superficial changes |
| CORS misconfiguration breaks production | Documented config; local dev unaffected; production explicit origins only |

---

## 12. Dependencies & Constraints

**Must preserve:**
- All existing RPCs and their signatures
- All existing RLS policies
- All existing SECURITY DEFINER pattern
- All existing test suites (320 tests, 0 failures)
- All existing wallet/economy logic
- All existing game completion idempotency
- All existing chat credit reservation/release

**Constraints:**
- No frontend secrets
- No static client-side bypass tokens
- No trust of client-provided validated state
- No localStorage for security-critical data
- No Redux or state-management framework addition
- No major architectural rewrite

---

## 12. Next Steps

1. Create `PHASE17_AUDIT.md` (in progress)
2. Implement game RPC hardening
3. Add `phase17_game_rpc_security.test.ts`
4. Implement AI rate limiting
5. Add `phase17_ai_rate_limit.test.ts`
6. Add Storage cleanup to `delete-account`
7. Add `phase17_storage_cleanup.test.ts`
8. Implement code splitting for games
9. Perform accessibility audit
10. Document production CORS
11. Run environment security audit
11. Run database security audit
11. Run full regression suite
12. Create all Phase 17 final reports

---

## 13. Phase 17 Definition of Done

[ ] Direct game reward farming is blocked
[ ] Game Edge Functions still work
[ ] AI rate limiting is server-side
[ ] AI credits remain atomic
[ ] Account deletion cleans user Storage
[ ] Game code is lazy-loaded
[ ] Initial bundle improves or tradeoff is documented
[ ] Image generation is verified/configured
[ ] TTS is verified/configured or clearly marked unavailable
[ ] Accessibility review completed
[ ] Production CORS is documented/configured
[ ] No frontend secrets
[ ] Existing RLS remains intact
[ ] Existing SECURITY DEFINER model remains intact
[ ] Existing 320 tests still pass
[ ] New Phase 17 security tests pass
[ ] npm run lint passes
[ ] npm run build passes
[ ] Deployment documentation exists
[ ] Production smoke test exists
[ ] PHASE17_Final_Report.md exists