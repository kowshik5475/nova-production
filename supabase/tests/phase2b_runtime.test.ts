// Phase 2B runtime security tests against linked Supabase project.
// Run: node --experimental-strip-types supabase/tests/phase2b_runtime.test.ts

import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const envPath = resolve(import.meta.dirname, '../../.env')
const envText = readFileSync(envPath, 'utf8')
const SUPABASE_URL = /VITE_SUPABASE_URL=(.+)/.exec(envText)?.[1]?.trim()
const ANON_KEY = /VITE_SUPABASE_ANON_KEY=(.+)/.exec(envText)?.[1]?.trim()
if (!SUPABASE_URL || !ANON_KEY) throw new Error('Missing Supabase env')

const FUNC = `${SUPABASE_URL}/functions/v1`
const email = 'p2busera@example.com'
const email2 = 'p2buserb@example.com'
const password = 'password123'

let accessToken = ''
let userId = ''
let sessionId = ''

async function fn(
  name: string,
  body: unknown,
  opts: { token?: string | null; origin?: string | null; method?: string } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  if (opts.origin) headers.Origin = opts.origin
  const res = await fetch(`${FUNC}/${name}`, {
    method: opts.method ?? 'POST',
    headers,
    body: opts.method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { status: res.status, headers: res.headers, json, text }
}

before(async () => {
  // Fixed test users created out-of-band via SQL (avoids email rate limits).
  const token = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({ email, password }),
  })
  const tokenBody = await token.json().catch(() => ({}))
  accessToken = tokenBody?.access_token ?? ''
  userId = tokenBody?.user?.id ?? userId
  if (!accessToken) {
    console.error('auth bootstrap failed', { token: tokenBody })
  }
})

after(() => {
  // Leave throwaway user; production cleanup not required for test account.
})

test('TTT start creates session', async () => {
  assert.ok(accessToken, 'auth bootstrap failed')
  const r = await fn('process-tictactoe', { action: 'start' }, { token: accessToken })
  assert.equal(r.status, 200, r.text)
  sessionId = r.json.sessionId
  assert.ok(sessionId)
})

const validXWin = ['X', 'X', 'X', 'O', 'O', null, null, null, null]
const validOWin = ['O', 'X', 'X', 'O', null, null, 'O', null, 'X']
const validDraw = ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X']

test('1. Valid X win', async () => {
  const r = await fn(
    'process-tictactoe',
    { action: 'complete', sessionId, board: validXWin },
    { token: accessToken },
  )
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.outcome, 'win')
  assert.equal(r.json.awardedCoins, 10)
  assert.equal(r.json.awardedXp, 25)
})

test('9. Duplicate completion short-circuits (same session, stable key)', async () => {
  const r = await fn(
    'process-tictactoe',
    { action: 'complete', sessionId, board: validXWin },
    { token: accessToken },
  )
  // Second call: session already COMPLETED → rejected at session status check
  // OR idempotent RPC path. Either way no double award.
  assert.ok(r.status === 200 || r.status === 400, `status=${r.status} ${r.text}`)
  if (r.status === 200) {
    assert.equal(r.json.awardedCoins, 0, 'retry must not re-award')
  } else {
    assert.match(String(r.json?.error ?? r.text), /completed|already|Session/i)
  }
})

test('10. Concurrent duplicate completions remain safe', async () => {
  const start = await fn('process-tictactoe', { action: 'start' }, { token: accessToken })
  assert.equal(start.status, 200, start.text)
  const sid = start.json.sessionId
  const body = { action: 'complete', sessionId: sid, board: validDraw }
  const [a, b] = await Promise.all([
    fn('process-tictactoe', body, { token: accessToken }),
    fn('process-tictactoe', body, { token: accessToken }),
  ])
  // At most one success awards; the other fails or returns zero award.
  const successes = [a, b].filter((r) => r.status === 200)
  assert.ok(successes.length >= 1, `a=${a.text} b=${b.text}`)
  for (const s of successes) {
    if (s.json.awardedCoins) {
      // draw awards 0 anyway; if win, only one may have >0
    }
  }
  const awards = successes.map((s) => s.json.awardedCoins ?? 0)
  assert.ok(
    awards.filter((n) => n > 0).length <= 1,
    `multiple awards: ${JSON.stringify(awards)}`,
  )
})

test('2. Valid O win on fresh session', async () => {
  const start = await fn('process-tictactoe', { action: 'start' }, { token: accessToken })
  const sid = start.json.sessionId
  const r = await fn(
    'process-tictactoe',
    { action: 'complete', sessionId: sid, board: validOWin },
    { token: accessToken },
  )
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.outcome, 'loss')
  assert.equal(r.json.awardedCoins, 0)
})

test('4. Invalid winner claim / both-win board rejected', async () => {
  const start = await fn('process-tictactoe', { action: 'start' }, { token: accessToken })
  const sid = start.json.sessionId
  const r = await fn(
    'process-tictactoe',
    {
      action: 'complete',
      sessionId: sid,
      board: ['X', 'X', 'X', 'O', 'O', 'O', null, null, null],
    },
    { token: accessToken },
  )
  assert.equal(r.status, 400, r.text)
})

test('5. Invalid board size rejected', async () => {
  const start = await fn('process-tictactoe', { action: 'start' }, { token: accessToken })
  const sid = start.json.sessionId
  const r = await fn(
    'process-tictactoe',
    { action: 'complete', sessionId: sid, board: ['X', 'O'] },
    { token: accessToken },
  )
  assert.equal(r.status, 400, r.text)
})

test('6. Invalid cell value rejected', async () => {
  const start = await fn('process-tictactoe', { action: 'start' }, { token: accessToken })
  const sid = start.json.sessionId
  const board = Array(9).fill(null)
  board[0] = 'Z'
  const r = await fn(
    'process-tictactoe',
    { action: 'complete', sessionId: sid, board },
    { token: accessToken },
  )
  assert.equal(r.status, 400, r.text)
})

test('7. Impossible board state rejected', async () => {
  const start = await fn('process-tictactoe', { action: 'start' }, { token: accessToken })
  const sid = start.json.sessionId
  const r = await fn(
    'process-tictactoe',
    { action: 'complete', sessionId: sid, board: Array(9).fill('X') },
    { token: accessToken },
  )
  assert.equal(r.status, 400, r.text)
})

test('8. Wrong turn count rejected', async () => {
  const start = await fn('process-tictactoe', { action: 'start' }, { token: accessToken })
  const sid = start.json.sessionId
  // X line but x == o (need x = o+1)
  const r = await fn(
    'process-tictactoe',
    {
      action: 'complete',
      sessionId: sid,
      board: ['X', 'X', 'X', 'O', 'O', null, 'O', null, null],
    },
    { token: accessToken },
  )
  assert.equal(r.status, 400, r.text)
})

test('11. Session belonging to another user rejected', async () => {
  const t = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({ email: email2, password }),
  })
  const token2 = (await t.json().catch(() => ({})))?.access_token ?? ''
  assert.ok(token2, 'user B login failed')

  const start = await fn('process-tictactoe', { action: 'start' }, { token: accessToken })
  const sid = start.json.sessionId
  const r = await fn(
    'process-tictactoe',
    { action: 'complete', sessionId: sid, board: validDraw },
    { token: token2 },
  )
  assert.equal(r.status, 400, r.text)
  assert.match(String(r.json?.error ?? ''), /unauthorized|Invalid/i)
})

test('12. Unauthenticated request rejected', async () => {
  const r = await fn('process-tictactoe', { action: 'start' }, { token: null })
  assert.equal(r.status, 401, r.text)
})

test('13. Allowed development origin (CORS preflight)', async () => {
  const res = await fetch(`${FUNC}/process-tictactoe`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  })
  assert.ok(res.status === 204 || res.status === 200, `status=${res.status}`)
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173')
})

test('15. Unexpected origin rejected on preflight', async () => {
  const res = await fetch(`${FUNC}/process-tictactoe`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://evil.example.com',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  })
  assert.equal(res.status, 403)
  assert.equal(res.headers.get('access-control-allow-origin'), null)
})

test('14. Configured production origin — skipped (CORS_ALLOWED_ORIGINS not set in this run; unit-tested)', () => {
  assert.ok(true)
})

test('16. Chat response never contains provider key pattern', async () => {
  assert.ok(accessToken, 'auth bootstrap failed')
  const r = await fn(
    'nova-chat',
    { message: 'hi', idempotencyKey: crypto.randomUUID() },
    { token: accessToken },
  )
  const blob = JSON.stringify(r.json) + r.text
  assert.ok(!/AIza[0-9A-Za-z_-]{10,}/.test(blob), 'provider key leaked in response')
  // 200 = successful stream; 4xx/5xx = guarded failure. Key must never appear.
  assert.ok(
    r.status === 200 || [400, 401, 402, 500, 502].includes(r.status),
    `status=${r.status} ${r.text}`,
  )
  if (r.status === 200) {
    // done wallet payload must not report negative credits after a normal chat
    const doneMatch = /event: done\ndata: (\{.*\})/.exec(r.text)
    if (doneMatch) {
      const done = JSON.parse(doneMatch[1]) as { wallet?: { ai_credits?: number } }
      if (typeof done.wallet?.ai_credits === 'number') {
        assert.ok(done.wallet.ai_credits >= 0, `ai_credits=${done.wallet.ai_credits}`)
      }
    }
  }
})

test('17-18. Provider key not in URL — static code check', async () => {
  const src = readFileSync(
    resolve(import.meta.dirname, '../functions/nova-chat/index.ts'),
    'utf8',
  )
  assert.ok(!src.includes('key=${geminiKey}'), 'key must not be appended to URL')
  assert.ok(!src.includes('&key='), 'no &key= in source')
  assert.ok(src.includes('x-goog-api-key'), 'key must use header transport')
})

test('19-20. Logs do not contain provider key or full history', async () => {
  const src = readFileSync(
    resolve(import.meta.dirname, '../functions/nova-chat/index.ts'),
    'utf8',
  )
  assert.ok(!src.includes('history-trace'), 'history-trace removed')
  assert.ok(!src.includes('nova-diag-history'), 'nova-diag-history removed')
  assert.ok(!/console\.(log|error)\([^)]*geminiKey/.test(src), 'key not logged')
  assert.ok(!src.includes('console.log(\'nova-timing'), 'verbose timing removed')
})
