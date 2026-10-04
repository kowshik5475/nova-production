// Upgrade Phase K — Ball Run timing rules.
//
// The client never supplies a score, a duration or an outcome. This module
// defines the window the server accepts so both the Edge Function and the
// tests share one set of numbers.

export const BALL_RUN_MIN_MS = 5_000
export const BALL_RUN_MAX_MS = 120_000
export const BALL_RUN_WIN_MS = 60_000
/** A client-reported duration may differ from the server clock by this much. */
export const BALL_RUN_TOLERANCE_MS = 3_000
export const BALL_RUN_MAX_SCORE = 100

export type TimingCheck =
  | { ok: true; elapsedMs: number; score: number; outcome: 'win' | 'loss' }
  | { ok: false; error: string }

/** Server-derived timing verdict for one run. */
export function evaluateRun(startedAtMs: number, nowMs: number): TimingCheck {
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) {
    return { ok: false, error: 'Session has no start time' }
  }
  const elapsedMs = Math.floor(nowMs - startedAtMs)
  if (elapsedMs < BALL_RUN_MIN_MS) return { ok: false, error: 'Run too short to count' }
  if (elapsedMs > BALL_RUN_MAX_MS) return { ok: false, error: 'Session expired — start a new run' }
  return {
    ok: true,
    elapsedMs,
    score: Math.min(BALL_RUN_MAX_SCORE, Math.floor(elapsedMs / 1000)),
    outcome: elapsedMs >= BALL_RUN_WIN_MS ? 'win' : 'loss',
  }
}

/** Rejects a client duration that does not match the server clock. */
export function claimMatchesServer(claimedMs: unknown, serverMs: number): boolean {
  if (typeof claimedMs !== 'number' || !Number.isFinite(claimedMs)) return false
  if (claimedMs < 0) return false
  return Math.abs(claimedMs - serverMs) <= BALL_RUN_TOLERANCE_MS
}
