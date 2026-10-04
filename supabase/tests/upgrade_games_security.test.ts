// Upgrade tests — Ball Run, Water Sort and economy hardening (Phases I/K/S).
// Run: node --experimental-strip-types supabase/tests/upgrade_games_security.test.ts
//
// Fixtures: 2 disposable out-of-band users created in before() and deleted in
// after(). No shared p2b* row is mutated.
//
// Coverage:
//   * Ball Run — server stamps started_at, derives score/outcome from the
//     server clock, enforces the 5s–120s window, rejects forged claims,
//     idempotent completion, cross-user rejection at Edge AND RPC level.
//   * Water Sort — replay-only completion (empty / illegal / unsolved moves
//     rejected), a real BFS solution wins 15 coins + 35 XP, move-count bounds,
//     idempotency, cross-user rejection.
//   * TTT — cross-user completion RPC rejected.
//   * Economy tables stay server-written: no client INSERT/UPDATE/DELETE on
//     game_results, wallet, wallet_transactions, profiles or game_sessions
//     beyond the documented own-row INSERT/SELECT.
//   * Anonymous callers are blocked everywhere.

import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  applyMove,
  isSolved,
  replayMoves,
  type Move,
  type Tubes,
} from '../../supabase/functions/_shared/watersort_validate.ts'

const root = resolve(import.meta.dirname, '../..')
const envText = readFileSync(resolve(root, '.env'), 'utf8')
const SUPABASE_URL = /VITE_SUPABASE_URL=(.+)/.exec(envText)?.[1]?.trim()
const ANON_KEY = /VITE_SUPABASE_ANON_KEY=(.+)/.exec(envText)?.[1]?.trim()
if (!SUPABASE_URL || !ANON_KEY) throw new Error('Missing Supabase env')

const FUNC = `${SUPABASE_URL}/functions/v1`
const password = 'password123'
const TEMP = [
  { id: '00000000-0000-4000-8000-00000000d00a', email: 'upgsvcA@example.test', name: 'Upg Svc A', credits: 0 },
  { id: '00000000-0000-4000-8000-00000000d00b', email: 'upgsvcB@example.test', name: 'Upg Svc B', credits: 0 },
]
const IDA = TEMP[0]!.id

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

async function api(path: string, init: RequestInit = {}, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', apikey: ANON_KEY! }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { ...headers, ...((init.headers as Record<string, string> | undefined) ?? {}) },
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

const rpc = (name: string, args: Record<string, unknown>, token?: string) =>
  api(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(args) }, token)

const rest = (path: string, token: string, init: RequestInit = {}) => api(path, init, token)

type Row = Record<string, unknown>

async function rows(path: string, token: string): Promise<Row[]> {
  const r = await rest(path, token)
  assert.equal(r.status, 200, r.text)
  return r.json as Row[]
}

async function fn(name: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', apikey: ANON_KEY! }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${FUNC}/${name}`, {
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

const walletRow = async (token: string) => (await rows('/rest/v1/wallet?select=ai_credits,earned_coins', token))[0] as { ai_credits: number; earned_coins: number }
const profileRow = async (token: string) => (await rows('/rest/v1/profiles?select=xp,level', token))[0] as { xp: number; level: number }
const progressRow = async (token: string, gameId: string) => {
  const rs = await rows(`/rest/v1/game_progress?select=games_played,games_won,best_score&game_id=eq.${gameId}`, token)
  return rs[0] as { games_played: number; games_won: number; best_score: number } | undefined
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Creates a Ball Run session straight through REST (own-row INSERT is allowed). */
async function insertSession(token: string, userId: string, gameId: string, extra: Record<string, unknown> = {}) {
  const r = await rest('/rest/v1/game_sessions', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ user_id: userId, game_id: gameId, status: 'STARTED', ...extra }),
  })
  assert.equal(r.status, 201, `session insert: ${r.text}`)
  const row = (r.json as Row[])[0]
  assert.ok(row, r.text)
  return row as { id: string; started_at: string; status: string }
}

function assertAnonBlocked(r: { status: number; text: string }, label: string) {
  assert.notEqual(r.status, 200, `anon ${label} must not succeed`)
  assert.ok([400, 401, 403, 404].includes(r.status), `anon ${label} status=${r.status}: ${r.text}`)
  if (r.status === 400) {
    assert.match(r.text, /Authentication required/i, `anon ${label} hit the auth guard`)
  }
}

// ── Water Sort solver: shortest path through the shared rules ──
function boardKey(tubes: Tubes): string {
  return tubes
    .map((tube) => tube.join(','))
    .sort()
    .join('|')
}

function solveWaterSort(initial: Tubes): Move[] | null {
  if (isSolved(initial)) return []
  const seen = new Set<string>([boardKey(initial)])
  const queue: { tubes: Tubes; path: Move[] }[] = [{ tubes: initial.map((t) => t.slice()), path: [] }]
  let head = 0
  while (head < queue.length && queue.length < 200_000) {
    const node = queue[head] as { tubes: Tubes; path: Move[] }
    head += 1
    for (let from = 0; from < node.tubes.length; from += 1) {
      for (let to = 0; to < node.tubes.length; to += 1) {
        if (from === to) continue
        const next = applyMove(node.tubes, from, to)
        if (!next) continue
        const path: Move[] = [...node.path, { from, to }]
        if (isSolved(next)) return path
        const key = boardKey(next)
        if (seen.has(key)) continue
        seen.add(key)
        queue.push({ tubes: next, path })
      }
    }
  }
  return null
}

// ── Linked-project SQL helper (documented test mechanism) ─────
let sqlSeq = 0
function sqlRaw(query: string): { ok: boolean; out: string } {
  const tmp = resolve(process.env.TEMP || process.env.TMP || '.', `upgsvc-${process.pid}-${Date.now()}-${sqlSeq++}.sql`)
  writeFileSync(tmp, query, 'utf8')
  try {
    const out = execFileSync('npx.cmd', ['supabase', 'db', 'query', '--linked', '-f', tmp], {
      cwd: root, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], shell: true,
    })
    return { ok: true, out: String(out ?? '') }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    return { ok: false, out: `${e.stdout ?? ''}\n${e.stderr ?? ''}` }
  } finally {
    try { unlinkSync(tmp) } catch { /* ignore */ }
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

let tokenA = ''
let tokenB = ''

before(async () => {
  sql(TEMP.map(tempUserSql).join('\n'))
  tokenA = await signIn(TEMP[0].email)
  tokenB = await signIn(TEMP[1].email)
})

after(async () => {
  try {
    sql(`delete from auth.users where id in (${TEMP.map((u) => `'${u.id}'`).join(',')});`)
  } catch {
    /* best effort */
  }
})

// ── G1/G4: Ball Run timing is owned by the server ─────────────

test('G1. Ball Run: started_at is server-stamped; instant cash-in is rejected', async () => {
  const forgedStart = '2020-01-01T00:00:00.000Z'
  const session = await insertSession(tokenA, IDA, 'ball-run', { started_at: forgedStart })

  const ageMs = Date.now() - Date.parse(session.started_at)
  assert.ok(ageMs >= 0 && ageMs < 60_000, `started_at server-stamped (age=${ageMs}ms), not client-supplied`)

  const xpBefore = (await profileRow(tokenA)).xp
  const coinsBefore = (await walletRow(tokenA)).earned_coins

  const tooFast = await rpc(
    'complete_ball_run_game',
    { p_session_id: session.id, p_idempotency_key: crypto.randomUUID() },
    tokenA,
  )
  assert.notEqual(tooFast.status, 200, 'completing immediately must fail')
  assert.match(String(tooFast.text), /Run too short to count/i)

  assert.equal((await profileRow(tokenA)).xp, xpBefore, 'rejected run grants no XP')
  assert.equal((await walletRow(tokenA)).earned_coins, coinsBefore, 'rejected run grants no coins')

  const results = await rows(`/rest/v1/game_results?select=id&session_id=eq.${session.id}`, tokenA)
  assert.equal(results.length, 0, 'no result row for the rejected run')

  const still = await rows(`/rest/v1/game_sessions?select=status&id=eq.${session.id}`, tokenA)
  assert.equal(still[0]?.status, 'STARTED', 'failed completion rolls back completely')
})

test('G4. Ball Run: a session parked open past the 120s window expires', async () => {
  const session = await insertSession(tokenA, IDA, 'ball-run')
  sql(`update public.game_sessions set started_at = now() - interval '130 seconds' where id = '${session.id}' and user_id = '${IDA}';`)

  const expired = await rpc(
    'complete_ball_run_game',
    { p_session_id: session.id, p_idempotency_key: crypto.randomUUID() },
    tokenA,
  )
  assert.notEqual(expired.status, 200, 'expired session rejected')
  assert.match(String(expired.text), /Session expired/i)

  const results = await rows(`/rest/v1/game_results?select=id&session_id=eq.${session.id}`, tokenA)
  assert.equal(results.length, 0, 'no result row for the expired run')
})

// ── G2/G3: Ball Run Edge flow ─────────────────────────────────

test('G2. Ball Run: a real 5s+ run counts, forged claims do not, replay pays once', async () => {
  const start = await fn('process-ball-run', { action: 'start' }, tokenA)
  assert.equal(start.status, 200, start.text)
  const sessionId = (start.json as Row).sessionId as string
  assert.ok(sessionId, start.text)

  const walletBefore = await walletRow(tokenA)
  const profileBefore = await profileRow(tokenA)
  const progressBefore = (await progressRow(tokenA, 'ball-run')) ?? { games_played: 0, games_won: 0, best_score: 0 }

  await sleep(5500)

  // A wildly wrong client claim is rejected and never consumed.
  const forgedClaim = await fn(
    'process-ball-run',
    { action: 'complete', sessionId, survivedMs: 999_999 },
    tokenA,
  )
  assert.equal(forgedClaim.status, 400, forgedClaim.text)
  assert.match(String((forgedClaim.json as Row).error), /does not match the server clock/i)

  // The honest completion derives everything server-side.
  const done = await fn('process-ball-run', { action: 'complete', sessionId }, tokenA)
  assert.equal(done.status, 200, done.text)
  const payload = done.json as Row
  assert.equal(payload.outcome, 'loss', 'a ~5.5s run is not a 60s win')
  assert.equal(Number(payload.awardedXp), 5, 'loss awards 5 XP')
  assert.equal(Number(payload.awardedCoins), 0, 'loss awards no coins')
  assert.ok(Number(payload.score) >= 5 && Number(payload.score) <= 12, `score derived from survival (score=${payload.score})`)

  const walletAfter = await walletRow(tokenA)
  const profileAfter = await profileRow(tokenA)
  assert.equal(walletAfter.earned_coins, walletBefore.earned_coins, 'loss never mints coins')
  assert.equal(profileAfter.xp, profileBefore.xp + 5, 'profile XP +5')

  const results = await rows(
    `/rest/v1/game_results?select=outcome,score,duration&session_id=eq.${sessionId}`,
    tokenA,
  )
  assert.equal(results.length, 1, 'one result row')
  assert.equal(results[0]?.outcome, 'loss')
  assert.ok(Number(results[0]?.duration) >= 5, 'duration recorded from server clock')

  const progress = await progressRow(tokenA, 'ball-run')
  assert.ok(progress, 'game_progress row created')
  assert.equal(progress.games_played, progressBefore.games_played + 1, 'games_played +1')
  assert.equal(progress.games_won, progressBefore.games_won, 'games_won unchanged on a loss')

  // Replay at the Edge layer: status guard.
  const replayEdge = await fn('process-ball-run', { action: 'complete', sessionId }, tokenA)
  assert.equal(replayEdge.status, 400, replayEdge.text)
  assert.match(String((replayEdge.json as Row).error), /already completed/i)

  // Replay at the RPC layer with the same key: idempotent ledger, no re-award.
  const walletBeforeReplay = await walletRow(tokenA)
  const ledger = await rpc(
    'complete_ball_run_game',
    { p_session_id: sessionId, p_idempotency_key: sessionId },
    tokenA,
  )
  assert.equal(ledger.status, 200, ledger.text)
  const ledgerRow = (Array.isArray(ledger.json) ? (ledger.json as Row[])[0] : (ledger.json as Row)) as Row
  assert.equal(Number(ledgerRow.awarded_xp), 0, 'idempotent replay awards nothing')
  assert.equal(Number(ledgerRow.awarded_coins), 0, 'idempotent replay awards nothing')
  assert.equal((await walletRow(tokenA)).earned_coins, walletBeforeReplay.earned_coins, 'wallet untouched by replay')

  // A fresh idempotency key on a finished session is still refused.
  const freshKey = await rpc(
    'complete_ball_run_game',
    { p_session_id: sessionId, p_idempotency_key: crypto.randomUUID() },
    tokenA,
  )
  assert.notEqual(freshKey.status, 200, 'fresh key cannot bypass the status guard')
  assert.match(String(freshKey.text), /already completed/i)
})

test('G3. Ball Run: another user cannot complete or touch my session', async () => {
  const start = await fn('process-ball-run', { action: 'start' }, tokenA)
  assert.equal(start.status, 200, start.text)
  const sessionId = (start.json as Row).sessionId as string

  const edge = await fn('process-ball-run', { action: 'complete', sessionId }, tokenB)
  assert.equal(edge.status, 400, edge.text)
  assert.match(String((edge.json as Row).error), /Invalid or unauthorized session/i)

  const direct = await rpc(
    'complete_ball_run_game',
    { p_session_id: sessionId, p_idempotency_key: crypto.randomUUID() },
    tokenB,
  )
  assert.notEqual(direct.status, 200, 'cross-user RPC must fail')
  assert.match(String(direct.text), /Invalid or unauthorized session/i)

  const asOwner = await rows(`/rest/v1/game_sessions?select=status&id=eq.${sessionId}`, tokenA)
  assert.equal(asOwner[0]?.status, 'STARTED', 'session untouched by the attacker')

  const stolen = await rows(`/rest/v1/game_sessions?select=id&id=eq.${sessionId}`, tokenB)
  assert.equal(stolen.length, 0, 'RLS hides the session from the attacker')
})

// ── G5/G6: Water Sort replay-only completion ──────────────────

test('G5. Water Sort: only a replayed, solved board pays out', async () => {
  const start = await fn('process-water-sort', { action: 'start', colors: 3 }, tokenA)
  assert.equal(start.status, 200, start.text)
  const started = start.json as Row
  const sessionId = started.sessionId as string
  const tubes = started.tubes as Tubes
  assert.ok(Array.isArray(tubes) && tubes.length >= 3, start.text)
  assert.equal(typeof started.par, 'number', 'par reported for scoring')

  // 1. Empty move list.
  const empty = await fn('process-water-sort', { action: 'complete', sessionId, moves: [] }, tokenA)
  assert.equal(empty.status, 400, empty.text)
  assert.match(String((empty.json as Row).error), /cannot be empty/i)

  // 2. Structurally legal shape, illegal move (self-move).
  const illegal = await fn(
    'process-water-sort',
    { action: 'complete', sessionId, moves: [{ from: 0, to: 0 }] },
    tokenA,
  )
  assert.equal(illegal.status, 400, illegal.text)
  assert.match(String((illegal.json as Row).error), /illegal/i)

  // 3. Solve the puzzle with a shortest-path BFS through the shared rules,
  //    then verify the exact replay the server will run.
  const solution = solveWaterSort(tubes)
  assert.ok(solution && solution.length > 0, 'solver produced a move list')
  assert.ok(solution.length <= 400, 'solution within MAX_MOVES')
  const localReplay = replayMoves(tubes, solution)
  assert.ok(localReplay.ok && localReplay.solved, 'shared replay confirms the solution')

  if (solution.length > 0) {
    // A legal prefix that does not finish the puzzle is still a refusal.
    const partial = await fn(
      'process-water-sort',
      { action: 'complete', sessionId, moves: [solution[0]] },
      tokenA,
    )
    assert.equal(partial.status, 400, partial.text)
    assert.match(String((partial.json as Row).error), /not solved/i)
  }

  // 4. RPC-level move-count bounds — checked before anything is written.
  const zeroMoves = await rpc(
    'complete_water_sort_game',
    { p_session_id: sessionId, p_move_count: 0, p_idempotency_key: crypto.randomUUID() },
    tokenA,
  )
  assert.notEqual(zeroMoves.status, 200, 'move_count 0 rejected')
  assert.match(String(zeroMoves.text), /Invalid move count/i)

  const tooMany = await rpc(
    'complete_water_sort_game',
    { p_session_id: sessionId, p_move_count: 401, p_idempotency_key: crypto.randomUUID() },
    tokenA,
  )
  assert.notEqual(tooMany.status, 200, 'move_count 401 rejected')
  assert.match(String(tooMany.text), /Invalid move count/i)

  // 4b. The RPC itself replays the claimed move list — a direct call can no
  //     longer pay out on a move count alone.
  const noMoveList = await rpc(
    'complete_water_sort_game',
    { p_session_id: sessionId, p_move_count: solution.length, p_idempotency_key: crypto.randomUUID() },
    tokenA,
  )
  assert.notEqual(noMoveList.status, 200, 'RPC without a move list rejected')
  assert.match(String(noMoveList.text), /Move list required/i)

  const unsolvedReplay = await rpc(
    'complete_water_sort_game',
    {
      p_session_id: sessionId,
      p_move_count: solution.length,
      p_idempotency_key: crypto.randomUUID(),
      p_moves: [solution[0]],
    },
    tokenA,
  )
  assert.notEqual(unsolvedReplay.status, 200, 'RPC with an unsolved replay rejected')
  assert.match(String(unsolvedReplay.text), /not solved/i)

  const forgedReplay = await rpc(
    'complete_water_sort_game',
    {
      p_session_id: sessionId,
      p_move_count: 1,
      p_idempotency_key: crypto.randomUUID(),
      p_moves: [{ from: 0, to: 0 }],
    },
    tokenA,
  )
  assert.notEqual(forgedReplay.status, 200, 'RPC with an illegal move rejected')
  assert.match(String(forgedReplay.text), /illegal/i)

  // 5. The real solution wins — server re-derives score, coins and XP.
  const walletBefore = await walletRow(tokenA)
  const profileBefore = await profileRow(tokenA)
  const progressBefore = (await progressRow(tokenA, 'water-sort')) ?? { games_played: 0, games_won: 0, best_score: 0 }

  const done = await fn('process-water-sort', { action: 'complete', sessionId, moves: solution }, tokenA)
  assert.equal(done.status, 200, done.text)
  const payload = done.json as Row
  assert.equal(payload.outcome, 'win')
  assert.equal(Number(payload.moves), solution.length, 'server reports the replayed length')
  assert.equal(Number(payload.awardedCoins), 15, 'win awards 15 coins')
  assert.equal(Number(payload.awardedXp), 35, 'win awards 35 XP')
  const score = Number(payload.score)
  assert.ok(score >= 20 && score <= 100, `score inside the 20–100 band (score=${score})`)

  const walletAfter = await walletRow(tokenA)
  const profileAfter = await profileRow(tokenA)
  assert.equal(walletAfter.earned_coins, walletBefore.earned_coins + 15, 'wallet credited once')
  assert.equal(profileAfter.xp, profileBefore.xp + 35, 'profile XP +35')

  const results = await rows(
    `/rest/v1/game_results?select=outcome,score,moves&session_id=eq.${sessionId}`,
    tokenA,
  )
  assert.equal(results.length, 1, 'one result row')
  assert.equal(results[0]?.outcome, 'win')
  assert.equal(Number(results[0]?.moves), solution.length, 'moves column mirrors the replay')

  const progress = await progressRow(tokenA, 'water-sort')
  assert.ok(progress, 'game_progress row created')
  assert.equal(progress.games_played, progressBefore.games_played + 1, 'games_played +1')
  assert.equal(progress.games_won, progressBefore.games_won + 1, 'games_won +1')

  // 6. Replays pay nothing.
  const ledger = await rpc(
    'complete_water_sort_game',
    { p_session_id: sessionId, p_move_count: solution.length, p_idempotency_key: sessionId },
    tokenA,
  )
  assert.equal(ledger.status, 200, ledger.text)
  const ledgerRow = (Array.isArray(ledger.json) ? (ledger.json as Row[])[0] : (ledger.json as Row)) as Row
  assert.equal(Number(ledgerRow.awarded_coins), 0, 'idempotent replay awards no coins')
  assert.equal(Number(ledgerRow.awarded_xp), 0, 'idempotent replay awards no XP')
  assert.equal((await walletRow(tokenA)).earned_coins, walletAfter.earned_coins, 'wallet unchanged by replay')

  const replayEdge = await fn(
    'process-water-sort',
    { action: 'complete', sessionId, moves: solution },
    tokenA,
  )
  assert.equal(replayEdge.status, 400, replayEdge.text)
  assert.match(String((replayEdge.json as Row).error), /already completed/i)
})

test('G6. Water Sort: another user cannot complete or read my session', async () => {
  const start = await fn('process-water-sort', { action: 'start', colors: 3 }, tokenA)
  assert.equal(start.status, 200, start.text)
  const sessionId = (start.json as Row).sessionId as string

  const edge = await fn('process-water-sort', { action: 'complete', sessionId, moves: [] }, tokenB)
  assert.equal(edge.status, 400, edge.text)
  assert.match(String((edge.json as Row).error), /Invalid or unauthorized session/i)

  const direct = await rpc(
    'complete_water_sort_game',
    { p_session_id: sessionId, p_move_count: 5, p_idempotency_key: crypto.randomUUID() },
    tokenB,
  )
  assert.notEqual(direct.status, 200, 'cross-user RPC must fail')
  assert.match(String(direct.text), /Invalid or unauthorized session/i)

  const stolen = await rows(`/rest/v1/game_sessions?select=id&id=eq.${sessionId}`, tokenB)
  assert.equal(stolen.length, 0, 'RLS hides the session from the attacker')
})

// ── G7: the same guard on the pre-existing game ───────────────

test('G7. Tic-Tac-Toe: the completion RPC refuses another user\u2019s session', async () => {
  const session = await insertSession(tokenA, IDA, 'tictactoe')

  const cross = await rpc(
    'complete_tictactoe_game',
    { p_session_id: session.id, p_outcome: 'win', p_idempotency_key: crypto.randomUUID() },
    tokenB,
  )
  assert.notEqual(cross.status, 200, 'cross-user completion must fail')
  assert.match(String(cross.text), /Invalid or unauthorized session/i)

  const still = await rows(`/rest/v1/game_sessions?select=status&id=eq.${session.id}`, tokenA)
  assert.equal(still[0]?.status, 'STARTED', 'session untouched')

  const results = await rows(`/rest/v1/game_results?select=id&session_id=eq.${session.id}`, tokenA)
  assert.equal(results.length, 0, 'no result row written')
})

// ── G8/G9: the economy stays server-written; anon sees nothing ─

test('G8. Clients cannot forge results, rewards, balances or session transitions', async () => {
  const session = await insertSession(tokenA, IDA, 'ball-run')

  // Direct result row — the ledger of every reward.
  const forgedResult = await rest('/rest/v1/game_results', tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      session_id: session.id,
      user_id: IDA,
      game_id: 'ball-run',
      score: 100,
      outcome: 'win',
    }),
  })
  assert.ok(
    [401, 403, 405].includes(forgedResult.status) ||
      (Array.isArray(forgedResult.json) && forgedResult.json.length === 0),
    `game_results insert status=${forgedResult.status}: ${forgedResult.text}`,
  )
  assert.equal(
    (await rows(`/rest/v1/game_results?select=id&session_id=eq.${session.id}`, tokenA)).length,
    0,
    'no forged result row exists',
  )

  // Direct reward transaction.
  const forgedTx = await rest('/rest/v1/wallet_transactions', tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: IDA,
      type: 'GAME_REWARD',
      amount: 500,
      currency: 'NOVA_COIN',
      source: 'BALL_RUN_WIN',
      reference_id: session.id,
    }),
  })
  assert.ok(
    [401, 403, 405].includes(forgedTx.status) ||
      (Array.isArray(forgedTx.json) && forgedTx.json.length === 0),
    `wallet_transactions insert status=${forgedTx.status}: ${forgedTx.text}`,
  )
  const txs = await rows(`/rest/v1/wallet_transactions?select=id&reference_id=eq.${session.id}`, tokenA)
  assert.equal(txs.length, 0, 'no forged transaction exists')

  // Direct balance / progression edits.
  const walletBefore = await walletRow(tokenA)
  const patchWallet = await rest(`/rest/v1/wallet?user_id=eq.${IDA}`, tokenA, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ai_credits: 999, earned_coins: 999 }),
  })
  if (patchWallet.status === 200 || patchWallet.status === 204) {
    assert.equal(Array.isArray(patchWallet.json) ? patchWallet.json.length : 0, 0, 'no wallet row updated')
  } else {
    assert.ok([400, 403, 404].includes(patchWallet.status), `wallet patch status=${patchWallet.status}`)
  }
  const walletAfter = await walletRow(tokenA)
  assert.equal(walletAfter.ai_credits, walletBefore.ai_credits, 'credits not client-writable')
  assert.equal(walletAfter.earned_coins, walletBefore.earned_coins, 'coins not client-writable')

  const profileBefore = await profileRow(tokenA)
  const patchProfile = await rest(`/rest/v1/profiles?id=eq.${IDA}`, tokenA, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ xp: 999999, level: 99 }),
  })
  if (patchProfile.status === 200 || patchProfile.status === 204) {
    assert.equal(Array.isArray(patchProfile.json) ? patchProfile.json.length : 0, 0, 'no profile row updated')
  } else {
    assert.ok([400, 403, 404].includes(patchProfile.status), `profiles patch status=${patchProfile.status}`)
  }
  const profileAfter = await profileRow(tokenA)
  assert.notEqual(profileAfter.xp, 999999, 'XP not client-writable')
  assert.equal(profileAfter.xp, profileBefore.xp, 'XP unchanged')

  // Session state transitions belong to SECURITY DEFINER RPCs only.
  const patchSession = await rest(`/rest/v1/game_sessions?id=eq.${session.id}`, tokenA, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'COMPLETED', started_at: '2020-01-01T00:00:00.000Z' }),
  })
  if (patchSession.status === 200 || patchSession.status === 204) {
    assert.equal(Array.isArray(patchSession.json) ? patchSession.json.length : 0, 0, 'no session row updated')
  } else {
    assert.ok([400, 403, 404].includes(patchSession.status), `sessions patch status=${patchSession.status}`)
  }

  const delSession = await rest(`/rest/v1/game_sessions?id=eq.${session.id}`, tokenA, {
    method: 'DELETE',
    headers: { Prefer: 'return=representation' },
  })
  if (delSession.status === 200 || delSession.status === 204) {
    assert.equal(Array.isArray(delSession.json) ? delSession.json.length : 0, 0, 'no session row deleted')
  } else {
    assert.ok([400, 403, 404, 405].includes(delSession.status), `sessions delete status=${delSession.status}`)
  }

  const survivor = await rows(`/rest/v1/game_sessions?select=status&id=eq.${session.id}`, tokenA)
  assert.equal(survivor[0]?.status, 'STARTED', 'session state never client-writable')
})

test('G9. Anonymous callers are blocked from sessions, results and completions', async () => {
  const anonSessions = await api('/rest/v1/game_sessions?select=id')
  if (anonSessions.status === 200) {
    assert.deepEqual(anonSessions.json, [], 'anonymous caller sees no session rows')
  } else {
    assert.ok(anonSessions.status === 401 || anonSessions.status === 403, `status=${anonSessions.status}`)
  }

  const anonResults = await api('/rest/v1/game_results?select=id')
  if (anonResults.status === 200) {
    assert.deepEqual(anonResults.json, [], 'anonymous caller sees no result rows')
  } else {
    assert.ok(anonResults.status === 401 || anonResults.status === 403, `status=${anonResults.status}`)
  }

  const anonRpc = await rpc('complete_ball_run_game', {
    p_session_id: crypto.randomUUID(),
    p_idempotency_key: crypto.randomUUID(),
  })
  assertAnonBlocked(anonRpc, 'complete_ball_run_game')

  const anonWater = await rpc('complete_water_sort_game', {
    p_session_id: crypto.randomUUID(),
    p_move_count: 10,
    p_idempotency_key: crypto.randomUUID(),
  })
  assertAnonBlocked(anonWater, 'complete_water_sort_game')

  const anonEdge = await fn('process-ball-run', { action: 'start' })
  assert.equal(anonEdge.status, 401, `anon edge status=${anonEdge.status}: ${anonEdge.text}`)
})
