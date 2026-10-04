import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildCorsHeaders, handlePreflight } from '../_shared/cors.ts'
import { isValidUuid, validateTttBoard } from '../_shared/tictactoe_validate.ts'

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers })
}

Deno.serve(async (request) => {
  const preflight = handlePreflight(request)
  if (preflight) return preflight
  const cors = buildCorsHeaders(request)

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, cors)
  }

  // ── Authenticate ──────────────────────────────────────────
  const authHeader = request.headers.get('Authorization')
  if (!authHeader) {
    return json({ error: 'Authentication required' }, 401, cors)
  }

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

  const client = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })

  const {
    data: { user },
    error: authError,
  } = await client.auth.getUser()
  if (authError || !user) {
    return json({ error: 'Invalid session' }, 401, cors)
  }

  try {
    const body = await request.json()
    const { action } = body

    // ════════════════════════════════════════════════════════
    //  START — create a game_sessions row
    // ════════════════════════════════════════════════════════
    if (action === 'start') {
      const { data: session, error: insertErr } = await client
        .from('game_sessions')
        .insert({ user_id: user.id, game_id: 'tictactoe', status: 'STARTED' })
        .select('id')
        .single()

      if (insertErr) {
        return json({ error: insertErr.message }, 500, cors)
      }
      return json({ success: true, sessionId: session.id }, 200, cors)
    }

    // ════════════════════════════════════════════════════════
    //  COMPLETE — validate board server-side, then atomic RPC
    // ════════════════════════════════════════════════════════
    if (action === 'complete') {
      const { sessionId, board } = body as {
        sessionId?: unknown
        board?: unknown
      }

      if (!isValidUuid(sessionId)) {
        return json({ error: 'sessionId must be a valid UUID' }, 400, cors)
      }
      if (board === undefined || board === null) {
        return json({ error: 'board is required' }, 400, cors)
      }

      // Server derives the outcome — never trust a client "winner" claim.
      const validation = validateTttBoard(board)
      if (!validation.ok) {
        return json({ error: validation.error }, 400, cors)
      }
      const outcome = validation.outcome

      // Session must belong to this user and be a live tictactoe session.
      const { data: sessionRow, error: sessionErr } = await client
        .from('game_sessions')
        .select('id, user_id, game_id, status')
        .eq('id', sessionId)
        .maybeSingle()

      if (sessionErr) {
        return json({ error: 'Failed to load session' }, 400, cors)
      }
      if (!sessionRow || sessionRow.user_id !== user.id) {
        return json({ error: 'Invalid or unauthorized session' }, 400, cors)
      }
      if (sessionRow.game_id !== 'tictactoe') {
        return json({ error: 'Session is not a Tic-Tac-Toe game' }, 400, cors)
      }
      if (sessionRow.status !== 'STARTED') {
        return json({ error: 'Session already completed or abandoned' }, 400, cors)
      }

      // Stable idempotency key: the session id is minted once at start
      // and reused for every retry of this same logical completion.
      const idempotencyKey = sessionId

      const { data, error: rpcErr } = await client.rpc('complete_tictactoe_game', {
        p_session_id: sessionId,
        p_outcome: outcome,
        p_idempotency_key: idempotencyKey,
      })

      if (rpcErr) {
        return json({ error: rpcErr.message }, 400, cors)
      }

      const row = data?.[0]
      return json(
        {
          success: true,
          outcome,
          awardedCoins: row?.awarded_coins ?? 0,
          awardedXp: row?.awarded_xp ?? 0,
          wallet: row
            ? { earned_coins: row.earned_coins, ai_credits: row.ai_credits }
            : null,
        },
        200,
        cors,
      )
    }

    return json({ error: 'Unknown action' }, 400, cors)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    return json({ error: message }, 500, cors)
  }
})
