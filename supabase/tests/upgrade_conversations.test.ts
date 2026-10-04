// Upgrade tests — threaded conversations (Phase C/D).
// Run: node --experimental-strip-types supabase/tests/upgrade_conversations.test.ts
//
// Fixtures: 2 disposable out-of-band users created in before() and deleted in
// after() (deleting auth.users cascades to every child row). No shared p2b*
// profile / wallet / chat row is mutated. A owns the threads under test; B is
// the isolation fixture. Every assertion below is about the conversation
// contract: CRUD through the SECURITY DEFINER RPCs only, ownership derived
// from auth.uid() alone, and reserve → finalize persisting one exchange into
// exactly one thread exactly once.

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

const password = 'password123'
const TEMP = [
  { id: '00000000-0000-4000-8000-00000000c00a', email: 'upgconvA@example.test', name: 'Upg Conv A', credits: 5 },
  { id: '00000000-0000-4000-8000-00000000c00b', email: 'upgconvB@example.test', name: 'Upg Conv B', credits: 2 },
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

const rpc = (name: string, args: Record<string, unknown>, token: string) =>
  api(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(args) }, token)

const rest = (path: string, token: string, init: RequestInit = {}) => api(path, init, token)

type Row = Record<string, unknown>

async function rows(path: string, token: string): Promise<Row[]> {
  const r = await rest(path, token)
  assert.equal(r.status, 200, r.text)
  return r.json as Row[]
}

async function wallet(token: string) {
  const rs = await rows('/rest/v1/wallet?select=ai_credits,earned_coins', token)
  assert.equal(rs.length, 1, 'own wallet row')
  return rs[0] as { ai_credits: number; earned_coins: number }
}

async function listThreads(token: string, limit = 20) {
  const r = await rpc('get_chat_conversations', { p_limit: limit }, token)
  assert.equal(r.status, 200, r.text)
  return r.json as Row[]
}

async function createThread(token: string, title?: string) {
  const r = await rpc('create_chat_conversation', title === undefined ? {} : { p_title: title }, token)
  assert.equal(r.status, 200, r.text)
  const row = (r.json as Row[])[0]
  assert.ok(row, r.text)
  return row as { conversation_id: string; title: string }
}

async function history(token: string, conversationId: string | null, limit = 50) {
  const args: Record<string, unknown> = { p_limit: limit }
  if (conversationId) args.p_conversation_id = conversationId
  return rpc('get_chat_history', args, token)
}

async function reserve(token: string, conversationId?: string, mode?: string) {
  const args: Record<string, unknown> = { p_idempotency_key: crypto.randomUUID() }
  if (conversationId) args.p_conversation_id = conversationId
  if (mode) args.p_mode = mode
  return rpc('reserve_chat_credit', args, token)
}

async function finalize(
  token: string,
  requestId: string,
  userContent: string,
  assistantContent: string,
  mode = 'chat',
) {
  return rpc(
    'finalize_chat_credit',
    {
      p_request_id: requestId,
      p_user_content: userContent,
      p_assistant_content: assistantContent,
      p_mode: mode,
    },
    token,
  )
}

const unwrapRequest = (r: { status: number; json: unknown; text: string }) => {
  assert.equal(r.status, 200, r.text)
  const rowsArr = Array.isArray(r.json) ? (r.json as Row[]) : [r.json as Row]
  const req = rowsArr[0]
  assert.ok(req?.request_id, r.text)
  return req as { request_id: string; ai_credits: number; state: string }
}

// ── Linked-project SQL helper (documented test mechanism) ─────
let sqlSeq = 0
function sqlRaw(query: string): { ok: boolean; out: string } {
  const tmp = resolve(process.env.TEMP || process.env.TMP || '.', `upgconv-${process.pid}-${Date.now()}-${sqlSeq++}.sql`)
  writeFileSync(tmp, query, 'utf8')
  try {
    const out = execFileSync('npx.cmd', ['supabase', 'db', 'query', '--linked', '-f', tmp], {
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
      unlinkSync(tmp)
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

// ── Suite state ───────────────────────────────────────────────
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

// ── C1-C2: CRUD round-trip and title normalisation ────────────

test('C1. create → list → rename → delete round-trip', async () => {
  const created = await createThread(tokenA)
  assert.equal(created.title, 'New conversation', 'default title')

  const listed = await listThreads(tokenA)
  const found = listed.find((row) => row.conversation_id === created.conversation_id)
  assert.ok(found, 'new thread appears in own list')

  const renamed = await rpc(
    'rename_chat_conversation',
    { p_conversation_id: created.conversation_id, p_title: 'Sprint planning notes' },
    tokenA,
  )
  assert.equal(renamed.status, 200, renamed.text)
  assert.equal(((renamed.json as Row[])[0] as Row).title, 'Sprint planning notes')

  const afterRename = await listThreads(tokenA)
  assert.equal(
    (afterRename.find((row) => row.conversation_id === created.conversation_id) as Row).title,
    'Sprint planning notes',
    'rename is visible in the list',
  )

  const del = await rpc(
    'delete_chat_conversation',
    { p_conversation_id: created.conversation_id },
    tokenA,
  )
  assert.ok(del.status === 200 || del.status === 204, del.text)

  const afterDelete = await listThreads(tokenA)
  assert.ok(
    !afterDelete.some((row) => row.conversation_id === created.conversation_id),
    'deleted thread is gone',
  )
})

test('C2. Titles are whitespace-normalised and capped at 60 chars', async () => {
  const messy = await createThread(tokenA, '   spaced    out\t title  ')
  assert.equal(messy.title, 'spaced out title', 'whitespace collapsed')

  const long = await createThread(tokenA, 'x'.repeat(200))
  assert.equal(long.title.length, 60, 'title capped at 60 chars')

  const blank = await createThread(tokenA, '     ')
  assert.equal(blank.title, 'New conversation', 'blank title falls back to the default')

  for (const row of [messy, long, blank]) {
    await rpc('delete_chat_conversation', { p_conversation_id: row.conversation_id }, tokenA)
  }
})

// ── C3-C6: ownership and the absence of client write paths ────

test('C3. Another user cannot list or read my threads', async () => {
  const mine = await createThread(tokenA, 'Isolation fixture')

  const bList = await listThreads(tokenB)
  assert.ok(
    !bList.some((row) => row.conversation_id === mine.conversation_id),
    'B never sees A\u2019s thread',
  )

  const bHistory = await history(tokenB, mine.conversation_id)
  assert.notEqual(bHistory.status, 200, 'cross-user history must be rejected')
  assert.match(String(bHistory.text), /Conversation not found/i)

  const bRest = await rows('/rest/v1/chat_conversations?select=id', tokenB)
  assert.ok(!bRest.some((row) => row.id === mine.conversation_id), 'RLS hides the row too')

  await rpc('delete_chat_conversation', { p_conversation_id: mine.conversation_id }, tokenA)
})

test('C4. Another user cannot rename or delete my thread', async () => {
  const mine = await createThread(tokenA, 'Owner title')

  const rename = await rpc(
    'rename_chat_conversation',
    { p_conversation_id: mine.conversation_id, p_title: 'stolen' },
    tokenB,
  )
  assert.notEqual(rename.status, 200, 'cross-user rename must fail')
  assert.match(String(rename.text), /Conversation not found/i)

  const del = await rpc(
    'delete_chat_conversation',
    { p_conversation_id: mine.conversation_id },
    tokenB,
  )
  assert.notEqual(del.status, 200, 'cross-user delete must fail')
  assert.match(String(del.text), /Conversation not found/i)

  const still = await listThreads(tokenA)
  const row = still.find((r) => r.conversation_id === mine.conversation_id) as Row | undefined
  assert.ok(row, 'thread still exists for its owner')
  assert.equal(row.title, 'Owner title', 'title untouched')

  await rpc('delete_chat_conversation', { p_conversation_id: mine.conversation_id }, tokenA)
})

test('C5. No client-side INSERT / UPDATE / DELETE on chat_conversations', async () => {
  const mine = await createThread(tokenA, 'Policies fixture')

  const insert = await rest('/rest/v1/chat_conversations', tokenA, {
    method: 'POST',
    body: JSON.stringify({ user_id: IDA, title: 'forged' }),
  })
  assert.ok(
    [401, 403, 405].includes(insert.status) ||
      (Array.isArray(insert.json) && insert.json.length === 0),
    `insert blocked: ${insert.status} ${insert.text}`,
  )

  const patch = await rest(`/rest/v1/chat_conversations?id=eq.${mine.conversation_id}`, tokenA, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ title: 'hacked' }),
  })
  if (patch.status === 200 || patch.status === 204) {
    assert.equal(Array.isArray(patch.json) ? patch.json.length : 0, 0, 'no row updated')
  } else {
    assert.ok([400, 403, 404].includes(patch.status), `patch status=${patch.status}`)
  }

  const del = await rest(`/rest/v1/chat_conversations?id=eq.${mine.conversation_id}`, tokenA, {
    method: 'DELETE',
    headers: { Prefer: 'return=representation' },
  })
  if (del.status === 200 || del.status === 204) {
    assert.equal(Array.isArray(del.json) ? del.json.length : 0, 0, 'no row deleted')
  } else {
    assert.ok([400, 403, 404].includes(del.status), `delete status=${del.status}`)
  }

  const surviving = await listThreads(tokenA)
  const row = surviving.find((r) => r.conversation_id === mine.conversation_id) as Row | undefined
  assert.ok(row, 'thread still exists')
  assert.equal(row.title, 'Policies fixture', 'title never client-writable')

  await rpc('delete_chat_conversation', { p_conversation_id: mine.conversation_id }, tokenA)
})

test('C6. chat_messages stays server-written — no client INSERT path', async () => {
  const insert = await rest('/rest/v1/chat_messages', tokenA, {
    method: 'POST',
    body: JSON.stringify({ user_id: IDA, role: 'assistant', content: 'forged reply' }),
  })
  assert.ok(
    [401, 403, 405].includes(insert.status) ||
      (Array.isArray(insert.json) && insert.json.length === 0),
    `insert blocked: ${insert.status} ${insert.text}`,
  )

  // Anonymous callers see nothing at all.
  const anon = await api('/rest/v1/chat_messages?select=id')
  assert.ok(
    anon.status === 401 || anon.status === 403 || (Array.isArray(anon.json) && anon.json.length === 0),
    `anon status=${anon.status}`,
  )

  const anonRpc = await api('/rest/v1/rpc/create_chat_conversation', {
    method: 'POST',
    body: JSON.stringify({}),
  })
  assertAnonBlocked(anonRpc, 'create_chat_conversation')
})

// Anonymous callers must never get data out of a chat RPC. PostgREST surfaces
// the function's own auth guard as 400 'Authentication required'; a missing
// grant shows up as 401/403/404. Neither path may ever succeed.
function assertAnonBlocked(r: { status: number; text: string }, label: string) {
  assert.notEqual(r.status, 200, `anon ${label} must not succeed`)
  assert.ok(
    [400, 401, 403, 404].includes(r.status),
    `anon ${label} status=${r.status}: ${r.text}`,
  )
  if (r.status === 400) {
    assert.match(r.text, /Authentication required/i, `anon ${label} hit the auth guard`)
  }
}

// ── C7-C8: reserve → finalize persists into exactly one thread ─

test('C7. reserve → finalize persists the exchange into the thread', async () => {
  const before = await wallet(tokenA)
  assert.ok(before.ai_credits >= 1, 'fixture A seeded with credits')

  const thread = await createThread(tokenA)
  const req = unwrapRequest(await reserve(tokenA, thread.conversation_id, 'chat'))
  assert.equal(req.state, 'reserved')

  const mid = await wallet(tokenA)
  assert.equal(mid.ai_credits, before.ai_credits - 1, 'reserve debits exactly one credit')

  const fin = await finalize(
    tokenA,
    req.request_id,
    'What is a tuple in Python?',
    'A tuple is an immutable ordered sequence.',
  )
  assert.ok(fin.status === 200 || fin.status === 204, fin.text)

  const after = await wallet(tokenA)
  assert.equal(after.ai_credits, before.ai_credits - 1, 'finalize never touches the balance again')

  // Messages landed in THIS conversation, oldest first.
  const hist = await history(tokenA, thread.conversation_id)
  assert.equal(hist.status, 200, hist.text)
  const msgs = hist.json as Row[]
  assert.equal(msgs.length, 2, 'exactly one user + one assistant message')
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant'], 'ordered oldest first')
  assert.equal(msgs[0].content, 'What is a tuple in Python?')
  assert.equal(msgs[1].content, 'A tuple is an immutable ordered sequence.')
  assert.equal(msgs[0].mode, 'chat')
  assert.ok(msgs[0].created_at && msgs[1].created_at, 'timestamps present')

  // Thread bookkeeping: first-turn auto-title + last_message_at + count.
  const threads = await listThreads(tokenA)
  const row = threads.find((r) => r.conversation_id === thread.conversation_id) as Row
  assert.ok(row, 'thread listed')
  assert.equal(row.title, 'What is a tuple in Python?', 'auto-titled from the first message')
  assert.ok(row.last_message_at, 'last_message_at stamped')
  assert.equal(Number(row.message_count), 2, 'message count is server-derived')

  // Exactly one authoritative AI_USAGE debit for this request.
  const usage = await rows(
    '/rest/v1/wallet_transactions?select=amount,source,reference_id&type=eq.AI_USAGE',
    tokenA,
  )
  const mine = usage.filter((t) => t.reference_id === req.request_id)
  assert.equal(mine.length, 1, 'one AI_USAGE row per finalized request')
  assert.equal(Number(mine[0].amount), -1)
  assert.equal(mine[0].source, 'AI_CHAT')
})

test('C8. finalize is idempotent — no duplicate messages, no double debit', async () => {
  const thread = await createThread(tokenA)
  const req = unwrapRequest(await reserve(tokenA, thread.conversation_id, 'chat'))
  const creditsAfterReserve = (await wallet(tokenA)).ai_credits
  const usageBefore = (
    await rows('/rest/v1/wallet_transactions?select=id&type=eq.AI_USAGE', tokenA)
  ).length

  for (let i = 0; i < 3; i += 1) {
    const fin = await finalize(tokenA, req.request_id, 'repeat me', 'reply one')
    assert.ok(fin.status === 200 || fin.status === 204, fin.text)
  }

  const hist = await history(tokenA, thread.conversation_id)
  assert.equal(hist.status, 200, hist.text)
  assert.equal((hist.json as Row[]).length, 2, 'messages written exactly once')

  const after = await wallet(tokenA)
  assert.equal(after.ai_credits, creditsAfterReserve, 'no extra credit spent')

  const usageAfter = (
    await rows('/rest/v1/wallet_transactions?select=id&type=eq.AI_USAGE', tokenA)
  ).length
  assert.equal(usageAfter, usageBefore + 1, 'exactly one AI_USAGE debit for the request')

  // A genuinely new reservation on the same thread adds exactly two messages.
  const req2 = unwrapRequest(await reserve(tokenA, thread.conversation_id, 'chat'))
  const fin2 = await finalize(tokenA, req2.request_id, 'second turn', 'reply two')
  assert.ok(fin2.status === 200 || fin2.status === 204, fin2.text)
  const finalHist = await history(tokenA, thread.conversation_id)
  assert.equal(finalHist.status, 200, finalHist.text)
  assert.equal((finalHist.json as Row[]).length, 4, 'a new request adds exactly two messages')
  assert.equal((await wallet(tokenA)).ai_credits, creditsAfterReserve - 1, 'one credit per request')

  await rpc('delete_chat_conversation', { p_conversation_id: thread.conversation_id }, tokenA)
})

// ── C9-C11: routing validation and auto-title rules ───────────

test('C9. Reserving against another user\u2019s conversation is rejected', async () => {
  const mine = await createThread(tokenA, 'Private thread')
  const before = await wallet(tokenB)

  const r = await reserve(tokenB, mine.conversation_id, 'chat')
  assert.notEqual(r.status, 200, 'cross-user reserve must fail')
  assert.match(String(r.text), /Conversation not found/i)

  const after = await wallet(tokenB)
  assert.equal(after.ai_credits, before.ai_credits, 'failed reserve never debits')

  await rpc('delete_chat_conversation', { p_conversation_id: mine.conversation_id }, tokenA)
})

test('C10. Mode is an allow-list on the reservation row', async () => {
  const bad = await reserve(tokenA, undefined, 'hologram')
  assert.notEqual(bad.status, 200, 'unknown mode rejected')
  assert.match(String(bad.text), /Invalid chat mode/i)

  const before = await wallet(tokenA)
  for (const mode of ['chat', 'vision', 'image', 'speech']) {
    const ok = await reserve(tokenA, undefined, mode)
    const req = unwrapRequest(ok)
    assert.equal(req.state, 'reserved', `${mode} accepted`)
    const release = await rpc('release_chat_credit', { p_request_id: req.request_id }, tokenA)
    assert.ok(release.status === 200 || release.status === 204, release.text)
  }
  const after = await wallet(tokenA)
  assert.equal(after.ai_credits, before.ai_credits, 'release refunds every reserved credit')
})

test('C11. Auto-title never overwrites a custom or already-titled thread', async () => {
  const thread = await createThread(tokenA, 'My own title')
  const req = unwrapRequest(await reserve(tokenA, thread.conversation_id, 'chat'))
  const fin = await finalize(tokenA, req.request_id, 'rewritten?', 'no.')
  assert.ok(fin.status === 200 || fin.status === 204, fin.text)

  const threads = await listThreads(tokenA)
  const row = threads.find((r) => r.conversation_id === thread.conversation_id) as Row
  assert.equal(row.title, 'My own title', 'custom title survives finalize')

  await rpc('delete_chat_conversation', { p_conversation_id: thread.conversation_id }, tokenA)
})

// ── C12: backward-compatible history signature ────────────────

test('C12. Legacy get_chat_history(p_limit) still returns own history', async () => {
  const legacy = await history(tokenA, null, 5)
  assert.equal(legacy.status, 200, legacy.text)
  const msgs = legacy.json as Row[]
  assert.ok(msgs.length > 0 && msgs.length <= 5, `rows=${msgs.length}`)
  for (const m of msgs) assert.ok(m.id, 'row shape preserved')

  const anon = await api('/rest/v1/rpc/get_chat_history', {
    method: 'POST',
    body: JSON.stringify({ p_limit: 5 }),
  })
  assertAnonBlocked(anon, 'get_chat_history')
})
