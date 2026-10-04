// Phase 6 — display-name editing security + static tests
// Run: node --experimental-strip-types supabase/tests/phase6_display_name.test.ts
// Uses existing Phase 2B test users only. Creates no permanent users.
// Restores original display names after tests.

import assert from 'node:assert/strict'
import { test } from 'node:test'
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

const profileSrc = readFileSync(resolve(root, 'src/app/profile.tsx'), 'utf8')
const migrationSrc = readFileSync(
  resolve(root, 'supabase/migrations/20260924000004_phase6_update_own_display_name.sql'),
  'utf8',
)

const { validateDisplayName, DISPLAY_NAME_MAX_LENGTH } = (await import('../../src/app/utils.ts')) as {
  validateDisplayName: (raw: string) => { ok: true; value: string } | { ok: false; error: string }
  DISPLAY_NAME_MAX_LENGTH: number
}

async function signIn(email: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY! },
    body: JSON.stringify({ email, password }),
  })
  assert.ok(res.ok, `sign-in ${email}: ${res.status}`)
  const body = (await res.json()) as { access_token: string }
  assert.ok(body.access_token, 'access token present')
  return body.access_token
}

async function rest(path: string, token?: string, init?: RequestInit) {
  const headers: Record<string, string> = { apikey: ANON_KEY!, 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } })
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { status: res.status, json, text }
}

async function rpcUpdateName(token: string, p_display_name: string) {
  return rest('rpc/update_own_display_name', token, {
    method: 'POST',
    body: JSON.stringify({ p_display_name }),
  })
}

async function getProfile(token: string) {
  const own = await rest('profiles?select=id,display_name,xp,level,streak&limit=1', token)
  assert.equal(own.status, 200)
  return (own.json as { id: string; display_name: string; xp: number; level: number; streak: number }[])[0]
}

const originalNames = new Map<string, string>()

async function captureOriginal(email: string) {
  const token = await signIn(email)
  const row = await getProfile(token)
  originalNames.set(email, row.display_name)
  return { token, row }
}

// ── Static / validation ──────────────────────────────────────

test('validation: empty and whitespace-only rejected', () => {
  assert.equal(validateDisplayName('').ok, false)
  assert.equal(validateDisplayName('   ').ok, false)
})

test('validation: trims leading/trailing whitespace', () => {
  const r = validateDisplayName('  Ada Lovelace  ')
  assert.ok(r.ok)
  if (r.ok) assert.equal(r.value, 'Ada Lovelace')
})

test('validation: max length enforced (not silently truncated)', () => {
  assert.equal(DISPLAY_NAME_MAX_LENGTH, 50)
  const ok = validateDisplayName('x'.repeat(50))
  assert.ok(ok.ok)
  const bad = validateDisplayName('x'.repeat(51))
  assert.equal(bad.ok, false)
})

test('validation: normal Unicode names accepted', () => {
  const r = validateDisplayName('Zoë José 李雷')
  assert.ok(r.ok)
})

test('static: profile UI uses validateDisplayName and update_own_display_name', () => {
  assert.match(profileSrc, /validateDisplayName/)
  assert.match(profileSrc, /update_own_display_name/)
  assert.match(profileSrc, /p_display_name/)
  assert.match(profileSrc, /Cancel/)
  assert.match(profileSrc, /Saving/)
  assert.match(profileSrc, /Display name updated/)
})

test('static: migration is narrow — only display_name, SECURITY DEFINER, grants', () => {
  assert.match(migrationSrc, /update_own_display_name/)
  assert.match(migrationSrc, /security definer/i)
  assert.match(migrationSrc, /set search_path = public/i)
  assert.match(migrationSrc, /auth\.uid\(\)/)
  assert.match(migrationSrc, /set display_name = v_name/)
  assert.doesNotMatch(migrationSrc, /set xp\s*=/i)
  assert.doesNotMatch(migrationSrc, /set level\s*=/i)
  assert.doesNotMatch(migrationSrc, /set streak\s*=/i)
  assert.doesNotMatch(migrationSrc, /for update using \(true\)/i)
  assert.match(migrationSrc, /grant execute.*authenticated/)
  assert.match(migrationSrc, /revoke all.*anon/)
})

test('static: no broad profiles UPDATE policy in phase 6 sources', () => {
  assert.doesNotMatch(migrationSrc, /for update\s+using\s*\(true\)/i)
  assert.doesNotMatch(migrationSrc, /for all\s+using\s*\(true\)/i)
})

// ── Runtime RLS / RPC (requires migration applied) ───────────

test('A. User A can update own display name via RPC', async () => {
  const { token, row } = await captureOriginal(emailA)
  const next = `Phase6 A ${Date.now() % 100000}`
  const res = await rpcUpdateName(token, next)
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json, next)
  const after = await getProfile(token)
  assert.equal(after.display_name, next)
  originalNames.set(emailA, next)
  // restore immediately for later suites
  const restore = await rpcUpdateName(token, row.display_name)
  assert.equal(restore.status, 200)
  originalNames.set(emailA, row.display_name)
})

test('B. User A cannot UPDATE User B profile via REST', async () => {
  const { token: tokenA } = await captureOriginal(emailA)
  const { token: tokenB, row: rowB } = await captureOriginal(emailB)
  const res = await rest(`profiles?id=eq.${rowB.id}`, tokenA, {
    method: 'PATCH',
    headers: { 'Prefer': 'return=representation' },
    body: JSON.stringify({ display_name: 'Hacked By A' }),
  })
  // No UPDATE policy → 403/404/42501 or 0 rows
  assert.ok(res.status === 403 || res.status === 404 || res.status === 42501 || res.status === 204 || res.status === 200, `status=${res.status}`)
  if (res.status === 200 || res.status === 204) {
    const rows = Array.isArray(res.json) ? res.json : []
    assert.equal(rows.length, 0, 'no rows updated')
  }
  const bNow = await getProfile(tokenB)
  assert.equal(bNow.display_name, rowB.display_name, 'B name unchanged')
})

test('C. User A cannot modify XP via REST profile update', async () => {
  const { token, row } = await captureOriginal(emailA)
  const res = await rest(`profiles?id=eq.${row.id}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ xp: row.xp + 9999 }),
  })
  assert.ok(res.status === 403 || res.status === 404 || res.status === 42501 || res.status === 204 || res.status === 200, `status=${res.status}`)
  const after = await getProfile(token)
  assert.equal(after.xp, row.xp, 'xp unchanged')
})

test('D. User A cannot modify level via REST profile update', async () => {
  const { token, row } = await captureOriginal(emailA)
  await rest(`profiles?id=eq.${row.id}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ level: 999 }),
  })
  const after = await getProfile(token)
  assert.equal(after.level, row.level, 'level unchanged')
})

test('E. User A cannot modify streak via REST profile update', async () => {
  const { token, row } = await captureOriginal(emailA)
  await rest(`profiles?id=eq.${row.id}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ streak: 999 }),
  })
  const after = await getProfile(token)
  assert.equal(after.streak, row.streak, 'streak unchanged')
})

test('E2. Display-name RPC does not change xp/level/streak', async () => {
  const { token, row } = await captureOriginal(emailA)
  const next = `Phase6 SEC ${Date.now() % 100000}`
  const res = await rpcUpdateName(token, next)
  assert.equal(res.status, 200, res.text)
  const after = await getProfile(token)
  assert.equal(after.display_name, next)
  assert.equal(after.xp, row.xp)
  assert.equal(after.level, row.level)
  assert.equal(after.streak, row.streak)
  const back = await rpcUpdateName(token, row.display_name)
  assert.equal(back.status, 200)
  originalNames.set(emailA, row.display_name)
})

test('F. Anonymous user cannot update profile or call RPC', async () => {
  const anonPatch = await rest('profiles?id=neq.00000000-0000-0000-0000-000000000000', undefined, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ display_name: 'anon' }),
  })
  // No UPDATE policy: either rejected or 200 with zero rows affected.
  if (anonPatch.status === 200 || anonPatch.status === 204) {
    const rows = Array.isArray(anonPatch.json) ? anonPatch.json : []
    assert.equal(rows.length, 0, 'anon PATCH must not update any rows')
  } else {
    assert.ok(
      anonPatch.status === 401 || anonPatch.status === 403 || anonPatch.status === 404,
      `patch status=${anonPatch.status}`,
    )
  }

  const anonRpc = await rpcUpdateName('', 'anon')
  assert.ok(
    anonRpc.status === 401 || anonRpc.status === 403 || anonRpc.status === 400,
    `rpc status=${anonRpc.status}`,
  )
})

test('F2. RPC rejects empty display name', async () => {
  const { token } = await captureOriginal(emailA)
  const res = await rpcUpdateName(token, '   ')
  assert.ok(res.status >= 400, `status=${res.status}`)
})

test('G. Unrelated profile fields remain protected (no client UPDATE policy)', async () => {
  const { token, row } = await captureOriginal(emailA)
  const forgedXp = 999999
  const forgedLevel = 999
  const res = await rest(`profiles?id=eq.${row.id}`, token, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ display_name: 'Should Fail', xp: forgedXp, level: forgedLevel }),
  })
  if (res.status === 200 || res.status === 204) {
    const rows = Array.isArray(res.json) ? res.json : []
    assert.equal(rows.length, 0, 'no rows returned from blocked UPDATE')
  } else {
    assert.ok(
      res.status === 403 || res.status === 404 || res.status === 42501,
      `status=${res.status}`,
    )
  }
  const after = await getProfile(token)
  assert.equal(after.display_name, row.display_name, 'display_name not writable via REST')
  assert.notEqual(after.xp, forgedXp, 'xp not writable via REST')
  assert.notEqual(after.level, forgedLevel, 'level not writable via REST')
})

// Final restore (in case earlier tests left a temp name)
test('cleanup: restore original display names', async () => {
  for (const email of [emailA, emailB] as const) {
    const token = await signIn(email)
    const original = originalNames.get(email)
    assert.ok(original, `captured name for ${email}`)
    const res = await rpcUpdateName(token, original)
    assert.equal(res.status, 200, res.text)
    const after = await getProfile(token)
    assert.equal(after.display_name, original)
  }
})
