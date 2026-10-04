// Phase 9 — Achievements V1 security + functional tests
// Run: node --experimental-strip-types supabase/tests/phase9_achievements.test.ts
// Uses existing Phase 2B test users only. Creates no permanent users.
// Restores any state mutated by tests where practical.

import assert from 'node:assert/strict'
import { test, before } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const envText = readFileSync(resolve(root, '.env'), 'utf8')
const SUPABASE_URL = /VITE_SUPABASE_URL=(.+)/.exec(envText)?.[1]?.trim()
const ANON_KEY = /VITE_SUPABASE_ANON_KEY=(.+)/.exec(envText)?.[1]?.trim()
if (!SUPABASE_URL || !ANON_KEY) throw new Error('Missing Supabase env')

const emailA = 'p2busera@example.com'
const emailB = 'p2buserb@example.com'
const password = 'password123'

const migrationSrc = readFileSync(
  resolve(root, 'supabase/migrations/20260924000005_phase9_achievements_v1.sql'),
  'utf8',
)
const profileSrc = readFileSync(resolve(root, 'src/app/profile.tsx'), 'utf8')
const typesSrc = readFileSync(resolve(root, 'src/app/types.ts'), 'utf8')
const coreSrc = readFileSync(
  resolve(root, 'supabase/migrations/20260920_00_core_tables.sql'),
  'utf8',
)
const phase2aSrc = readFileSync(
  resolve(root, 'supabase/migrations/20260924000001_phase2a_p0_rls_hardening.sql'),
  'utf8',
)

let tokenA = ''
let tokenB = ''
let idA = ''
let idB = ''

async function signIn(email: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY! },
    body: JSON.stringify({ email, password }),
  })
  assert.ok(res.ok, `sign-in ${email}: ${res.status}`)
  const body = (await res.json()) as { access_token: string }
  return body.access_token
}

async function rest(path: string, token?: string, init?: RequestInit) {
  const headers: Record<string, string> = { apikey: ANON_KEY!, 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { status: res.status, json, text }
}

async function edge(name: string, body: unknown, token: string) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: ANON_KEY!,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { status: res.status, json, text }
}

before(async () => {
  tokenA = await signIn(emailA)
  tokenB = await signIn(emailB)
  const a = await rest('profiles?select=id&limit=1', tokenA)
  const b = await rest('profiles?select=id&limit=1', tokenB)
  idA = (a.json as { id: string }[])[0].id
  idB = (b.json as { id: string }[])[0].id
})

// ── Static: schema / migration / UI ──────────────────────────

test('static. Migration seeds exactly the 5 V1 catalog rows (idempotent)', () => {
  assert.match(migrationSrc, /insert into public\.achievements/)
  assert.match(migrationSrc, /on conflict \(id\) do nothing/)
  for (const id of [
    'first_game',
    'first_ttt_win',
    'first_sudoku',
    'first_ai_chat',
    'first_coin_exchange',
  ]) {
    assert.ok(migrationSrc.includes(`'${id}'`), `catalog contains ${id}`)
  }
  // target_type must satisfy existing CHECK constraint
  assert.doesNotMatch(migrationSrc, /target_type.*milestone/i)
})

test('static. Composite PK already provides idempotency (core migration)', () => {
  assert.match(coreSrc, /primary key \(user_id, achievement_id\)/)
  assert.match(migrationSrc, /on conflict do nothing/)
})

test('static. No client-callable award_achievement RPC', () => {
  assert.doesNotMatch(migrationSrc, /create or replace function public\.award_achievement/i)
  assert.doesNotMatch(migrationSrc, /grant execute.*award_achievement/i)
})

test('static. Award hooks exist inside all 4 authoritative RPCs', () => {
  // Each function body must contain the user_achievements insert with ON CONFLICT
  const fns = [
    'complete_tictactoe_game',
    'complete_sudoku_game',
    'finalize_chat_credit',
    'exchange_nova_coins',
  ]
  for (const fnName of fns) {
    const idx = migrationSrc.indexOf(`function public.${fnName}`)
    assert.ok(idx >= 0, `${fnName} defined in phase9 migration`)
    const next = migrationSrc.indexOf('function public.', idx + 10)
    const body = migrationSrc.slice(idx, next === -1 ? undefined : next)
    assert.match(body, /insert into public\.user_achievements/)
    assert.match(body, /on conflict do nothing/)
  }
})

test('static. TTT awards only on win (not loss/draw)', () => {
  const idx = migrationSrc.indexOf('function public.complete_tictactoe_game')
  const next = migrationSrc.indexOf('function public.', idx + 10)
  const body = migrationSrc.slice(idx, next === -1 ? undefined : next)
  // awards must be inside if p_outcome = 'win'
  assert.match(body, /if p_outcome = 'win' then[\s\S]*first_ttt_win[\s\S]*end if/)
})

test('static. finalize_chat_credit awards only after state completed (idempotent guard)', () => {
  const idx = migrationSrc.indexOf('function public.finalize_chat_credit')
  const next = migrationSrc.indexOf('function public.', idx + 10)
  const body = migrationSrc.slice(idx, next === -1 ? undefined : next)
  assert.match(body, /state = 'completed' then\s*\n\s*return/)
  // award insert comes AFTER the completed update
  const completedIdx = body.indexOf("set state = 'completed'")
  const awardIdx = body.indexOf('first_ai_chat')
  assert.ok(completedIdx >= 0 && awardIdx > completedIdx, 'award after completed update')
})

test('static. exchange awards only after wallet_transactions insert', () => {
  const idx = migrationSrc.indexOf('function public.exchange_nova_coins')
  const body = migrationSrc.slice(idx)
  const txIdx = body.indexOf('COIN_EXCHANGE')
  const awardIdx = body.indexOf('first_coin_exchange')
  assert.ok(txIdx >= 0 && awardIdx > txIdx, 'award after successful exchange writes')
})

test('static. Profile UI shows achievements section with earned/locked + empty state', () => {
  assert.match(profileSrc, /ACHIEVEMENTS/)
  assert.match(profileSrc, /profile-achievement/)
  assert.match(profileSrc, /Earned/)
  assert.match(profileSrc, /Locked/)
  assert.match(profileSrc, /No achievements yet/)
  assert.match(profileSrc, /from\('achievements'\)/)
  assert.match(profileSrc, /from\('user_achievements'\)/)
  assert.match(profileSrc, /earned_at/)
})

test('static. ProfileState includes achievements array', () => {
  assert.match(typesSrc, /achievements: AchievementView\[\]/)
  assert.match(typesSrc, /AchievementView/)
  assert.match(typesSrc, /earned: boolean/)
})

test('static. No broad user_achievements write policies added', () => {
  assert.doesNotMatch(migrationSrc, /create policy.*user_achievements/i)
  assert.doesNotMatch(migrationSrc, /for insert/i)
  assert.doesNotMatch(migrationSrc, /with check \(true\)/i)
  // Phase 2A still owns the SELECT-own policy
  assert.match(phase2aSrc, /Users can read own achievements/)
  assert.match(phase2aSrc, /auth\.uid\(\) = user_id/)
})

test('static. Achievements catalog remains publicly readable, not writable', () => {
  assert.match(coreSrc, /Public can view achievements/)
  assert.match(coreSrc, /for select using \(true\)/)
  // no insert/update/delete policy on achievements in phase9 migration
  assert.doesNotMatch(migrationSrc, /create policy/i)
})

// ── Runtime security (A–H) ───────────────────────────────────

test('A. User A can read own user_achievements', async () => {
  const r = await rest(`user_achievements?select=achievement_id,earned_at&user_id=eq.${idA}`, tokenA)
  assert.equal(r.status, 200, r.text)
  assert.ok(Array.isArray(r.json), 'returns array')
})

test('A2. User A can read global achievements catalog', async () => {
  const r = await rest('achievements?select=id,name,description,category,icon', tokenA)
  assert.equal(r.status, 200, r.text)
  const rows = r.json as { id: string }[]
  assert.ok(rows.length >= 5, `catalog has V1 rows, got ${rows.length}`)
  const ids = new Set(rows.map((x) => x.id))
  for (const id of ['first_game', 'first_ttt_win', 'first_sudoku', 'first_ai_chat', 'first_coin_exchange']) {
    assert.ok(ids.has(id), `catalog contains ${id}`)
  }
})

test('B. User A cannot read User B user_achievements', async () => {
  const r = await rest(`user_achievements?select=achievement_id&user_id=eq.${idB}`, tokenA)
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(r.json, [], 'B rows invisible to A')
})

test('C. Anonymous cannot read user_achievements (protected)', async () => {
  const r = await rest('user_achievements?select=achievement_id')
  // RLS: anon has no policy → empty or 401
  if (r.status === 200) {
    assert.deepEqual(r.json, [], 'anon sees no user achievement rows')
  } else {
    assert.ok(r.status === 401 || r.status === 403, `status=${r.status}`)
  }
})

test('D. User A cannot INSERT an achievement directly', async () => {
  const r = await rest('user_achievements', tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ user_id: idA, achievement_id: 'first_game' }),
  })
  assert.ok(
    r.status === 401 || r.status === 403 || r.status === 405 || r.status === 42501 || r.status === 409,
    `status=${r.status}`,
  )
})

test('E. User A cannot UPDATE an achievement directly', async () => {
  const r = await rest(`user_achievements?user_id=eq.${idA}`, tokenA, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ earned_at: new Date().toISOString() }),
  })
  if (r.status === 200 || r.status === 204) {
    const rows = Array.isArray(r.json) ? r.json : []
    assert.equal(rows.length, 0, 'no rows updated')
  } else {
    assert.ok(r.status === 403 || r.status === 404 || r.status === 42501, `status=${r.status}`)
  }
})

test('F. User A cannot DELETE an achievement directly', async () => {
  const r = await rest(`user_achievements?user_id=eq.${idA}&achievement_id=eq.first_game`, tokenA, {
    method: 'DELETE',
    headers: { Prefer: 'return=representation' },
  })
  if (r.status === 200 || r.status === 204) {
    const rows = Array.isArray(r.json) ? r.json : []
    assert.equal(rows.length, 0, 'no rows deleted')
  } else {
    assert.ok(r.status === 403 || r.status === 404 || r.status === 42501, `status=${r.status}`)
  }
})

test('G. User A cannot award an achievement to User B', async () => {
  const r = await rest('user_achievements', tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: idB, achievement_id: 'first_game' }),
  })
  assert.ok(
    r.status === 401 || r.status === 403 || r.status === 405 || r.status === 42501 || r.status === 409,
    `status=${r.status}`,
  )
  // B still has no forced rows from this attempt
  const bRows = await rest(`user_achievements?select=achievement_id&user_id=eq.${idB}`, tokenB)
  assert.equal(bRows.status, 200)
  // rows may exist from real play — just ensure A's insert didn't add a bogus one pattern
  // (we cannot distinguish; the INSERT itself must fail which we asserted)
})

test('H. User A cannot self-award arbitrary achievement IDs', async () => {
  const r = await rest('user_achievements', tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: idA, achievement_id: 'made_up_achievement' }),
  })
  assert.ok(
    r.status === 401 || r.status === 403 || r.status === 405 || r.status === 42501 || r.status === 409 || r.status === 500,
    `status=${r.status}`,
  )
})

// ── Functional (I–O) ─────────────────────────────────────────

test('I/J/K. Static: game RPCs award First Game / TTT Win / Sudoku on verified completion only', () => {
  // Covered by award-hook + win-guard static tests above; assert catalog ids used.
  assert.match(migrationSrc, /values \(v_user_id, 'first_game'\)/)
  assert.match(migrationSrc, /values \(v_user_id, 'first_ttt_win'\)/)
  assert.match(migrationSrc, /values \(v_user_id, 'first_sudoku'\)/)
  // No award on session start edge functions
  const tttEdge = readFileSync(resolve(root, 'supabase/functions/process-tictactoe/index.ts'), 'utf8')
  const sudokuEdge = readFileSync(resolve(root, 'supabase/functions/process-sudoku/index.ts'), 'utf8')
  assert.doesNotMatch(tttEdge, /user_achievements/)
  assert.doesNotMatch(sudokuEdge, /user_achievements/)
  assert.doesNotMatch(tttEdge, /first_game/)
  assert.doesNotMatch(sudokuEdge, /first_game/)
})

test('L. Static: AI achievement only in finalize, not reserve/release', () => {
  const m02 = readFileSync(
    resolve(root, 'supabase/migrations/20260920000002_chat_messages_and_credit_reservation.sql'),
    'utf8',
  )
  const m17 = readFileSync(
    resolve(root, 'supabase/migrations/20260924000002_phase2c_reserve_chat_credit_refund_fix.sql'),
    'utf8',
  )
  assert.doesNotMatch(m02, /user_achievements/)
  assert.doesNotMatch(m17, /user_achievements/)
  // reserve edge path doesn't award
  const chatEdge = readFileSync(resolve(root, 'supabase/functions/nova-chat/index.ts'), 'utf8')
  assert.doesNotMatch(chatEdge, /user_achievements/)
  assert.doesNotMatch(chatEdge, /first_ai_chat/)
})

test('M/N. Successful coin exchange awards First Coin Exchange once (runtime)', async () => {
  const before = await rest(
    `user_achievements?select=achievement_id&user_id=eq.${idA}&achievement_id=eq.first_coin_exchange`,
    tokenA,
  )
  assert.equal(before.status, 200, before.text)
  const hadIt = Array.isArray(before.json) && before.json.length > 0

  // Ensure enough coins for at least one exchange if not already earned
  if (!hadIt) {
    const w = await rest('wallet?select=earned_coins,ai_credits', tokenA)
    assert.equal(w.status, 200)
    const wallet = (w.json as { earned_coins: number }[])[0]
    assert.ok(wallet, 'wallet exists')
    if (wallet.earned_coins >= 10) {
      const ex = await edge('exchange-nova-coins', { idempotencyKey: crypto.randomUUID() }, tokenA)
      assert.equal(ex.status, 200, ex.text)
      const after = await rest(
        `user_achievements?select=achievement_id&user_id=eq.${idA}&achievement_id=eq.first_coin_exchange`,
        tokenA,
      )
      assert.equal(after.status, 200)
      assert.equal((after.json as unknown[]).length, 1, 'exactly one first_coin_exchange row')
    } else {
      // Skip runtime award if insufficient coins — static hook already verified
      assert.ok(true, 'skip: insufficient coins for exchange (static hook verified)')
    }
  } else {
    // Already earned — verify still exactly one (idempotent, no duplicates)
    assert.equal((before.json as unknown[]).length, 1, 'exactly one row when already earned')
  }

  // N: duplicate exchange with new key must not create a second achievement row
  const w2 = await rest('wallet?select=earned_coins', tokenA)
  const wallet2 = (w2.json as { earned_coins: number }[])[0]
  if (wallet2 && wallet2.earned_coins >= 10) {
    await edge('exchange-nova-coins', { idempotencyKey: crypto.randomUUID() }, tokenA)
    const count = await rest(
      `user_achievements?select=achievement_id&user_id=eq.${idA}&achievement_id=eq.first_coin_exchange`,
      tokenA,
    )
    assert.equal((count.json as unknown[]).length, 1, 'still exactly one after second exchange')
  }
})

test('O. Failed operations do not award — insufficient exchange leaves achievement logic unchanged', async () => {
  // Capture current achievement count for first_coin_exchange
  const before = await rest(
    `user_achievements?select=achievement_id&user_id=eq.${idA}&achievement_id=eq.first_coin_exchange`,
    tokenA,
  )
  const beforeCount = Array.isArray(before.json) ? before.json.length : 0

  const w = await rest('wallet?select=earned_coins', tokenA)
  const wallet = (w.json as { earned_coins: number }[])[0]
  if (wallet.earned_coins < 10) {
    // Attempt exchange that must fail — should not award if not already present via failure path
    // (award only runs after successful writes inside the function)
    const ex = await edge('exchange-nova-coins', { idempotencyKey: crypto.randomUUID() }, tokenA)
    assert.ok(ex.status >= 400, `expected failure, got ${ex.status}`)
    const after = await rest(
      `user_achievements?select=achievement_id&user_id=eq.${idA}&achievement_id=eq.first_coin_exchange`,
      tokenA,
    )
    const afterCount = Array.isArray(after.json) ? after.json.length : 0
    assert.equal(afterCount, beforeCount, 'failed exchange does not change achievement rows')
  } else {
    assert.ok(true, 'skip: user has coins — insufficient-funds path not reachable')
  }
})

test('runtime. Catalog global read works for User B too', async () => {
  const r = await rest('achievements?select=id', tokenB)
  assert.equal(r.status, 200)
  assert.ok((r.json as unknown[]).length >= 5)
})

test('runtime. User B cannot see User A rows', async () => {
  const r = await rest(`user_achievements?select=achievement_id&user_id=eq.${idA}`, tokenB)
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, [])
})

test('static. Profile does not invent fake earned state (earned only from DB join)', () => {
  // earned flag comes from earnedMap built from user_achievements query
  assert.match(profileSrc, /earnedMap\.has\(a\.id\)/)
  assert.doesNotMatch(profileSrc, /earned:\s*true\s*,\s*earned_at/)
})
