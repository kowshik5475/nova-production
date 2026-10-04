// Phase 12 — Leaderboard V1 tests (static + A–AJ)
// Run: node --experimental-strip-types supabase/tests/phase12_leaderboard.test.ts
//
// Fixtures: 5 disposable out-of-band users created in before() and deleted in
// after(), plus the existing Phase 2B test users. Every profiles.xp /
// profiles.updated_at mutation is snapshotted in before() and restored in
// after() (and inside the tests that touch it), so no other suite is affected.
// Seeded legacy leaderboard rows are removed again in the same test.

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
const emailZero = 'phase12zero@example.test'
const password = 'password123'

const m12 = readFileSync(
  resolve(root, 'supabase/migrations/20260925000001_phase12_leaderboard_v1.sql'),
  'utf8',
)
const core = readFileSync(resolve(root, 'supabase/migrations/20260920_00_core_tables.sql'), 'utf8')
const m2a = readFileSync(
  resolve(root, 'supabase/migrations/20260924000001_phase2a_p0_rls_hardening.sql'),
  'utf8',
)
const profileSrc = readFileSync(resolve(root, 'src/app/profile.tsx'), 'utf8')
const typesSrc = readFileSync(resolve(root, 'src/app/types.ts'), 'utf8')

// Executable SQL only — comments may legitimately mention other objects.
const m12Sql = m12.replace(/--[^\n\r]*/g, '')

const VIEW = 'leaderboard_ranked'
const SELECT = 'rank,display_name,xp,level,is_me'
const ALLOWED_KEYS = ['display_name', 'is_me', 'level', 'rank', 'xp']

type BoardRow = { rank: number; display_name: string; xp: number; level: number; is_me: boolean }
type ExpectedRow = { id: string; display_name: string; xp: number }
type ProfileSnap = { id: string; xp: number; updated_at: string }
type LegacyRow = { id: string; user_id: string; score: number }

const TEMP = [
  { id: '00000000-0000-4000-8000-000000001201', email: 'phase12tie1@example.test', name: 'Phase12 Tie One' },
  { id: '00000000-0000-4000-8000-000000001202', email: 'phase12tie2@example.test', name: 'Phase12 Tie Two' },
  { id: '00000000-0000-4000-8000-000000001203', email: 'phase12del@example.test', name: 'Phase12 Deleted' },
  { id: '00000000-0000-4000-8000-000000001204', email: 'phase12nop@example.test', name: 'Phase12 No Profile' },
  { id: '00000000-0000-4000-8000-000000001205', email: 'phase12zero@example.test', name: 'Phase12 Zero' },
]
const [TIE1, TIE2, DEL, NOP] = TEMP.map((u) => u.id)
const ZERO = TEMP[4].id
const NAME1 = TEMP[0].name
const NAME2 = TEMP[1].name
const NAME_DEL = TEMP[2].name
const NAME_NOP = TEMP[3].name

let tokenA = ''
let tokenB = ''
let tokenZero = ''
let idA = ''
let idB = ''
let nameA = ''
let nameB = ''
let snapshot: ProfileSnap[] = []
let seeded: string[] = []

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

// Linked-project SQL helper (documented test mechanism on the linked project).
let sqlSeq = 0
function sqlRaw(query: string): { ok: boolean; out: string } {
  const osTmp = resolve(
    process.env.TEMP || process.env.TMP || '.',
    `phase12-${process.pid}-${Date.now()}-${sqlSeq++}.sql`,
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

// Extracts the single data cell of the CLI's table output (one row, one column).
function sqlCell(query: string): string {
  const r = sqlRaw(query)
  assert.ok(r.ok, `sql failed: ${r.out}`)
  const cells = r.out
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0 && l.startsWith('│'))
  assert.ok(cells.length >= 2, `unexpected sql output: ${r.out}`)
  const line = cells[1]
  const end = line.lastIndexOf('│')
  assert.ok(end > 0, `unexpected sql row: ${r.out}`)
  return line.slice(1, end).trim()
}

function sqlJson<T>(query: string): T {
  return JSON.parse(sqlCell(query)) as T
}

async function readBoard(token?: string): Promise<BoardRow[]> {
  const r = await rest(`${VIEW}?select=${SELECT}&order=rank.asc`, token)
  assert.equal(r.status, 200, r.text)
  return r.json as BoardRow[]
}

// The board minus the caller-scoped is_me marker: identical for every reader.
function publicView(rows: BoardRow[]) {
  return rows.map((r) => ({ rank: r.rank, display_name: r.display_name, xp: r.xp, level: r.level }))
}

async function ownProfile(token: string, uid?: string) {
  const path = uid
    ? `profiles?select=id,display_name,xp,level&id=eq.${uid}`
    : 'profiles?select=id,display_name,xp,level'
  const r = await rest(path, token)
  assert.equal(r.status, 200, r.text)
  const rows = r.json as { id: string; display_name: string; xp: number; level: number }[]
  assert.equal(rows.length, 1, 'own profile row readable')
  return rows[0]
}

function expectedBoard(): ExpectedRow[] {
  return sqlJson<ExpectedRow[]>(
    `select coalesce(json_agg(json_build_object('id', p.id, 'display_name', p.display_name, 'xp', p.xp)
      order by p.xp desc, p.updated_at asc, p.id asc)::text, '[]')
       from public.profiles p
       join auth.users u on u.id = p.id
      where p.xp > 0;`,
  )
}

function viewRelations(): string[] {
  const cell = sqlCell(
    `select coalesce(string_agg(distinct cl.relname, ','), '')
       from pg_rewrite rw
       join pg_depend d on d.objid = rw.oid
       join pg_class cl on cl.oid = d.refobjid
      where rw.ev_class = 'public.${VIEW}'::regclass
        and cl.relkind in ('r', 'v', 'm', 'p', 'f')
        and cl.relname <> '${VIEW}';`,
  )
  return cell ? cell.split(',').filter(Boolean) : []
}

function legacyBoard(): LegacyRow[] {
  return sqlJson<LegacyRow[]>(
    `select coalesce(json_agg(json_build_object('id', id, 'user_id', user_id, 'score', score))::text, '[]')
       from public.leaderboard;`,
  )
}

function seedLeaderboardRow(score: number): string {
  const id = sqlCell(
    `insert into public.leaderboard (user_id, score) values ('${idA}', ${score}) returning id::text;`,
  )
  seeded.push(id)
  return id
}

function clearSeeded() {
  if (seeded.length === 0) return
  sql(`delete from public.leaderboard where id in (${seeded.map((i) => `'${i}'`).join(',')});`)
  seeded = []
}

function setXp(...entries: { id: string; xp: number; at?: string }[]) {
  const stmts = entries.map((e) => {
    const ts = e.at ? `'${e.at}'::timestamptz` : "timezone('utc'::text, now())"
    return `update public.profiles set xp = ${e.xp}, updated_at = ${ts} where id = '${e.id}';`
  })
  sql(stmts.join('\n'))
}

function restoreSnapshot() {
  if (snapshot.length === 0) return
  sql(
    snapshot
      .map(
        (p) =>
          `update public.profiles set xp = ${p.xp}, updated_at = '${p.updated_at}'::timestamptz where id = '${p.id}';`,
      )
      .join('\n'),
  )
}

function tempUserSql(u: { id: string; email: string; name: string }): string {
  return `
delete from auth.users where email = '${u.email}';
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_sent_at, confirmation_token, recovery_token,
  email_change, email_change_token_new, email_change_token_current,
  phone_change, phone_change_token,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, is_sso_user
)
values (
  '${u.id}'::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated',
  'authenticated',
  '${u.email}',
  crypt('${password}', gen_salt('bf')),
  now(), now(), '', '', '', '', '', '', '',
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"${u.name}"}'::jsonb,
  now(), now(), false
);
`
}

before(async () => {
  // 1. Snapshot the real profiles before any fixture exists.
  snapshot = sqlJson<ProfileSnap[]>(
    `select coalesce(json_agg(json_build_object('id', id, 'xp', xp, 'updated_at', updated_at::text) order by id)::text, '[]')
       from public.profiles;`,
  )
  assert.ok(snapshot.length >= 3, 'snapshot captured real profiles')

  // 2. Disposable fixture users (out-of-band, avoids email rate limits).
  // Purge any legacy leaderboard rows left behind by an interrupted prior run
  // (clearSeeded only tracks in-memory ids, so stale rows would otherwise
  // leak into the "no rank row created" assertions). Covers both the TEMP
  // fixtures and the shared Phase 2B users (p2busera/b) this suite signs in as.
  sql(`delete from public.leaderboard;`)
  sql(TEMP.map(tempUserSql).join('\n'))
  // One fixture user deliberately has an auth account but no profile row.
  sql(`delete from public.profiles where id = '${NOP}';`)

  // 3. Sessions for the accounts the suite signs in as.
  tokenA = await signIn(emailA)
  tokenB = await signIn(emailB)
  tokenZero = await signIn(emailZero)
  const a = await ownProfile(tokenA)
  idA = a.id
  nameA = a.display_name
  const b = await ownProfile(tokenB)
  idB = b.id
  nameB = b.display_name
})

after(async () => {
  try {
    clearSeeded()
  } catch {
    /* best effort */
  }
  try {
    sql(`delete from auth.users where id in (${TEMP.map((u) => `'${u.id}'`).join(',')});`)
  } catch {
    /* best effort */
  }
  try {
    restoreSnapshot()
  } catch {
    /* best effort */
  }
})

// ── Static ───────────────────────────────────────────────────

test('static. Migration adds one read-only view and one index — no table, no policy, no writes', () => {
  assert.match(m12Sql, /create or replace view public\.leaderboard_ranked/)
  assert.equal((m12Sql.match(/create or replace view/g) ?? []).length, 1, 'exactly one view')
  assert.equal((m12Sql.match(/create index/g) ?? []).length, 1, 'exactly one index')
  assert.doesNotMatch(m12Sql, /create table/i)
  assert.doesNotMatch(m12Sql, /drop table/i)
  assert.doesNotMatch(m12Sql, /alter table/i)
  assert.doesNotMatch(m12Sql, /alter column/i)
  assert.doesNotMatch(m12Sql, /create policy/i)
  assert.doesNotMatch(m12Sql, /drop policy/i)
  assert.doesNotMatch(m12Sql, /create or replace function/i)
  assert.doesNotMatch(m12Sql, /security definer/i)
  assert.doesNotMatch(m12Sql, /\binsert into\b/i)
  assert.doesNotMatch(m12Sql, /\bupdate\s+public\./i)
  assert.doesNotMatch(m12Sql, /\bdelete from\b/i)
  // ranking rule
  assert.match(m12Sql, /row_number\(\) over/)
  assert.match(m12Sql, /p\.xp desc/)
  assert.match(m12Sql, /p\.updated_at asc/)
  assert.match(m12Sql, /p\.id asc/)
  assert.match(m12Sql, /where p\.xp > 0/)
  assert.match(m12Sql, /auth\.uid\(\)/)
  // intentional, restricted grant
  assert.match(m12Sql, /revoke all on public\.leaderboard_ranked/)
  assert.match(m12Sql, /grant select on public\.leaderboard_ranked to anon, authenticated/)
  // the legacy leaderboard table is neither read nor populated
  assert.doesNotMatch(m12Sql, /from\s+public\.leaderboard[\s;]/i)
  // profiles RLS stays exactly as Phase 2A left it
  assert.match(m2a, /profiles\s+→ SELECT own only/)
  assert.match(core, /create policy "Users can read own profile" on public\.profiles/)
})

test('static. Profile UI: leaderboard section, top-50, refresh on open, no polling, no client writes', () => {
  assert.match(profileSrc, /from\('leaderboard_ranked'\)/)
  assert.match(profileSrc, /const LEADERBOARD_LIMIT = 50/)
  assert.match(profileSrc, /\.limit\(LEADERBOARD_LIMIT\)/)
  assert.match(profileSrc, /\.eq\('is_me', true\)/)
  assert.match(profileSrc, /Loading leaderboard/)
  assert.match(profileSrc, /No leaderboard data yet\./)
  assert.match(profileSrc, /Couldn.*load leaderboard\./)
  assert.match(profileSrc, /No rank yet/)
  assert.match(profileSrc, /LEADERBOARD/)
  assert.match(profileSrc, /!isDemo/)
  assert.match(typesSrc, /LeaderboardRow/)
  assert.match(typesSrc, /AchievementView\[\]/)
  assert.doesNotMatch(profileSrc, /setInterval/)
  assert.doesNotMatch(profileSrc, /localStorage/)
  assert.doesNotMatch(profileSrc, /\.insert\(/)
  assert.doesNotMatch(profileSrc, /\.update\(/)
  assert.doesNotMatch(profileSrc, /\.delete\(/)
})

// ── A–H: read surface & privacy ─────────────────────────────

test('A. Anonymous behavior follows the intended public leaderboard access policy', async () => {
  const read = await rest(`${VIEW}?select=${SELECT}&order=rank.asc&limit=50`)
  assert.equal(read.status, 200, read.text)
  const rows = read.json as BoardRow[]
  assert.ok(Array.isArray(rows), 'array response')
  assert.ok(rows.length > 0, 'public read returns the qualifying board')
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ALLOWED_KEYS)
    assert.equal(row.is_me, false, 'anonymous caller owns no row')
  }

  // The rest of the schema is still private under the existing profiles RLS.
  const profiles = await rest('profiles?select=id,display_name,xp')
  assert.equal(profiles.status, 200, profiles.text)
  assert.deepEqual(profiles.json, [], 'anon reads no profile rows')

  // Anonymous clients cannot write the legacy leaderboard either.
  const write = await rest('leaderboard', undefined, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: idA, score: 1 }),
  })
  assert.ok([401, 403, 404, 405].includes(write.status), `anon write status=${write.status}`)
  assert.equal(legacyBoard().length, 0, 'no anonymous leaderboard entry')
})

test('B. Authenticated user can read the leaderboard', async () => {
  const rows = await readBoard(tokenA)
  assert.ok(rows.length > 0, 'authenticated read returns rows')
  assert.deepEqual(Object.keys(rows[0]).sort(), ALLOWED_KEYS)
  rows.forEach((row, i) => assert.equal(row.rank, i + 1, 'dense 1..n ranks'))
})

test('C. Leaderboard returns only the intended public fields', async () => {
  const rows = await readBoard(tokenA)
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ALLOWED_KEYS)
  }
  const wild = await rest(`${VIEW}?select=*&limit=50`, tokenB)
  assert.equal(wild.status, 200, wild.text)
  for (const row of wild.json as Record<string, unknown>[]) {
    assert.deepEqual(Object.keys(row).sort(), ALLOWED_KEYS)
  }
})

test('D. Email is never returned', async () => {
  const raw = await rest(`${VIEW}?select=*&limit=50`, tokenA)
  assert.equal(raw.status, 200, raw.text)
  assert.ok(!/[\w.+-]+@[\w-]+\.[\w.-]+/.test(raw.text), 'no email-shaped string in the payload')
  for (const row of raw.json as Record<string, unknown>[]) {
    assert.ok(!('email' in row), 'no email key')
  }
})

test('E. Authentication metadata is never returned', async () => {
  const raw = await rest(`${VIEW}?select=*&limit=50`, tokenA)
  assert.equal(raw.status, 200, raw.text)
  for (const forbidden of [
    'app_metadata',
    'user_metadata',
    'email_confirmed_at',
    'last_sign_in_at',
    'access_token',
    'confirmation_token',
  ]) {
    assert.ok(!raw.text.includes(forbidden), `leaked ${forbidden}`)
  }
})

test('F. Wallet balance is never returned', async () => {
  const raw = await rest(`${VIEW}?select=*&limit=50`, tokenA)
  assert.equal(raw.status, 200, raw.text)
  for (const forbidden of ['earned_coins', 'wallet', 'balance', 'wallet_transactions']) {
    assert.ok(!raw.text.includes(forbidden), `leaked ${forbidden}`)
  }
})

test('G. AI credits are never returned', async () => {
  const raw = await rest(`${VIEW}?select=*&limit=50`, tokenA)
  assert.equal(raw.status, 200, raw.text)
  assert.ok(!raw.text.includes('ai_credits'), 'leaked ai_credits')
  for (const row of raw.json as Record<string, unknown>[]) {
    assert.ok(!('ai_credits' in row), 'no ai_credits key')
  }
})

test('H. Chat data is never returned and the view never reads chat tables', async () => {
  const raw = await rest(`${VIEW}?select=*&limit=50`, tokenA)
  assert.equal(raw.status, 200, raw.text)
  for (const forbidden of ['chat_messages', 'nova-chat', 'message', 'conversation']) {
    assert.ok(!raw.text.includes(forbidden), `leaked ${forbidden}`)
  }
  assert.ok(!viewRelations().some((r) => r.includes('chat')), 'view does not read chat tables')
})

// ── I–N: write / manipulation resistance ────────────────────

test('I. User cannot INSERT leaderboard entries', async () => {
  const before = legacyBoard().length
  const r = await rest('leaderboard', tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ user_id: idA, score: 12345 }),
  })
  assert.ok([401, 403, 404, 405].includes(r.status), `status=${r.status}`)
  assert.equal(legacyBoard().length, before, 'no row inserted')
})

test('J. User cannot UPDATE leaderboard entries', async () => {
  const rowId = seedLeaderboardRow(111)
  try {
    const r = await rest(`leaderboard?id=eq.${rowId}`, tokenA, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ score: 99999 }),
    })
    if (r.status === 200 || r.status === 204) {
      assert.deepEqual(r.json, [], 'no rows updated')
    } else {
      assert.ok([401, 403, 404, 405].includes(r.status), `status=${r.status}`)
    }
    const rows = legacyBoard().filter((x) => x.id === rowId)
    assert.equal(rows.length, 1, 'row still exists')
    assert.equal(rows[0].score, 111, 'score untouched')
  } finally {
    clearSeeded()
  }
})

test('K. User cannot DELETE leaderboard entries', async () => {
  const rowId = seedLeaderboardRow(222)
  try {
    const r = await rest(`leaderboard?id=eq.${rowId}`, tokenA, {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' },
    })
    if (r.status === 200 || r.status === 204) {
      assert.deepEqual(r.json, [], 'no rows deleted')
    } else {
      assert.ok([401, 403, 404, 405].includes(r.status), `status=${r.status}`)
    }
    const rows = legacyBoard().filter((x) => x.id === rowId)
    assert.equal(rows.length, 1, 'row still exists after the delete attempt')
  } finally {
    clearSeeded()
  }
})

test('L. User cannot submit an arbitrary XP value to affect ranking', async () => {
  const before = await readBoard(tokenA)
  const beforeXp = (await ownProfile(tokenA, idA)).xp

  const post = await rest('leaderboard', tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: idA, score: 999999 }),
  })
  assert.ok([401, 403, 404, 405].includes(post.status), `status=${post.status}`)

  const patch = await rest(`profiles?id=eq.${idA}`, tokenA, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ xp: 999999 }),
  })
  if (patch.status === 200 || patch.status === 204) {
    assert.deepEqual(patch.json, [], 'no profile row updated')
  } else {
    assert.ok([401, 403, 404, 405].includes(patch.status), `status=${patch.status}`)
  }

  const after = await readBoard(tokenA)
  assert.deepEqual(after, before, 'ranking unchanged')
  assert.equal((await ownProfile(tokenA, idA)).xp, beforeXp, 'authoritative xp unchanged')
})

test('M. User cannot submit an arbitrary rank', async () => {
  const before = await readBoard(tokenA)

  const view = await rest(VIEW, tokenA, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ rank: 1 }),
  })
  assert.ok(view.status >= 400, `view PATCH status=${view.status}`)

  const table = await rest('leaderboard', tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: idA, score: 1, rank: 1 }),
  })
  assert.ok(table.status >= 400, `table POST status=${table.status}`)
  assert.equal(legacyBoard().length, 0, 'no rank row created')

  const after = await readBoard(tokenA)
  assert.deepEqual(after, before, 'ranks unchanged')
  after.forEach((row, i) => assert.equal(row.rank, i + 1, 'ranks stay database-derived 1..n'))
})

test('N. User cannot submit an arbitrary user_id to manipulate ranking', async () => {
  const before = await readBoard(tokenA)

  const post = await rest('leaderboard', tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: idB, score: 999999 }),
  })
  assert.ok([401, 403, 404, 405].includes(post.status), `status=${post.status}`)
  assert.equal(legacyBoard().length, 0, 'no entry created for another user')

  // is_me is computed from auth.uid(), never from a request parameter.
  const selfA = await rest(`${VIEW}?select=display_name,is_me&is_me=eq.true`, tokenA)
  assert.equal(selfA.status, 200, selfA.text)
  assert.deepEqual(
    (selfA.json as BoardRow[]).map((r) => [r.display_name, r.is_me]),
    [[nameA, true]],
    'A is flagged only for A',
  )
  const selfB = await rest(`${VIEW}?select=display_name,is_me&is_me=eq.true`, tokenB)
  assert.deepEqual(selfB.json, [], 'B (0 XP) has no qualifying row to claim')

  const spoof = await rest(
    `${VIEW}?select=display_name,is_me&is_me=eq.true&display_name=eq.${encodeURIComponent(nameB)}`,
    tokenA,
  )
  assert.deepEqual(spoof.json, [], 'A can never be flagged as B')

  assert.deepEqual(await readBoard(tokenA), before, 'ranking unchanged')
})

// ── O–R: authoritative source & account scope ───────────────

test('O. Ranking is derived from authoritative database state', async () => {
  const expected = expectedBoard()
  const rows = await readBoard(tokenA)
  assert.deepEqual(
    rows.map((r) => r.display_name),
    expected.map((e) => e.display_name),
    'view order == authoritative profiles order',
  )
  assert.deepEqual(
    rows.map((r) => r.xp),
    expected.map((e) => e.xp),
    'view xp == authoritative profiles.xp',
  )
  assert.deepEqual(viewRelations().sort(), ['profiles'], 'view reads exactly one table')

  const write = await rest('profiles', tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: idA, xp: 999999 }),
  })
  assert.ok(write.status >= 400, `profiles POST status=${write.status}`)
})

test('P. Changing a legitimate user authoritative XP changes ranking appropriately', async () => {
  setXp({ id: idA, xp: 1 }, { id: idB, xp: 2 })
  try {
    let rows = await readBoard(tokenA)
    assert.notEqual(rows.find((r) => r.display_name === nameA)?.rank, 1, 'A starts unranked #1')

    setXp({ id: idA, xp: 1000000 })
    rows = await readBoard(tokenA)
    assert.equal(rows[0].display_name, nameA, 'authoritative XP gain moves A to rank 1')
    assert.equal(rows[0].rank, 1)
    assert.deepEqual(
      rows.map((r) => r.display_name),
      expectedBoard().map((e) => e.display_name),
      'independent SQL order agrees',
    )
  } finally {
    restoreSnapshot()
  }
  const restored = await readBoard(tokenA)
  assert.deepEqual(
    restored.map((r) => r.xp),
    expectedBoard().map((e) => e.xp),
    'baseline restored',
  )
})

test('Q. Deleted users do not appear', async () => {
  setXp({ id: DEL, xp: 800000 })
  let rows = await readBoard(tokenA)
  assert.ok(rows.some((r) => r.display_name === NAME_DEL), 'fixture user visible while alive')

  sql(`delete from auth.users where id = '${DEL}';`)
  rows = await readBoard(tokenA)
  assert.ok(!rows.some((r) => r.display_name === NAME_DEL), 'deleted account removed from the board')
  assert.deepEqual(
    rows.map((r) => r.display_name),
    expectedBoard().map((e) => e.display_name),
    'board still equals authoritative state',
  )
})

test('R. Demo users do not appear', async () => {
  const rows = await readBoard(tokenA)
  const expected = expectedBoard()
  assert.equal(rows.length, expected.length, 'one row per real authenticated profile')
  assert.deepEqual(
    rows.map((r) => r.display_name),
    expected.map((e) => e.display_name),
    'every row maps to an auth.users account',
  )
  const demo = await rest(`${VIEW}?select=display_name,xp&display_name=eq.Player&xp=eq.40`, tokenA)
  assert.equal(demo.status, 200, demo.text)
  assert.deepEqual(demo.json, [], 'local demo fixture never reaches the database')
  assert.match(profileSrc, /!isDemo/, 'demo mode does not render the leaderboard')
})

// ── S–T: ties and own rank ──────────────────────────────────

test('S. Same XP produces deterministic ordering', async () => {
  setXp({ id: TIE1, xp: 5000, at: '2026-01-01T00:00:00.000Z' })
  setXp({ id: TIE2, xp: 5000, at: '2026-01-02T00:00:00.000Z' })
  const first = await readBoard(tokenA)
  const second = await readBoard(tokenA)
  assert.deepEqual(second, first, 'repeat read is byte-identical')

  const i1 = first.findIndex((r) => r.display_name === NAME1)
  const i2 = first.findIndex((r) => r.display_name === NAME2)
  assert.ok(i1 >= 0 && i2 >= 0, 'both tied users listed')
  assert.equal(i2, i1 + 1, 'equal XP sits on consecutive ranks')
  assert.equal(first[i2].rank, first[i1].rank + 1, 'equal XP still gets distinct ranks')
  assert.ok(i1 < i2, 'earlier authoritative timestamp ranks first')
})

test('T. Current-user rank matches the authoritative ranking', async () => {
  const me = await rest(`${VIEW}?select=${SELECT}&is_me=eq.true`, tokenA)
  assert.equal(me.status, 200, me.text)
  const rows = me.json as BoardRow[]
  assert.equal(rows.length, 1, 'exactly one self row')
  assert.equal(rows[0].is_me, true)
  assert.equal(rows[0].display_name, nameA)

  const expected = expectedBoard()
  const idx = expected.findIndex((e) => e.id === idA)
  assert.ok(idx >= 0, 'A has qualifying progression')
  assert.equal(rows[0].rank, idx + 1, 'rank matches the authoritative order')
  assert.equal(rows[0].xp, expected[idx].xp, 'xp matches authoritative xp')
})

// ── U–AC: functional behaviour ──────────────────────────────

test('U. Correct ranking by authoritative XP', async () => {
  setXp({ id: idB, xp: 3000 }, { id: TIE1, xp: 2000 }, { id: idA, xp: 1000 }, { id: TIE2, xp: 500 })
  try {
    const rows = await readBoard(tokenA)
    assert.deepEqual(
      rows.slice(0, 4).map((r) => r.display_name),
      [nameB, NAME1, nameA, NAME2],
      'highest XP first',
    )
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].xp >= rows[i].xp, 'xp is non-increasing')
    }
    assert.deepEqual(
      rows.map((r) => r.display_name),
      expectedBoard().map((e) => e.display_name),
      'view == authoritative order',
    )
  } finally {
    restoreSnapshot()
  }
})

test('V. Deterministic tie handling', async () => {
  const same = '2026-02-03T04:05:06.000Z'
  setXp({ id: TIE1, xp: 7000, at: same }, { id: TIE2, xp: 7000, at: same })

  const rows = await readBoard(tokenA)
  const i1 = rows.findIndex((r) => r.display_name === NAME1)
  const i2 = rows.findIndex((r) => r.display_name === NAME2)
  assert.equal(i2, i1 + 1, 'identical xp and timestamp stay adjacent')
  assert.deepEqual(
    rows.map((r) => r.display_name),
    expectedBoard().map((e) => e.display_name),
    'view honours the documented tie-break',
  )

  const tied = expectedBoard().filter((e) => e.xp === 7000).map((e) => e.id)
  assert.equal(tied.length, 2, 'two tied profiles')
  assert.deepEqual([...tied].sort(), tied, 'final stable key (profile id) ascending')

  const again = await readBoard(tokenA)
  assert.deepEqual(again, rows, 'ordering stable across repeated reads')
})

test('W. Top-N limit works', async () => {
  setXp({ id: TIE1, xp: 6000 }, { id: TIE2, xp: 5000 })
  const all = await readBoard(tokenA)
  assert.ok(all.length >= 3, 'board has at least 3 qualifying rows')

  const top = await rest(`${VIEW}?select=rank,display_name&order=rank.asc&limit=3`, tokenA)
  assert.equal(top.status, 200, top.text)
  const rows = top.json as { rank: number; display_name: string }[]
  assert.equal(rows.length, 3, 'limit=3 returns 3 rows')
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3])
  assert.deepEqual(
    rows.map((r) => r.display_name),
    all.slice(0, 3).map((r) => r.display_name),
    'the first three of the full board',
  )

  const top50 = await rest(`${VIEW}?select=rank&order=rank.asc&limit=50`, tokenA)
  assert.equal(top50.status, 200, top50.text)
  assert.equal(
    (top50.json as unknown[]).length,
    Math.min(50, all.length),
    'the UI never loads more than 50 rows',
  )
  assert.equal(all.length, expectedBoard().length, 'full read still matches authoritative state')
})

test('X. Current-user rank is correct if implemented', async () => {
  setXp({ id: ZERO, xp: 0 })
  const top = await readBoard(tokenA)
  const me = await rest(`${VIEW}?select=${SELECT}&is_me=eq.true`, tokenA)
  assert.equal(me.status, 200, me.text)
  const selfRows = me.json as BoardRow[]
  assert.equal(selfRows.length, 1, 'own rank row returned')

  const inList = top.find((r) => r.is_me)
  assert.ok(inList, 'A appears in the list')
  assert.equal(inList.rank, selfRows[0].rank, 'list rank == own-rank query')
  assert.equal(inList.xp, selfRows[0].xp, 'list xp == own-rank xp')

  // A user with no qualifying progression gets no rank at all.
  const zero = await rest(`${VIEW}?select=rank,is_me&is_me=eq.true`, tokenZero)
  assert.equal(zero.status, 200, zero.text)
  assert.deepEqual(zero.json, [], 'no fabricated rank for 0 XP')
  assert.match(profileSrc, /No rank yet/, 'UI shows the honest fallback')
})

test('Y. Empty state works', async () => {
  setXp({ id: ZERO, xp: 0 })
  const self = await rest(`${VIEW}?select=rank&is_me=eq.true`, tokenZero)
  assert.equal(self.status, 200, self.text)
  assert.deepEqual(self.json, [], 'no self rank to render')

  try {
    sql('update public.profiles set xp = 0;')
    const empty = await rest(`${VIEW}?select=rank,display_name,xp&order=rank.asc`, tokenA)
    assert.equal(empty.status, 200, empty.text)
    assert.deepEqual(empty.json, [], 'fully empty board returns an empty array')
    assert.equal(expectedBoard().length, 0, 'authoritative source agrees the board is empty')
  } finally {
    restoreSnapshot()
  }
  assert.match(profileSrc, /No leaderboard data yet\./, 'UI renders the empty state')
})

test('Z. Deleted or absent profile does not appear', async () => {
  setXp({ id: NOP, xp: 4000 })
  const rows = await readBoard(tokenA)
  assert.ok(!rows.some((r) => r.display_name === NAME_NOP), 'auth user without a profile is absent')
  assert.equal(rows.length, expectedBoard().length, 'no extra rows beyond real profiles')

  // A profile cannot exist without an auth user, so no orphan can ever rank.
  const orphan = sqlRaw(
    `insert into public.profiles (id, display_name, xp) values ('11111111-1111-4111-8111-111111111111', 'Ghost', 999999);`,
  )
  assert.equal(orphan.ok, false, 'foreign key rejects orphan profiles')
  assert.match(orphan.out, /foreign key|violates/i, `got: ${orphan.out}`)
})

test('AA. Demo user does not appear', async () => {
  const rows = await readBoard(tokenA)
  const expected = expectedBoard()
  assert.equal(rows.length, expected.length, 'no fabricated or demo entries')
  assert.deepEqual(
    rows.map((r) => r.display_name),
    expected.map((e) => e.display_name),
    'every row is a real authenticated profile',
  )
  const demo = await rest(`${VIEW}?select=display_name,xp&display_name=eq.Player&xp=eq.40`, tokenA)
  assert.deepEqual(demo.json, [], 'demo fixture is client-side only')
  assert.match(profileSrc, /!isDemo/, 'leaderboard stays out of demo mode')
})

test('AB. Updated XP changes ranking', async () => {
  setXp({ id: TIE1, xp: 100 }, { id: TIE2, xp: 200 }, { id: idA, xp: 5000 })
  try {
    let rows = await readBoard(tokenA)
    assert.equal(rows[0].display_name, nameA, 'A leads before the XP change')

    setXp({ id: TIE2, xp: 90000 })
    rows = await readBoard(tokenA)
    assert.equal(rows[0].display_name, NAME2, 'XP gain promotes the player')
    assert.equal(rows[0].rank, 1)
    const aRow = rows.find((r) => r.display_name === nameA)
    assert.ok(aRow, 'A still listed')
    assert.equal(aRow.rank, 2, 'A is displaced by the new leader')

    // A refresh (fresh session, no client cache) shows the same persisted state.
    const fresh = await signIn(emailA)
    const again = await readBoard(fresh)
    assert.deepEqual(again, rows, 'refresh returns the persisted authoritative ranking')
  } finally {
    tokenA = await signIn(emailA)
    restoreSnapshot()
  }
})

test('AC. Refresh and re-read return the persisted authoritative ranking', async () => {
  setXp({ id: idA, xp: 4242 }, { id: TIE1, xp: 4242 })
  try {
    const first = await readBoard(tokenA)
    const fresh = await signIn(emailA)
    const second = await readBoard(fresh)
    assert.deepEqual(second, first, 'identical across a fresh session')
    assert.deepEqual(
      second.map((r) => r.display_name),
      expectedBoard().map((e) => e.display_name),
      'matches a fresh authoritative read',
    )
    assert.deepEqual(
      publicView(await readBoard(tokenB)),
      publicView(second),
      'same board for another signed-in user (only is_me differs)',
    )
  } finally {
    tokenA = await signIn(emailA)
    restoreSnapshot()
  }
  const baseline = await readBoard(tokenA)
  const expected = expectedBoard()
  assert.deepEqual(baseline.map((r) => r.display_name), expected.map((e) => e.display_name))
  assert.deepEqual(baseline.map((r) => r.xp), expected.map((e) => e.xp))
})

// ── AD–AJ: security ─────────────────────────────────────────

test('AD. Direct leaderboard INSERT is blocked on both surfaces', async () => {
  const before = legacyBoard().length
  const table = await rest('leaderboard', tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: idA, score: 5 }),
  })
  assert.ok([401, 403, 404, 405].includes(table.status), `table status=${table.status}`)

  const view = await rest(VIEW, tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: 'Cheater', xp: 999999, rank: 1, is_me: true }),
  })
  assert.ok(view.status >= 400, `view status=${view.status}`)

  assert.equal(legacyBoard().length, before, 'no legacy row created')
  assert.ok(
    !(await readBoard(tokenA)).some((r) => r.display_name === 'Cheater'),
    'no fake entry in the board',
  )
})

test('AE. Direct leaderboard UPDATE is blocked on both surfaces', async () => {
  const before = await readBoard(tokenA)
  const view = await rest(VIEW, tokenA, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ xp: 999999, rank: 1 }),
  })
  assert.ok(view.status >= 400, `view PATCH status=${view.status}`)

  const rowId = seedLeaderboardRow(4242)
  try {
    const table = await rest(`leaderboard?id=eq.${rowId}`, tokenA, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ score: 999999 }),
    })
    if (table.status === 200 || table.status === 204) {
      assert.deepEqual(table.json, [], 'no rows updated')
    } else {
      assert.ok([401, 403, 404, 405].includes(table.status), `status=${table.status}`)
    }
    const rows = legacyBoard().filter((x) => x.id === rowId)
    assert.equal(rows[0]?.score, 4242, 'legacy row unchanged')
  } finally {
    clearSeeded()
  }
  assert.deepEqual(await readBoard(tokenA), before, 'board unchanged')
})

test('AF. Direct leaderboard DELETE is blocked on both surfaces', async () => {
  const before = await readBoard(tokenA)
  const view = await rest(VIEW, tokenA, {
    method: 'DELETE',
    headers: { Prefer: 'return=representation' },
  })
  assert.ok(view.status >= 400, `view DELETE status=${view.status}`)

  const rowId = seedLeaderboardRow(9876)
  try {
    const table = await rest(`leaderboard?id=eq.${rowId}`, tokenA, {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' },
    })
    if (table.status === 200 || table.status === 204) {
      assert.deepEqual(table.json, [], 'no rows deleted')
    } else {
      assert.ok([401, 403, 404, 405].includes(table.status), `status=${table.status}`)
    }
    assert.equal(legacyBoard().filter((x) => x.id === rowId).length, 1, 'legacy row survives')
  } finally {
    clearSeeded()
  }
  assert.deepEqual(await readBoard(tokenA), before, 'board unchanged')
})

test('AG. Arbitrary XP cannot be submitted', async () => {
  const before = await readBoard(tokenA)
  const beforeXp = (await ownProfile(tokenA, idA)).xp

  const table = await rest('leaderboard', tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: idA, score: 999999 }),
  })
  assert.ok([401, 403, 404, 405].includes(table.status), `status=${table.status}`)

  const profile = await rest(`profiles?id=eq.${idA}`, tokenA, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ xp: 999999, level: 99 }),
  })
  if (profile.status === 200 || profile.status === 204) {
    assert.deepEqual(profile.json, [], 'profile not client-writable')
  } else {
    assert.ok([401, 403, 404, 405].includes(profile.status), `status=${profile.status}`)
  }

  const view = await rest(VIEW, tokenA, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ xp: 999999 }),
  })
  assert.ok(view.status >= 400, `view status=${view.status}`)

  assert.equal(legacyBoard().length, 0, 'no submitted xp entry')
  assert.equal((await ownProfile(tokenA, idA)).xp, beforeXp, 'authoritative xp unchanged')
  assert.deepEqual(await readBoard(tokenA), before, 'ranking unchanged')
})

test('AH. Arbitrary rank cannot be submitted', async () => {
  const before = await readBoard(tokenA)

  const view = await rest(VIEW, tokenA, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ rank: 1 }),
  })
  assert.ok(view.status >= 400, `view status=${view.status}`)

  const table = await rest('leaderboard', tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: idA, score: 1, rank: 1 }),
  })
  assert.ok(table.status >= 400, `table status=${table.status}`)
  assert.equal(legacyBoard().length, 0, 'no rank row created')

  const after = await readBoard(tokenA)
  assert.deepEqual(after, before, 'ranking unchanged')
  after.forEach((row, i) => assert.equal(row.rank, i + 1, 'ranks stay sequential and database-derived'))
  assert.deepEqual(
    after.map((r) => r.display_name),
    expectedBoard().map((e) => e.display_name),
    'order still matches the authoritative source',
  )
})

test('AI. Arbitrary user_id cannot affect ranking', async () => {
  const before = await readBoard(tokenA)
  const beforeCount = legacyBoard().length

  const post = await rest('leaderboard', tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: idB, score: 999999 }),
  })
  assert.ok([401, 403, 404, 405].includes(post.status), `status=${post.status}`)
  assert.equal(legacyBoard().length, beforeCount, 'no entry for the supplied user_id')

  const asB = await rest(`${VIEW}?select=display_name,is_me&is_me=eq.true`, tokenB)
  assert.deepEqual(asB.json, [], 'B cannot gain a rank through A')

  const seen = await rest(
    `${VIEW}?select=display_name,is_me&display_name=eq.${encodeURIComponent(nameB)}`,
    tokenA,
  )
  assert.equal(seen.status, 200, seen.text)
  for (const row of seen.json as BoardRow[]) assert.equal(row.is_me, false, 'never flagged as A')

  assert.deepEqual(await readBoard(tokenA), before, 'ranking unchanged')
})

test('AJ. Private fields are not returned', async () => {
  const cols = sqlCell(
    `select coalesce(string_agg(column_name, ',' order by ordinal_position), '')
       from information_schema.columns
      where table_schema = 'public' and table_name = '${VIEW}';`,
  )
  assert.equal(cols, 'rank,display_name,xp,level,is_me', 'exact public column set')

  const raw = await rest(`${VIEW}?select=*&limit=50`, tokenA)
  assert.equal(raw.status, 200, raw.text)
  const rows = raw.json as Record<string, unknown>[]
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ALLOWED_KEYS)
  for (const forbidden of [
    'email',
    'user_id',
    'wallet',
    'ai_credits',
    'earned_coins',
    'chat',
    'password',
    'access_token',
    'app_metadata',
    'session',
    'game_results',
  ]) {
    assert.ok(!raw.text.includes(forbidden), `leaked ${forbidden}`)
  }

  // The underlying profile rows stay private behind their own RLS.
  const own = await rest(`profiles?select=id&id=eq.${idA}`, tokenA)
  assert.equal((own.json as unknown[]).length, 1, 'own profile row still readable')
  const other = await rest(`profiles?select=id&id=eq.${idB}`, tokenA)
  assert.deepEqual(other.json, [], 'other profiles still hidden')
})
