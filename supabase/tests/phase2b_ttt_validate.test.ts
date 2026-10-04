// Phase 2B — Tic-Tac-Toe board validation + CORS allowlist unit tests
// Run: node --experimental-strip-types supabase/tests/phase2b_ttt_validate.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'

// Minimal Deno shim so cors.ts can load under Node (must precede dynamic imports).
Object.assign(globalThis, {
  Deno: {
    env: {
      get: (key: string) => process.env[key],
    },
  },
})

const { isValidUuid, validateTttBoard } = await import(
  '../functions/_shared/tictactoe_validate.ts'
)
const { isOriginAllowed, buildCorsHeaders } = await import(
  '../functions/_shared/cors.ts'
)

test('1. Valid X win', () => {
  const board = ['X', 'X', 'X', 'O', 'O', null, null, null, null]
  const r = validateTttBoard(board)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.outcome, 'win')
})

test('2. Valid O win', () => {
  const board = ['O', 'X', 'X', 'O', null, null, 'O', null, 'X']
  const r = validateTttBoard(board)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.outcome, 'loss')
})

test('3. Valid draw', () => {
  const board = ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X']
  const r = validateTttBoard(board)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.outcome, 'draw')
})

test('4. Both players cannot win (invalid claim)', () => {
  const board = ['X', 'X', 'X', 'O', 'O', 'O', null, null, null]
  const r = validateTttBoard(board)
  assert.equal(r.ok, false)
})

test('5. Invalid board size', () => {
  assert.equal(validateTttBoard(['X', 'O']).ok, false)
  assert.equal(validateTttBoard(Array(10).fill(null)).ok, false)
  assert.equal(validateTttBoard('not-array').ok, false)
})

test('6. Invalid cell value', () => {
  const board = Array(9).fill(null)
  board[0] = 'Z'
  assert.equal(validateTttBoard(board).ok, false)
  const board2 = Array(9).fill(null)
  board2[0] = 1
  assert.equal(validateTttBoard(board2).ok, false)
})

test('7. Impossible board / wrong mark counts', () => {
  // More O than X (O cannot move first)
  assert.equal(
    validateTttBoard(['O', 'O', 'O', 'X', 'X', null, null, null, null]).ok,
    false,
  )
  // X far ahead of O without alternating turns
  assert.equal(
    validateTttBoard(['X', 'X', 'X', 'X', null, null, null, null, null]).ok,
    false,
  )
})

test('8. Wrong turn count for X win (x must equal o+1)', () => {
  const board = ['X', 'X', 'X', 'O', 'O', null, 'O', null, null]
  const r = validateTttBoard(board)
  assert.equal(r.ok, false)
})

test('9. Incomplete board with no winner rejected', () => {
  const board = ['X', 'O', null, null, null, null, null, null, null]
  const r = validateTttBoard(board)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /not finished/i)
})

test('10. Full board of one mark rejected', () => {
  assert.equal(validateTttBoard(Array(9).fill('X')).ok, false)
})

test('null and empty string accepted as empty cells', () => {
  const board = ['X', 'X', 'X', 'O', 'O', '', undefined, null, null]
  const r = validateTttBoard(board)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.outcome, 'win')
})

test('isValidUuid', () => {
  assert.equal(isValidUuid('not-a-uuid'), false)
  assert.equal(isValidUuid('123e4567-e89b-12d3-a456-426614174000'), true)
})

// ── CORS (set env before these run) ──────────────────────────
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com, https://www.example.com'

test('13. Allowed development origin', () => {
  assert.equal(isOriginAllowed('http://localhost:5173'), true)
  assert.equal(isOriginAllowed('http://127.0.0.1:3000'), true)
})

test('14. Configured production origin', () => {
  assert.equal(isOriginAllowed('https://app.example.com'), true)
  assert.equal(isOriginAllowed('https://www.example.com'), true)
})

test('15. Unexpected origin rejected', () => {
  assert.equal(isOriginAllowed('https://evil.example.com'), false)
  assert.equal(isOriginAllowed(null), false)
  assert.equal(isOriginAllowed('https://app.example.com.evil.com'), false)
})

test('CORS headers echo only allowlisted Origin', () => {
  const okReq = new Request('https://example.com', {
    headers: { Origin: 'http://localhost:5173' },
  })
  const okHeaders = buildCorsHeaders(okReq)
  assert.equal(okHeaders['Access-Control-Allow-Origin'], 'http://localhost:5173')

  const badReq = new Request('https://example.com', {
    headers: { Origin: 'https://evil.example.com' },
  })
  const badHeaders = buildCorsHeaders(badReq)
  assert.equal(badHeaders['Access-Control-Allow-Origin'], undefined)
})
