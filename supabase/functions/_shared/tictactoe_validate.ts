// Server-side Tic-Tac-Toe board validation.
// Client submits the final board; the server derives the authoritative outcome.
// Player is always X (moves first). Computer is always O.

export type TttOutcome = 'win' | 'loss' | 'draw'
export type TttCell = 'X' | 'O' | null

export type TttValidation =
  | { ok: true; outcome: TttOutcome }
  | { ok: false; error: string }

const WIN_LINES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
]

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

function normalizeBoard(raw: unknown): { ok: true; cells: TttCell[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'Board must be an array of 9 cells' }
  }
  if (raw.length !== 9) {
    return { ok: false, error: 'Board must have exactly 9 cells' }
  }
  const cells: TttCell[] = []
  for (const cell of raw) {
    if (cell === null || cell === undefined || cell === '') {
      cells.push(null)
    } else if (cell === 'X' || cell === 'O') {
      cells.push(cell)
    } else {
      return { ok: false, error: 'Invalid cell value' }
    }
  }
  return { ok: true, cells }
}

function winningMarks(cells: TttCell[]): Set<'X' | 'O'> {
  const winners = new Set<'X' | 'O'>()
  for (const [a, b, c] of WIN_LINES) {
    const mark = cells[a]
    if (mark && mark === cells[b] && mark === cells[c]) {
      winners.add(mark)
    }
  }
  return winners
}

/**
 * Validate a submitted final board and derive the outcome.
 * Does not trust a client-provided winner/outcome claim.
 */
export function validateTttBoard(raw: unknown): TttValidation {
  const normalized = normalizeBoard(raw)
  if (!normalized.ok) {
    return { ok: false, error: normalized.error }
  }
  const cells = normalized.cells

  const xCount = cells.filter((c) => c === 'X').length
  const oCount = cells.filter((c) => c === 'O').length

  // X moves first and turns alternate: O ≤ X ≤ O+1.
  if (oCount > xCount || xCount > oCount + 1) {
    return { ok: false, error: 'Invalid mark counts for turn order' }
  }

  const winners = winningMarks(cells)
  if (winners.size > 1) {
    return { ok: false, error: 'Both players cannot win' }
  }

  if (winners.size === 1) {
    const winner = winners.has('X') ? 'X' : 'O'
    if (winner === 'X') {
      // Game ends on X's move → X = O + 1.
      if (xCount !== oCount + 1) {
        return { ok: false, error: 'Invalid turn count for X win' }
      }
      return { ok: true, outcome: 'win' }
    }
    // Game ends on O's move → X = O.
    if (xCount !== oCount) {
      return { ok: false, error: 'Invalid turn count for O win' }
    }
    return { ok: true, outcome: 'loss' }
  }

  // No winner: only a full board is a valid terminal state (draw).
  const hasEmpty = cells.some((c) => c === null)
  if (hasEmpty) {
    return { ok: false, error: 'Game is not finished' }
  }
  if (xCount !== 5 || oCount !== 4) {
    return { ok: false, error: 'Invalid draw state' }
  }
  return { ok: true, outcome: 'draw' }
}
