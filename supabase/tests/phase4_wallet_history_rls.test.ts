// Phase 4 — wallet transaction history RLS runtime check
// Run: node --experimental-strip-types supabase/tests/phase4_wallet_history_rls.test.ts
// Uses existing Phase 2B test users only. Creates no permanent users.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const envPath = resolve(import.meta.dirname, '../../.env')
const envText = readFileSync(envPath, 'utf8')
const SUPABASE_URL = /VITE_SUPABASE_URL=(.+)/.exec(envText)?.[1]?.trim()
const ANON_KEY = /VITE_SUPABASE_ANON_KEY=(.+)/.exec(envText)?.[1]?.trim()
if (!SUPABASE_URL || !ANON_KEY) throw new Error('Missing Supabase env')

const emailA = 'p2busera@example.com'
const emailB = 'p2buserb@example.com'
const password = 'password123'

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

async function rest(path: string, token?: string) {
  const headers: Record<string, string> = { apikey: ANON_KEY! }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers })
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { status: res.status, json, text }
}

test('A reads only own wallet_transactions', async () => {
  const tokenA = await signIn(emailA)
  const own = await rest('wallet_transactions?select=id,user_id&limit=100', tokenA)
  assert.equal(own.status, 200)
  const rows = own.json as { user_id: string }[]
  assert.ok(Array.isArray(rows) && rows.length > 0, 'A has rows')
  const owners = new Set(rows.map((r) => r.user_id))
  assert.equal(owners.size, 1, 'single owner')
})

test('A cannot read B rows via user_id filter', async () => {
  const tokenA = await signIn(emailA)
  const tokenB = await signIn(emailB)
  const bProf = await rest('profiles?select=id&limit=1', tokenB)
  const bId = (bProf.json as { id: string }[])[0]?.id
  assert.ok(bId, 'B profile id')
  const cross = await rest(`wallet_transactions?select=id&user_id=eq.${bId}&limit=10`, tokenA)
  assert.equal(cross.status, 200)
  const rows = cross.json as unknown[]
  assert.equal(rows.length, 0, 'no cross-user rows')
})

test('unauthenticated cannot read wallet_transactions', async () => {
  const anon = await rest('wallet_transactions?select=id&limit=1')
  assert.ok(
    anon.status === 401 || anon.status === 403 || (anon.status === 200 && anon.text.trim() === '[]'),
    `status=${anon.status}`,
  )
  if (anon.status === 200) assert.equal(anon.text.trim(), '[]')
})

test('client cannot INSERT wallet_transactions', async () => {
  const tokenA = await signIn(emailA)
  const own = await rest('wallet_transactions?select=user_id&limit=1', tokenA)
  const userId = (own.json as { user_id: string }[])[0]?.user_id
  assert.ok(userId, 'user_id')
  const res = await fetch(`${SUPABASE_URL}/rest/v1/wallet_transactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: ANON_KEY!,
      Authorization: `Bearer ${tokenA}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      user_id: userId,
      type: 'GAME_REWARD',
      amount: 1,
      currency: 'NOVA_COIN',
    }),
  })
  assert.ok(
    res.status === 401 || res.status === 403 || res.status === 405 || res.status === 42501,
    `insert blocked status=${res.status}`,
  )
})
