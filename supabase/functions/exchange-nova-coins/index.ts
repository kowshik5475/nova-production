import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildCorsHeaders, handlePreflight } from '../_shared/cors.ts'

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers })
}

Deno.serve(async (request) => {
  const preflight = handlePreflight(request)
  if (preflight) return preflight
  const cors = buildCorsHeaders(request)

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors)

  const authHeader = request.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Authentication required' }, 401, cors)

  const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  })
  const {
    data: { user },
    error: authError,
  } = await client.auth.getUser()
  if (authError || !user) return json({ error: 'Invalid session' }, 401, cors)

  const { idempotencyKey } = await request.json()
  if (!idempotencyKey)
    return json({ error: 'idempotencyKey is required' }, 400, cors)
  const { data, error } = await client.rpc('exchange_nova_coins', {
    p_coin_amount: 10,
    p_idempotency_key: idempotencyKey,
  })
  if (error) return json({ error: error.message }, 400, cors)
  return json(
    {
      success: true,
      wallet: { earned_coins: data?.[0]?.nova_coins, ai_credits: data?.[0]?.ai_credits },
    },
    200,
    cors,
  )
})
