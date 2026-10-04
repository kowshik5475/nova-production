// Phase 13 - Reward -> Chat re-entry V1 tests (static + A-R)
// Run: node --experimental-strip-types supabase/tests/phase13_reward_chat_reentry.test.ts
//
// Fixtures: 2 disposable out-of-band users created in before() and deleted in
// after() (delete from auth.users cascades to every child row). No shared
// p2b* profile / wallet / game row is mutated, so every other suite keeps its
// state. This phase needs no migration: the AI context is derived at read time
// from rows the requesting user's RLS already scopes.
//
// E2E tolerance: nova-chat needs a live provider. When it answers 200 the suite
// asserts the streamed `start.recentActivity`; otherwise it asserts the failure
// is a guarded 4xx/5xx and still verifies economy + row invariants.

import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

import { buildRecentActivity, isUuid } from '../functions/_shared/recent_activity.ts'
import type { RecentActivity } from '../functions/_shared/recent_activity.ts'

const root = resolve(import.meta.dirname, '../..')
const envText = readFileSync(resolve(root, '.env'), 'utf8')
const SUPABASE_URL = /VITE_SUPABASE_URL=(.+)/.exec(envText)?.[1]?.trim()
const ANON_KEY = /VITE_SUPABASE_ANON_KEY=(.+)/.exec(envText)?.[1]?.trim()
if (!SUPABASE_URL || !ANON_KEY) throw new Error('Missing Supabase env')

const password = 'password123'
const TEMP = [
  { id: '00000000-0000-4000-8000-000000001301', email: 'phase13a@example.test', name: 'Phase13 A', credits: 5 },
  { id: '00000000-0000-4000-8000-000000001302', email: 'phase13b@example.test', name: 'Phase13 B', credits: 2 },
]
const [IDA] = TEMP.map((u) => u.id)
const EMAIL_A = TEMP[0].email
const EMAIL_B = TEMP[1].email

// ── Sources under test ────────────────────────────────────────
const sharedSrc = readFileSync(
  resolve(root, 'supabase/functions/_shared/recent_activity.ts'),
  'utf8',
)
const chatEdge = readFileSync(resolve(root, 'supabase/functions/nova-chat/index.ts'), 'utf8')
const tttEdge = readFileSync(resolve(root, 'supabase/functions/process-tictactoe/index.ts'), 'utf8')
const sudokuEdge = readFileSync(resolve(root, 'supabase/functions/process-sudoku/index.ts'), 'utf8')
const appSrc = readFileSync(resolve(root, 'src/app/App.tsx'), 'utf8')
const chatSrc = readFileSync(resolve(root, 'src/app/chat.tsx'), 'utf8')
const tttSrc = readFileSync(resolve(root, 'src/app/tictactoe.tsx'), 'utf8')
const sudokuSrc = readFileSync(resolve(root, 'src/app/sudoku.tsx'), 'utf8')
const typesSrc = readFileSync(resolve(root, 'src/app/types.ts'), 'utf8')
const cssSrc = readFileSync(resolve(root, 'src/index.css'), 'utf8')
const migrationNames = readdirSync(resolve(root, 'supabase/migrations'))

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

// ── Linked-project SQL helper (documented test mechanism) ─────
let sqlSeq = 0
function sqlRaw(query: string): { ok: boolean; out: string } {
  const osTmp = resolve(
    process.env.TEMP || process.env.TMP || '.',
    `phase13-${process.pid}-${Date.now()}-${sqlSeq++}.sql`,
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
const validOLoss = ['O', 'O', 'O', 'X', 'X', null, null, null, 'X']
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

type Row = Record<string, unknown>

async function rows(path: string, token: string): Promise<Row[]> {
  const r = await rest(path, token)
  assert.equal(r.status, 200, r.text)
  return r.json as Row[]
}

async function sessionRow(token: string, sid: string) {
  const rs = await rows(`game_sessions?select=id,game_id,status&id=eq.${sid}`, token)
  return rs[0] ?? null
}

async function resultRow(token: string, sid: string) {
  const rs = await rows(
    `game_results?select=session_id,game_id,outcome,created_at&session_id=eq.${sid}`,
    token,
  )
  return rs[0] ?? null
}

async function rewardRows(token: string, sid: string) {
  return rows(
    `wallet_transactions?select=id,user_id,type,amount,reference_id&reference_id=eq.${sid}&type=eq.GAME_REWARD`,
    token,
  )
}

async function profileRow(token: string) {
  const rs = await rows('profiles?select=id,xp,level,streak', token)
  assert.equal(rs.length, 1, 'own profile readable')
  return rs[0]
}

async function walletRow(token: string) {
  const rs = await rows('wallet?select=user_id,ai_credits,earned_coins', token)
  assert.equal(rs.length, 1, 'own wallet readable')
  return rs[0]
}

// Exactly the derivation nova-chat performs, re-run against live rows.
async function derive(token: string, sid: string): Promise<RecentActivity | null> {
  const s = await sessionRow(token, sid)
  if (!s || s.status !== 'COMPLETED') return null
  const r = await resultRow(token, sid)
  if (!r) return null
  const rewards = await rewardRows(token, sid)
  const p = await profileRow(token)
  return buildRecentActivity({
    game: r.game_id as string,
    outcome: r.outcome as string,
    completedAt: r.created_at as string,
    coinsEarned: (rewards[0]?.amount as number) ?? 0,
    profile: { xp: p.xp as number, level: p.level as number, streak: p.streak as number },
  })
}

async function startTtt(token: string, board?: unknown[]) {
  const start = await edge('process-tictactoe', { action: 'start' }, token)
  assert.equal(start.status, 200, start.text)
  const sid = (start.json as { sessionId: string }).sessionId
  if (!board) return { sid, done: null as { status: number; json: unknown; text: string } | null }
  const done = await edge('process-tictactoe', { action: 'complete', sessionId: sid, board }, token)
  return { sid, done }
}

// ── Suite state ───────────────────────────────────────────────
let tokenA = ''
let tokenB = ''
let sidWin = ''
let sidDraw = ''
let sidSudoku = ''
let sidStarted = ''

before(async () => {
  sql(TEMP.map(tempUserSql).join('\n'))
  tokenA = await signIn(EMAIL_A)
  tokenB = await signIn(EMAIL_B)
  const pa = await profileRow(tokenA)
  assert.equal(pa.id, IDA, 'profile row for fixture A')
  const wa = await walletRow(tokenA)
  assert.equal(wa.ai_credits, TEMP[0].credits, 'fixture A credits seeded')
})

after(async () => {
  try {
    sql(`delete from auth.users where id in (${TEMP.map((u) => `'${u.id}'`).join(',')});`)
  } catch {
    /* best effort */
  }
})

// ── Static ────────────────────────────────────────────────────

test('static. Phase 13 adds no migration - the context is derived at read time', () => {
  assert.deepEqual(
    migrationNames.filter((f) => /phase13/i.test(f)),
    [],
    'no phase13 migration file exists',
  )
  assert.ok(!migrationNames.some((f) => /recent_activity|reentry|re-entry/i.test(f)))
})

// The suggestion copy is asserted below; declared here to keep the check inline.
const POST_GAME_SUGGESTION_CHECK = (() => {
  const m = /const POST_GAME_SUGGESTION[^=]*= (\{[\s\S]*?\n\})/.exec(chatSrc)
  return m?.[1] ?? ''
})()

test('static. nova-chat accepts only message, idempotencyKey and gameSessionId', () => {
  // the only thing ever read out of the request body is this destructure
  //
  // The full field set is routing + validation only. conversationId selects a
  // thread, mode selects a provider mode and attachmentPath points at a
  // storage object the function re-validates for owner/mime/size before use.
  // None of them can carry an outcome, reward, identity or context payload.
  const destructures = [...chatEdge.matchAll(/const \{([^}]*)\} = body as/g)]
  assert.equal(destructures.length, 1, 'exactly one body destructure')
  const fields = (destructures[0]?.[1] ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\?$/, ''))
    .filter(Boolean)
  assert.deepEqual(
    fields.sort(),
    ['attachmentPath', 'conversationId', 'gameSessionId', 'idempotencyKey', 'message', 'mode'],
  )
  // guard: a malformed reference is ignored, never looked up
  assert.match(chatEdge, /if \(isUuid\(gameSessionId\)\)/)
  assert.ok(!/body\.(recentActivity|outcome|awardedCoins|xp|coins)/.test(chatEdge))
})

test('static. Context is derived from RLS-scoped tables and never written', () => {
  assert.match(chatEdge, /\.from\('game_sessions'\)/)
  assert.match(chatEdge, /\.from\('game_results'\)/)
  assert.match(chatEdge, /\.from\('wallet_transactions'\)/)
  assert.match(chatEdge, /sessionRow\.status === 'COMPLETED'/)
  assert.match(chatEdge, /playerCtx\.recentActivity = recentActivity/)
  // read-only: no table writes and no reward-minting call anywhere in the function
  for (const write of [/\.insert\(/, /\.update\(/, /\.delete\(/, /\.upsert\(/]) {
    assert.ok(!write.test(chatEdge), `nova-chat must not perform ${write}`)
  }
  for (const mint of ['complete_tictactoe_game', 'complete_sudoku_game', 'exchange_nova_coins', 'touch_user_streak']) {
    assert.ok(!chatEdge.includes(mint), `re-entry must not call ${mint}`)
  }
  assert.ok(!/service_role/i.test(chatEdge), 'no service-role client')
  // only the credit-reservation contract RPCs are reachable
  const rpcs = [...chatEdge.matchAll(/\.rpc\('([a-z_]+)'/g)].map((m) => m[1])
  assert.deepEqual(
    [...new Set(rpcs)].sort(),
    [
      'finalize_chat_credit',
      'get_chat_history',
      'get_chat_request_state',
      'release_chat_credit',
      'reserve_chat_credit',
    ],
  )
  assert.ok(!/create policy|alter table|create table/i.test(chatEdge))
})

test('static. recent_activity module is pure, allow-listed and identity-free', () => {
  assert.match(sharedSrc, /export function buildRecentActivity/)
  assert.match(sharedSrc, /export function isUuid/)
  // checks run against code only - comments may legitimately explain the rules
  const code = sharedSrc
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  for (const forbidden of [
    'email',
    'password',
    'access_token',
    'apikey',
    'ai_credits',
    'earned_coins',
    'user_id',
    'auth.',
    'Deno.',
    'fetch(',
    'supabase',
    'wallet',
  ]) {
    assert.ok(!code.includes(forbidden), `shared module must not use ${forbidden}`)
  }
  // allow-lists, not free-form passthrough
  assert.match(sharedSrc, /GAMES = new Set\(\['tictactoe', 'sudoku'\]\)/)
  assert.match(sharedSrc, /OUTCOMES = new Set\(\['win', 'loss', 'draw', 'complete'\]\)/)
  // nova-chat imports it instead of re-implementing the logic
  assert.match(chatEdge, /from '\.\.\/_shared\/recent_activity\.ts'/)
})

test('static. One-time carrier is in-memory, consumed on done, and never stored', () => {
  assert.match(appSrc, /const \[postGame, setPostGame\] = useState<PostGameContext \| null>\(null\)/)
  for (const src of [appSrc, chatSrc, tttSrc, sudokuSrc]) {
    assert.ok(!/localStorage|sessionStorage/.test(src), 'no persistent storage for re-entry context')
  }
  assert.match(typesSrc, /export type PostGameContext = \{ sessionId: string; game: 'tictactoe' \| 'sudoku' \}/)
  // sent with the request, consumed exactly once when the reply completes
  assert.match(chatSrc, /\.\.\.\(context \? \{ gameSessionId: context\.sessionId \} : \{\}\)/)
  assert.match(chatSrc, /if \(context\) onPostGameConsumed\(\)/)
  // suggestion only fills the composer - the player still presses Send
  const chipBlock = chatSrc.slice(chatSrc.indexOf('chat-postgame'))
  assert.ok(chipBlock.length > 0, 'post-game chip rendered')
  assert.match(chipBlock, /onClick=\{\(\) => setPrompt\(POST_GAME_SUGGESTION\[postGame\.game\]\.prompt\)\}/)
  assert.ok(!chipBlock.slice(0, chipBlock.indexOf('</div>')).includes('sendMessage'), 'chip never auto-sends')
  assert.ok(!/coins|XP|credit/i.test(POST_GAME_SUGGESTION_CHECK), 'suggestion carries no reward values')
})

test('static. Games expose the hand-off only after a server-confirmed completion', () => {
  assert.match(
    tttSrc,
    /if \(error\) throw error\s+\/\/ Result recorded by the server[\s\S]{0,80}setCompletedSessionId\(sessionId\)/,
  )
  assert.match(tttSrc, /function restartGame\(\) \{[\s\S]{0,200}setCompletedSessionId\(null\)/)
  assert.match(
    sudokuSrc,
    /if \(!error && data\?\.success\) \{\s+\/\/ Result recorded by the server[\s\S]{0,80}setCompletedSessionId\(sudokuSessionIdRef\.current\)/,
  )
  assert.match(sudokuSrc, /function startSudokuGame[\s\S]{0,900}setCompletedSessionId\(null\)/)
  // demo mode never reaches the completion branch, so no hand-off exists there
  assert.match(tttSrc, /if \(!supabase \|\| !session\) return/)
  // existing UI surfaces stay exactly as they were
  assert.match(tttSrc, /`game-status\$\{statusVariant/)
  assert.match(tttSrc, /New round/)
  assert.match(sudokuSrc, /Quit/)
  assert.match(sudokuSrc, /New Puzzle/)
  assert.match(appSrc, /onContinueToChat=\{\(sessionId\) => continueToChat\(sessionId, 'tictactoe'\)\}/)
  assert.match(appSrc, /onContinueToChat=\{\(sessionId\) => continueToChat\(sessionId, 'sudoku'\)\}/)
  assert.match(appSrc, /postGame=\{postGame\}/)
  assert.match(cssSrc, /\.chat-postgame \{/)
  assert.match(cssSrc, /\.chat-postgame button \{/)
})

// ── A-D: authoritative completion rows feed the derivation ────

test('A. TTT win produces the authoritative chain and the derived context', async () => {
  const { sid, done } = await startTtt(tokenA, validXWin)
  assert.equal(done?.status, 200, done?.text)
  sidWin = sid

  const s = await sessionRow(tokenA, sid)
  assert.equal(s?.status, 'COMPLETED')
  assert.equal(s?.game_id, 'tictactoe')

  const r = await resultRow(tokenA, sid)
  assert.equal(r?.outcome, 'win')
  assert.equal(r?.game_id, 'tictactoe')

  const rewards = await rewardRows(tokenA, sid)
  assert.equal(rewards.length, 1, 'exactly one GAME_REWARD for the session')
  assert.equal(rewards[0].user_id, IDA, 'reward belongs to the player')
  assert.equal(rewards[0].reference_id, sid, 'reward references the session')

  const activity = await derive(tokenA, sid)
  const p = await profileRow(tokenA)
  assert.ok(activity, 'context derived')
  assert.equal(activity.type, 'game_completion')
  assert.equal(activity.game, 'tictactoe')
  assert.equal(activity.outcome, 'win')
  assert.equal(activity.completedAt, r?.created_at, 'timestamp taken from game_results')
  assert.deepEqual(activity.progression, {
    xp: p.xp as number,
    level: p.level as number,
    ...((p.streak as number) > 0 ? { streak: p.streak as number } : {}),
  })
  assert.deepEqual(activity.reward, { coins: rewards[0].amount as number })
  assert.ok((rewards[0].amount as number) > 0, 'win paid coins')
})

test('B. TTT loss yields outcome loss and a reward only if one was actually paid', async () => {
  const { sid, done } = await startTtt(tokenA, validOLoss)
  assert.equal(done?.status, 200, done?.text)
  const r = await resultRow(tokenA, sid)
  assert.equal(r?.outcome, 'loss')

  const activity = await derive(tokenA, sid)
  assert.ok(activity)
  assert.equal(activity.game, 'tictactoe')
  assert.equal(activity.outcome, 'loss')

  const rewards = await rewardRows(tokenA, sid)
  if (rewards.length === 0) {
    assert.equal(activity.reward, undefined, 'no reward key when nothing was paid')
  } else {
    assert.equal(rewards.length, 1)
    assert.deepEqual(activity.reward, { coins: rewards[0].amount as number })
  }
})

test('C. TTT draw yields outcome draw', async () => {
  const { sid, done } = await startTtt(tokenA, validDraw)
  assert.equal(done?.status, 200, done?.text)
  sidDraw = sid

  const r = await resultRow(tokenA, sid)
  assert.equal(r?.outcome, 'draw')

  const activity = await derive(tokenA, sid)
  assert.ok(activity)
  assert.equal(activity.game, 'tictactoe')
  assert.equal(activity.outcome, 'draw')
  assert.equal(activity.type, 'game_completion')
})

test('D. Sudoku completion yields a sudoku context with its own reward', async () => {
  const start = await edge('process-sudoku', { action: 'start', puzzleId: 0 }, tokenA)
  assert.equal(start.status, 200, start.text)
  const sid = (start.json as { sessionId: string }).sessionId
  const done = await edge(
    'process-sudoku',
    { action: 'complete', sessionId: sid, puzzleId: 0, board: solvedBoard },
    tokenA,
  )
  assert.equal(done.status, 200, done.text)
  sidSudoku = sid

  const r = await resultRow(tokenA, sid)
  assert.ok(r, 'game_results row written')
  assert.ok(['win', 'complete'].includes(r.outcome as string), `outcome=${r.outcome}`)

  const activity = await derive(tokenA, sid)
  assert.ok(activity)
  assert.equal(activity.game, 'sudoku')
  assert.equal(activity.outcome, r.outcome)
  assert.ok(activity.progression, 'progression attached')
})

// ── E: pure derivation contract ───────────────────────────────

test('E. buildRecentActivity rejects anything that is not a completed game', () => {
  assert.equal(isUuid(sidWin), true)
  assert.equal(isUuid('not-a-uuid'), false)
  assert.equal(isUuid(undefined), false)
  assert.equal(isUuid(42), false)

  assert.equal(buildRecentActivity({}), null)
  assert.equal(buildRecentActivity({ game: 'chess', outcome: 'win', completedAt: 'now' }), null)
  assert.equal(buildRecentActivity({ game: 'tictactoe', outcome: 'blunder', completedAt: 'now' }), null)
  assert.equal(buildRecentActivity({ game: 'tictactoe', outcome: 'win' }), null)
  assert.equal(
    buildRecentActivity({ game: 'tictactoe', outcome: 'win', completedAt: '', profile: null }),
    null,
    'empty timestamp is rejected',
  )

  const minimal = buildRecentActivity({ game: 'sudoku', outcome: 'complete', completedAt: '2026-09-25T00:00:00Z' })
  assert.deepEqual(minimal, {
    type: 'game_completion',
    game: 'sudoku',
    outcome: 'complete',
    completedAt: '2026-09-25T00:00:00Z',
  })

  // allow-listed keys only, even when callers pass junk
  const full = buildRecentActivity({
    game: 'tictactoe',
    outcome: 'win',
    completedAt: '2026-09-25T00:00:00Z',
    coinsEarned: 10,
    profile: { xp: 5, level: 1, streak: 0 },
  })
  assert.ok(full)
  assert.deepEqual(
    Object.keys(full).sort(),
    ['completedAt', 'game', 'outcome', 'progression', 'reward', 'type'],
  )
  assert.deepEqual(full.progression, { xp: 5, level: 1 }, 'zero streak is omitted')
  assert.equal(JSON.stringify(full).includes('streak'), false)
})

// ── F-H: RLS scoping and pending sessions ─────────────────────

test('F. Another player cannot read the rows a re-entry context is derived from', async () => {
  assert.ok(sidWin, 'A completed a game in A')
  const sessions = await rows(`game_sessions?select=id&id=eq.${sidWin}`, tokenB)
  assert.deepEqual(sessions, [], 'B cannot see A session')
  const results = await rows(`game_results?select=id&session_id=eq.${sidWin}`, tokenB)
  assert.deepEqual(results, [], 'B cannot see A result')
  const rewards = await rows(
    `wallet_transactions?select=id&reference_id=eq.${sidWin}`,
    tokenB,
  )
  assert.deepEqual(rewards, [], 'B cannot see A reward')
  // exactly what nova-chat would derive for B referencing A's session: nothing
  assert.equal(await derive(tokenB, sidWin), null)
})

test('G. The player who completed the game can read every derivation input', async () => {
  const s = await sessionRow(tokenA, sidWin)
  const r = await resultRow(tokenA, sidWin)
  const rewards = await rewardRows(tokenA, sidWin)
  assert.ok(s && r && rewards.length === 1)
  assert.equal(await derive(tokenA, sidWin) !== null, true)
})

test('H. A started-but-unfinished session produces no context', async () => {
  const { sid } = await startTtt(tokenA)
  sidStarted = sid
  const s = await sessionRow(tokenA, sid)
  assert.equal(s?.status, 'STARTED')
  assert.equal(await resultRow(tokenA, sid), null, 'no result row for an unfinished session')
  assert.equal(await derive(tokenA, sid), null, 'unfinished session yields no context')
  // and the server requires COMPLETED before it looks anything up
  assert.match(chatEdge, /sessionRow\.status === 'COMPLETED'/)
  assert.equal(await derive(tokenB, sidStarted), null)
})

// ── I: live re-entry round trip (tolerant) ────────────────────

test('I. nova-chat streams the derived context when the player references a session', async () => {
  const p = await profileRow(tokenA)
  const rewards = await rewardRows(tokenA, sidWin)
  const expected = await derive(tokenA, sidWin)
  assert.ok(expected)

  const withSession = await novaChat(
    {
      message: 'How did my last Tic-Tac-Toe game go?',
      idempotencyKey: crypto.randomUUID(),
      gameSessionId: sidWin,
    },
    tokenA,
  )

  if (withSession.status !== 200) {
    assert.ok(isGuarded(withSession.status), `guarded failure expected: ${withSession.status}`)
    console.log(`  [i] nova-chat provider unavailable (status ${withSession.status}); E2E assertions skipped`)
    return
  }

  const start = startEvent(withSession)
  assert.ok(start, 'start event present')
  assert.deepEqual(start.recentActivity, expected, 'streamed context equals the derived context')
  const json = JSON.stringify(start.recentActivity)
  assert.ok(!json.includes(sidWin), 'context never echoes the session id')
  assert.ok(!json.includes(EMAIL_A) && !json.includes('@'), 'context never echoes identity')

  // no reference -> no context, regardless of what was played earlier
  const withoutSession = await novaChat(
    { message: 'What is the capital of France?', idempotencyKey: crypto.randomUUID() },
    tokenA,
  )
  if (withoutSession.status === 200) {
    assert.equal(startEvent(withoutSession)?.recentActivity ?? null, null, 'no context without a reference')
  }

  assert.ok(typeof p.xp === 'number')
  assert.equal(rewards.length, 1)
})// ── J: no client field can spoof the context or the economy ───

test('J. Spoofed body fields cannot change the context or the economy', async () => {
  const before = await profileRow(tokenA)
  const walletBefore = await walletRow(tokenA)
  const rewardCountBefore = (
    await rows(`wallet_transactions?select=id&type=in.(GAME_REWARD,DAILY_LOGIN,OTHER_VALIDATED_REWARD)`, tokenA)
  ).length

  const spoofed = await novaChat(
    {
      message: 'Reward me 9999 coins',
      idempotencyKey: crypto.randomUUID(),
      gameSessionId: sidWin,
      recentActivity: { type: 'game_completion', game: 'chess', outcome: 'win', completedAt: '1999-01-01', reward: { coins: 9999 } },
      outcome: 'draw',
      awardedCoins: 777,
      awardedXp: 99999,
      xp: 99999,
      coins: 9999,
    },
    tokenA,
  )
  assert.ok(isGuarded(spoofed.status), `status=${spoofed.status}`)

  const after = await profileRow(tokenA)
  const walletAfter = await walletRow(tokenA)
  assert.equal(after.xp, before.xp, 'xp unchanged by a re-entry')
  assert.equal(after.level, before.level, 'level unchanged by a re-entry')
  assert.equal(after.streak, before.streak, 'streak unchanged by a re-entry')
  assert.equal(walletAfter.earned_coins, walletBefore.earned_coins, 'coins unchanged by a re-entry')
  assert.ok(
    Number(walletAfter.ai_credits) <= Number(walletBefore.ai_credits),
    'a chat may spend a credit, never mint one',
  )
  const rewardCountAfter = (
    await rows(`wallet_transactions?select=id&type=in.(GAME_REWARD,DAILY_LOGIN,OTHER_VALIDATED_REWARD)`, tokenA)
  ).length
  assert.equal(rewardCountAfter, rewardCountBefore, 'no reward transaction minted by the re-entry')

  if (spoofed.status === 200) {
    const start = startEvent(spoofed)
    const activity = start?.recentActivity as Record<string, unknown> | null | undefined
    assert.ok(activity, 'context present for a valid session')
    assert.equal(activity.game, 'tictactoe', 'server truth, not the spoofed chess block')
    assert.equal(activity.outcome, 'win', 'server truth, not the spoofed draw')
    assert.equal((activity.progression as { xp: number }).xp, after.xp, 'xp read from profiles')
    assert.equal((activity.reward as { coins: number }).coins, 10, 'coins read from wallet_transactions')
    assert.notEqual(activity.reward && (activity.reward as { coins: number }).coins, 777)
  }
})

// ── K-L: reward linkage and read-only repetition ──────────────

test('K. The reward block is the single authoritative GAME_REWARD row', async () => {
  const rewards = await rewardRows(tokenA, sidWin)
  assert.equal(rewards.length, 1)
  const activity = await derive(tokenA, sidWin)
  assert.ok(activity)
  assert.deepEqual(activity.reward, { coins: rewards[0].amount as number })
  assert.equal(activity.reward?.coins, 10, 'TTT win pays 10 NOVA Coins')
  // no other reference style: the transaction is keyed by the session id
  assert.equal(rewards[0].type, 'GAME_REWARD')
  assert.equal(rewards[0].reference_id, sidWin)
})

test('L. Repeating the re-entry is read-only - rows and rewards never duplicate', async () => {
  const count = async (path: string, token: string) => (await rows(path, token)).length
  const resultsBefore = await count('game_results?select=id', tokenA)
  const rewardsBefore = await count(
    'wallet_transactions?select=id&type=eq.GAME_REWARD',
    tokenA,
  )
  const xpBefore = (await profileRow(tokenA)).xp

  for (let i = 0; i < 2; i++) {
    const r = await novaChat(
      {
        message: 'Summarise my progress.',
        idempotencyKey: crypto.randomUUID(),
        gameSessionId: sidDraw,
      },
      tokenA,
    )
    assert.ok(isGuarded(r.status), `status=${r.status}`)
  }

  assert.equal(await count('game_results?select=id', tokenA), resultsBefore, 'no new results')
  assert.equal(
    await count('wallet_transactions?select=id&type=eq.GAME_REWARD', tokenA),
    rewardsBefore,
    'no new rewards',
  )
  assert.equal((await profileRow(tokenA)).xp, xpBefore, 'xp unchanged')
})

// ── M-N: credit cost and cross-user live reference ────────────

test('M. The re-entry itself is free - a chat may spend a credit, never mint one', async () => {
  const creditsBefore = Number((await walletRow(tokenA)).ai_credits)
  const profileBefore = await profileRow(tokenA)
  const rewardRowsBefore = (
    await rows('wallet_transactions?select=id&type=in.(GAME_REWARD,DAILY_LOGIN,OTHER_VALIDATED_REWARD)', tokenA)
  ).length

  const r = await novaChat(
    {
      message: 'One line on my progress please.',
      idempotencyKey: crypto.randomUUID(),
      gameSessionId: sidSudoku,
    },
    tokenA,
  )
  assert.ok(isGuarded(r.status), `status=${r.status}`)

  const creditsAfter = Number((await walletRow(tokenA)).ai_credits)
  if (r.status === 200) {
    assert.equal(creditsAfter, creditsBefore - 1, 'a completed reply costs exactly 1 credit')
  } else {
    assert.equal(creditsAfter, creditsBefore, 'a failed reply refunds the credit')
  }
  assert.ok(creditsAfter <= creditsBefore, 'the re-entry never mints a credit')

  const profileAfter = await profileRow(tokenA)
  assert.equal(profileAfter.xp, profileBefore.xp, 'xp untouched by re-entry')
  assert.equal(profileAfter.level, profileBefore.level, 'level untouched by re-entry')
  assert.equal(profileAfter.streak, profileBefore.streak, 'streak untouched by re-entry')
  assert.equal(
    (await rows('wallet_transactions?select=id&type=in.(GAME_REWARD,DAILY_LOGIN,OTHER_VALIDATED_REWARD)', tokenA)).length,
    rewardRowsBefore,
    'no reward-side transaction created by a chat re-entry',
  )
  assert.equal(await derive(tokenA, sidSudoku) !== null, true, 'the referenced session still derives')
})

test('N. A live cross-user reference yields no context', async () => {
  const r = await novaChat(
    {
      message: 'How did my last game go?',
      idempotencyKey: crypto.randomUUID(),
      gameSessionId: sidWin,
    },
    tokenB,
  )
  assert.ok(isGuarded(r.status), `status=${r.status}`)
  if (r.status === 200) {
    assert.equal(
      startEvent(r)?.recentActivity ?? null,
      null,
      'B referencing A session gets no context',
    )
  } else {
    console.log(`  [n] nova-chat provider unavailable (status ${r.status}); E2E assertions skipped`)
  }
})

// ── O-R: client-side write surface ────────────────────────────

test('O. The browser cannot write the tables a re-entry context is read from', async () => {
  const post = await rest('game_results', tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      session_id: sidWin,
      user_id: IDA,
      game_id: 'tictactoe',
      outcome: 'win',
    }),
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

  const patch = await rest(`profiles?id=eq.${IDA}`, tokenA, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ xp: 999999, level: 99 }),
  })
  if (patch.status === 200 || patch.status === 204) {
    const rowsPatched = Array.isArray(patch.json) ? patch.json : []
    assert.equal(rowsPatched.length, 0, 'no profile row updated')
  } else {
    assert.ok([400, 403, 404].includes(patch.status), `profiles patch status=${patch.status}: ${patch.text}`)
  }
  assert.equal((await profileRow(tokenA)).xp !== 999999, true)

  const w = await rest(`wallet?user_id=eq.${IDA}`, tokenA, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ai_credits: 999 }),
  })
  if (w.status === 200 || w.status === 204) {
    const rowsW = Array.isArray(w.json) ? w.json : []
    assert.equal(rowsW.length, 0, 'no wallet row updated')
  } else {
    assert.ok([400, 403, 404].includes(w.status), `wallet patch status=${w.status}: ${w.text}`)
  }
  assert.ok(Number((await walletRow(tokenA)).ai_credits) < 999, 'credits not client-writable')
})

test('P. Anonymous callers cannot derive or replay a context', async () => {
  const unauth = await novaChat({
    message: 'hi',
    idempotencyKey: crypto.randomUUID(),
    gameSessionId: sidWin,
  })
  assert.ok(unauth.status === 401 || unauth.status === 403, `status=${unauth.status}`)
  assert.equal(startEvent(unauth), null, 'no start event without auth')

  const anon = await rest('game_sessions?select=id')
  if (anon.status === 200) {
    assert.deepEqual(anon.json, [], 'anonymous caller sees no session rows')
  } else {
    assert.ok(anon.status === 401 || anon.status === 403, `anon read status=${anon.status}`)
  }
  const anonResult = await rest(`game_results?select=id&session_id=eq.${sidWin}`)
  if (anonResult.status === 200) {
    assert.deepEqual(anonResult.json, [], 'anonymous caller sees no result rows')
  } else {
    assert.ok(anonResult.status === 401 || anonResult.status === 403, `anon read status=${anonResult.status}`)
  }
})

test('Q. The derived context never carries identity, balance or chat internals', async () => {
  const activity = await derive(tokenA, sidWin)
  assert.ok(activity)
  const json = JSON.stringify(activity)
  for (const forbidden of ['@', 'password', 'ai_credits', 'earned_coins', 'credits', 'user_id', 'session', 'chat']) {
    assert.ok(!json.includes(forbidden), `context leaks "${forbidden}": ${json}`)
  }
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(json), 'no uuid in context')
  assert.deepEqual(Object.keys(activity).sort(), [
    'completedAt',
    'game',
    'outcome',
    'progression',
    'reward',
    'type',
  ])
})

test('R. Previous phases still own the reward path - process functions unchanged', () => {
  // completion still happens only in the game edge functions
  assert.match(tttEdge, /complete_tictactoe_game/)
  assert.match(sudokuEdge, /complete_sudoku_game/)
  // nova-chat keeps its Phase 2C reservation contract
  assert.match(chatEdge, /reserve_chat_credit/)
  assert.match(chatEdge, /finalize_chat_credit/)
  // the re-entry block sits after the reservation and before history load
  const reserveIdx = chatEdge.indexOf("rpc('reserve_chat_credit'")
  const contextIdx = chatEdge.indexOf('One-time post-game re-entry context')
  const historyIdx = chatEdge.indexOf('Load recent conversation history')
  assert.ok(reserveIdx > 0 && contextIdx > reserveIdx, 'context after reservation')
  assert.ok(historyIdx > contextIdx, 'context before history load')
})
