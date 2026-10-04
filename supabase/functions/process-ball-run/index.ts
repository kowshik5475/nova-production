import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildCorsHeaders, handlePreflight } from '../_shared/cors.ts'
import { claimMatchesServer, evaluateRun, BALL_RUN_WIN_MS } from '../_shared/ballrun_validate.ts'

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers })
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
    //  START — create a game_sessions row; the seed is informational only
    // ════════════════════════════════════════════════════════
    if (action === 'start') {
      const { data: session, error: insertErr } = await client
        .from('game_sessions')
        .insert({
          user_id: user.id,
          game_id: 'ball-run',
          status: 'STARTED',
          session_data: { seed: crypto.getRandomValues(new Uint32Array(1))[0] },
        })
        .select('id, started_at')
        .single()

      if (insertErr) {
        return json({ error: insertErr.message }, 500, cors)
      }
      return json(
        {
          success: true,
          sessionId: session.id,
          winMs: BALL_RUN_WIN_MS,
          maxMs: 120_000,
        },
        200,
        cors,
      )
    }

    // ════════════════════════════════════════════════════════
    //  COMPLETE — the server derives elapsed time, score and outcome
    // ════════════════════════════════════════════════════════
    if (action === 'complete') {
      const { sessionId, survivedMs } = body as { sessionId?: unknown; survivedMs?: unknown }

      if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
        return json({ error: 'sessionId must be a valid UUID' }, 400, cors)
      }

      const { data: sessionRow, error: sessionErr } = await client
        .from('game_sessions')
        .select('id, user_id, game_id, status, started_at')
        .eq('id', sessionId)
        .maybeSingle()

      if (sessionErr) {
        return json({ error: 'Failed to load session' }, 400, cors)
      }
      if (!sessionRow || sessionRow.user_id !== user.id) {
        return json({ error: 'Invalid or unauthorized session' }, 400, cors)
      }
      if (sessionRow.game_id !== 'ball-run') {
        return json({ error: 'Session is not a Ball Run game' }, 400, cors)
      }
      if (sessionRow.status !== 'STARTED') {
        return json({ error: 'Session already completed or abandoned' }, 400, cors)
      }

      const startedMs = Date.parse(sessionRow.started_at)
      const verdict = evaluateRun(startedMs, Date.now())
      if (!verdict.ok) {
        return json({ error: verdict.error }, 400, cors)
      }

      // The claim is only a consistency check — the score comes from the
      // server clock. A wildly wrong claim is rejected, never trusted.
      if (survivedMs !== undefined && !claimMatchesServer(survivedMs, verdict.elapsedMs)) {
        return json({ error: 'Reported duration does not match the server clock' }, 400, cors)
      }

      const idempotencyKey = sessionId
      const { data, error: rpcErr } = await client.rpc('complete_ball_run_game', {
        p_session_id: sessionId,
        p_idempotency_key: idempotencyKey,
      })

      if (rpcErr) {
        return json({ error: rpcErr.message }, 400, cors)
      }

      const row = data?.[0]
      return json(
        {
          success: true,
          outcome: verdict.outcome,
          score: row?.score ?? verdict.score,
          durationMs: verdict.elapsedMs,
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
