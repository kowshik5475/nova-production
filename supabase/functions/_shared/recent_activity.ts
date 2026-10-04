// Phase 13 — one-time post-game Chat re-entry context.
//
// Pure derivation helper shared by the nova-chat Edge Function and the Phase 13
// test suite. It is deliberately free of Deno/Supabase APIs so the exact logic
// that feeds the AI can be exercised directly.
//
// Contract:
//   * Every field is sourced from authoritative rows already loaded under the
//     requesting user's RLS scope (game_sessions, game_results,
//     wallet_transactions, profiles). Nothing here trusts client input.
//   * The result is a small allow-listed object: no user id, email, auth
//     metadata, wallet balance, AI credit balance, tokens or RPC internals.
//   * It never mints rewards — coins only surface when a GAME_REWARD
//     transaction already exists for that session, and progression values are
//     read, never written.

export type RecentActivityProfile = {
  xp: number
  level: number
  streak?: number | null
}

export type RecentActivitySource = {
  game?: string | null
  outcome?: string | null
  completedAt?: string | null
  coinsEarned?: number | null
  profile?: RecentActivityProfile | null
}

export type RecentActivity = {
  type: 'game_completion'
  game: 'tictactoe' | 'sudoku' | 'ball-run' | 'water-sort'
  outcome: 'win' | 'loss' | 'draw' | 'complete'
  completedAt: string
  progression?: { xp: number; level: number; streak?: number }
  reward?: { coins: number }
}

const GAMES = new Set(['tictactoe', 'sudoku'])
// The Games Hub adds two more catalog entries; re-entry stays an allow-list.
const EXTENDED_GAMES = new Set([...GAMES, 'ball-run', 'water-sort'])
const OUTCOMES = new Set(['win', 'loss', 'draw', 'complete'])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Shape check for the optional one-time session reference. Never a lookup key on its own. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/**
 * Build the AI-facing recent-activity block, or null when the source is not a
 * completed game this player is allowed to reference.
 */
export function buildRecentActivity(source: RecentActivitySource): RecentActivity | null {
  const { game, outcome, completedAt } = source
  if (typeof game !== 'string' || !EXTENDED_GAMES.has(game)) return null
  if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) return null
  if (typeof completedAt !== 'string' || completedAt.length === 0) return null

  const activity: RecentActivity = {
    type: 'game_completion',
    game: game as RecentActivity['game'],
    outcome: outcome as RecentActivity['outcome'],
    completedAt,
  }

  const profile = source.profile
  if (profile && typeof profile.xp === 'number' && typeof profile.level === 'number') {
    const progression: { xp: number; level: number; streak?: number } = {
      xp: profile.xp,
      level: profile.level,
    }
    if (typeof profile.streak === 'number' && profile.streak > 0) {
      progression.streak = profile.streak
    }
    activity.progression = progression
  }

  const coins = source.coinsEarned
  if (typeof coins === 'number' && Number.isFinite(coins) && coins > 0) {
    activity.reward = { coins }
  }

  return activity
}
