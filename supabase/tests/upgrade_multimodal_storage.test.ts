// Upgrade tests — multimodal modes, attachments and private Storage (Phases F/G/H).
// Run: node --experimental-strip-types supabase/tests/upgrade_multimodal_storage.test.ts
//
// Fixtures: 2 disposable out-of-band users created in before() and deleted in
// after(). No shared p2b* row is mutated.
//
// Coverage:
//   * pure mode/attachment/message gates (the exact module nova-chat imports)
//   * the static contract that nova-chat and the client actually call them
//   * runtime isolation on the private chat-attachments bucket
//   * finalize persists media metadata and rejects unknown media kinds

import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  CHAT_MODES,
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_LENGTH,
  IMAGE_MIME_TYPES,
  normalizeMode,
  isOwnerPath,
  checkImageAttachment,
  checkMessageText,
  mediaObjectPath,
  isValidUuid,
} from '../../supabase/functions/_shared/chat_modes.ts'

const root = resolve(import.meta.dirname, '../..')
const envText = readFileSync(resolve(root, '.env'), 'utf8')
const SUPABASE_URL = /VITE_SUPABASE_URL=(.+)/.exec(envText)?.[1]?.trim()
const ANON_KEY = /VITE_SUPABASE_ANON_KEY=(.+)/.exec(envText)?.[1]?.trim()
if (!SUPABASE_URL || !ANON_KEY) throw new Error('Missing Supabase env')

const novaChatSrc = readFileSync(resolve(root, 'supabase/functions/nova-chat/index.ts'), 'utf8')
const clientSrc = readFileSync(resolve(root, 'src/lib/supabase/client.ts'), 'utf8')
const homeCode = readFileSync(resolve(root, 'src/app/home.tsx'), 'utf8')
const chatCode = readFileSync(resolve(root, 'src/app/chat.tsx'), 'utf8')

const password = 'password123'
const TEMP = [
  { id: '00000000-0000-4000-8000-00000000f00a', email: 'upgmmA@example.test', name: 'Upg MM A', credits: 3 },
  { id: '00000000-0000-4000-8000-00000000f00b', email: 'upgmmB@example.test', name: 'Upg MM B', credits: 1 },
]
const [IDA, IDB] = TEMP.map((u) => u.id)

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
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers: { ...headers, ...((init.headers as Record<string, string> | undefined) ?? {}) } })
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

type Row = Record<string, unknown>

async function rows(path: string, token: string): Promise<Row[]> {
  const r = await api(path, {}, token)
  assert.equal(r.status, 200, r.text)
  return r.json as Row[]
}

async function wallet(token: string) {
  const rs = await rows('/rest/v1/wallet?select=ai_credits', token)
  return (rs[0] as { ai_credits: number }).ai_credits
}

async function createThread(token: string, title: string) {
  const r = await rpc('create_chat_conversation', { p_title: title }, token)
  assert.equal(r.status, 200, r.text)
  return ((r.json as Row[])[0] as Row).conversation_id as string
}

async function reserve(token: string, conversationId?: string, mode?: string) {
  const args: Record<string, unknown> = { p_idempotency_key: crypto.randomUUID() }
  if (conversationId) args.p_conversation_id = conversationId
  if (mode) args.p_mode = mode
  const r = await rpc('reserve_chat_credit', args, token)
  assert.equal(r.status, 200, r.text)
  const row = (Array.isArray(r.json) ? (r.json as Row[])[0] : (r.json as Row)) as Row
  assert.ok(row?.request_id, r.text)
  return row.request_id as string
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])

async function storage(path: string, token: string, init: RequestInit & { body?: unknown } = {}) {
  const body = init.body
  const headers: Record<string, string> = { apikey: ANON_KEY!, Authorization: `Bearer ${token}` }
  if (body !== undefined && !(body instanceof Uint8Array)) {
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(`${SUPABASE_URL}/storage/v1/${path}`, {
    ...init,
    body: body instanceof Uint8Array || body === undefined ? (body as BodyInit | undefined) : (body as string),
    headers: { ...headers, ...((init.headers as Record<string, string> | undefined) ?? {}) },
  })
  const text = await res.text()
  return { status: res.status, text }
}

async function signPath(bucketPath: string, token: string) {
  return storage(`object/sign/${bucketPath}`, token, {
    method: 'POST',
    body: JSON.stringify({ expiresIn: 60 }),
  })
}

// ── Linked-project SQL helper (documented test mechanism) ─────
let sqlSeq = 0
function sqlRaw(query: string): { ok: boolean; out: string } {
  const tmp = resolve(process.env.TEMP || process.env.TMP || '.', `upgmm-${process.pid}-${Date.now()}-${sqlSeq++}.sql`)
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

// ── M1-M4: the pure gates nova-chat imports ───────────────────

test('M1. normalizeMode is a strict allow-list with a chat default', () => {
  assert.equal(normalizeMode(undefined), 'chat')
  assert.equal(normalizeMode(null), 'chat')
  assert.equal(normalizeMode(''), 'chat')
  for (const mode of CHAT_MODES) assert.equal(normalizeMode(mode), mode)
  for (const bad of ['hologram', 'CHAT', 'vision ', 'admin', '']) {
    const got = normalizeMode(bad)
    if (bad === '') continue
    assert.equal(got, null, `"${bad}" rejected`)
  }
  assert.equal(normalizeMode(42), null, 'non-string rejected')
  assert.equal(normalizeMode(['chat']), null, 'array rejected')
  assert.deepEqual([...CHAT_MODES].sort(), ['chat', 'image', 'speech', 'vision'])
})

test('M2. Attachment paths are owner-folder only — no traversal, no absolute paths', () => {
  assert.equal(isOwnerPath(`${IDA}/shot.png`, IDA), true)
  assert.equal(isOwnerPath(`${IDA}/nested/shot.png`, IDA), true, 'sub-folders allowed')
  assert.equal(isOwnerPath(`${IDB}/shot.png`, IDA), false, "someone else's folder")
  assert.equal(isOwnerPath(`${IDA}x/shot.png`, IDA), false, 'prefix trick rejected')
  assert.equal(isOwnerPath(`../${IDA}/shot.png`, IDA), false, 'traversal rejected')
  assert.equal(isOwnerPath(`/${IDA}/shot.png`, IDA), false, 'absolute path rejected')
  assert.equal(isOwnerPath(`${IDA}//shot.png`, IDA), false, 'empty segment rejected')
  assert.equal(isOwnerPath(`${IDA}/`, IDA), false, 'missing file name')
  assert.equal(isOwnerPath('shot.png', IDA), false, 'missing owner folder')
  assert.equal(isOwnerPath('', IDA), false)
  assert.equal(isOwnerPath(7, IDA), false, 'non-string rejected')

  const good = checkImageAttachment({
    path: `${IDA}/shot.png`,
    ownerId: IDA,
    mimeType: 'image/png',
    bytes: 1024,
  })
  assert.equal(good.ok, true)

  const foreign = checkImageAttachment({
    path: `${IDB}/shot.png`,
    ownerId: IDA,
    mimeType: 'image/png',
    bytes: 1024,
  })
  assert.equal(foreign.ok, false)
  if (!foreign.ok) assert.match(foreign.error, /not yours/i)

  const badMime = checkImageAttachment({
    path: `${IDA}/shot.svg`,
    ownerId: IDA,
    mimeType: 'image/svg+xml',
    bytes: 10,
  })
  assert.equal(badMime.ok, false)
  if (!badMime.ok) assert.match(badMime.error, /Unsupported image type/i)

  const tooBig = checkImageAttachment({
    path: `${IDA}/shot.png`,
    ownerId: IDA,
    mimeType: 'image/png',
    bytes: MAX_IMAGE_BYTES + 1,
  })
  assert.equal(tooBig.ok, false)
  if (!tooBig.ok) assert.match(tooBig.error, /5 MB/i)

  for (const mime of IMAGE_MIME_TYPES) {
    const r = checkImageAttachment({ path: `${IDA}/x`, ownerId: IDA, mimeType: mime, bytes: 1 })
    assert.equal(r.ok, true, `${mime} allowed`)
  }
})

test('M3. Message text and media paths follow the shared limits', () => {
  assert.equal(checkMessageText('  hello  ').ok, true)
  const empty = checkMessageText('   ')
  assert.equal(empty.ok, false)
  const tooLong = checkMessageText('x'.repeat(MAX_MESSAGE_LENGTH + 1))
  assert.equal(tooLong.ok, false)
  const numeric = checkMessageText(42)
  assert.equal(numeric.ok, false)
  const okText = checkMessageText('y'.repeat(MAX_MESSAGE_LENGTH))
  assert.equal(okText.ok, true)

  const p = mediaObjectPath(IDA, 'png')
  assert.equal(isOwnerPath(p, IDA), true, 'generated media lands in the owner folder')
  const weird = mediaObjectPath(IDA, '../../etc/passwd')
  assert.ok(!weird.includes('..'), 'extension sanitised')

  assert.equal(isValidUuid(crypto.randomUUID()), true)
  assert.equal(isValidUuid('not-a-uuid'), false)
  assert.equal(isValidUuid(42), false)
})

test('M4. nova-chat enforces the shared gates and keeps models configurable', () => {
  assert.match(novaChatSrc, /from '\.\.\/_shared\/chat_modes\.ts'/, 'imports the shared module')
  for (const fn of ['normalizeMode', 'checkMessageText', 'checkImageAttachment', 'mediaObjectPath', 'CHAT_MODES']) {
    assert.ok(novaChatSrc.includes(fn), `nova-chat calls ${fn}`)
  }
  // Model names are env-driven with safe fallbacks — never a bare hardcoded call.
  for (const env of ['GEMINI_TEXT_MODEL', 'GEMINI_VISION_MODEL', 'GEMINI_IMAGE_MODEL', 'GEMINI_TTS_MODEL']) {
    assert.ok(novaChatSrc.includes(env), `${env} is configurable`)
  }
  assert.match(novaChatSrc, /Deno\.env\.get\('GEMINI_API_KEY'\)/, 'key read from env only')
  const keyOccurrences = novaChatSrc.split('GEMINI_API_KEY').length - 1
  const keyInEnvGet = novaChatSrc.split("Deno.env.get('GEMINI_API_KEY')").length - 1
  assert.equal(keyOccurrences, keyInEnvGet, 'GEMINI_API_KEY only ever read from the environment')
  assert.ok(!novaChatSrc.includes('SUPABASE_SERVICE_ROLE_KEY'), 'chat never uses the service role')
  assert.ok(!novaChatSrc.includes('create table') && !novaChatSrc.includes('create policy'), 'no DDL from the function')
})

test('M5. The browser bundle never sees a service key, a Gemini key or DDL', () => {
  for (const forbidden of ['SERVICE_ROLE', 'service_role', 'GEMINI']) {
    assert.ok(!homeCode.includes(forbidden), `home must not reference ${forbidden}`)
    assert.ok(!chatCode.includes(forbidden), `chat must not reference ${forbidden}`)
  }
  assert.ok(!envText.includes('SERVICE_ROLE'), '.env carries no service-role key')
  assert.ok(!envText.includes('GEMINI'), '.env carries no Gemini key in the web app')
  assert.match(clientSrc, /VITE_SUPABASE_URL/, 'client built from VITE_ vars only')
  assert.match(clientSrc, /VITE_SUPABASE_ANON_KEY/, 'client built from the anon key only')
})

// ── M6: private bucket isolation at runtime ───────────────────

test('M6. chat-attachments is owner-scoped: upload, sign and delete are isolated', async () => {
  const pathA = `${IDA}/probe.png`
  const pathB = `${IDB}/probe.png`

  const uploadA = await storage(`object/chat-attachments/${pathA}`, tokenA, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'x-upsert': 'true' },
    body: PNG,
  })
  assert.equal(uploadA.status, 200, `own-folder upload: ${uploadA.text}`)

  const uploadBIntoA = await storage(`object/chat-attachments/${pathA}`, tokenB, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'x-upsert': 'true' },
    body: PNG,
  })
  assert.notEqual(uploadBIntoA.status, 200, "B cannot write into A's folder")
  assert.match(uploadBIntoA.text, /row-level security|AccessDenied|Unauthorized/i)

  const signB = await signPath(`chat-attachments/${pathA}`, tokenB)
  assert.notEqual(signB.status, 200, 'B cannot sign A\u2019s object')
  assert.match(signB.text, /not found|not_found|Access denied|Unauthorized/i)

  const delB = await storage(`object/chat-attachments/${pathA}`, tokenB, { method: 'DELETE' })
  assert.notEqual(delB.status, 200, 'B cannot delete A\u2019s object')

  const signA = await signPath(`chat-attachments/${pathA}`, tokenA)
  assert.equal(signA.status, 200, `owner can sign own object: ${signA.text}`)
  const signedUrl = (JSON.parse(signA.text) as { signedURL: string }).signedURL
  const fetched = await fetch(`${SUPABASE_URL}/storage/v1${signedUrl}`)
  assert.equal(fetched.status, 200, 'signed URL resolves for the owner')
  const bytes = Buffer.from(await fetched.arrayBuffer())
  assert.equal(Buffer.compare(bytes, PNG), 0, 'object bytes intact')

  // Symmetric direction: A cannot reach B's object either.
  const uploadB = await storage(`object/chat-attachments/${pathB}`, tokenB, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'x-upsert': 'true' },
    body: PNG,
  })
  assert.equal(uploadB.status, 200, 'B can write its own folder')
  const signBbyA = await signPath(`chat-attachments/${pathB}`, tokenA)
  assert.notEqual(signBbyA.status, 200, 'A cannot sign B\u2019s object')

  const delA = await storage(`object/chat-attachments/${pathA}`, tokenA, { method: 'DELETE' })
  assert.equal(delA.status, 200, 'owner cleanup')
  const delB2 = await storage(`object/chat-attachments/${pathB}`, tokenB, { method: 'DELETE' })
  assert.equal(delB2.status, 200, 'owner cleanup')
})

// ── M7: finalize persists media metadata safely ───────────────

test('M7. finalize stores media metadata and rejects unknown media kinds', async () => {
  const thread = await createThread(tokenA, 'Media thread')
  const requestId = await reserve(tokenA, thread, 'image')
  const creditsAfterReserve = await wallet(tokenA)

  const path = `${IDA}/generated-output.png`
  const ok = await rpc(
    'finalize_chat_credit',
    {
      p_request_id: requestId,
      p_user_content: 'draw a cube',
      p_assistant_content: 'Here is the cube.',
      p_mode: 'image',
      p_media_path: path,
      p_media_kind: 'image_output',
    },
    tokenA,
  )
  assert.ok(ok.status === 200 || ok.status === 204, ok.text)
  assert.equal(await wallet(tokenA), creditsAfterReserve, 'finalize never mints credits')

  const hist = await rpc('get_chat_history', { p_limit: 10, p_conversation_id: thread }, tokenA)
  assert.equal(hist.status, 200, hist.text)
  const msgs = hist.json as Row[]
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].media_path, null, 'user message carries no output path')
  assert.equal(msgs[1].media_path, path, 'assistant message references the object')
  assert.equal(msgs[1].media_kind, 'image_output')
  assert.equal(msgs[1].mode, 'image')

  // Unknown media kinds are rejected by the finalize gate itself.
  const badRequest = await reserve(tokenA, thread, 'chat')
  const bad = await rpc(
    'finalize_chat_credit',
    {
      p_request_id: badRequest,
      p_user_content: 'x',
      p_assistant_content: 'y',
      p_media_path: `${IDA}/evil.mp4`,
      p_media_kind: 'video_output',
    },
    tokenA,
  )
  assert.notEqual(bad.status, 200, 'unknown media kind rejected')
  assert.match(String(bad.text), /Invalid media kind/i)

  const release = await rpc('release_chat_credit', { p_request_id: badRequest }, tokenA)
  assert.ok(release.status === 200 || release.status === 204, release.text)

  const finalHist = await rpc('get_chat_history', { p_limit: 10, p_conversation_id: thread }, tokenA)
  assert.equal((finalHist.json as Row[]).length, 2, 'rejected finalize wrote nothing')
})
