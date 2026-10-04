import React, { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import type { Session } from '@supabase/supabase-js'

// Ball Run — reflex survival. The run is timed by the server: the client only
// says when to start, and the outcome, score and rewards are read back from
// complete_ball_run_game after the function derives elapsed time from
// game_sessions.started_at.

const LANES = 3
const TRACK_HEIGHT = 400
const BALL_Y = 352
const BALL_RADIUS = 16
const WALL_HEIGHT = 26
const WIN_MS = 60_000
const WIN_MESSAGE = 'Survive 60 seconds to earn 15 NOVA Coins + 30 XP.'

type Wall = { id: number; y: number; safeLane: number }

type Wallet = {
  earnedCoins: number
  aiCredits: number
  isDemo: boolean
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

type Phase = 'idle' | 'running' | 'submitting' | 'done'

export default function BallRun({
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
  const [lane, setLane] = useState(1)
  const [walls, setWalls] = useState<Wall[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [message, setMessage] = useState(WIN_MESSAGE)
  const [completedSessionId, setCompletedSessionId] = useState<string | null>(null)

  const laneRef = useRef(1)
  const startedAtRef = useRef<number | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const rafRef = useRef<number | null>(null)
  const lastTsRef = useRef<number | null>(null)
  const wallsRef = useRef<Wall[]>([])
  const spawnAccRef = useRef(0)
  const nextWallIdRef = useRef(1)
  const phaseRef = useRef<Phase>('idle')

  const setPhaseBoth = useCallback((next: Phase) => {
    phaseRef.current = next
    setPhase(next)
  }, [])

  const moveLane = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(LANES - 1, next))
    laneRef.current = clamped
    setLane(clamped)
  }, [])

  const finish = useCallback(
    async (reason: 'crash' | 'timeout') => {
      const sessionId = sessionIdRef.current
      if (!sessionId || !supabase || !session) return
      if (phaseRef.current !== 'running') return
      setPhaseBoth('submitting')
      startedAtRef.current = startedAtRef.current ?? Date.now()
      const survivedMs = Date.now() - startedAtRef.current
      try {
        const { data, error } = await supabase.functions.invoke('process-ball-run', {
          body: { action: 'complete', sessionId, survivedMs },
        })
        if (error) throw error
        // The server verdict is the only one that counts.
        const outcome = data?.outcome === 'win' ? 'win' : 'loss'
        setCompletedSessionId(sessionId)
        sessionIdRef.current = null
        setMessage(
          outcome === 'win'
            ? `Run complete — +${data.awardedCoins} NOVA Coins, +${data.awardedXp} XP.`
            : reason === 'timeout'
              ? 'Time is up. Survive the full 60 seconds next time.'
              : `You survived ${Math.floor(survivedMs / 1000)}s. Survive 60 seconds to earn the reward.`,
        )
        if (outcome === 'win') addToast('success', `Run cleared +${data.awardedCoins} coins +${data.awardedXp} XP`)
        void wallet.refresh()
        setPhaseBoth('done')
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Could not record the run'
        if (/too short|expired/i.test(msg)) {
          sessionIdRef.current = null
          setMessage(`${msg}. Start a fresh run to record one.`)
          setPhaseBoth('done')
        } else {
          addToast('error', msg)
          setPhaseBoth('done')
        }
      }
    },
    [addToast, session, setPhaseBoth, wallet],
  )

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    lastTsRef.current = null
  }, [])

  const tick = useCallback(
    function tickFn(ts: number) {
      if (phaseRef.current !== 'running') return
      const startedAt = startedAtRef.current
      if (startedAt === null) return
      const last = lastTsRef.current ?? ts
      lastTsRef.current = ts
      const dt = Math.min(0.05, (ts - last) / 1000)
      const elapsedMs = Date.now() - startedAt
      setElapsed(elapsedMs)

      let next = wallsRef.current
      spawnAccRef.current += dt
      const interval = Math.max(0.5, 1.0 - (elapsedMs / WIN_MS) * 0.4)
      if (spawnAccRef.current >= interval) {
        spawnAccRef.current = 0
        next = [
          ...next,
          { id: nextWallIdRef.current++, y: -WALL_HEIGHT, safeLane: Math.floor(Math.random() * LANES) },
        ]
      }

      const speed = 210 + (elapsedMs / WIN_MS) * 150
      next = next
        .map((wall) => ({ ...wall, y: wall.y + speed * dt }))
        .filter((wall) => wall.y < TRACK_HEIGHT + 40)
      wallsRef.current = next
      setWalls(next)

      const crashed = next.some(
        (wall) =>
          wall.safeLane !== laneRef.current &&
          wall.y <= BALL_Y + BALL_RADIUS &&
          wall.y + WALL_HEIGHT >= BALL_Y - BALL_RADIUS,
      )

      if (crashed) {
        stopLoop()
        setWalls([])
        wallsRef.current = []
        void finish('crash')
        return
      }
      if (elapsedMs >= WIN_MS) {
        stopLoop()
        setWalls([])
        wallsRef.current = []
        void finish('timeout')
        return
      }
      rafRef.current = requestAnimationFrame(tickFn)
    },
    [finish, stopLoop],
  )
  const startRun = useCallback(
    async () => {
      if (!supabase || !session) {
        setMessage('Sign in to record a run.')
        return
      }
      setWalls([])
      wallsRef.current = []
      setElapsed(0)
      moveLane(1)
      setCompletedSessionId(null)
      sessionIdRef.current = null
      setPhaseBoth('running')
      setMessage('Dodge the gaps. Survive 60 seconds.')
      try {
        const { data, error } = await supabase.functions.invoke('process-ball-run', {
          body: { action: 'start' },
        })
        if (error) throw error
        sessionIdRef.current = data.sessionId
        startedAtRef.current = Date.now()
        spawnAccRef.current = 0
        nextWallIdRef.current = 1
        lastTsRef.current = null
        rafRef.current = requestAnimationFrame(tick)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Could not start the run'
        addToast('error', msg)
        setPhaseBoth('idle')
        setMessage(WIN_MESSAGE)
      }
    },
    [addToast, moveLane, session, setPhaseBoth, tick],
  )

  useEffect(() => {
    if (phase !== 'running') return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'a') {
        event.preventDefault()
        moveLane(laneRef.current - 1)
      } else if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'd') {
        event.preventDefault()
        moveLane(laneRef.current + 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [moveLane, phase])

  useEffect(() => () => stopLoop(), [stopLoop])

  function restartGame() {
    stopLoop()
    setWalls([])
    wallsRef.current = []
    setElapsed(0)
    moveLane(1)
    setCompletedSessionId(null)
    sessionIdRef.current = null
    startedAtRef.current = null
    setPhaseBoth('idle')
    setMessage(WIN_MESSAGE)
  }

  const secondsLeft = Math.max(0, Math.ceil((WIN_MS - elapsed) / 1000))

  return (
    <div className="game-environment game-ball-run">
      <p className="eyebrow">GAME 03 · REFLEX</p>
      <h1>Ball Run</h1>
      <p className="lede">{WIN_MESSAGE}</p>

      <div className="game-layout">
        <div
          className={`br-track${phase === 'running' ? ' is-running' : ''}`}
          style={{ height: `${TRACK_HEIGHT}px` }}
          role="application"
          aria-label="Ball Run track"
        >
          {[0, 1, 2].map((index) => (
            <span key={index} className="br-lane" style={{ left: `${(index * 100) / 3}%` }} />
          ))}
          {walls.map((wall) => (
            <div key={wall.id} className="br-wall" style={{ top: `${wall.y}px` }}>
              {[0, 1, 2].map((index) => (
                <i key={index} className={index === wall.safeLane ? 'is-gap' : 'is-bar'} />
              ))}
            </div>
          ))}
          <span
            className="br-ball"
            style={{
              top: `${BALL_Y - BALL_RADIUS}px`,
              left: `calc(${(lane * 100) / 3 + 100 / 6}% - ${BALL_RADIUS}px)`,
            }}
          />
        </div>

        <article className="game-status" role="status" aria-live="polite" aria-atomic="true">
          <p className="status-label">
            {phase === 'running' ? `${secondsLeft}s left` : 'NOVA watches your run'}
          </p>
          {phase === 'submitting' && <p className="game-submitting">Recording run…</p>}
          <h2>{message}</h2>
          <p className="br-elapsed">{(elapsed / 1000).toFixed(1)}s survived</p>

          {phase === 'idle' && (
            <button type="button" onClick={() => void startRun()}>
              Start run
            </button>
          )}
          {(phase === 'running' || phase === 'submitting') && (
            <div className="br-lane-controls" role="group" aria-label="Move lane">
              {[0, 1, 2].map((index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => moveLane(index)}
                  disabled={phase !== 'running' || lane === index}
                  aria-label={`Lane ${index + 1}`}
                >
                  {index + 1}
                </button>
              ))}
            </div>
          )}
          {phase === 'done' && completedSessionId && onContinueToChat && (
            <button
              type="button"
              onClick={() => onContinueToChat(completedSessionId)}
            >
              Continue to Chat
            </button>
          )}
          {phase === 'done' && (
            <button type="button" onClick={restartGame}>
              New run
            </button>
          )}
        </article>
      </div>
    </div>
  )
}
