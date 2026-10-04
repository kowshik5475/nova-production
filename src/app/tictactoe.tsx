import React, { useCallback, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import type { Session } from '@supabase/supabase-js'

type Mark = 'X' | 'O' | null

const winningLines = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]]
const emptyBoard: Mark[] = Array(9).fill(null)

function getWinner(board: Mark[]) {
  const line = winningLines.find(([a, b, c]) => board[a] && board[a] === board[b] && board[a] === board[c])
  return line ? board[line[0]] : null
}

function getComputerMove(board: Mark[]) {
  const open = board.map((cell, index) => (cell ? null : index)).filter((index): index is number => index !== null)
  for (const mark of ['O', 'X'] as const) {
    const winningMove = open.find((index) => { const next = [...board]; next[index] = mark; return getWinner(next) === mark })
    if (winningMove !== undefined) return winningMove
  }
  return open.includes(4) ? 4 : open[0]
}

type Wallet = {
  earnedCoins: number
  aiCredits: number
  isDemo: boolean
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  exchangeCoins: () => Promise<void>
}

export default function TicTacToe({ session, wallet, addToast, onContinueToChat }: { session: Session | null; wallet: Wallet; addToast: (kind: 'success' | 'error', text: string) => void; onContinueToChat?: (sessionId: string) => void }) {
  const [board, setBoard] = useState<Mark[]>(emptyBoard)
  const [gameMessage, setGameMessage] = useState('Win to earn 10 NOVA Coins + 25 XP.')
  const [gameEnded, setGameEnded] = useState(false)
  const [gameSubmitting, setGameSubmitting] = useState(false)
  const [completedSessionId, setCompletedSessionId] = useState<string | null>(null)

  const gameSessionIdRef = useRef<string | null>(null)
  const gameSessionReadyRef = useRef<Promise<string | null>>(Promise.resolve(null))

  const gameResult = useMemo(() => getWinner(board), [board])
  const statusVariant = !gameEnded
    ? ''
    : gameResult === 'X'
      ? 'is-victory'
      : gameResult === 'O'
        ? 'is-defeat'
        : 'is-draw'

  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (!supabase || !session) return null
    if (gameSessionIdRef.current) return gameSessionIdRef.current
    try {
      const { data, error } = await supabase.functions.invoke('process-tictactoe', {
        body: { action: 'start' },
      })
      if (error) throw error
      gameSessionIdRef.current = data.sessionId
      return data.sessionId
    } catch {
      return null
    }
  }, [session])

  const completeGame = useCallback(async (finalBoard: Mark[]) => {
    if (!supabase || !session) return
    setGameSubmitting(true)
    try {
      const sessionId = gameSessionIdRef.current
      if (!sessionId) return
      const { data, error } = await supabase.functions.invoke('process-tictactoe', {
        body: { action: 'complete', sessionId, board: finalBoard },
      })
      if (error) throw error
      // Result recorded by the server: this round may now hand off to Chat.
      setCompletedSessionId(sessionId)
      if (data.outcome === 'win') {
        addToast('success', `Won ${data.awardedCoins} coins + ${data.awardedXp} XP`)
        wallet.refresh()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not record game result'
      addToast('error', msg)
    } finally {
      setGameSubmitting(false)
    }
  }, [session, wallet, addToast])

  function restartGame() {
    setBoard(emptyBoard)
    setGameEnded(false)
    setGameMessage('Win to earn 10 NOVA Coins + 25 XP.')
    setCompletedSessionId(null)
    gameSessionIdRef.current = null
    gameSessionReadyRef.current = Promise.resolve(null)
  }

  function playMove(index: number) {
    if (board[index] || gameEnded || gameSubmitting) return

    const playerBoard = [...board]; playerBoard[index] = 'X'
    const playerWon = getWinner(playerBoard) === 'X'
    const playerDraw = !playerWon && playerBoard.every(Boolean)

    if (playerWon) {
      setBoard(playerBoard); setGameEnded(true)
      setGameMessage('Victory! +10 NOVA Coins, +25 XP.')
      gameSessionReadyRef.current = ensureSession()
      gameSessionReadyRef.current.then(() => completeGame(playerBoard))
      return
    }
    if (playerDraw) {
      setBoard(playerBoard); setGameEnded(true)
      setGameMessage('Draw! Win the next round to earn coins + XP.')
      gameSessionReadyRef.current = ensureSession()
      gameSessionReadyRef.current.then(() => completeGame(playerBoard))
      return
    }

    gameSessionReadyRef.current = ensureSession()

    const computerMove = getComputerMove(playerBoard)
    if (computerMove === undefined) return
    playerBoard[computerMove] = 'O'
    const computerWon = getWinner(playerBoard) === 'O'
    const draw = !computerWon && playerBoard.every(Boolean)
    setBoard(playerBoard)

    if (computerWon || draw) setGameEnded(true)
    if (computerWon) {
      setGameMessage('NOVA wins this round. Try again for the reward!')
      gameSessionReadyRef.current.then(() => completeGame(playerBoard))
    }
    if (draw) {
      setGameMessage('Draw! Win the next round to earn coins + XP.')
      gameSessionReadyRef.current.then(() => completeGame(playerBoard))
    }
  }

  return (
    <div className="game-environment game-tictactoe">
      <p className="eyebrow">GAME 01 · STRATEGY</p>
      <h1>Tic-Tac-Toe</h1>
      <p className="lede">You are X. Win to earn 10 NOVA Coins + 25 XP.</p>
      <div className="game-layout">
        <div className="board" role="group" aria-label="Tic-Tac-Toe board">
          {board.map((cell, index) => {
            const row = Math.floor(index / 3) + 1
            const col = (index % 3) + 1
            return (
              <button
                key={index}
                type="button"
                className={cell ? `is-filled mark-${cell.toLowerCase()}` : 'is-empty'}
                onClick={() => playMove(index)}
                disabled={Boolean(cell) || gameEnded || gameSubmitting}
                aria-label={`Row ${row}, Column ${col}${cell ? `, ${cell}` : ', empty'}${cell ? ', filled' : ', empty cell, place mark'}`}
              >
                {cell ? <span className="mark" aria-hidden="true">{cell}</span> : null}
              </button>
            )
          })}
        </div>
        <article
          className={`game-status${statusVariant ? ` ${statusVariant}` : ''}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <p className="status-label">{gameResult ? `${gameResult} completed the line` : 'NOVA plays as O'}</p>
          {gameSubmitting && <p className="game-submitting">Recording result…</p>}
          <h2>{gameMessage}</h2>
          {completedSessionId && onContinueToChat && (
            <button type="button" onClick={() => onContinueToChat(completedSessionId)} disabled={gameSubmitting}>
              Continue to Chat
            </button>
          )}
          <button type="button" onClick={restartGame} disabled={gameSubmitting}>New round</button>
        </article>
      </div>
    </div>
  )
}
