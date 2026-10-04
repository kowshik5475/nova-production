import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildCorsHeaders, handlePreflight } from '../_shared/cors.ts'
import {
  generatePuzzle,
  randomSeed,
  replayMoves,
  type Tubes,
} from '../_shared/watersort_validate.ts'

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers })
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isTubes(value: unknown): value is Tubes {
  return (
    Array.isArray(value) &&
    value.length >= 3 &&
    value.length <= 10 &&
    value.every((tube) => Array.isArray(tube) && tube.every((b) => typeof b === 'number'))
  )
}

Deno.serve(async (request) => {
  const preflight = handlePreflight(request)
  if (preflight) return preflight
  const cors = buildCorsHeaders(request)

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, cors)
  }

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
    //  START — the server generates and solves-checks the puzzle
    // ════════════════════════════════════════════════════════
    if (action === 'start') {
      const requested = typeof body.colors === 'number' ? body.colors : 4
      const puzzle = generatePuzzle(randomSeed(), requested)

      const { data: session, error: insertErr } = await client
        .from('game_sessions')
        .insert({
          user_id: user.id,
          game_id: 'water-sort',
          status: 'STARTED',
          session_data: {
            tubes: puzzle.tubes,
            colors: puzzle.colors,
            par: puzzle.par,
          },
        })
        .select('id')
        .single()

      if (insertErr) {
        return json({ error: insertErr.message }, 500, cors)
      }

      return json(
        {
          success: true,
          sessionId: session.id,
          tubes: puzzle.tubes,
          colors: puzzle.colors,
          par: puzzle.par,
        },
        200,
        cors,
      )
    }

    // ════════════════════════════════════════════════════════
    //  COMPLETE — replay the claimed move list against the stored puzzle
    // ════════════════════════════════════════════════════════
    if (action === 'complete') {
      const { sessionId, moves } = body as { sessionId?: unknown; moves?: unknown }

      if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
        return json({ error: 'sessionId must be a valid UUID' }, 400, cors)
      }

      const { data: sessionRow, error: sessionErr } = await client
        .from('game_sessions')
        .select('id, user_id, game_id, status, session_data')
        .eq('id', sessionId)
        .maybeSingle()

      if (sessionErr) {
        return json({ error: 'Failed to load session' }, 400, cors)
      }
      if (!sessionRow || sessionRow.user_id !== user.id) {
        return json({ error: 'Invalid or unauthorized session' }, 400, cors)
      }
      if (sessionRow.game_id !== 'water-sort') {
        return json({ error: 'Session is not a Water Sort game' }, 400, cors)
      }
      if (sessionRow.status !== 'STARTED') {
        return json({ error: 'Session already completed or abandoned' }, 400, cors)
      }

      const stored = sessionRow.session_data as { tubes?: unknown } | null
      if (!stored || !isTubes(stored.tubes)) {
        return json({ error: 'Session has no puzzle' }, 400, cors)
      }

      const replay = replayMoves(stored.tubes as Tubes, moves)
      if (!replay.ok) {
        return json({ error: replay.error }, 400, cors)
      }
      if (!replay.solved) {
        return json({ error: 'Puzzle is not solved yet' }, 400, cors)
      }

      const idempotencyKey = sessionId
      const { data, error: rpcErr } = await client.rpc('complete_water_sort_game', {
        p_session_id: sessionId,
        p_move_count: replay.moves,
        p_idempotency_key: idempotencyKey,
        // The database replays the same list again before it will pay out,
        // so a direct RPC call cannot claim an unearned win.
        p_moves: moves as Array<{ from: number; to: number }>,
      })

      if (rpcErr) {
        return json({ error: rpcErr.message }, 400, cors)
      }

      const row = data?.[0]
      return json(
        {
          success: true,
          outcome: 'win',
          moves: replay.moves,
          score: row?.score ?? 100,
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
