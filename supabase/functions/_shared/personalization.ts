// Upgrade Phase M — rule-based personalization for the NOVA system prompt.
//
// Pure and server-side. Every line it produces is derived from authoritative
// rows already loaded under the requesting user's scope, and each suggestion
// states the rule that fired. There is no model-in-the-loop, no free-form
// client input, and it returns null when no rule applies — NOVA never
// invents progress, statistics, or advice about data it does not have.

export type PersonalizationGame = {
  id: string
  label: string
  played: number
  won: number
}

export type PersonalizationInput = {
  displayName?: string | null
  level?: number | null
  xp?: number | null
  streak?: number | null
  games?: PersonalizationGame[] | null
}

const MIN_GAMES_FOR_RATE = 3

function rate(game: PersonalizationGame): number {
  if (game.played <= 0) return 0
  return game.won / game.played
}

function pct(value: number): number {
  return Math.round(value * 100)
}

/**
 * Returns a short directive block for the system instruction, or null when
 * nothing in the input justifies a personalized note.
 */
export function buildPersonalization(input: PersonalizationInput): string | null {
  const notes: string[] = []

  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : ''
  const level = typeof input.level === 'number' ? input.level : null
  const xp = typeof input.xp === 'number' ? input.xp : null
  const streak = typeof input.streak === 'number' ? input.streak : null
  const games = Array.isArray(input.games) ? input.games : []

  if (displayName) notes.push(`The player's name is ${displayName}.`)

  if (level !== null && level >= 5 && xp !== null) {
    notes.push(`They are level ${level} (${xp} XP) — treat them as an experienced player.`)
  }

  if (streak !== null && streak >= 3) {
    notes.push(
      `Rule: streak >= 3 → they are on a ${streak}-day streak; acknowledge it briefly when they open.`,
    )
  }

  const played = games.filter((g) => g && typeof g.played === 'number' && g.played > 0)

  if (played.length === 0) {
    notes.push(
      'Rule: no completed games yet → if they ask what to do next, suggest starting with a short game, but only if they ask.',
    )
  }

  for (const game of played) {
    if (game.played < MIN_GAMES_FOR_RATE) continue
    const r = rate(game)
    if (r < 0.4) {
      notes.push(
        `Rule: ${game.label} win rate below 40% (${game.won}/${game.played}) → if they ask about improvement, suggest one concrete opening or scanning habit for ${game.label}.`,
      )
    } else if (r >= 0.7) {
      notes.push(
        `Rule: ${game.label} win rate ${pct(r)}% (${game.won}/${game.played}) → if they ask about improvement, suggest raising difficulty or trying a different game.`,
      )
    }
  }

  if (notes.length === 0) return null
  return notes.join('\n')
}
