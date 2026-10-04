# NOVA — Phase 20 Baseline

## 1. Verified Starting Baseline (Post-Phase 19)

### 1.1 Phase 19 Verified State
- **Code splitting**: IMPLEMENTED via React.lazy() + Suspense + Vite manualChunks config
- **Build output**: 6 JS chunks generated (proven by `dist/assets/` inspection)
- **Performance**: Initial JS payload 446.41 kB gzip (main + runtime) vs 687.38 kB baseline — 35% reduction
- **Game chunks**: TTX (3.60 kB gzip), Sudoku (7.41 kB gzip), Ball Run (228.07 kB gzip), Water Sort (3.88 kB gzip)
- **Tests**: 320/320 passing, all 16 suites green
- **TypeScript**: 0 errors (`tsc -b` passes)
- **Lint**: 0 errors (only pre-existing warnings)
- **Security**: All Phase 17 protections intact, no regressions
- **PWA**: DEFERRED (auth-aware service worker strategy not established)
- **Conversation switching**: Verified fixed (stale messages resolved)

### 1.2 Current Build Artifacts
| Metric | Value |
|---|---|
| Main JS gzip | 446.41 kB |
| Main CSS gzip | 64.55 kB |
| JS chunks | 6 |
| CSS chunks | 1 |
| Game chunks | 4 (TTX, Sudoku, Ball Run, Water Sort) |
| Largest JS chunk | 228.07 kB gzip (Ball Run) |
| Runtime chunk | 0.71 kB gzip |
| Build command | `tsc -b && vite build` |
| TypeScript | ✓ 0 errors |
| Lint | ✓ 0 errors |
| Production build | ✓ PASS |

### 1.3 Code Splitting Architecture (Phase 19)
- **Source**: `src/app/App.tsx` — 4 game components wrapped in `React.lazy()` + `Suspense`
- **Config**: `vite.config.ts` — `build.rollupOptions.output.manualChunks` function
- **Method**: `React.lazy()` + `dynamic import()` + `Suspense` + Vite `manualChunks`
- **Verification**: Build output proves separation into 6 chunks — not claimed, proven

### 1.4 Files Modified in Phase 19
- `src/app/App.tsx` — added lazy imports + Suspense fallbacks for 4 games
- `vite.config.ts` — added `manualChunks` configuration
- `PHASE19_BASELINE.md` — created
- `PHASE19_CODE_SPLITTING_ANALYSIS.md` — created
- `PHASE19_VERIFICATION_REPORT.md` — created

### 1.5 Tests
- **Total**: 320
- **Passed**: 320
- **Failed**: 0
- **Skipped**: 0
- **Suites**: 16

### 1.5 Security Baseline (Post-Phase 19, verified)
All Phase 17 protections intact:
- ✓ Game RPC direct farming blocked
- ✓ Session ownership enforcement
- ✓ AI rate limiting server-side
- ✓ Storage cleanup on deletion
- ✓ CORS production config
- ✓ No frontend secrets exposed
- ✓ RLS intact
- ✓ SECURITY DEFINER RPCs preserved
- ✓ Credit reservation→finalization→release chain intact

### 1.6 Accessibility (Phase 19 — source-level)
All ARIA attributes confirmed on 4 games and chat component. Screen-reader test: NOT EXECUTABLE IN CURRENT ENVIRONMENT (documented limitation).

## 2. Phase 20 Starting Point

Phase 20 begins with a verified, production-stable architecture:
- Code splitting implemented and proven by build output
- All 320 tests passing
- No security regressions
- TypeScript and lint clean
- Performance improved 35% initial payload reduction

The baseline is recorded in `PHASE20_BASELINE.md`. All subsequent work must maintain these verified conditions.