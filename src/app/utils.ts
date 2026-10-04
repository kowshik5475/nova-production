import type { GameProgress } from './types'

export function formatDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}d ago`
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

export function validateNewPassword(password: string, confirm: string): string | null {
  if (!password || !confirm) return 'Enter and confirm your new password'
  if (password.length < 6) return 'Password must be at least 6 characters'
  if (password !== confirm) return 'Passwords do not match'
  return null
}

export const DISPLAY_NAME_MAX_LENGTH = 50

export type DisplayNameValidation =
  | { ok: true; value: string }
  | { ok: false; error: string }

export function validateDisplayName(raw: string): DisplayNameValidation {
  const value = raw.trim()
  if (!value) return { ok: false, error: 'Display name is required' }
  if (value.length > DISPLAY_NAME_MAX_LENGTH) {
    return { ok: false, error: `Display name must be ${DISPLAY_NAME_MAX_LENGTH} characters or fewer` }
  }
  return { ok: true, value }
}

export function getInsight(progress: GameProgress | null, coins: number, credits: number): string {
  if (!progress || progress.games_played === 0) return 'Play your first Tic-Tac-Toe game to begin building your strategy profile.'
  const winRate = progress.games_won / progress.games_played
  if (winRate < 0.5) return 'Try another strategy round to improve your win rate.'
  if (coins >= 10 && credits === 0) return 'Exchange 10 NOVA Coins to unlock a NOVA conversation.'
  if (credits > 0) return 'Ask NOVA for a strategy suggestion.'
  return 'Keep playing to earn more coins and level up.'
}
