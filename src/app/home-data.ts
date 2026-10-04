export const HOME_GAME_IDS = ['tictactoe', 'sudoku', 'ball-run', 'water-sort'] as const

export type HomeGameResultRow = {
  id: string
  session_id: string | null
  game_id: string
  outcome: string
  created_at: string
}

export type HomeRewardRow = {
  reference_id: string | null
  amount: number
}

export type HomeActivityRow = {
  id: string
  game: string
  outcome: string
  outcomeLabel: string
  outcomeClass: string
  coins: number | null
  createdAt: string
}

export type HomeAchievementEarned = {
  user_id: string
  earned_at: string
}

export type HomeAchievementCatalogRow = {
  id: string
  name: string
  target_type: string
  user_achievements: HomeAchievementEarned[] | null
}

export type HomeAchievementSummary = {
  total: number
  earned: number
  recent: { id: string; name: string; earnedAt: string } | null
  streakTotal: number
  streakEarned: number
}

export function gameLabel(gameId: string): string {
  if (gameId === 'tictactoe') return 'Tic-Tac-Toe'
  if (gameId === 'sudoku') return 'Sudoku'
  if (gameId === 'ball-run') return 'Ball Run'
  if (gameId === 'water-sort') return 'Water Sort'
  return gameId
}

export function outcomeLabel(outcome: string): string {
  if (outcome === 'win') return 'Won'
  if (outcome === 'loss') return 'Lost'
  if (outcome === 'draw') return 'Draw'
  if (outcome === 'complete') return 'Completed'
  return outcome
}

export function outcomeClass(outcome: string): string {
  if (outcome === 'win') return 'profile-outcome-win'
  if (outcome === 'loss') return 'profile-outcome-loss'
  if (outcome === 'draw') return 'profile-outcome-draw'
  return ''
}

export function mapActivityRows(
  results: HomeGameResultRow[],
  rewards: HomeRewardRow[],
): HomeActivityRow[] {
  const paid = new Map<string, number>()
  for (const reward of rewards) {
    if (reward.reference_id) paid.set(reward.reference_id, reward.amount)
  }
  return results.map((result) => {
    const amount = result.session_id ? paid.get(result.session_id) : undefined
    return {
      id: result.id,
      game: gameLabel(result.game_id),
      outcome: result.outcome,
      outcomeLabel: outcomeLabel(result.outcome),
      outcomeClass: outcomeClass(result.outcome),
      coins: amount ?? null,
      createdAt: result.created_at,
    }
  })
}

export function summarizeAchievements(
  rows: HomeAchievementCatalogRow[],
  userId: string,
): HomeAchievementSummary {
  let earned = 0
  let streakTotal = 0
  let streakEarned = 0
  let recent: HomeAchievementSummary['recent'] = null
  for (const row of rows) {
    const mine = (row.user_achievements ?? []).filter((entry) => entry.user_id === userId)
    const isStreak = row.target_type === 'streak'
    if (isStreak) streakTotal += 1
    if (mine.length === 0) continue
    earned += 1
    if (isStreak) streakEarned += 1
    const earnedAt = mine[0]?.earned_at
    if (earnedAt && (!recent || earnedAt > recent.earnedAt)) {
      recent = { id: row.id, name: row.name, earnedAt }
    }
  }
  return { total: rows.length, earned, recent, streakTotal, streakEarned }
}

// Rule-based Home personalization. Pure: every line is derived from one
// authoritative value the caller already loaded (never invented client-side),
// each rule states its own condition, and the list is capped so the hero stays
// short. No rule → no line; Home renders nothing extra.
export type HomeSuggestionInput = {
  level: number
  streak: number
  aiCredits: number
  earnedCoins: number
  recentGames: number
  conversationCount: number
  walletReady: boolean
}

export function buildHomeSuggestions(input: HomeSuggestionInput): string[] {
  const lines: string[] = []

  if (input.conversationCount > 0) {
    lines.push('Continue where you left off — your latest NOVA thread is waiting in Chat.')
  } else {
    lines.push('Start your first thread — NOVA saves every conversation so you can resume later.')
  }

  if (input.streak >= 3) {
    lines.push(`You're on a ${input.streak}-day streak — a quick challenge keeps it alive today.`)
  }

  if (input.walletReady && input.aiCredits === 0) {
    lines.push('You are out of AI Credits — win a challenge to earn more.')
  } else if (input.recentGames === 0) {
    lines.push('No completed challenges yet — ask NOVA what to try first.')
  }

  if (input.level >= 5) {
    lines.push(`You're level ${input.level} — NOVA already treats you as an experienced player.`)
  }

  if (input.walletReady && input.earnedCoins >= 10) {
    lines.push('Exchange 10 NOVA Coins for an AI Credit whenever you want to keep chatting.')
  }

  return lines.slice(0, 3)
}

export function describeAchievements(summary: HomeAchievementSummary): string {
  const streak = `Streak badges ${summary.streakEarned}/${summary.streakTotal}`
  if (summary.earned === 0) {
    return `No achievements yet — play a game to earn your first. ${streak}`
  }
  if (summary.recent) return `Latest: ${summary.recent.name} · ${streak}`
  return streak
}
