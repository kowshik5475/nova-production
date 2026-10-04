// Upgrade Phase K — Water Sort puzzle generation and server-side replay.
//
// Pure module shared by the process-water-sort Edge Function and the upgrade
// tests. The server owns the puzzle: it is generated from a seed at session
// start, stored in session_data, and the client only ever submits a move list.
// Completion is verified by replaying that move list against the stored puzzle
// — an unsolvable or hand-edited final board cannot pass.

export const TUBE_CAPACITY = 4
export const MIN_COLORS = 3
export const MAX_COLORS = 6
export const MAX_MOVES = 400
/** Search budget for the solvability gate at session start. */
export const SOLVE_NODE_BUDGET = 40_000

export type Move = { from: number; to: number }
export type Tubes = number[][]

export type Puzzle = {
  tubes: Tubes
  colors: number
  par: number
}

/** Deterministic 32-bit PRNG so a seed fully reproduces a puzzle. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function randomSeed(): number {
  const values = new Uint32Array(1)
  globalThis.crypto.getRandomValues(values)
  return values[0] >>> 0
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

/** Builds one candidate: `colors` half-full tubes plus two empty tubes. */
export function dealPuzzle(seed: number, colors: number): Puzzle {
  const colourCount = Math.min(MAX_COLORS, Math.max(MIN_COLORS, Math.floor(colors)))
  const rand = mulberry32(seed)

  const balls: number[] = []
  for (let colour = 0; colour < colourCount; colour += 1) {
    for (let i = 0; i < TUBE_CAPACITY; i += 1) balls.push(colour)
  }

  const ordered = shuffle(balls, rand)
  const tubes: Tubes = Array.from({ length: colourCount + 2 }, () => [] as number[])
  for (let i = 0; i < ordered.length; i += 1) {
    tubes[i % colourCount].push(ordered[i])
  }

  return { tubes, colors: colourCount, par: colourCount * 6 }
}

export function isSolved(tubes: Tubes): boolean {
  return tubes.every(
    (tube) =>
      tube.length === 0 ||
      (tube.length === TUBE_CAPACITY && tube.every((ball) => ball === tube[0])),
  )
}

/** Returns a new tubes array for a legal move, or null when illegal. */
export function applyMove(tubes: Tubes, from: number, to: number): Tubes | null {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null
  if (from === to) return null
  if (from < 0 || to < 0 || from >= tubes.length || to >= tubes.length) return null

  const source = tubes[from]
  const target = tubes[to]
  if (source.length === 0) return null
  if (target.length >= TUBE_CAPACITY) return null

  const top = source[source.length - 1]
  if (target.length > 0 && target[target.length - 1] !== top) return null

  let run = 0
  while (run < source.length && source[source.length - 1 - run] === top) run += 1
  const movable = Math.min(run, TUBE_CAPACITY - target.length)
  if (movable <= 0) return null

  const next = tubes.map((tube) => tube.slice())
  for (let i = 0; i < movable; i += 1) next[to].push(next[from].pop() as number)
  return next
}

function keyOf(tubes: Tubes): string {
  return tubes
    .map((tube) => tube.join(','))
    .sort()
    .join('|')
}

/**
 * Bounded depth-first search for a winning line. Used at session start so the
 * server never hands out a puzzle it could not solve itself.
 */
export function isSolvable(
  tubes: Tubes,
  nodeBudget: number = SOLVE_NODE_BUDGET,
): boolean {
  if (isSolved(tubes)) return true

  const seen = new Set<string>([keyOf(tubes)])
  const stack: Tubes[] = [tubes.map((tube) => tube.slice())]
  let visited = 0

  while (stack.length > 0 && visited < nodeBudget) {
    const current = stack.pop() as Tubes
    visited += 1
    for (let from = 0; from < current.length; from += 1) {
      for (let to = 0; to < current.length; to += 1) {
        if (from === to) continue
        const next = applyMove(current, from, to)
        if (!next) continue
        if (isSolved(next)) return true
        const key = keyOf(next)
        if (seen.has(key)) continue
        seen.add(key)
        stack.push(next)
      }
    }
  }
  return false
}

/**
 * Generates a puzzle the server has verified to be solvable. Retries with a
 * fresh seed before falling back to the last candidate.
 */
export function generatePuzzle(seed: number, colors: number): Puzzle {
  let candidate = dealPuzzle(seed, colors)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (isSolvable(candidate.tubes)) return candidate
    candidate = dealPuzzle((seed + (attempt + 1) * 7919) >>> 0, colors)
  }
  return candidate
}

export type ReplayResult =
  | { ok: true; solved: boolean; moves: number }
  | { ok: false; error: string }

/** Replays a client move list against the stored puzzle. */
export function replayMoves(initial: Tubes, moves: unknown): ReplayResult {
  if (!Array.isArray(moves)) return { ok: false, error: 'moves must be an array' }
  if (moves.length === 0) return { ok: false, error: 'moves cannot be empty' }
  if (moves.length > MAX_MOVES) return { ok: false, error: `moves exceeds ${MAX_MOVES}` }

  let state: Tubes = initial.map((tube) => tube.slice())

  for (let i = 0; i < moves.length; i += 1) {
    const move = moves[i] as Move | null
    if (!move || typeof move !== 'object') return { ok: false, error: `move ${i} is malformed` }
    const { from, to } = move as Move
    if (typeof from !== 'number' || typeof to !== 'number') {
      return { ok: false, error: `move ${i} is malformed` }
    }
    const next = applyMove(state, from, to)
    if (!next) return { ok: false, error: `move ${i} is illegal` }
    state = next
  }

  return { ok: true, solved: isSolved(state), moves: moves.length }
}
