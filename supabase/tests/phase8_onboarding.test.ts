// Phase 8 — new-user display-name onboarding tests
// Run: node --experimental-strip-types supabase/tests/phase8_onboarding.test.ts
// Static + validation + runtime checks. Creates no permanent users.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')

const appSrc = readFileSync(resolve(root, 'src/app/App.tsx'), 'utf8')
const onboardingSrc = readFileSync(resolve(root, 'src/app/onboarding.tsx'), 'utf8')
const supabaseSrc = readFileSync(resolve(root, 'src/lib/supabase.ts'), 'utf8')
const useProfileSrc = readFileSync(resolve(root, 'src/lib/supabase/useProfile.ts'), 'utf8')
const profileSrc = readFileSync(resolve(root, 'src/app/profile.tsx'), 'utf8')
const clientSrc = readFileSync(resolve(root, 'src/lib/supabase/client.ts'), 'utf8')

const envText = readFileSync(resolve(root, '.env'), 'utf8')
const SUPABASE_URL = /VITE_SUPABASE_URL=(.+)/.exec(envText)?.[1]?.trim()
const ANON_KEY = /VITE_SUPABASE_ANON_KEY=(.+)/.exec(envText)?.[1]?.trim()
if (!SUPABASE_URL || !ANON_KEY) throw new Error('Missing Supabase env')

const emailA = 'p2busera@example.com'
const password = 'password123'

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

async function rpcUpdateName(token: string, p_display_name: string) {
  return rest('rpc/update_own_display_name', token, {
    method: 'POST',
    body: JSON.stringify({ p_display_name }),
  })
}

async function getOwnProfile(token: string) {
  const own = await rest('profiles?select=id,display_name&limit=1', token)
  assert.equal(own.status, 200)
  return (own.json as { id: string; display_name: string }[])[0]
}

// ── Detection helpers (mirrors App gate logic) ───────────────

function needsOnboarding(displayName: string | null | undefined): boolean {
  return !(displayName ?? '').trim().length > 0
}

// ── Static / unit ────────────────────────────────────────────

test('1. Complete profile bypasses onboarding', () => {
  assert.equal(needsOnboarding('Ada Lovelace'), false)
  assert.equal(needsOnboarding('Player'), false)
  assert.equal(needsOnboarding('  x  '), false)
})

test('2. NULL display_name requires onboarding', () => {
  assert.equal(needsOnboarding(null), true)
  assert.equal(needsOnboarding(undefined), true)
})

test('3. Empty display_name requires onboarding', () => {
  assert.equal(needsOnboarding(''), true)
})

test('4. Whitespace display_name requires onboarding', () => {
  assert.equal(needsOnboarding('   '), true)
  assert.equal(needsOnboarding('\t\n'), true)
})

test('6. Invalid empty name rejected', () => {
  assert.equal(validateDisplayName('').ok, false)
  assert.equal(validateDisplayName('   ').ok, false)
})

test('7. Overlong name rejected', () => {
  assert.equal(validateDisplayName('x'.repeat(DISPLAY_NAME_MAX_LENGTH + 1)).ok, false)
  const ok = validateDisplayName('x'.repeat(DISPLAY_NAME_MAX_LENGTH))
  assert.ok(ok.ok)
})

test('8. Onboarding uses existing update_own_display_name RPC', () => {
  assert.match(onboardingSrc, /update_own_display_name/)
  assert.match(onboardingSrc, /p_display_name/)
  assert.match(onboardingSrc, /validateDisplayName/)
})

test('9. No direct client UPDATE to profiles introduced', () => {
  assert.doesNotMatch(onboardingSrc, /from\(['"]profiles['"]\)\s*\.\s*(update|upsert)/)
  assert.doesNotMatch(onboardingSrc, /\.update\(/)
  // Phase 7/6 suites still cover absence of broad UPDATE policies.
  const migrations = readdirSync(resolve(root, 'supabase/migrations'))
  const phase8 = migrations.filter((f) => f.includes('phase8'))
  assert.equal(phase8.length, 0, 'no phase8 migration expected')
})

test('10. Demo mode unaffected — onboarding gated on supabaseClient + session', () => {
  // Gate must require both supabaseClient and session (demo has neither configured).
  // App.tsx formats the condition across multiple lines.
  const normalized = appSrc.replace(/\s+/g, ' ')
  assert.match(
    normalized,
    /supabaseClient && session && !needsPasswordReset && profileStatus === 'ready' && !profile\.displayName\.trim\(\)/,
  )
  // Onboarding is not rendered in demo path (no supabase → earlier gates skip to shell).
  assert.match(useProfileSrc, /!supabase \|\| !session/)
})

test('12. Successful save updates local profile state via refresh', () => {
  assert.match(onboardingSrc, /onComplete/)
  assert.match(appSrc, /refreshProfile/)
  assert.match(useProfileSrc, /setProfile\(/)
})

test('5/11. Onboarding component has save states and error handling', () => {
  assert.match(onboardingSrc, /'saving'/)
  assert.match(onboardingSrc, /'error'/)
  assert.match(onboardingSrc, /'success'/)
  assert.match(onboardingSrc, /role="alert"/)
  assert.match(onboardingSrc, /Could not save display name/)
  assert.match(onboardingSrc, /Session expired|session expired|sign in again/i)
})

test('static. Gates ordered: loading → recovery → sign-in → profile check → onboarding → shell', () => {
  // Match gate conditions, not destructured identifiers at the top of App().
  const authLoading = appSrc.indexOf('if (authLoading)')
  const recovery = appSrc.indexOf('if (supabaseClient && needsPasswordReset)')
  const signInGate = appSrc.indexOf('if (supabaseClient && !session)')
  const profileLoading = appSrc.indexOf("profileStatus === 'loading'")
  const profileError = appSrc.indexOf("profileStatus === 'error'")
  const onboarding = appSrc.indexOf('<Onboarding')
  const shell = appSrc.indexOf('const appClass')
  assert.ok(authLoading >= 0 && recovery > authLoading, 'recovery after authLoading')
  assert.ok(signInGate > recovery, 'signIn after recovery')
  assert.ok(profileLoading > signInGate, 'profile loading after signIn')
  assert.ok(profileError > profileLoading, 'profile error after loading')
  assert.ok(onboarding > profileError, 'onboarding after profile error')
  assert.ok(shell > onboarding, 'shell after onboarding')
})

test('static. signUp seeds empty display_name metadata for new users', () => {
  assert.match(supabaseSrc, /signUp/)
  assert.match(supabaseSrc, /display_name/)
  assert.match(supabaseSrc, /options:\s*\{\s*data:/)
})

test('static. onboarding copy matches spec', () => {
  assert.match(onboardingSrc, /WELCOME TO NOVA/)
  assert.match(onboardingSrc, /Choose your display name to get started/)
  assert.match(onboardingSrc, /Continue/)
})

test('static. no native alert/confirm in onboarding', () => {
  assert.doesNotMatch(onboardingSrc, /alert\(/)
  assert.doesNotMatch(onboardingSrc, /confirm\(/)
})

test('static. no second display-name mechanism in onboarding', () => {
  // Must not invent a new RPC or direct update path.
  assert.doesNotMatch(onboardingSrc, /rpc\(['"](?!update_own_display_name)/)
  assert.doesNotMatch(onboardingSrc, /SUPABASE_SERVICE_ROLE/i)
})

// ── Runtime ──────────────────────────────────────────────────

test('runtime. Existing user has non-empty display_name (bypasses onboarding)', async () => {
  const token = await signIn(emailA)
  const row = await getOwnProfile(token)
  assert.ok(row.display_name.trim().length > 0, `expected non-empty, got ${JSON.stringify(row.display_name)}`)
})

test('runtime. update_own_display_name saves and returns trimmed name (reuse Phase 6 path)', async () => {
  const token = await signIn(emailA)
  const original = await getOwnProfile(token)
  const next = `Phase8 ${Date.now() % 100000}`
  const res = await rpcUpdateName(token, `  ${next}  `)
  assert.equal(res.status, 200, res.text)
  assert.equal(res.json, next, 'RPC returns trimmed value')
  const after = await getOwnProfile(token)
  assert.equal(after.display_name, next)
  // restore
  const back = await rpcUpdateName(token, original.display_name)
  assert.equal(back.status, 200)
  const restored = await getOwnProfile(token)
  assert.equal(restored.display_name, original.display_name)
})

test('runtime. RPC rejects empty/whitespace (onboarding cannot complete invalid)', async () => {
  const token = await signIn(emailA)
  const res = await rpcUpdateName(token, '   ')
  assert.ok(res.status >= 400, `status=${res.status}`)
})

test('runtime. Anonymous cannot call onboarding RPC', async () => {
  const res = await rpcUpdateName('', 'New Name')
  assert.ok(res.status === 401 || res.status === 403 || res.status === 400, `status=${res.status}`)
})

test('runtime. Direct REST PATCH cannot set display_name (no client UPDATE policy)', async () => {
  const token = await signIn(emailA)
  const original = await getOwnProfile(token)
  const res = await rest(`profiles?id=eq.${original.id}`, token, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ display_name: 'Bypassed' }),
  })
  if (res.status === 200 || res.status === 204) {
    const rows = Array.isArray(res.json) ? res.json : []
    assert.equal(rows.length, 0, 'no rows updated')
  } else {
    assert.ok(res.status === 403 || res.status === 404 || res.status === 42501, `status=${res.status}`)
  }
  const after = await getOwnProfile(token)
  assert.equal(after.display_name, original.display_name)
})

test('13. Refresh/session restoration: completed profile not re-triggered (gate is displayName-based)', async () => {
  // After save, display_name is non-empty → needsOnboarding false → no onboarding on reload.
  const token = await signIn(emailA)
  const row = await getOwnProfile(token)
  assert.equal(needsOnboarding(row.display_name), false)
  // Gate source references displayName from useProfile, not localStorage/session flags.
  assert.doesNotMatch(appSrc, /localStorage/)
  assert.doesNotMatch(appSrc, /sessionStorage\['nova_onboarding/)
  assert.match(useProfileSrc, /display_name/)
})

test('static. profile.tsx Phase 6 path untouched by onboarding', () => {
  assert.match(profileSrc, /update_own_display_name/)
  assert.match(profileSrc, /validateDisplayName/)
})

test('static. client still anon-only (no service-role leak via onboarding)', () => {
  assert.doesNotMatch(clientSrc, /SERVICE_ROLE/i)
  assert.doesNotMatch(onboardingSrc, /SERVICE_ROLE/i)
})
