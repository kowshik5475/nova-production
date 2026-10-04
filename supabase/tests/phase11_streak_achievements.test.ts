// Phase 11 — Streak Achievements V1 tests (A–U)
// Run: node --experimental-strip-types supabase/tests/phase11_streak_achievements.test.ts
// Uses existing Phase 2B test users only. Creates no permanent users.
// Date fixtures: temporary streak date overrides on the linked test project
// (documented test mechanism, snapshot/restored in after()).

import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../..')
const envText = readFileSync(resolve(root, '.env'), 'utf8')
const SUPABASE_URL = /VITE_SUPABASE_URL=(.+)/.exec(envText)?.[1]?.trim()
const ANON_KEY = /VITE_SUPABASE_ANON_KEY=(.+)/.exec(envText)?.[1]?.trim()
if (!SUPABASE_URL || !ANON_KEY) throw new Error('Missing Supabase env')

const emailA = 'p2busera@example.com'
const emailB = 'p2buserb@example.com'
const password = 'password123'

const m11 = readFileSync(
  resolve(root, 'supabase/migrations/20260924000007_phase11_streak_achievements_v1.sql'),
  'utf8',
)
const m10 = readFileSync(
  resolve(root, 'supabase/migrations/20260924000006_phase10_streak_v1.sql'),
  'utf8',
)
const m9 = readFileSync(
  resolve(root, 'supabase/migrations/20260924000005_phase9_achievements_v1.sql'),
  'utf8',
)
const m2a = readFileSync(
  resolve(root, 'supabase/migrations/20260924000001_phase2a_p0_rls_hardening.sql'),
  'utf8',
)
const core = readFileSync(
  resolve(root, 'supabase/migrations/20260920_00_core_tables.sql'),
  'utf8',
)
const profileSrc = readFileSync(resolve(root, 'src/app/profile.tsx'), 'utf8')
const typesSrc = readFileSync(resolve(root, 'src/app/types.ts'), 'utf8')
const tttEdge = readFileSync(
  resolve(root, 'supabase/functions/process-tictactoe/index.ts'),
  'utf8',
)
const sudokuEdge = readFileSync(
  resolve(root, 'supabase/functions/process-sudoku/index.ts'),
  'utf8',
)
const chatEdge = readFileSync(resolve(root, 'supabase/functions/nova-chat/index.ts'), 'utf8')

const STREAK_IDS = ['streak_3', 'streak_7', 'streak_14']
const PHASE9_IDS = [
  'first_game',
  'first_ttt_win',
  'first_sudoku',
  'first_ai_chat',
  'first_coin_exchange',
]

let tokenA = ''
let tokenB = ''
let idA = ''
let idB = ''
let savedStreakA = 0
let savedLastA: string | null = null
let savedStreakAchA: string[] = []
let savedStreakAchB: string[] = []

const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10)
const today = () => new Date().toISOString().slice(0, 10)

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

async function rpc(name: string, args: Record<string, unknown>, token?: string) {
  return rest(`rpc/${name}`, token, { method: 'POST', body: JSON.stringify(args) })
}

// Linked-project SQL helper (documented test mechanism on the linked project).
let sqlSeq = 0
function sqlRaw(query: string): { ok: boolean; out: string } {
  const osTmp = resolve(
    process.env.TEMP || process.env.TMP || '.',
    `phase11-${process.pid}-${Date.now()}-${sqlSeq++}.sql`,
  )
  writeFileSync(osTmp, query, 'utf8')
  try {
    const out = execFileSync('npx.cmd', ['supabase', 'db', 'query', '--linked', '-f', osTmp], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    })
    return { ok: true, out: String(out ?? '') }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    return { ok: false, out: `${e.stdout ?? ''}\n${e.stderr ?? ''}` }
  } finally {
    try {
      unlinkSync(osTmp)
    } catch {
      /* ignore */
    }
  }
}

function sql(query: string) {
  const r = sqlRaw(query)
  assert.ok(r.ok, `sql failed: ${r.out}`)
}

async function getStreak(token: string, uid: string) {
  const r = await rest(`profiles?select=streak,last_activity_date&id=eq.${uid}`, token)
  assert.equal(r.status, 200, r.text)
  const rows = r.json as { streak: number; last_activity_date: string | null }[]
  assert.equal(rows.length, 1, 'profile row')
  return rows[0]
}

async function streakAwards(token: string, uid: string): Promise<string[]> {
  const r = await rest(
    `user_achievements?select=achievement_id&user_id=eq.${uid}&achievement_id=in.(streak_3,streak_7,streak_14)`,
    token,
  )
  assert.equal(r.status, 200, r.text)
  const have = new Set(
    (r.json as { achievement_id: string }[]).map((x) => x.achievement_id),
  )
  return STREAK_IDS.filter((id) => have.has(id))
}

function setStreakFixture(uid: string, streak: number, lastDate: string | null, clearAwards = false) {
  const lastLit = lastDate ? `'${lastDate}'` : 'null'
  const del = clearAwards
    ? `delete from public.user_achievements where user_id = '${uid}' and achievement_id in ('streak_3','streak_7','streak_14');\n`
    : ''
  sql(`${del}update public.profiles set streak = ${streak}, last_activity_date = ${lastLit} where id = '${uid}';`)
}

const validXWin = ['X', 'X', 'X', 'O', 'O', null, null, null, null]
const validDraw = ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X']
const solvedBoard = [
  5, 3, 4, 6, 7, 8, 9, 1, 2,
  6, 7, 2, 1, 9, 5, 3, 4, 8,
  1, 9, 8, 3, 4, 2, 5, 6, 7,
  8, 5, 9, 7, 6, 1, 4, 2, 3,
  4, 2, 6, 8, 5, 3, 7, 9, 1,
  7, 1, 3, 9, 2, 4, 8, 5, 6,
  9, 6, 1, 5, 3, 7, 2, 8, 4,
  2, 8, 7, 4, 1, 9, 6, 3, 5,
  3, 4, 5, 2, 8, 6, 1, 7, 9,
]

async function completeTtt(token: string, board = validDraw) {
  const start = await edge('process-tictactoe', { action: 'start' }, token)
  assert.equal(start.status, 200, start.text)
  const sid = start.json.sessionId
  const done = await edge('process-tictactoe', { action: 'complete', sessionId: sid, board }, token)
  return { sid, done }
}

async function completeSudoku(token: string) {
  const start = await edge('process-sudoku', { action: 'start', puzzleId: 0 }, token)
  assert.equal(start.status, 200, start.text)
  const sid = start.json.sessionId
  const done = await edge(
    'process-sudoku',
    { action: 'complete', sessionId: sid, puzzleId: 0, board: solvedBoard },
    token,
  )
  return { sid, done }
}

async function readCatalog(token: string) {
  const r = await rest('achievements?select=id,name,description,category,target_type,target_value,icon', token)
  assert.equal(r.status, 200, r.text)
  return r.json as {
    id: string
    name: string
    description: string
    category: string
    target_type: string
    target_value: number
    icon: string | null
  }[]
}

before(async () => {
  tokenA = await signIn(emailA)
  tokenB = await signIn(emailB)
  const a = await rest('profiles?select=id,streak,last_activity_date&limit=1', tokenA)
  const b = await rest('profiles?select=id&limit=1', tokenB)
  idA = (a.json as { id: string }[])[0].id
  idB = (b.json as { id: string }[])[0].id
  savedStreakA = (a.json as { streak: number }[])[0].streak
  savedLastA = (a.json as { last_activity_date: string | null }[])[0].last_activity_date
  savedStreakAchA = await streakAwards(tokenA, idA)
  savedStreakAchB = await streakAwards(tokenB, idB)
})

after(async () => {
  // Restore User A streak fixture + streak achievement snapshots (best effort).
  try {
    const lastLit = savedLastA ? `'${savedLastA}'` : 'null'
    const del = `delete from public.user_achievements where user_id = '${idA}' and achievement_id in ('streak_3','streak_7','streak_14');`
    const ins = savedStreakAchA.length
      ? `\ninsert into public.user_achievements (user_id, achievement_id) values ${savedStreakAchA
          .map((id) => `('${idA}','${id}')`)
          .join(',')}\non conflict do nothing;`
      : ''
    const delB = `delete from public.user_achievements where user_id = '${idB}' and achievement_id in ('streak_3','streak_7','streak_14');`
    const insB = savedStreakAchB.length
      ? `\ninsert into public.user_achievements (user_id, achievement_id) values ${savedStreakAchB
          .map((id) => `('${idB}','${id}')`)
          .join(',')}\non conflict do nothing;`
      : ''
    sql(
      `update public.profiles set streak = ${savedStreakA}, last_activity_date = ${lastLit} where id = '${idA}';\n${del}${ins}\n${delB}${insB}`,
    )
  } catch {
    /* best-effort restore */
  }
})

// ── Static: migration / schema / security ────────────────────

test('static. One focused migration: catalog seed + touch_user_streak replacement only', () => {
  assert.match(m11, /insert into public\.achievements/)
  assert.match(m11, /create or replace function public\.touch_user_streak\(\)/)
  assert.equal((m11.match(/create or replace function/g) ?? []).length, 1, 'exactly one function')
  assert.doesNotMatch(m11, /create table/i)
  assert.doesNotMatch(m11, /drop table/i)
  assert.doesNotMatch(m11, /alter table/i)
  assert.doesNotMatch(m11, /create policy/i)
  assert.doesNotMatch(m11, /drop policy/i)
  assert.doesNotMatch(m11, /alter column/i)
  // the four Phase 9/10 RPCs are not redefined here
  for (const fn of [
    'complete_tictactoe_game',
    'complete_sudoku_game',
    'finalize_chat_credit',
    'exchange_nova_coins',
  ]) {
    assert.ok(!m11.includes(`function public.${fn}`), `${fn} untouched by phase11`)
  }
})

test('static. Seed is idempotent and contains only streak_3 / streak_7 / streak_14', () => {
  assert.match(m11, /on conflict \(id\) do nothing/)
  for (const id of STREAK_IDS) assert.ok(m11.includes(`'${id}'`), `catalog contains ${id}`)
  const seeded = [...m11.matchAll(/'(streak_\d+)'/g)].map((m) => m[1])
  assert.deepEqual(
    [...new Set(seeded)].sort(),
    ['streak_14', 'streak_3', 'streak_7'],
    'no extra streak thresholds seeded',
  )
  assert.match(m11, /'streak', 'streak',\s*3/)
  assert.match(m11, /'streak', 'streak',\s*7/)
  assert.match(m11, /'streak', 'streak',\s*14/)
})

test('static. target_type = streak is valid under the existing CHECK constraint', () => {
  assert.match(
    core,
    /target_type text not null check \(target_type in \('games_played', 'games_won', 'streak', 'xp', 'first_game'\)\)/,
  )
  assert.match(m9, /'games_won'/)
})

test('static. touch_user_streak keeps Phase 10 semantics + internal-only EXECUTE', () => {
  assert.match(m11, /v_uid uuid := auth\.uid\(\)/)
  assert.ok(!/touch_user_streak\([^)]*user_id/i.test(m11), 'no user_id parameter')
  assert.match(m11, /timezone\('utc'::text, now\(\)\)\)::date/)
  assert.match(m11, /select last_activity_date, streak[\s\S]*?for update/)
  assert.match(m11, /security definer/)
  assert.match(m11, /set search_path = public/)
  assert.match(m11, /greatest\(coalesce\(v_streak, 0\), 0\) \+ 1/)
  assert.match(m11, /v_streak := 1/)
  assert.match(m11, /revoke all on function public\.touch_user_streak\(\) from public/)
  assert.match(m11, /revoke all on function public\.touch_user_streak\(\) from anon/)
  assert.match(m11, /revoke all on function public\.touch_user_streak\(\) from authenticated/)
  assert.doesNotMatch(m11, /grant execute/i)
})

test('static. Award logic lives only inside touch_user_streak (single authoritative path)', () => {
  assert.equal(
    (m11.match(/insert into public\.user_achievements/g) ?? []).length,
    1,
    'one award insert in the migration',
  )
  const idx = m11.indexOf('function public.touch_user_streak')
  assert.ok(idx >= 0)
  const body = m11.slice(idx)
  assert.match(body, /insert into public\.user_achievements/)
  assert.match(body, /from public\.achievements a/)
  assert.match(body, /a\.target_type = 'streak'/)
  assert.match(body, /a\.target_value <= v_streak/)
  assert.match(body, /on conflict do nothing/)
  assert.ok(!m11.includes('award_achievement'), 'no client-callable award function')
  // all four authoritative RPCs still route through touch_user_streak (Phase 10)
  for (const fn of [
    'complete_tictactoe_game',
    'complete_sudoku_game',
    'finalize_chat_credit',
    'exchange_nova_coins',
  ]) {
    const i = m10.indexOf(`function public.${fn}`)
    assert.ok(i >= 0, `${fn} in phase10`)
    const next = m10.indexOf('function public.', i + 10)
    const seg = m10.slice(i, next === -1 ? undefined : next)
    assert.match(seg, /perform public\.touch_user_streak\(\)/, `${fn} touches streak`)
  }
})

test('static. No browser award path: no RLS change, no grants, no edge/secret access', () => {
  assert.doesNotMatch(m11, /create policy/i)
  assert.doesNotMatch(m11, /grant execute/i)
  assert.doesNotMatch(m11, /service_role/i)
  assert.doesNotMatch(m11, /SERVICE_ROLE/i)
  assert.doesNotMatch(m11, /with check \(true\)/i)
  assert.match(m2a, /Users can read own achievements/)
  assert.match(m2a, /auth\.uid\(\) = user_id/)
  assert.doesNotMatch(tttEdge, /user_achievements/)
  assert.doesNotMatch(sudokuEdge, /user_achievements/)
  assert.doesNotMatch(chatEdge, /user_achievements/)
  assert.doesNotMatch(tttEdge, /streak_3/)
  assert.doesNotMatch(sudokuEdge, /streak_3/)
  assert.doesNotMatch(chatEdge, /streak_3/)
})

test('static. Profile UI needs no change: it reads the global catalog + own awards', () => {
  assert.match(profileSrc, /from\('achievements'\)/)
  assert.match(profileSrc, /from\('user_achievements'\)/)
  assert.match(profileSrc, /earnedMap\.has\(a\.id\)/)
  assert.match(profileSrc, /profile-achievement-locked/)
  assert.match(profileSrc, /profile-achievement-earned/)
  assert.doesNotMatch(profileSrc, /streak_3|streak_7|streak_14/, 'no hardcoded streak ids in UI')
  assert.match(typesSrc, /achievements: AchievementView\[\]/)
})

// ── A–B: catalog ─────────────────────────────────────────────

test('A. Catalog contains exactly the 3 intended streak achievements', async () => {
  const rows = (await readCatalog(tokenA)).filter((r) => r.target_type === 'streak')
  assert.equal(rows.length, 3, `expected 3 streak rows, got ${rows.length}`)
  rows.sort((x, y) => x.target_value - y.target_value)
  assert.deepEqual(
    rows.map((r) => [r.id, r.name, r.target_value]),
    [
      ['streak_3', '3-Day Streak', 3],
      ['streak_7', '7-Day Streak', 7],
      ['streak_14', '14-Day Streak', 14],
    ],
  )
  assert.equal(rows[0].description, 'Maintain a 3-day NOVA activity streak.')
  assert.equal(rows[1].description, 'Maintain a 7-day NOVA activity streak.')
  assert.equal(rows[2].description, 'Maintain a 14-day NOVA activity streak.')
})

test('B. target_type = streak is accepted by the live CHECK constraint', async () => {
  const r = sqlRaw(
    `select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.achievements'::regclass and contype = 'c';`,
  )
  assert.ok(r.ok, r.out)
  assert.match(r.out, /'streak'/, 'CHECK constraint lists streak')
  const cat = await readCatalog(tokenA)
  assert.ok(cat.some((c) => c.target_type === 'streak'), 'streak rows persisted')
})

// ── C–I: awarding ────────────────────────────────────────────
// Order matters: fixtures set streak state, activities run serially.

test('C. First qualifying activity does not award streak_3', async () => {
  setStreakFixture(idA, 0, null, true)
  const before = await getStreak(tokenA, idA)
  assert.equal(before.streak, 0)
  assert.equal(before.last_activity_date, null)
  assert.deepEqual(await streakAwards(tokenA, idA), [])

  const { done } = await completeTtt(tokenA, validXWin)
  assert.equal(done.status, 200, done.text)

  const after = await getStreak(tokenA, idA)
  assert.equal(after.streak, 1, 'first activity → streak 1')
  assert.deepEqual(await streakAwards(tokenA, idA), [], 'no streak achievement at streak 1')
})

test('D. Streak 3 awards streak_3', async () => {
  setStreakFixture(idA, 2, yesterday())
  const { done } = await completeTtt(tokenA, validDraw)
  assert.equal(done.status, 200, done.text)

  const after = await getStreak(tokenA, idA)
  assert.equal(after.streak, 3, 'consecutive day → streak 3')
  assert.deepEqual(await streakAwards(tokenA, idA), ['streak_3'])
})

test('E. Streak 3 retry (same day) does not duplicate', async () => {
  const before = await getStreak(tokenA, idA)
  assert.equal(before.streak, 3)
  const { done } = await completeSudoku(tokenA)
  assert.equal(done.status, 200, done.text)

  const after = await getStreak(tokenA, idA)
  assert.equal(after.streak, 3, 'same-day activity does not increment')
  assert.deepEqual(await streakAwards(tokenA, idA), ['streak_3'], 'exactly one streak_3')
})

test('F. Streak 7 awards streak_7', async () => {
  setStreakFixture(idA, 6, yesterday())
  const { done } = await completeTtt(tokenA, validDraw)
  assert.equal(done.status, 200, done.text)

  const after = await getStreak(tokenA, idA)
  assert.equal(after.streak, 7, 'consecutive day → streak 7')
  assert.deepEqual(await streakAwards(tokenA, idA), ['streak_3', 'streak_7'])
})

test('H. Previously earned streak_3 remains after streak 7', async () => {
  const awards = await streakAwards(tokenA, idA)
  assert.ok(awards.includes('streak_3'), 'streak_3 still earned')
  assert.ok(awards.includes('streak_7'), 'streak_7 earned')
})

test('G. Streak 14 awards streak_14', async () => {
  setStreakFixture(idA, 13, yesterday())
  const { done } = await completeTtt(tokenA, validDraw)
  assert.equal(done.status, 200, done.text)

  const after = await getStreak(tokenA, idA)
  assert.equal(after.streak, 14, 'consecutive day → streak 14')
  assert.deepEqual(await streakAwards(tokenA, idA), ['streak_3', 'streak_7', 'streak_14'])
})

test('I. Jumping a threshold awards every newly satisfied threshold once', async () => {
  // 6 → 7 in one step with nothing previously earned: awards 3 AND 7.
  setStreakFixture(idA, 6, yesterday(), true)
  assert.deepEqual(await streakAwards(tokenA, idA), [])

  const { done } = await completeTtt(tokenA, validDraw)
  assert.equal(done.status, 200, done.text)

  const after = await getStreak(tokenA, idA)
  assert.equal(after.streak, 7)
  assert.deepEqual(
    await streakAwards(tokenA, idA),
    ['streak_3', 'streak_7'],
    'both newly satisfied thresholds awarded, 14 stays locked',
  )
})

// ── R: same-day behaviour ────────────────────────────────────

test('R. Same-day activity does not increase streak or duplicate awards', async () => {
  const before = await getStreak(tokenA, idA)
  assert.equal(before.streak, 7, 'state carried from I')
  const beforeAwards = await streakAwards(tokenA, idA)
  assert.deepEqual(beforeAwards, ['streak_3', 'streak_7'])

  const { done } = await completeTtt(tokenA, validDraw)
  assert.equal(done.status, 200, done.text)

  const after = await getStreak(tokenA, idA)
  assert.equal(after.streak, 7, 'same-day activity does not increment')
  assert.equal(after.last_activity_date, before.last_activity_date, 'date unchanged')
  assert.deepEqual(await streakAwards(tokenA, idA), beforeAwards, 'no duplicate awards')
})

// ── S: refresh / persistence ─────────────────────────────────

test('S. Refresh and re-login preserve earned streak achievements', async () => {
  // fresh session (equivalent to refresh + logout/login), no client cache
  const fresh = await signIn(emailA)
  tokenA = fresh

  const r = await rest(
    `user_achievements?select=achievement_id&user_id=eq.${idA}&achievement_id=in.(streak_3,streak_7,streak_14)`,
    tokenA,
  )
  assert.equal(r.status, 200, r.text)
  const ids = (r.json as { achievement_id: string }[]).map((x) => x.achievement_id).sort()
  assert.deepEqual(ids, ['streak_3', 'streak_7'], 'earned set survives a fresh read')

  const cat = await rest('achievements?select=id&target_type=eq.streak', tokenA)
  assert.equal(cat.status, 200, cat.text)
  assert.equal((cat.json as unknown[]).length, 3, 'catalog visible after re-login')

  const again = await rest(
    `user_achievements?select=achievement_id&user_id=eq.${idA}&achievement_id=in.(streak_3,streak_7,streak_14)`,
    tokenA,
  )
  assert.deepEqual(
    (again.json as { achievement_id: string }[]).map((x) => x.achievement_id).sort(),
    ids,
    'repeat read identical (persistence, not localStorage)',
  )

  // Cross-user isolation: B sees none of A's streak awards, and B's own set
  // is exactly what it was at suite start.
  const bRows = await rest(
    `user_achievements?select=achievement_id&user_id=eq.${idA}&achievement_id=in.(streak_3,streak_7,streak_14)`,
    tokenB,
  )
  assert.equal(bRows.status, 200, bRows.text)
  assert.deepEqual(bRows.json, [], 'B cannot see A streak achievements')
  assert.deepEqual(await streakAwards(tokenB, idB), savedStreakAchB, 'B awards untouched by suite')
})

// ── J: authoritative transaction ─────────────────────────────

test('J. Streak achievement is awarded in the same authoritative transaction', async () => {
  // Fixture committed first: streak 2, last activity yesterday, no awards yet.
  setStreakFixture(idA, 2, yesterday(), true)
  assert.deepEqual(await streakAwards(tokenA, idA), [])

  // Inside ONE transaction: impersonate the authenticated user, run the
  // authoritative streak update, then abort the transaction — but only if
  // the streak_3 award actually exists in that transaction.
  const probe = [
    'begin;',
    `select set_config('request.jwt.claim.sub', '${idA}', true);`,
    'select public.touch_user_streak();',
    `select 1 / ((select count(*) from public.user_achievements where user_id = '${idA}' and achievement_id = 'streak_3') - 1) as p11_award_present_in_tx;`,
    'rollback;',
  ].join('\n')

  const res = sqlRaw(probe)
  assert.equal(res.ok, false, `probe must abort the transaction, got ok. out=${res.out}`)
  assert.match(res.out, /division by zero/, `award must exist inside the tx. out=${res.out}`)

  // Rollback removed BOTH the streak update and the award — nothing leaked.
  const after = await getStreak(tokenA, idA)
  assert.equal(after.streak, 2, 'streak update rolled back')
  assert.equal(after.last_activity_date, yesterday(), 'activity date rolled back')
  assert.deepEqual(await streakAwards(tokenA, idA), [], 'award rolled back with the streak')
})

// ── K–L: non-qualifying activity ─────────────────────────────

test('K. Failed activity does not award a streak achievement', async () => {
  const before = await getStreak(tokenA, idA)
  assert.equal(before.streak, 2)
  const beforeAwards = await streakAwards(tokenA, idA)

  const start = await edge('process-sudoku', { action: 'start', puzzleId: 0 }, tokenA)
  assert.equal(start.status, 200)
  const bad = await edge(
    'process-sudoku',
    { action: 'complete', sessionId: start.json.sessionId, puzzleId: 0, board: Array(81).fill(0) },
    tokenA,
  )
  assert.ok(bad.status >= 400, `expected failure, got ${bad.status}`)

  const after = await getStreak(tokenA, idA)
  assert.equal(after.streak, before.streak, 'failed activity does not update streak')
  assert.equal(after.last_activity_date, before.last_activity_date)
  assert.deepEqual(await streakAwards(tokenA, idA), beforeAwards, 'no award on failure')
})

test('L. Abandoned activity does not award a streak achievement', async () => {
  const before = await getStreak(tokenA, idA)
  const beforeAwards = await streakAwards(tokenA, idA)

  const start = await edge('process-tictactoe', { action: 'start' }, tokenA)
  assert.equal(start.status, 200)

  const after = await getStreak(tokenA, idA)
  assert.equal(after.streak, before.streak, 'start alone does not update streak')
  assert.equal(after.last_activity_date, before.last_activity_date)
  assert.deepEqual(await streakAwards(tokenA, idA), beforeAwards, 'no award on abandon')
})

// ── M–Q: security ────────────────────────────────────────────

test('M. User cannot directly INSERT user_achievements', async () => {
  const r = await rest('user_achievements', tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ user_id: idA, achievement_id: 'streak_3' }),
  })
  assert.ok(
    r.status === 401 || r.status === 403 || r.status === 405 || r.status === 42501 || r.status === 409,
    `status=${r.status}`,
  )
  assert.deepEqual(await streakAwards(tokenA, idA), [], 'no self-awarded streak row')
})

test('N. User cannot directly UPDATE user_achievements', async () => {
  const r = await rest(`user_achievements?user_id=eq.${idA}`, tokenA, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ achievement_id: 'streak_14' }),
  })
  if (r.status === 200 || r.status === 204) {
    const rows = Array.isArray(r.json) ? r.json : []
    assert.equal(rows.length, 0, 'no rows updated')
  } else {
    assert.ok(r.status === 403 || r.status === 404 || r.status === 42501, `status=${r.status}`)
  }
  assert.deepEqual(await streakAwards(tokenA, idA), [], 'streak awards unchanged')
})

test('O. User cannot directly DELETE user_achievements', async () => {
  const r = await rest(`user_achievements?user_id=eq.${idA}&achievement_id=eq.streak_3`, tokenA, {
    method: 'DELETE',
    headers: { Prefer: 'return=representation' },
  })
  if (r.status === 200 || r.status === 204) {
    const rows = Array.isArray(r.json) ? r.json : []
    assert.equal(rows.length, 0, 'no rows deleted')
  } else {
    assert.ok(r.status === 403 || r.status === 404 || r.status === 42501, `status=${r.status}`)
  }
  assert.deepEqual(await streakAwards(tokenA, idA), [], 'nothing deleted')
})

test('P. User A cannot award a streak achievement to User B', async () => {
  const beforeB = await streakAwards(tokenB, idB)
  const beforeBStreak = await getStreak(tokenB, idB)
  const r = await rest('user_achievements', tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: idB, achievement_id: 'streak_3' }),
  })
  assert.ok(
    r.status === 401 || r.status === 403 || r.status === 405 || r.status === 42501 || r.status === 409,
    `status=${r.status}`,
  )
  const afterB = await streakAwards(tokenB, idB)
  assert.deepEqual(afterB, beforeB, 'B streak awards unchanged by A')

  // A also cannot touch B's streak columns.
  const patch = await rest(`profiles?id=eq.${idB}`, tokenA, {
    method: 'PATCH',
    body: JSON.stringify({ streak: 42 }),
  })
  if (patch.status === 200 || patch.status === 204) {
    const rows = Array.isArray(patch.json) ? patch.json : []
    assert.equal(rows.length, 0, 'A updated no B rows')
  }
  const bStreak = await getStreak(tokenB, idB)
  assert.equal(bStreak.streak, beforeBStreak.streak, 'B streak unchanged')
  assert.equal(
    bStreak.last_activity_date,
    beforeBStreak.last_activity_date,
    'B last_activity_date unchanged',
  )
})

test('Q. Anonymous user cannot award achievements', async () => {
  const post = await rest('user_achievements', undefined, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: idA, achievement_id: 'streak_3' }),
  })
  assert.ok(
    post.status === 401 || post.status === 403 || post.status === 405 || post.status === 42501,
    `post status=${post.status}`,
  )
  const anonRead = await rest('user_achievements?select=achievement_id')
  if (anonRead.status === 200) {
    assert.deepEqual(anonRead.json, [], 'anon sees no achievement rows')
  } else {
    assert.ok(anonRead.status === 401 || anonRead.status === 403, `read status=${anonRead.status}`)
  }

  const touchAnon = await rpc('touch_user_streak', {}, undefined)
  assert.ok(
    touchAnon.status === 401 || touchAnon.status === 403 || touchAnon.status === 404 ||
      touchAnon.status === 405 || touchAnon.status === 500,
    `anon touch status=${touchAnon.status}`,
  )
  const touchAuth = await rpc('touch_user_streak', {}, tokenA)
  assert.ok(
    touchAuth.status === 401 || touchAuth.status === 403 || touchAuth.status === 404 ||
      touchAuth.status === 405 || touchAuth.status === 500,
    `authenticated touch status=${touchAuth.status}`,
  )
})

// ── T: Phase 9 regression ────────────────────────────────────

test('T. Existing Phase 9 achievements remain functional', async () => {
  const cat = await readCatalog(tokenA)
  const ids = new Set(cat.map((c) => c.id))
  for (const id of PHASE9_IDS) assert.ok(ids.has(id), `phase9 catalog row ${id} intact`)
  assert.equal(
    cat.filter((c) => !STREAK_IDS.includes(c.id)).length,
    7,
    'exactly 7 non-streak catalog rows (5 Phase 9 + first_ball_run + first_water_sort, no duplicates)',
  )

  // live award hooks for the 5 Phase 9 achievements are unchanged
  assert.match(m10, /values \(v_user_id, 'first_game'\)/)
  assert.match(m10, /values \(v_user_id, 'first_ttt_win'\)/)
  assert.match(m10, /values \(v_user_id, 'first_sudoku'\)/)
  assert.match(m10, /values \(v_user_id, 'first_ai_chat'\)/)
  assert.match(m10, /values \(v_user_id, 'first_coin_exchange'\)/)
  assert.match(m9, /first_coin_exchange/)

  // runtime: this suite's own Phase 9 awards are still present
  const r = await rest(
    `user_achievements?select=achievement_id&user_id=eq.${idA}`,
    tokenA,
  )
  assert.equal(r.status, 200, r.text)
  const earned = new Set((r.json as { achievement_id: string }[]).map((x) => x.achievement_id))
  for (const id of ['first_game', 'first_ttt_win', 'first_sudoku']) {
    assert.ok(earned.has(id), `phase9 achievement ${id} earned at runtime`)
  }
})

// ── U: concurrency ───────────────────────────────────────────

test('U. Concurrent qualifying activities do not duplicate streak achievements', async () => {
  // Fresh state: streak 2, last activity yesterday, no streak awards yet.
  setStreakFixture(idA, 2, yesterday(), true)
  assert.deepEqual(await streakAwards(tokenA, idA), [])

  const s1 = await edge('process-tictactoe', { action: 'start' }, tokenA)
  const s2 = await edge('process-tictactoe', { action: 'start' }, tokenA)
  assert.equal(s1.status, 200, s1.text)
  assert.equal(s2.status, 200, s2.text)

  const [a, b] = await Promise.all([
    edge('process-tictactoe', { action: 'complete', sessionId: s1.json.sessionId, board: validDraw }, tokenA),
    edge('process-tictactoe', { action: 'complete', sessionId: s2.json.sessionId, board: validXWin }, tokenA),
  ])
  const ok = [a, b].filter((r) => r.status === 200)
  assert.ok(ok.length >= 1, `at least one success: ${a.status}/${b.status}`)

  const after = await getStreak(tokenA, idA)
  assert.equal(after.streak, 3, 'FOR UPDATE serialises the increment')
  assert.equal(after.last_activity_date, today(), 'activity date is today (UTC convention)')
  assert.deepEqual(await streakAwards(tokenA, idA), ['streak_3'], 'exactly one streak_3 row')
})
