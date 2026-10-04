// Phase 14 - Dynamic Home & Progression Summary V1 tests (static + A-V)
// Run: node --experimental-strip-types supabase/tests/phase14_dynamic_home.test.ts
//
// Fixtures: 2 disposable out-of-band users created in before() and deleted in
// after() (delete from auth.users cascades to every child row). No shared
// p2b* profile / wallet / game row is mutated. A completes one Tic-Tac-Toe win,
// one Sudoku puzzle and one abandoned (STARTED) session; B completes nothing
// and is the empty-state + isolation fixture.
//
// The home* helpers re-issue the exact queries src/app/home.tsx issues, so each
// "Home displays ..." case is verified against live rows the browser would
// receive and then passed through the same pure mappers the UI uses
// (src/app/home-data.ts). Display bindings are asserted statically on
// home.tsx because this environment has no DOM runtime - each such case is
// documented inline. Security-sensitive cases (O, U, J) use real runtime
// verification against the linked project.

import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  describeAchievements,
  mapActivityRows,
  summarizeAchievements,
} from '../../src/app/home-data.ts'
import type {
  HomeAchievementCatalogRow,
  HomeGameResultRow,
  HomeRewardRow,
} from '../../src/app/home-data.ts'

const root = resolve(import.meta.dirname, '../..')
const envText = readFileSync(resolve(root, '.env'), 'utf8')
const SUPABASE_URL = /VITE_SUPABASE_URL=(.+)/.exec(envText)?.[1]?.trim()
const ANON_KEY = /VITE_SUPABASE_ANON_KEY=(.+)/.exec(envText)?.[1]?.trim()
if (!SUPABASE_URL || !ANON_KEY) throw new Error('Missing Supabase env')

const password = 'password123'
const TEMP = [
  { id: '00000000-0000-4000-8000-000000001401', email: 'phase14a@example.test', name: 'Phase14 A', credits: 4 },
  { id: '00000000-0000-4000-8000-000000001402', email: 'phase14b@example.test', name: 'Phase14 B', credits: 1 },
]
const [IDA, IDB] = TEMP.map((u) => u.id)
const EMAIL_A = TEMP[0].email
const EMAIL_B = TEMP[1].email

// ── Sources under test ────────────────────────────────────────
const homeSrc = readFileSync(resolve(root, 'src/app/home.tsx'), 'utf8')
const dataSrc = readFileSync(resolve(root, 'src/app/home-data.ts'), 'utf8')
const appSrc = readFileSync(resolve(root, 'src/app/App.tsx'), 'utf8')
const clientSrc = readFileSync(resolve(root, 'src/lib/supabase/client.ts'), 'utf8')
const profileHookSrc = readFileSync(resolve(root, 'src/lib/supabase/useProfile.ts'), 'utf8')
const walletHookSrc = readFileSync(resolve(root, 'src/lib/supabase/wallet.ts'), 'utf8')
const chatSrc = readFileSync(resolve(root, 'src/app/chat.tsx'), 'utf8')
const chatEdge = readFileSync(resolve(root, 'supabase/functions/nova-chat/index.ts'), 'utf8')
const cssSrc = readFileSync(resolve(root, 'src/index.css'), 'utf8')
const migrationNames = readdirSync(resolve(root, 'supabase/migrations'))

// Comment-free copies: prose in comments may legitimately mention the very
// tokens the static assertions forbid in code.
const homeCode = `${homeSrc}\n${dataSrc}`
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')

// ── Network helpers ───────────────────────────────────────────
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

type SseEvent = { event: string | null; data: Record<string, unknown> | null }

function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = []
  for (const block of text.split(/\n\n+/)) {
    let event: string | null = null
    let data: Record<string, unknown> | null = null
    for (const line of block.split(/\n/)) {
      if (line.startsWith('event: ')) event = line.slice(7).trim()
      else if (line.startsWith('data: ')) {
        try {
          data = JSON.parse(line.slice(6).trim()) as Record<string, unknown>
        } catch {
          data = null
        }
      }
    }
    if (event !== null || data !== null) events.push({ event, data })
  }
  return events
}

async function novaChat(body: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', apikey: ANON_KEY! }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${SUPABASE_URL}/functions/v1/nova-chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, text, events: parseSse(text) }
}

const startEvent = (r: { events: SseEvent[] }) => r.events.find((e) => e.event === 'start')?.data ?? null
const isGuarded = (status: number) => status === 200 || [400, 401, 402, 500, 502].includes(status)

function uidOf(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as {
    sub: string
  }
  return payload.sub
}

// ── Linked-project SQL helper (documented test mechanism) ─────
let sqlSeq = 0
function sqlRaw(query: string): { ok: boolean; out: string } {
  const osTmp = resolve(
    process.env.TEMP || process.env.TMP || '.',
    `phase14-${process.pid}-${Date.now()}-${sqlSeq++}.sql`,
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

function tempUserSql(u: { id: string; email: string; name: string; credits: number }): string {
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
insert into public.wallet (user_id, ai_credits, earned_coins)
values ('${u.id}'::uuid, ${u.credits}, 0)
on conflict (user_id) do update set ai_credits = ${u.credits};
`
}

// ── Game helpers ──────────────────────────────────────────────
const validXWin = ['X', 'X', 'X', 'O', 'O', null, null, null, null]
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

type Row = Record<string, unknown>

async function rows(path: string, token: string): Promise<Row[]> {
  const r = await rest(path, token)
  assert.equal(r.status, 200, r.text)
  return r.json as Row[]
}

// The exact three queries src/app/home.tsx issues on Home entry.
async function homeProfile(token: string): Promise<Row> {
  const rs = await rows('profiles?select=display_name,level,xp,streak', token)
  assert.equal(rs.length, 1, 'own profile readable')
  return rs[0]!
}

async function homeWallet(token: string): Promise<Row> {
  const rs = await rows('wallet?select=earned_coins,ai_credits', token)
  assert.equal(rs.length, 1, 'own wallet readable')
  return rs[0]!
}

async function homeActivity(token: string): Promise<Row[]> {
  const uid = uidOf(token)
  return rows(
    `game_results?select=id,session_id,game_id,outcome,created_at&user_id=eq.${uid}` +
      `&game_id=in.(tictactoe,sudoku)&order=created_at.desc&limit=3`,
    token,
  )
}

async function homeRewards(token: string): Promise<Row[]> {
  const uid = uidOf(token)
  return rows(
    `wallet_transactions?select=reference_id,amount&user_id=eq.${uid}` +
      `&type=eq.GAME_REWARD&order=created_at.desc&limit=5`,
    token,
  )
}

async function homeAchievements(token: string): Promise<Row[]> {
  return rows(
    'achievements?select=id,name,target_type,user_achievements(user_id,earned_at)&order=id',
    token,
  )
}

const toResults = (rs: Row[]): HomeGameResultRow[] =>
  rs.map((r) => ({
    id: r.id as string,
    session_id: (r.session_id as string | null) ?? null,
    game_id: r.game_id as string,
    outcome: r.outcome as string,
    created_at: r.created_at as string,
  }))

const toRewards = (rs: Row[]): HomeRewardRow[] =>
  rs.map((r) => ({
    reference_id: (r.reference_id as string | null) ?? null,
    amount: Number(r.amount),
  }))

const toCatalog = (rs: Row[]): HomeAchievementCatalogRow[] =>
  rs.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    target_type: r.target_type as string,
    user_achievements: ((r.user_achievements as Row[] | null) ?? []).map((e) => ({
      user_id: e.user_id as string,
      earned_at: e.earned_at as string,
    })),
  }))

async function startTtt(token: string, board?: unknown[]) {
  const start = await edge('process-tictactoe', { action: 'start' }, token)
  assert.equal(start.status, 200, start.text)
  const sid = (start.json as { sessionId: string }).sessionId
  if (!board) return { sid, done: null as { status: number; json: unknown; text: string } | null }
  const done = await edge('process-tictactoe', { action: 'complete', sessionId: sid, board }, token)
  return { sid, done }
}

async function startSudoku(token: string) {
  const start = await edge('process-sudoku', { action: 'start', puzzleId: 0 }, token)
  assert.equal(start.status, 200, start.text)
  const sid = (start.json as { sessionId: string }).sessionId
  const done = await edge(
    'process-sudoku',
    { action: 'complete', sessionId: sid, puzzleId: 0, board: solvedBoard },
    token,
  )
  return { sid, done }
}

// ── Suite state ───────────────────────────────────────────────
let tokenA = ''
let tokenB = ''
let sidWin = ''
let sidSudoku = ''
let sidStarted = ''
let baseline = { xp: 0, level: 1, streak: 0, coins: 0, credits: 0 }

before(async () => {
  sql(TEMP.map(tempUserSql).join('\n'))
  tokenA = await signIn(EMAIL_A)
  tokenB = await signIn(EMAIL_B)

  // Authoritative state captured BEFORE any game is played.
  const p0 = await homeProfile(tokenA)
  const w0 = await homeWallet(tokenA)
  baseline = {
    xp: Number(p0.xp),
    level: Number(p0.level),
    streak: Number(p0.streak),
    coins: Number(w0.earned_coins),
    credits: Number(w0.ai_credits),
  }
  assert.equal(baseline.credits, TEMP[0].credits, 'fixture A credits seeded')
  assert.equal(baseline.coins, 0, 'fixture A starts with no coins')

  const win = await startTtt(tokenA, validXWin)
  assert.equal(win.done?.status, 200, win.done?.text)
  sidWin = win.sid

  const sudoku = await startSudoku(tokenA)
  assert.equal(sudoku.done.status, 200, sudoku.done.text)
  sidSudoku = sudoku.sid

  // Abandoned: started, never completed - must never show as activity.
  const abandoned = await startTtt(tokenA)
  sidStarted = abandoned.sid
})

after(async () => {
  try {
    sql(`delete from auth.users where id in (${TEMP.map((u) => `'${u.id}'`).join(',')});`)
  } catch {
    /* best effort */
  }
})

// ── Statics (supplements, before A) ───────────────────────────

test('static. Phase 14 adds zero migrations, RPCs and RLS changes', () => {
  assert.deepEqual(migrationNames.filter((f) => /phase14/i.test(f)), [], 'no phase14 migration')
  for (const forbidden of ['create table', 'alter table', 'create policy', 'drop policy', 'create or replace function']) {
    assert.ok(!homeCode.includes(forbidden), `home code must not contain "${forbidden}"`)
  }
  assert.ok(!homeSrc.includes('.rpc(') && !dataSrc.includes('.rpc('), 'no new RPC calls')
  assert.ok(!/service_role/i.test(homeCode), 'no service-role client')
})

test('static. Home reads only allow-listed tables through the existing hooks', () => {
  const froms = [...homeSrc.matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(froms)].sort(), ['achievements', 'game_results', 'wallet_transactions'])
  // progression + economy arrive as props from the existing loaders
  assert.ok(!homeSrc.includes("from('profiles')"), 'Home never queries profiles itself')
  assert.ok(!homeSrc.includes("from('wallet')"), 'Home never queries wallet itself')
  assert.match(appSrc, /profile=\{profile\}/)
  assert.match(appSrc, /wallet=\{wallet\}/)
  assert.match(profileHookSrc, /\.select\('display_name, level, xp, streak'\)/)
  assert.match(walletHookSrc, /\.select\('earned_coins, ai_credits'\)/)
})

test('static. Existing UI system stays frozen - every Home class already exists', () => {
  const required = [
    'eyebrow', 'hero-grid', 'primary-card', 'insight-card', 'progress',
    'wallet-status', 'chat-error', 'chat-error-actions', 'wallet-history-empty',
    'profile-activity', 'profile-activity-row', 'profile-outcome', 'profile-activity-date',
  ]
  for (const cls of required) {
    assert.ok(cssSrc.includes(`.${cls}`), `.${cls} must already exist in index.css`)
  }
  assert.match(homeSrc, /hero-grid/)
  assert.match(homeSrc, /primary-card/)
  assert.match(homeSrc, /insight-card/)
  // Upgrade phase B removed the game-first "Play → Earn Coins → Exchange →
  // Chat" strip from Home (UPGRADE_AUDIT gap 1); the same frozen classes must
  // not reappear as new ad-hoc markup.
  assert.ok(!homeSrc.includes('className="flow"'), 'Home no longer renders the economy flow strip')
})

// ── A: authoritative profile progression ──────────────────────

test('A. Authenticated Home loads authoritative profile progression', async () => {
  // Static (no DOM): Home displays progression from the profile prop that
  // App feeds from useProfile, and never queries profiles itself (also
  // asserted in the static block above).
  assert.match(homeSrc, /profile\.displayName/)
  assert.match(appSrc, /session=\{session\}/)
  assert.match(appSrc, /onRefreshProfile=\{refreshProfile\}/)

  // Runtime: the exact profile read Home consumes returns the authoritative row.
  const p = await homeProfile(tokenA)
  assert.equal(p.display_name, 'Phase14 A', 'display name comes from the DB row')
  assert.equal(typeof p.level, 'number')
  assert.equal(typeof p.xp, 'number')
  assert.equal(typeof p.streak, 'number')
  assert.ok(Number(p.xp) > baseline.xp, 'server-awarded XP is visible to Home')
})

// ── B: authoritative XP ───────────────────────────────────────

test('B. Home displays authoritative XP', async () => {
  // Static (no DOM): XP is rendered verbatim from props.
  assert.match(homeSrc, /\{xp\} XP/)
  assert.match(homeSrc, /XP to Level \{level \+ 1\}/)

  // Runtime: exactly the server-awarded amounts (25 TTT win + 40 Sudoku).
  const p = await homeProfile(tokenA)
  assert.equal(Number(p.xp), baseline.xp + 25 + 40, 'XP equals the RPC-awarded total')
})

// ── C: authoritative level ────────────────────────────────────

test('C. Home displays authoritative level', async () => {
  // Static (no DOM): level rendered verbatim from props.
  assert.match(homeSrc, /<p>LEVEL \{level\}<\/p>/)
  assert.ok(!homeCode.includes('setLevel'), 'Home never writes level')

  // Runtime: DB-computed level consistency for the XP Home displays.
  const p = await homeProfile(tokenA)
  const xp = Number(p.xp)
  assert.equal(Number(p.level), xp >= 100 ? Math.floor(xp / 100) + 1 : 1, 'level matches the DB rule')
})

// ── D: authoritative streak ───────────────────────────────────

test('D. Home displays authoritative streak', async () => {
  // Static (no DOM): streak rendered verbatim from the profile prop.
  assert.match(homeSrc, /<h2>\{profile\.streak\}<\/h2>/)
  assert.match(profileHookSrc, /display_name, level, xp, streak/)
  assert.ok(!homeCode.includes('setStreak'), 'Home never writes streak')

  // Runtime: completions today touched the authoritative streak.
  const p = await homeProfile(tokenA)
  const expected = Math.max(baseline.streak, 1)
  assert.equal(Number(p.streak), expected, 'streak reflects authoritative touch_user_streak')
})

// ── E: authoritative wallet state ─────────────────────────────

test('E. Home displays authoritative wallet state', async () => {
  // Static (no DOM): balances rendered verbatim; failure never shows a fake 0.
  assert.match(homeSrc, /\{wallet\.error \? '—' : wallet\.earnedCoins\}/)
  assert.match(homeSrc, /\{wallet\.error \? '—' : wallet\.aiCredits\}/)

  // Runtime: exactly the server-awarded balances (10 TTT win + 20 Sudoku).
  const w = await homeWallet(tokenA)
  assert.equal(Number(w.earned_coins), baseline.coins + 10 + 20, 'coins equal the awarded total')
  assert.equal(Number(w.ai_credits), baseline.credits, 'credits untouched by completions')
})

// ── F: recent completed game activity ─────────────────────────

test('F. Home displays recent completed game activity', async () => {
  // Static (no DOM): the exact activity query lives in Home.
  assert.match(homeSrc, /\.from\('game_results'\)/)
  assert.match(homeSrc, /select\('id, session_id, game_id, outcome, created_at'\)/)
  assert.match(homeSrc, /\.in\('game_id'/)
  assert.match(homeSrc, /order\('created_at', \{ ascending: false \}\)/)
  assert.match(homeSrc, /\.limit\(3\)/)

  // Runtime: only completed TTT/Sudoku results, newest first, capped at 3.
  const activity = await homeActivity(tokenA)
  assert.ok(activity.length >= 2 && activity.length <= 3, `rows=${activity.length}`)
  const times = activity.map((r) => Date.parse(r.created_at as string))
  assert.deepEqual([...times].sort((a, b) => b - a), times, 'newest first')
  for (const row of activity) {
    assert.ok(['tictactoe', 'sudoku'].includes(row.game_id as string), `game=${row.game_id}`)
  }
  assert.ok(activity.some((r) => r.session_id === sidWin), 'TTT win appears in activity')
  assert.ok(activity.some((r) => r.session_id === sidSudoku), 'Sudoku appears in activity')
})

// ── G-H: per-game presentation through the real mappers ───────

test('G. TTT completed result appears correctly', async () => {
  const activity = await homeActivity(tokenA)
  const rewards = await homeRewards(tokenA)
  const row = mapActivityRows(toResults(activity), toRewards(rewards)).find(
    (r) => activity.find((a) => a.id === r.id)?.session_id === sidWin,
  )
  assert.ok(row, 'TTT win row rendered by the Home mapper')
  assert.equal(row.game, 'Tic-Tac-Toe')
  assert.equal(row.outcome, 'win')
  assert.equal(row.outcomeLabel, 'Won')
  assert.equal(row.outcomeClass, 'profile-outcome-win')

  const paid = rewards.find((r) => r.reference_id === sidWin)
  assert.ok(paid, 'authoritative GAME_REWARD exists for the session')
  assert.equal(Number(paid!.amount), 10, 'TTT win pays 10 NOVA Coins')
  assert.equal(row.coins, 10, 'Home joins the paid amount by session id')
  assert.equal(row.createdAt, activity.find((a) => a.session_id === sidWin)?.created_at)
})

test('H. Sudoku completed result appears correctly', async () => {
  const activity = await homeActivity(tokenA)
  const rewards = await homeRewards(tokenA)
  const row = mapActivityRows(toResults(activity), toRewards(rewards)).find(
    (r) => activity.find((a) => a.id === r.id)?.session_id === sidSudoku,
  )
  assert.ok(row, 'Sudoku row rendered by the Home mapper')
  assert.equal(row.game, 'Sudoku')
  assert.ok(['complete', 'win'].includes(row.outcome), `outcome=${row.outcome}`)
  assert.ok(['Completed', 'Won'].includes(row.outcomeLabel), `label=${row.outcomeLabel}`)
  assert.equal(row.outcomeClass, row.outcome === 'win' ? 'profile-outcome-win' : '')

  const paid = rewards.find((r) => r.reference_id === sidSudoku)
  assert.ok(paid, 'authoritative GAME_REWARD exists for the Sudoku session')
  assert.equal(Number(paid!.amount), 20, 'Sudoku pays 20 NOVA Coins')
  assert.equal(row.coins, 20, 'Home joins the paid amount by session id')
})

// ── I: abandoned / failed sessions are not activity ───────────

test('I. Abandoned sessions are not presented as completed activity', async () => {
  // Static (no DOM): Home never reads game_sessions - activity comes only
  // from completed results, and unfinished sessions have no result row.
  assert.ok(!homeSrc.includes('game_sessions'), 'Home does not read sessions')

  // Runtime: the abandoned session has no result and never appears.
  const abandonedResults = await rows(
    `game_results?select=id&session_id=eq.${sidStarted}`,
    tokenA,
  )
  assert.deepEqual(abandonedResults, [], 'no result row for an unfinished session')
  const activity = await homeActivity(tokenA)
  assert.ok(!activity.some((r) => r.session_id === sidStarted), 'unfinished session absent')

  // Every row Home would render comes from a COMPLETED session.
  const ids = activity.map((r) => r.session_id as string)
  const sessions = await rows(
    `game_sessions?select=id,status&id=in.(${ids.join(',')})`,
    tokenA,
  )
  assert.equal(sessions.length, ids.length, 'all activity sessions readable')
  for (const s of sessions) assert.equal(s.status, 'COMPLETED', `session ${s.id} status=${s.status}`)
})

// ── J: demo mode never becomes a persisted player ─────────────

test('J. Demo mode does not become a real persisted player', async () => {
  // Static (no DOM): every Home network path is gated on session presence,
  // the client only exists when env vars are present, and no persistent
  // storage or write path exists in the demo route.
  assert.equal(homeSrc.match(/if \(!supabase \|\| !session\) return/g)?.length, 2, 'both loaders gated')
  assert.match(homeSrc, /if \(!session\) \{/)
  assert.match(clientSrc, /url && key \? createClient\(url, key\) : null/)
  for (const storage of ['localStorage', 'sessionStorage', 'fetch(', 'indexedDB']) {
    assert.ok(!homeCode.includes(storage), `demo path must not use ${storage}`)
  }
  // Demo values are props, not a locally persisted player.
  assert.match(profileHookSrc, /DEMO_PROFILE_INFO: ProfileInfo = \{ displayName: 'Player', level: 1, xp: 40, streak: 0 \}/)
  assert.ok(!profileHookSrc.includes('.insert('), 'useProfile never writes a demo profile')

  // Runtime: an anonymous caller cannot read or create a Home player row.
  const anonProfile = await rest('profiles?select=display_name,level,xp,streak')
  assert.ok(anonProfile.status === 401 || anonProfile.status === 403 || (Array.isArray(anonProfile.json) && anonProfile.json.length === 0), `status=${anonProfile.status}`)
  const anonActivity = await rest('game_results?select=id')
  assert.ok(anonActivity.status === 401 || anonActivity.status === 403 || (Array.isArray(anonActivity.json) && anonActivity.json.length === 0), `status=${anonActivity.status}`)
  const anonWallet = await rest('wallet?select=earned_coins,ai_credits')
  assert.ok(anonWallet.status === 401 || anonWallet.status === 403 || (Array.isArray(anonWallet.json) && anonWallet.json.length === 0), `status=${anonWallet.status}`)
})

// ── K-N: no local calculation of authoritative values ─────────

test('K. Home does not calculate XP locally', () => {
  assert.ok(!/\bxp\s*[+\-*/]/.test(homeCode), 'no arithmetic on xp')
  assert.ok(!homeCode.includes('awarded_xp') && !homeCode.includes('total_xp'), 'no XP ledger fields')
  assert.ok(!homeCode.includes('Math.floor(xp'), 'no local level/XP derivation')
  // The only xp operator allowed is the pre-existing frozen progress bar
  // (identical to profile.tsx), a modulo over the authoritative value.
  assert.match(homeSrc, /xp % 100/)
})

test('L. Home does not calculate streak locally', () => {
  assert.ok(!/\bstreak\s*[+\-*/]/.test(homeCode), 'no arithmetic on streak')
  assert.ok(!homeCode.includes('lastActive') && !homeCode.includes('last_active'), 'no local activity-date math')
  assert.match(homeSrc, /\{profile\.streak\}/)
})

test('M. Home does not calculate wallet balances locally', () => {
  assert.ok(!/\bearnedCoins\s*[+\-*/]/.test(homeCode), 'no arithmetic on earnedCoins')
  assert.ok(!/\baiCredits\s*[+\-*/]/.test(homeCode), 'no arithmetic on aiCredits')
  assert.ok(!homeCode.includes('setEarnedCoins') && !homeCode.includes('setAiCredits'), 'Home never writes balances')
  assert.ok(!homeCode.includes('Math.max') && !homeCode.includes('Math.min'), 'no clamping math')
  assert.match(homeSrc, /\{wallet\.earnedCoins\}|\? '—' : wallet\.earnedCoins/)
})

test('N. Home does not calculate achievements locally', () => {
  // Static: no eligibility math from raw stats - counts come from rows.
  for (const forbidden of ['games_played', 'games_won', 'Math.floor']) {
    assert.ok(!homeCode.includes(forbidden), `home code must not use ${forbidden}`)
  }
  assert.ok(!/\btarget_value\s*[<>]/.test(homeCode), 'no target thresholds')
  assert.match(homeSrc, /summarizeAchievements\(data \?\? \[\], userId\)/)
  assert.match(homeSrc, /\{achievements\.data\.earned\} \/ \{achievements\.data\.total\}/)

  // Runtime: earning is decided by user_achievements rows, never by stats.
  const fixture: HomeAchievementCatalogRow[] = [
    { id: 'first_game', name: 'First Game', target_type: 'games_played', user_achievements: null },
    {
      id: 'streak_3',
      name: '3-Day Streak',
      target_type: 'streak',
      user_achievements: [{ user_id: IDA, earned_at: '2026-09-25T00:00:00Z' }],
    },
    {
      id: 'streak_7',
      name: '7-Day Streak',
      target_type: 'streak',
      user_achievements: [{ user_id: IDB, earned_at: '2026-09-24T00:00:00Z' }],
    },
  ]
  const summary = summarizeAchievements(fixture, IDA)
  assert.equal(summary.total, 3)
  assert.equal(summary.earned, 1, 'only this player\'s rows count - stats never earn it')
  assert.equal(summary.streakTotal, 2)
  assert.equal(summary.streakEarned, 1)
  assert.equal(summary.recent?.id, 'streak_3')
  assert.equal(
    describeAchievements(summary),
    'Latest: 3-Day Streak · Streak badges 1/2',
  )
})

// ── O: cross-user isolation (runtime) ─────────────────────────

test("O. Other users' private data cannot be loaded through Home", async () => {
  // Static (no DOM): both Home queries scope by the signed-in user.
  assert.equal(homeSrc.match(/\.eq\('user_id', userId\)/g)?.length, 2, 'both activity queries filter user_id')
  assert.match(dataSrc, /entry\.user_id === userId/, 'achievement rows filtered by owner')

  // Runtime: B's Home queries never surface A's rows.
  const bActivity = await homeActivity(tokenB)
  assert.deepEqual(bActivity, [], 'B has no completed games')
  const bAchievements = toCatalog(await homeAchievements(tokenB))
  for (const row of bAchievements) {
    for (const entry of row.user_achievements) {
      assert.equal(entry.user_id, IDB, `embedded achievement row leaked: ${row.id}`)
    }
  }
  assert.equal(summarizeAchievements(bAchievements, IDB).earned, 0, 'B sees no earned achievements')

  // Runtime: explicitly targeting A's rows from B's token returns nothing.
  const crossResult = await rest(`game_results?select=id&session_id=eq.${sidWin}&user_id=eq.${IDA}`, tokenB)
  assert.equal(crossResult.status, 200, crossResult.text)
  assert.deepEqual(crossResult.json, [], 'B cannot select A\'s result')
  const crossReward = await rest(`wallet_transactions?select=id&reference_id=eq.${sidWin}`, tokenB)
  assert.equal(crossReward.status, 200, crossReward.text)
  assert.deepEqual(crossReward.json, [], 'B cannot select A\'s reward')
  const crossProfile = await rest(`profiles?select=id&id=eq.${IDA}`, tokenB)
  assert.equal(crossProfile.status, 200, crossProfile.text)
  assert.deepEqual(crossProfile.json, [], 'B cannot select A\'s profile')
})

// ── P: refresh reflects updated authoritative state ───────────

test('P. Refresh/reopen reflects updated authoritative state', async () => {
  // Static (no DOM): Home re-reads on entry and App feeds the refresh hook.
  assert.match(homeSrc, /void refreshRef\.current\(\)/)
  assert.match(homeSrc, /void loadActivity\(\)/)
  assert.match(homeSrc, /void loadAchievements\(\)/)
  assert.match(appSrc, /onRefreshProfile=\{refreshProfile\}/)

  // Runtime: state captured before another authoritative completion.
  const activityBefore = await homeActivity(tokenA)
  const profileBefore = await homeProfile(tokenA)
  const walletBefore = await homeWallet(tokenA)

  const again = await startTtt(tokenA, validXWin)
  assert.equal(again.done?.status, 200, again.done?.text)

  // Re-running Home's queries (what reopening Home does) shows the new state.
  const activityAfter = await homeActivity(tokenA)
  assert.equal(activityAfter[0]?.session_id, again.sid, 'newest completion leads the list')
  assert.ok(!activityBefore.some((r) => r.session_id === again.sid), 'it was absent before')

  const profileAfter = await homeProfile(tokenA)
  assert.equal(Number(profileAfter.xp), Number(profileBefore.xp) + 25, 'XP gain visible on reopen')
  const walletAfter = await homeWallet(tokenA)
  assert.equal(Number(walletAfter.earned_coins), Number(walletBefore.earned_coins) + 10, 'coin gain visible on reopen')

  // The TTT win from the fixture is still inside the 3-row window.
  assert.ok(activityAfter.some((r) => r.session_id === sidSudoku), 'older activity still listed')
})

// ── Q: empty recent activity ──────────────────────────────────

test('Q. Empty recent-activity state works', async () => {
  // Static (no DOM): the empty state renders only once the section resolved
  // with zero rows - never while loading or on error.
  assert.match(homeSrc, /activity\.status === 'ready' && activity\.data\.length === 0/)
  assert.match(homeSrc, /<p>No games yet<\/p>/)
  assert.match(homeSrc, /activity\.status === 'loading'/)
  assert.match(homeSrc, /activity\.status === 'error'/)

  // Runtime: a player with no completed games gets zero rows, mapped empty.
  const empty = await homeActivity(tokenB)
  assert.deepEqual(empty, [], 'B has no activity')
  assert.deepEqual(mapActivityRows(toResults(empty), toRewards(await homeRewards(tokenB))), [])
})

// ── R: empty achievement state ────────────────────────────────

test('R. Empty achievement state works', async () => {
  // Static (no DOM): the card renders counts plus the descriptive line.
  assert.match(homeSrc, /describeAchievements\(achievements\.data\)/)
  assert.match(homeSrc, /Loading achievements…/)

  // Runtime: B earned nothing - honest empty summary from authoritative rows.
  const catalog = toCatalog(await homeAchievements(tokenB))
  const summary = summarizeAchievements(catalog, IDB)
  const catalogTotal = await rows('achievements?select=id', tokenB)
  assert.equal(summary.total, catalogTotal.length, 'total is the catalog row count')
  assert.equal(summary.earned, 0, 'B earned nothing')
  assert.equal(summary.recent, null, 'no recent achievement fabricated')
  assert.equal(summary.streakEarned, 0)
  assert.equal(summary.streakTotal, 3, 'streak badges exist in the catalog')
  assert.match(describeAchievements(summary), /^No achievements yet/)
})

// ── S: error / retry behavior ─────────────────────────────────

test('S. Error/retry behavior works where applicable', () => {
  // Static (no DOM): each section owns an independent error state...
  assert.match(homeSrc, /setActivity\(\{ status: 'error' \}\)/)
  assert.match(homeSrc, /setAchievements\(\{ status: 'error' \}\)/)
  // ...its own retry trigger wired to its own loader...
  assert.match(homeSrc, /onClick=\{\(\) => void loadActivity\(\)\}/)
  assert.match(homeSrc, /onClick=\{\(\) => void loadAchievements\(\)\}/)
  // ...and the sections are loaded by separate promises, so one failure
  // cannot hide the other.
  assert.match(homeSrc, /void loadActivity\(\)\n\s*void loadAchievements\(\)/)
  assert.match(homeSrc, /Promise\.all\(\[\s*supabase\s*\.from\('game_results'\)/)
  assert.match(homeSrc, /status === 'error'/)
  // Wallet failure: explicit retry through the existing wallet loader and a
  // non-numeric placeholder instead of a fabricated zero balance.
  assert.match(homeSrc, /onClick=\{\(\) => void wallet\.refresh\(\)\}/)
  assert.match(homeSrc, /wallet\.error \? '—' : wallet\.earnedCoins/)
  assert.match(homeSrc, /wallet\.error \? '—' : wallet\.aiCredits/)
})

// ── T: no polling / timers ────────────────────────────────────

test('T. No polling/timer behavior was introduced', () => {
  for (const token of [
    'setInterval',
    'setTimeout',
    'requestAnimationFrame',
    'EventSource',
    '.subscribe(',
    'WebSocket',
    'refetchInterval',
    'setInterval(',
  ]) {
    assert.ok(!homeCode.includes(token), `home code must not use ${token}`)
  }
  // loads happen once per Home entry (mount effect), not on an interval
  assert.match(homeSrc, /useEffect\(\(\) => \{\n\s*mountedRef\.current = true/)
})

// ── U: no new client write path ───────────────────────────────

test('U. No new client write path was introduced', async () => {
  for (const write of ['.insert(', '.update(', '.upsert(', '.delete(', '.rpc(', '.invoke(', 'fetch(']) {
    assert.ok(!homeCode.includes(write), `home code must not call ${write}`)
  }

  // Runtime: the tables Home reads remain unreadable-for-write from the browser.
  const post = await rest('game_results', tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ session_id: sidWin, user_id: IDA, game_id: 'tictactoe', outcome: 'win' }),
  })
  assert.ok(
    [401, 403, 405].includes(post.status) || (Array.isArray(post.json) && post.json.length === 0),
    `game_results insert status=${post.status}`,
  )

  const tx = await rest('wallet_transactions', tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: IDA, type: 'GAME_REWARD', amount: 500, reference_id: sidWin }),
  })
  assert.ok(
    [401, 403, 405].includes(tx.status) || (Array.isArray(tx.json) && tx.json.length === 0),
    `wallet_transactions insert status=${tx.status}`,
  )

  const ua = await rest('user_achievements', tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: IDA, achievement_id: 'first_game' }),
  })
  assert.ok(
    [401, 403, 405].includes(ua.status) || (Array.isArray(ua.json) && ua.json.length === 0),
    `user_achievements insert status=${ua.status}`,
  )

  const patch = await rest(`profiles?id=eq.${IDA}`, tokenA, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ xp: 999999, level: 99, streak: 999 }),
  })
  if (patch.status === 200 || patch.status === 204) {
    assert.equal(Array.isArray(patch.json) ? patch.json.length : 0, 0, 'no profile row updated')
  } else {
    assert.ok([400, 403, 404].includes(patch.status), `profiles patch status=${patch.status}`)
  }
  const p = await homeProfile(tokenA)
  assert.notEqual(Number(p.xp), 999999, 'xp not client-writable')
})

// ── V: Phase 13 reward -> Chat re-entry remains functional ────

test('V. Phase 13 reward -> Chat re-entry remains functional', async () => {
  // Static: the Phase 13 contract is untouched by Phase 14.
  assert.ok(homeSrc.includes('gameSessionId') === false, 'Home never participates in re-entry')
  assert.match(chatSrc, /\.\.\.\(context \? \{ gameSessionId: context\.sessionId \} : \{\}\)/)
  assert.match(chatSrc, /if \(context\) onPostGameConsumed\(\)/)
  assert.match(appSrc, /const \[postGame, setPostGame\] = useState<PostGameContext \| null>\(null\)/)
  const destructures = [...chatEdge.matchAll(/const \{([^}]*)\} = body as/g)]
  assert.equal(destructures.length, 1, 'nova-chat keeps exactly one body destructure')
  const fields = (destructures[0]?.[1] ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\?$/, ''))
    .filter(Boolean)
  assert.deepEqual(
    fields.sort(),
    ['attachmentPath', 'conversationId', 'gameSessionId', 'idempotencyKey', 'message', 'mode'],
  )

  // Runtime (tolerant): a live re-entry still streams the derived context.
  const p = await homeProfile(tokenA)
  const withSession = await novaChat(
    {
      message: 'How did my last game go?',
      idempotencyKey: crypto.randomUUID(),
      gameSessionId: sidWin,
    },
    tokenA,
  )
  if (withSession.status !== 200) {
    assert.ok(isGuarded(withSession.status), `guarded failure expected: ${withSession.status}`)
    console.log(`  [v] nova-chat provider unavailable (status ${withSession.status}); E2E assertions skipped`)
    return
  }
  const start = startEvent(withSession)
  assert.ok(start, 'start event present')
  const activity = start?.recentActivity as Record<string, unknown> | null
  assert.ok(activity, 're-entry context present')
  assert.equal(activity?.game, 'tictactoe')
  assert.equal(activity?.outcome, 'win')
  assert.equal(
    (activity?.progression as { xp: number } | undefined)?.xp,
    Number(p.xp),
    'progression still read from authoritative profiles',
  )
})
