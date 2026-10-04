import React, { useCallback, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import type { Session } from '@supabase/supabase-js'

// Water Sort — the puzzle comes from the server (session_data) and the client
// only builds a move list. Completion is verified by replaying that list
// against the stored puzzle, so a hand-edited final board cannot pass.

const CAPACITY = 4
const PALETTE = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#14b8a6']

type Move = { from: number; to: number }
type Tubes = number[][]

function applyMove(tubes: Tubes, from: number, to: number): Tubes | null {
  if (from === to) return null
  if (from < 0 || to < 0 || from >= tubes.length || to >= tubes.length) return null
  const source = tubes[from]
  const target = tubes[to]
  if (source.length === 0) return null
  if (target.length >= CAPACITY) return null
  const top = source[source.length - 1]
  if (target.length > 0 && target[target.length - 1] !== top) return null
  let run = 0
  while (run < source.length && source[source.length - 1 - run] === top) run += 1
  const movable = Math.min(run, CAPACITY - target.length)
  if (movable <= 0) return null
  const next = tubes.map((tube) => tube.slice())
  for (let i = 0; i < movable; i += 1) next[to].push(next[from].pop() as number)
  return next
}

function isSolved(tubes: Tubes): boolean {
  return tubes.every(
    (tube) =>
      tube.length === 0 ||
      (tube.length === CAPACITY && tube.every((ball) => ball === tube[0])),
  )
}

type Wallet = {
  earnedCoins: number
  aiCredits: number
  isDemo: boolean
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

type Phase = 'idle' | 'playing' | 'submitting' | 'done'

const IDLE_MESSAGE = 'Sort every tube so each holds one colour. Solve to earn 15 NOVA Coins + 35 XP.'

export default function WaterSort({
  session,
  wallet,
  addToast,
  onContinueToChat,
}: {
  session: Session | null
  wallet: Wallet
  addToast: (kind: 'success' | 'error', text: string) => void
  onContinueToChat?: (sessionId: string) => void
}) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [tubes, setTubes] = useState<Tubes>([])
  const [moves, setMoves] = useState<Move[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [message, setMessage] = useState(IDLE_MESSAGE)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [completedSessionId, setCompletedSessionId] = useState<string | null>(null)
  const [par, setPar] = useState<number>(24)

  const startGame = useCallback(async () => {
    if (!supabase || !session) {
      setMessage('Sign in to record a solve.')
      return
    }
    setPhase('playing')
    setMessage('Tap a tube to lift its top colour, then tap where to pour.')
    setSelected(null)
    setMoves([])
    setCompletedSessionId(null)
    try {
      const { data, error } = await supabase.functions.invoke('process-water-sort', {
        body: { action: 'start', colors: 4 },
      })
      if (error) throw error
      setSessionId(data.sessionId)
      setTubes((data.tubes as Tubes) ?? [])
      setPar(typeof data.par === 'number' ? data.par : 24)
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : 'Could not start the puzzle')
      setPhase('idle')
      setMessage(IDLE_MESSAGE)
    }
  }, [addToast, session])

  const submit = useCallback(
    async (finalMoves: Move[]) => {
      if (!supabase || !session || !sessionId) return
      setPhase('submitting')
      try {
        const { data, error } = await supabase.functions.invoke('process-water-sort', {
          body: { action: 'complete', sessionId, moves: finalMoves },
        })
        if (error) throw error
        setCompletedSessionId(sessionId)
        setMessage(
          `Solved in ${data.moves} moves (+${data.awardedCoins} NOVA Coins, +${data.awardedXp} XP).`,
        )
        addToast('success', `Puzzle solved +${data.awardedCoins} coins +${data.awardedXp} XP`)
        void wallet.refresh()
        setPhase('done')
      } catch (err) {
        addToast('error', err instanceof Error ? err.message : 'Could not record the solve')
        setPhase('done')
      }
    },
    [addToast, session, sessionId, wallet],
  )

  function tapTube(index: number) {
    if (phase !== 'playing') return
    if (selected === null) {
      if (tubes[index].length === 0) return
      setSelected(index)
      return
    }
    if (selected === index) {
      setSelected(null)
      return
    }
    const next = applyMove(tubes, selected, index)
    if (!next) {
      setSelected(index)
      return
    }
    const nextMoves = [...moves, { from: selected, to: index }]
    setSelected(null)
    setTubes(next)
    setMoves(nextMoves)
    if (isSolved(next)) void submit(nextMoves)
  }

  function restartGame() {
    setPhase('idle')
    setTubes([])
    setMoves([])
    setSelected(null)
    setSessionId(null)
    setCompletedSessionId(null)
    setMessage(IDLE_MESSAGE)
  }

  return (
    <div className="game-environment game-water-sort">
      <p className="eyebrow">GAME 04 · PUZZLE</p>
      <h1>Water Sort</h1>
      <p className="lede">{IDLE_MESSAGE}</p>

      <div className="game-layout">
        <div className="ws-board" role="group" aria-label="Water Sort tubes">
          {tubes.map((tube, index) => (
            <button
              key={index}
              type="button"
              className={`ws-tube${selected === index ? ' is-selected' : ''}`}
              onClick={() => tapTube(index)}
              disabled={phase !== 'playing'}
              aria-label={`Tube ${index + 1} with ${tube.length} balls`}
              aria-pressed={selected === index}
            >
              <span className="ws-tube-body">
                {tube.map((color, position) => (
                  <span
                    key={position}
                    className="ws-ball"
                    style={{ background: PALETTE[color % PALETTE.length] }}
                  />
                ))}
              </span>
              <span className="ws-tube-base" />
            </button>
          ))}
          {tubes.length === 0 && <p className="ws-empty">Press start to deal a puzzle.</p>}
        </div>

        <article className="game-status" role="status" aria-live="polite" aria-atomic="true">
          <p className="status-label">
            {phase === 'playing' ? `${moves.length} moves · par ${par}` : 'NOVA shuffled the tubes'}
          </p>
          {phase === 'submitting' && <p className="game-submitting">Recording solve…</p>}
          <h2>{message}</h2>
          {phase === 'idle' && (
            <button type="button" onClick={() => void startGame()}>
              Start puzzle
            </button>
          )}
          {phase === 'playing' && (
            <button type="button" onClick={() => setSelected(null)}>
              Clear selection
            </button>
          )}
          {phase === 'done' && completedSessionId && onContinueToChat && (
            <button type="button" onClick={() => onContinueToChat(completedSessionId)}>
              Continue to Chat
            </button>
          )}
          {phase === 'done' && (
            <button type="button" onClick={restartGame}>
              New puzzle
            </button>
          )}
        </article>
      </div>
    </div>
  )
}
