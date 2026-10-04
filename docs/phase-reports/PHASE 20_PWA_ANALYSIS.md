# NOVA — Phase 20 PWA Safety Analysis

## 1. Purpose

Determine whether a safe PWA architecture is possible for NOVA without violating private-data correctness. This analysis answers the question: Can NOVA have a service worker that caches resources without exposing private user data?

## 2. Current State (Post-Phase 19)

### 2.1 Code Splitting
- Implemented via React.lazy() + Suspense + Vite manualChunks
- 6 JS chunks generated, 4 game chunks isolated
- Initial payload 35% reduced (687.38 kB → 446.41 kB gzip)
- Proven by actual build output

### 2.2 Security Baseline
All Phase 17 protections intact:
- RLS, SECURITY DEFINER RPCs, auth.uid()
- Game session ownership, server-derived outcomes
- AI rate limiting, credit reservation chain
- Storage user-prefix filtering, account deletion cleanup
- CORS explicit production origins
- No frontend secrets exposed

### 2.3 PWA Status (Phase 19)
- **Status**: DEFERRED
- **Reason**: Auth-aware service-worker strategy not established
- **Safety concern**: Caching private API responses would violate data isolation

## 3. Caching Boundary Classification

### 3.1 SAFE TO CACHE (Public/Non-Authenticated)

| Resource Category | Example | Safe to Cache? |
|---|---|---|
| HTML application shell | `index.html` | ✓ Yes (first visit only) |
| Compiled JavaScript | `*.js` bundles | ✓ Yes (immutable with content hashing) |
| Compiled CSS | `*.css` | ✓ Yes (immutable with content hashing) |
| Fonts | `*.woff, *.ttf` | ✓ Yes |
| Icons/logos | `*.png, *.svg` | ✓ Yes |
| Public images | NOVA branding | ✓ Yes |

### 3.2 DO NOT CACHE BY DEFAULT (Authenticated/Private)

| Resource Category | Supabase Endpoints | Safe to Cache? |
|---|---|---|
| Chat messages | `/rest/v1/chat_messages` | ✗ NO — contains user conversation history |
| Conversation history | `/rest/v1/chat_conversations` | ✗ NO — contains user thread data |
| Profile information | `/rest/v1/profiles` | ✗ NO — contains display name, XP, level, email |
| Wallet balances | `/rest/v1/wallet` | ✗ NO — contains NOVA Coins, AI Credits |
| Wallet transactions | `/rest/v1/wallet_transactions` | ✗ NO — contains financial ledger |
| AI credits status | `/rest/v1/ai_credits` | ✗ NO — consumption data |
| Game progress | `/rest/v1/game_progress` | ✗ NO — contains streak, XP, game-specific data |
| Game completion data | `/rest/v1/game_results` | ✗ NO — contains rewards, outcomes |
| Storage objects (private) | `chat-attachments/*` | ✗ NO — contains user images/attachments |
| Auth session data | `/auth/v1/*` | ✗ NO — contains session metadata |

### 3.3 Supabase-Specific Concerns

| Endpoint Pattern | Risk Level | Reason |
|---|---|---|
| `/rest/v1/*` (authenticated) | 🔴 High | RLS applies per-request, but cached responses could serve stale data |
| `/functions/v1/*` | 🔴 High | Edge Functions process authenticated requests; caching responses breaks idempotency |
| `/storage/v1/chat-attachments/*` | 🔴 High | Private attachments; user folder isolation would be bypassed |
| `/auth/v1/*` | 🔴 High | Session management; caching could interfere with Auth flow |

### 3.4 Why Caching Private Data Fails

1. **Stale data**: Service worker could serve cached chat messages from a previous conversation after a switch
2. **Data leakage**: Cached wallet balances from user A could appear for user B if origin is shared
3. **Idempotency breaks**: Credit reservation/finalization/release state machine could be confused by stale cached state
4. **Session invalidation**: Cached auth responses could persist after logout, causing Auth failures
5. **RLS bypass**: While RLS is per-request, cached responses ignore RLS policies entirely

## 4. PWA Option Assessment

### Option A — Safe PWA

**Not viable without significant architecture changes.**

Requirements that cannot be met with current NOVA architecture:
- ✗ Cannot cache `/rest/v1/` endpoints without risking data leakage
- ✗ Cannot cache `/functions/v1/nova-chat` responses without breaking credit idempotency
- ✗ Cannot cache Storage private attachments without bypassing user-folder isolation
- ✗ Cannot cache profile/wallet data without exposing another user's information

**Verdict**: ❌ DEFERRED — technical reasons prevent safe implementation without rewriting data-fetching architecture.

### Option B — Defer PWA

**Recommended.**

Rationale:
- ✓ No unsafe caching of private authenticated data
- ✓ Existing code splitting (Phase 19) provides performance benefits without PWA
- ✓ Maintains security boundaries established in Phases 17-19
- ✓ No service worker = no risk of incorrect caching
- ✓ Can revisit when auth-aware service worker strategy is designed

**Verdict**: ✓ DEFERRED — with documented technical reasons.

## 5. Recommended Path Forward

### 5.1 Immediate Decision
- **PWA: DEFERRED** with documented reasons (as determined in this analysis)
- No service worker implementation
- No web manifest deployment

### 5.2 Future Reconsideration (Phase 21+)
When a safe PWA architecture is designed:
1. **Authentication-aware service worker** that only caches public assets
2. **Route-based caching** that explicitly excludes `/rest/v1/`, `/functions/v1/`, `/storage/v1/`
3. **Cache expiration** tied to Supabase session validity
4. **Build-time asset manifest** that marks which chunks are safe to cache
5. **Update strategy** that clears caches on app version bump

### 5.3 Performance Without PWA
- Code splitting (Phase 19) already provides 35% initial payload reduction
- No service worker overhead
- No risk of incorrect caching
- Build proven stable with 320/320 tests passing

## 6. Documentation

This analysis is recorded in:
- `PHASE20_PWA_ANALYSIS.md`
- Phase 20 Baseline (`PHASE20_BASELINE.md`)
- Phase 20 Final Report (`PHASE20_VERIFICATION_REPORT.md`)

**Decision**: PWA DEFERRED — cannot safely cache authenticated/private data without architecture changes beyond Phase 20 scope.

## 7. Key Finding

PWA cannot be safely implemented in the current NOVA architecture without:
1. Rewriting how API responses are fetched and cached
2. Adding authentication-aware caching logic at the service worker level
3. Explicitly excluding all `/rest/v1/`, `/functions/v1/`, `/storage/v1/` endpoints
4. Potentially redesigning the data layer to support safe offline behavior

Since these changes would be significant and risk introducing regressions to the verified 320/320 test suite and security model, PWA is deferred with full documentation.