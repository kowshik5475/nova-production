import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildCorsHeaders, handlePreflight } from '../_shared/cors.ts'

// 0 = empty cell. Each puzzle has a unique valid solution.
const PUZZLES: { puzzle: number[]; solution: number[] }[] = [
  {
    puzzle: [
      5,3,0, 0,7,0, 0,0,0,
      6,0,0, 1,9,5, 0,0,0,
      0,9,8, 0,0,0, 0,6,0,
      8,0,0, 0,6,0, 0,0,3,
      4,0,0, 8,0,3, 0,0,1,
      7,0,0, 0,2,0, 0,0,6,
      0,6,0, 0,0,0, 2,8,0,
      0,0,0, 4,1,9, 0,0,5,
      0,0,0, 0,8,0, 0,7,9,
    ],
    solution: [
      5,3,4, 6,7,8, 9,1,2,
      6,7,2, 1,9,5, 3,4,8,
      1,9,8, 3,4,2, 5,6,7,
      8,5,9, 7,6,1, 4,2,3,
      4,2,6, 8,5,3, 7,9,1,
      7,1,3, 9,2,4, 8,5,6,
      9,6,1, 5,3,7, 2,8,4,
      2,8,7, 4,1,9, 6,3,5,
      3,4,5, 2,8,6, 1,7,9,
    ],
  },
  {
    puzzle: [
      0,0,0, 2,6,0, 7,0,1,
      6,8,0, 0,7,0, 0,9,0,
      1,9,0, 0,0,4, 5,0,0,
      8,2,0, 1,0,0, 0,4,0,
      0,0,4, 6,0,2, 9,0,0,
      0,5,0, 0,0,3, 0,2,8,
      0,0,9, 3,0,0, 0,7,4,
      0,4,0, 0,5,0, 0,3,6,
      7,0,3, 0,1,8, 0,0,0,
    ],
    solution: [
      4,3,5, 2,6,9, 7,8,1,
      6,8,2, 5,7,1, 4,9,3,
      1,9,7, 8,3,4, 5,6,2,
      8,2,6, 1,9,5, 3,4,7,
      3,7,4, 6,8,2, 9,1,5,
      9,5,1, 7,4,3, 6,2,8,
      5,1,9, 3,2,6, 8,7,4,
      2,4,8, 9,5,7, 1,3,6,
      7,6,3, 4,1,8, 2,5,9,
    ],
  },
  {
    puzzle: [
      0,0,0, 0,0,0, 0,0,0,
      0,0,0, 0,0,3, 0,8,5,
      0,0,1, 0,2,0, 0,0,0,
      0,0,0, 5,0,7, 0,0,0,
      0,0,4, 0,0,0, 1,0,0,
      0,9,0, 0,0,0, 0,0,0,
      5,0,0, 0,0,0, 0,7,3,
      0,0,2, 0,1,0, 0,0,0,
      0,0,0, 0,4,0, 0,0,9,
    ],
    solution: [
      9,8,7, 6,5,4, 3,2,1,
      2,4,6, 1,7,3, 9,8,5,
      3,5,1, 9,2,8, 7,4,6,
      1,2,8, 5,3,7, 6,9,4,
      6,3,4, 8,9,2, 1,5,7,
      7,9,5, 4,6,1, 8,3,2,
      5,1,9, 2,8,6, 4,7,3,
      4,7,2, 3,1,9, 5,6,8,
      8,6,3, 7,4,5, 2,1,9,
    ],
  },
]

function validateBoard(board: number[], solution: number[]): boolean {
  if (board.length !== 81) return false
  for (let i = 0; i < 81; i++) {
    if (board[i] < 1 || board[i] > 9) return false
    if (board[i] !== solution[i]) return false
  }
  return true
}

Deno.serve(async (request) => {
  const preflight = handlePreflight(request)
  if (preflight) return preflight
  const corsHeaders = buildCorsHeaders(request)
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders })
  }

  // Authenticate
  const authHeader = request.headers.get('Authorization')
  if (!authHeader) {
    return Response.json({ error: 'Authentication required' }, { status: 401, headers: corsHeaders })
  }

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

  const client = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })

  const { data: { user }, error: authError } = await client.auth.getUser()
  if (authError || !user) {
    return Response.json({ error: 'Invalid session' }, { status: 401, headers: corsHeaders })
  }

  try {
    const body = await request.json()
    const { action } = body

    // START - create a game session
    if (action === 'start') {
      const puzzleId = typeof body.puzzleId === 'number' ? body.puzzleId : Math.floor(Math.random() * PUZZLES.length)

      if (puzzleId < 0 || puzzleId >= PUZZLES.length) {
        return Response.json({ error: 'Invalid puzzle ID' }, { status: 400, headers: corsHeaders })
      }

      const { data: session, error: insertErr } = await client
        .from('game_sessions')
        .insert({ user_id: user.id, game_id: 'sudoku', status: 'STARTED' })
        .select('id')
        .single()

      if (insertErr) {
        return Response.json({ error: insertErr.message }, { status: 500, headers: corsHeaders })
      }

      return Response.json(
        {
          success: true,
          sessionId: session.id,
          puzzleId,
          puzzle: PUZZLES[puzzleId].puzzle,
        },
        { headers: corsHeaders },
      )
    }

    // COMPLETE - validate board and call atomic RPC
    if (action === 'complete') {
      const { sessionId, puzzleId, board } = body as {
        sessionId: string
        puzzleId: number
        board: number[]
      }

      if (!sessionId || puzzleId === undefined || !board) {
        return Response.json(
          { error: 'sessionId, puzzleId, and board are required' },
          { status: 400, headers: corsHeaders },
        )
      }

      if (puzzleId < 0 || puzzleId >= PUZZLES.length) {
        return Response.json({ error: 'Invalid puzzle ID' }, { status: 400, headers: corsHeaders })
      }

      if (!Array.isArray(board) || board.length !== 81) {
        return Response.json({ error: 'Board must be an array of 81 numbers' }, { status: 400, headers: corsHeaders })
      }

      // Validate against known solution
      const solution = PUZZLES[puzzleId].solution
      if (!validateBoard(board, solution)) {
        return Response.json(
          { error: 'Board does not match the puzzle solution' },
          { status: 400, headers: corsHeaders },
        )
      }

      // Stable idempotency key: session id is minted once at start and
      // reused for every retry of this same logical completion.
      const idempotencyKey = sessionId

      const { data, error: rpcErr } = await client.rpc('complete_sudoku_game', {
        p_session_id: sessionId,
        p_puzzle_id: puzzleId,
        p_idempotency_key: idempotencyKey,
      })

      if (rpcErr) {
        return Response.json({ error: rpcErr.message }, { status: 400, headers: corsHeaders })
      }

      const row = data?.[0]
      return Response.json(
        {
          success: true,
          outcome: 'win',
          awardedCoins: row?.awarded_coins ?? 0,
          awardedXp: row?.awarded_xp ?? 0,
          wallet: row ? { earned_coins: row.earned_coins, ai_credits: row.ai_credits } : null,
        },
        { headers: corsHeaders },
      )
    }

    return Response.json({ error: 'Unknown action' }, { status: 400, headers: corsHeaders })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    return Response.json({ error: message }, { status: 500, headers: corsHeaders })
  }
})
