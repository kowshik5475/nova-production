// Phase 7 — account deletion security + lifecycle tests
// Run: node --experimental-strip-types supabase/tests/phase7_account_deletion.test.ts
// Temp user created out-of-band via SQL (avoids email signup rate limits).
// Does NOT delete p2busera / p2buserb.

import assert from 'node:assert/strict'
import { test, before } from 'node:test'
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../..')
const envText = readFileSync(resolve(root, '.env'), 'utf8')
const SUPABASE_URL = /VITE_SUPABASE_URL=(.+)/.exec(envText)?.[1]?.trim()
const ANON_KEY = /VITE_SUPABASE_ANON_KEY=(.+)/.exec(envText)?.[1]?.trim()
if (!SUPABASE_URL || !ANON_KEY) throw new Error('Missing Supabase env')

const FUNC = `${SUPABASE_URL}/functions/v1`
const emailB = 'p2buserb@example.com'
const password = 'password123'
const tempEmail = 'phase7del@example.test'
const tempPassword = 'TempDelete!234'

const edgeSrc = readFileSync(resolve(root, 'supabase/functions/delete-account/index.ts'), 'utf8')
const profileSrc = readFileSync(resolve(root, 'src/app/profile.tsx'), 'utf8')
const appSrc = readFileSync(resolve(root, 'src/app/App.tsx'), 'utf8')

const frontendFiles = [
  'src/app/profile.tsx',
  'src/app/App.tsx',
  'src/lib/supabase/client.ts',
  'src/lib/supabase.ts',
  'src/app/auth.tsx',
]

let tempToken = ''
let tempId = ''
let tokenB = ''
let beforeCounts: Record<string, number> = {}
let gamesCountBefore = 0
let achievementsCountBefore = 0
let bBefore: unknown = null

async function signIn(email: string, pw: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY! },
    body: JSON.stringify({ email, password: pw }),
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

async function callDelete(token: string | null, body: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${FUNC}/delete-account`, {
    method: 'POST',
    headers,
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

async function countForUser(token: string, userId: string) {
  const tables: Record<string, string> = {
    profiles: 'id',
    wallet: 'user_id',
    wallet_transactions: 'user_id',
    game_sessions: 'user_id',
    game_results: 'user_id',
    game_progress: 'user_id',
    chat_messages: 'user_id',
    chat_requests: 'user_id',
    user_achievements: 'user_id',
    leaderboard: 'user_id',
    exchange_requests: 'user_id',
    game_completions: 'user_id',
  }
  const counts: Record<string, number> = {}
  for (const [table, col] of Object.entries(tables)) {
    const r = await rest(`${table}?select=${col}&${col}=eq.${userId}&limit=1000`, token)
    counts[table] = Array.isArray(r.json) ? r.json.length : -1
  }
  return counts
}

function runSql(sql: string): string {
  const tmp = resolve(root, `supabase/tests/.phase7-${process.pid}.sql`)
  writeFileSync(tmp, sql, 'utf8')
  try {
    return execFileSync(
      'cmd',
      ['/c', 'npx', '--yes', 'supabase', 'db', 'query', '--linked', '-f', tmp],
      { cwd: root, encoding: 'utf8', windowsHide: true },
    )
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

before(async () => {
  // Temp user created out-of-band via SQL (avoids email rate limits).
  // Uses same pattern as phase2a_attack_verification.sql.
  const setupSql = readFileSync(resolve(root, 'supabase/tests/phase7_setup_temp_user.sql'), 'utf8')
  runSql(setupSql)
  tempToken = await signIn(tempEmail, tempPassword)
  const me = await rest('profiles?select=id,display_name&limit=1', tempToken)
  assert.equal(me.status, 200)
  const meRows = me.json as { id: string }[]
  assert.equal(meRows.length, 1, 'temp profile auto-provisioned')
  tempId = meRows[0].id

  tokenB = await signIn(emailB, password)
  const bProf = await rest('profiles?select=id,display_name,xp&limit=1', tokenB)
  assert.equal((bProf.json as unknown[]).length, 1, 'B exists')
  bBefore = bProf.json

  beforeCounts = await countForUser(tempToken, tempId)
  assert.equal(beforeCounts.profiles, 1)
  assert.equal(beforeCounts.wallet, 1)

  const gamesBefore = await rest('games?select=id', tempToken)
  const achievementsBefore = await rest('achievements?select=id', tempToken)
  gamesCountBefore = Array.isArray(gamesBefore.json) ? gamesBefore.json.length : 0
  achievementsCountBefore = Array.isArray(achievementsBefore.json) ? achievementsBefore.json.length : 0
  assert.ok(gamesCountBefore > 0, 'games catalog non-empty before')
})

// ── Static ───────────────────────────────────────────────────

test('E. Service-role credential never present in frontend source', () => {
  for (const rel of frontendFiles) {
    const src = readFileSync(resolve(root, rel), 'utf8')
    assert.doesNotMatch(src, /SERVICE_ROLE/i, rel)
    assert.doesNotMatch(src, /service_role/i, rel)
    assert.doesNotMatch(src, /SUPABASE_SERVICE_ROLE_KEY/, rel)
  }
  assert.match(edgeSrc, /SUPABASE_SERVICE_ROLE_KEY/)
  assert.doesNotMatch(edgeSrc, /console\.(log|error|info).*service/i)
})

test('F/G static. Confirmation phrase required; client requires typing DELETE', () => {
  assert.match(edgeSrc, /DELETE/)
  assert.match(edgeSrc, /confirmation/)
  assert.match(profileSrc, /Type DELETE to confirm/)
  assert.match(profileSrc, /deleteConfirm\.trim\(\) !== 'DELETE'/)
  assert.match(profileSrc, /delete-account/)
  assert.doesNotMatch(profileSrc, /alert\(|confirm\(/)
  assert.match(appSrc, /onAccountDeleted/)
})

test('No broad client DELETE policies added for phase 7', () => {
  const files = readdirSync(resolve(root, 'supabase/migrations'))
  const phase7 = files.filter((f) => f.includes('phase7'))
  assert.equal(phase7.length, 0, 'no phase7 migration expected')
})

test('A. Mechanism supports self-delete only (auth.uid from JWT)', () => {
  assert.match(edgeSrc, /admin\.deleteUser\(user\.id\)/)
  assert.doesNotMatch(edgeSrc, /deleteUser\(body\.|deleteUser\(payload\./)
  assert.match(edgeSrc, /auth\.getUser\(\)/)
  assert.doesNotMatch(edgeSrc, /body\.user_id|payload\.user_id/)
})

// ── Runtime ──────────────────────────────────────────────────

test('D. Anonymous delete-account is rejected', async () => {
  const res = await callDelete(null, { confirmation: 'DELETE' })
  assert.equal(res.status, 401, res.text)
})

test('F. Wrong confirmation does not delete', async () => {
  const res = await callDelete(tempToken, { confirmation: 'delete' })
  assert.equal(res.status, 400, res.text)
  const prof = await rest('profiles?select=id&limit=1', tempToken)
  assert.equal((prof.json as unknown[]).length, 1, 'temp still exists')
})

test('C. Client cannot supply another user_id to delete B', async () => {
  const bProf = await rest('profiles?select=id&limit=1', tokenB)
  const bId = (bProf.json as { id: string }[])[0]?.id
  assert.ok(bId)

  // Correct confirmation + spoofed user_id: deletes CALLER (temp), not B.
  const res = await callDelete(tempToken, { confirmation: 'DELETE', user_id: bId, id: bId })
  assert.equal(res.status, 200, res.text)

  // B must still exist and be unchanged
  const bAfter = await rest('profiles?select=id,display_name,xp&limit=1', tokenB)
  assert.deepEqual(bAfter.json, bBefore, 'B profile unchanged after spoofed delete')
  const bRows = bAfter.json as { id: string }[]
  assert.equal(bRows.length, 1, 'B still exists')
  assert.equal(bRows[0].id, bId, 'B id unchanged')
})

test('H. Temp user personal rows cascade-deleted; globals intact; audit_log SET NULL', async () => {
  // Temp was deleted in test C. Re-sign-in must fail.
  const relogin = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY! },
    body: JSON.stringify({ email: tempEmail, password: tempPassword }),
  })
  assert.ok(relogin.status >= 400, `relogin status=${relogin.status}`)

  // SQL lifecycle: all personal tables empty; auth user gone; globals + B intact.
  const uid = tempId
  const out = runSql(`
select 'profiles' t, count(*) n from public.profiles where id = '${uid}'
union all select 'wallet', count(*) from public.wallet where user_id = '${uid}'
union all select 'wallet_transactions', count(*) from public.wallet_transactions where user_id = '${uid}'
union all select 'game_sessions', count(*) from public.game_sessions where user_id = '${uid}'
union all select 'game_results', count(*) from public.game_results where user_id = '${uid}'
union all select 'game_progress', count(*) from public.game_progress where user_id = '${uid}'
union all select 'chat_messages', count(*) from public.chat_messages where user_id = '${uid}'
union all select 'chat_requests', count(*) from public.chat_requests where user_id = '${uid}'
union all select 'user_achievements', count(*) from public.user_achievements where user_id = '${uid}'
union all select 'leaderboard', count(*) from public.leaderboard where user_id = '${uid}'
union all select 'exchange_requests', count(*) from public.exchange_requests where user_id = '${uid}'
union all select 'game_completions', count(*) from public.game_completions where user_id = '${uid}'
union all select 'audit_log', count(*) from public.audit_log where user_id = '${uid}'
union all select 'auth_users', count(*) from auth.users where id = '${uid}'
union all select 'games_catalog', count(*) from public.games
union all select 'B_profile', count(*) from public.profiles p
  join auth.users u on u.id = p.id where u.email = '${emailB}';
`)
  // Table output lines like: │ profiles │ 0 │
  const rows = [...out.matchAll(/│\s*([a-z_]+)\s*│\s*(\d+)\s*│/gi)]
  const counts: Record<string, number> = {}
  for (const [, k, v] of rows) counts[k] = Number(v)
  assert.ok(rows.length >= 15, `sql rows parsed=${rows.length}\n${out}`)
  for (const t of [
    'profiles',
    'wallet',
    'wallet_transactions',
    'game_sessions',
    'game_results',
    'game_progress',
    'chat_messages',
    'chat_requests',
    'user_achievements',
    'leaderboard',
    'exchange_requests',
    'game_completions',
    'auth_users',
  ]) {
    assert.equal(counts[t], 0, `${t} should be 0 after delete, got ${counts[t]}`)
  }
  assert.equal(counts.audit_log, 0, 'audit_log SET NULL leaves no matching user_id')
  assert.equal(counts.B_profile, 1, 'B profile intact')
  assert.ok(counts.games_catalog! >= 1, 'games catalog remains')

  const bSeesTemp = await rest(`profiles?select=id&id=eq.${tempId}`, tokenB)
  assert.equal((bSeesTemp.json as unknown[]).length, 0, 'B cannot see deleted temp profile')
  assert.equal(beforeCounts.profiles, 1, 'before: temp had profile')
  assert.equal(beforeCounts.wallet, 1, 'before: temp had wallet')
})

test('I. Global/reference data remains (games, achievements)', async () => {
  const g = await rest('games?select=id', tokenB)
  const a = await rest('achievements?select=id', tokenB)
  assert.ok(Array.isArray(g.json) && g.json.length > 0, 'games remain')
  assert.ok(Array.isArray(a.json), 'achievements query works')
  assert.ok((a.json as unknown[]).length >= achievementsCountBefore, 'achievements catalog intact')
})

test('J. Old temp session cannot continue using app APIs', async () => {
  const relogin = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY! },
    body: JSON.stringify({ email: tempEmail, password: tempPassword }),
  })
  assert.ok(relogin.status >= 400, `status=${relogin.status}`)

  // Leftover JWT: profile read should return empty or 401
  const after = await rest('profiles?select=id&limit=1', tempToken)
  assert.ok(
    after.status === 401 || after.status === 403 ||
      (after.status === 200 && (after.json as unknown[]).length === 0),
    `session after delete status=${after.status}`,
  )
})

test('K. No unrelated user affected (B intact)', async () => {
  const bAfter = await rest('profiles?select=id,display_name,xp&limit=1', tokenB)
  assert.deepEqual(bAfter.json, bBefore, 'B profile unchanged')
})

test('cleanup. temp account already deleted; re-delete returns success (idempotent)', async () => {
  // Already deleted in test C. Second call with valid-looking old JWT should not 500.
  // Old JWT may be invalid → 401; or valid but user gone → 401 on getUser or 200 idempotent.
  const del = await callDelete(tempToken, { confirmation: 'DELETE' })
  assert.ok(del.status === 200 || del.status === 401 || del.status === 400, `status=${del.status}`)
  // If 200, must be idempotent success
  if (del.status === 200) {
    assert.ok(del.json && typeof del.json === 'object' && 'success' in (del.json as object))
  }
})
