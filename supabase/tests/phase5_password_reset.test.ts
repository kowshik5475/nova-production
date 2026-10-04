// Phase 5 — password reset static/unit tests (no real email delivery).
// Run: node --experimental-strip-types supabase/tests/phase5_password_reset.test.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')

function read(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8')
}

const supabaseSrc = read('src/lib/supabase.ts')
const authSrc = read('src/app/auth.tsx')
const appSrc = read('src/app/App.tsx')
const utilsSrc = read('src/app/utils.ts')

const { isValidEmail, validateNewPassword } = (await import('../../src/app/utils.ts')) as {
  isValidEmail: (email: string) => boolean
  validateNewPassword: (password: string, confirm: string) => string | null
}

test('1. Forgot-password UI is reachable from sign-in', () => {
  assert.match(authSrc, /Forgot password\?/)
  assert.match(authSrc, /'forgot'/)
  assert.match(authSrc, /goForgot/)
})

test('2. Empty email is rejected', () => {
  assert.equal(isValidEmail(''), false)
  assert.equal(isValidEmail('   '), false)
})

test('3. Invalid email is handled', () => {
  assert.equal(isValidEmail('not-an-email'), false)
  assert.equal(isValidEmail('a@b'), false)
  assert.equal(isValidEmail('a@b.c'), true)
  assert.equal(isValidEmail('user@example.com'), true)
})

test('4. Valid reset request calls Supabase resetPasswordForEmail', () => {
  assert.match(supabaseSrc, /resetPasswordForEmail/)
  assert.match(supabaseSrc, /window\.location\.origin/)
  assert.match(authSrc, /resetPasswordForEmail/)
})

test('5. Reset-request success is neutral (no enumeration)', () => {
  assert.match(authSrc, /If an account exists for this email/)
  assert.doesNotMatch(authSrc, /does not exist/i)
  assert.doesNotMatch(supabaseSrc, /email not found/i)
})

test('6. Password mismatch is rejected', () => {
  assert.ok(validateNewPassword('secret1', 'secret2'))
  assert.match(validateNewPassword('secret1', 'secret2')!, /match/i)
  assert.ok(validateNewPassword('short', 'short'))
  assert.equal(validateNewPassword('secret1', 'secret1'), null)
  assert.ok(utilsSrc.includes('validateNewPassword'))
})

test('6a. Recovery URL detection handles type=recovery', () => {
  assert.match(supabaseSrc, /urlIndicatesPasswordRecovery/)
  assert.match(supabaseSrc, /type === 'recovery'/)
  assert.match(supabaseSrc, /PASSWORD_RECOVERY/)
})

test('6b. Recovery flag uses sessionStorage only (set/clear)', () => {
  assert.match(supabaseSrc, /nova_password_recovery/)
  assert.match(supabaseSrc, /writeRecoveryFlag/)
  assert.match(supabaseSrc, /readRecoveryFlag/)
  assert.match(supabaseSrc, /completePasswordReset/)
  assert.match(supabaseSrc, /sessionStorage\.removeItem|sessionStorage\.setItem/)
})

test('7/8. Password-update success and failure handled', () => {
  assert.match(authSrc, /Password updated successfully/)
  assert.match(authSrc, /Continue to NOVA/)
  assert.match(authSrc, /Could not update password/)
  assert.match(supabaseSrc, /updateUser\(\{ password \}\)/)
  assert.match(supabaseSrc, /friendlyAuthError/)
})

test('9/10. Existing sign-in and sign-up remain in AuthGate', () => {
  assert.match(authSrc, /await signIn/)
  assert.match(authSrc, /await signUp/)
  assert.match(authSrc, /'signin'/)
  assert.match(authSrc, /'signup'/)
  assert.match(supabaseSrc, /signInWithPassword/)
  assert.match(supabaseSrc, /auth\.signUp/)
})

test('11. Logout remains available (signOut not removed)', () => {
  assert.match(supabaseSrc, /signOut/)
  assert.match(appSrc, /signOut/)
})

test('Security: no password stored in localStorage; recovery flag is sessionStorage only', () => {
  assert.doesNotMatch(supabaseSrc, /localStorage/)
  assert.doesNotMatch(authSrc, /localStorage/)
  assert.match(supabaseSrc, /sessionStorage/)
  assert.match(supabaseSrc, /nova_password_recovery/)
})

test('Security: no password/token logging', () => {
  assert.doesNotMatch(supabaseSrc, /console\.(log|debug|info|warn|error).*password/i)
  assert.doesNotMatch(authSrc, /console\.(log|debug|info).*password/i)
  assert.doesNotMatch(supabaseSrc, /console\.log.*access_token/i)
  assert.doesNotMatch(authSrc, /console\.log.*reset/i)
})

test('Security: PASSWORD_RECOVERY handled via existing single auth listener', () => {
  assert.match(supabaseSrc, /PASSWORD_RECOVERY/)
  assert.equal(
    (supabaseSrc.match(/onAuthStateChange/g) ?? []).length,
    1,
    'exactly one onAuthStateChange subscription',
  )
})

test('App gates recovery before normal shell', () => {
  assert.match(appSrc, /needsPasswordReset/)
  assert.match(appSrc, /initialMode="reset"/)
})

test('No schema/migration/RLS changes in phase 5 sources', () => {
  assert.ok(!supabaseSrc.includes('create table'))
  assert.ok(!supabaseSrc.includes('drop policy'))
  assert.ok(!authSrc.includes('create table'))
})
