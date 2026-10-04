import React, { useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import type { Session } from '@supabase/supabase-js'

type Wallet = {
  earnedCoins: number
  aiCredits: number
  isDemo: boolean
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  exchangeCoins: () => Promise<void>
}

type SudokuPuzzle = { puzzle: number[]; solution: number[] }
const SUDOKU_PUZZLES: SudokuPuzzle[] = [
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

function sudokuConflicts(board: number[], idx: number): boolean {
  const v = board[idx]
  if (v === 0) return false
  const r = Math.floor(idx / 9), c = idx % 9
  const br = Math.floor(r / 3) * 3, bc = Math.floor(c / 3) * 3
  for (let i = 0; i < 9; i++) {
    const ri = r * 9 + i, ci = i * 9 + c
    if ((ri !== idx && board[ri] === v) || (ci !== idx && board[ci] === v)) return true
  }
  for (let dr = 0; dr < 3; dr++)
    for (let dc = 0; dc < 3; dc++) {
      const bi = (br + dr) * 9 + (bc + dc)
      if (bi !== idx && board[bi] === v) return true
    }
  return false
}

function isSudokuFull(board: number[]): boolean {
  for (let i = 0; i < 81; i++) if (board[i] === 0) return false
  return true
}

function formatSudokuTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function Sudoku({ session, wallet, addToast, onContinueToChat }: { session: Session | null; wallet: Wallet; addToast: (kind: 'success' | 'error', text: string) => void; onContinueToChat?: (sessionId: string) => void }) {
  const [sudokuPage, setSudokuPage] = useState<'menu' | 'game'>('menu')
  const [sudokuPuzzleId, setSudokuPuzzleId] = useState(0)
  const [sudokuBoard, setSudokuBoard] = useState<number[]>([])
  const [sudokuLocked, setSudokuLocked] = useState<boolean[]>([])
  const [sudokuSelected, setSudokuSelected] = useState<number | null>(null)
  const [sudokuMistakes, setSudokuMistakes] = useState(0)
  const [sudokuCompleted, setSudokuCompleted] = useState(false)
  const [sudokuTimer, setSudokuTimer] = useState(0)
  const sudokuTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sudokuSessionIdRef = useRef<string | null>(null)
  const [sudokuSubmitting, setSudokuSubmitting] = useState(false)
  const [completedSessionId, setCompletedSessionId] = useState<string | null>(null)

  function stopSudokuTimer() {
    if (sudokuTimerRef.current) { clearInterval(sudokuTimerRef.current); sudokuTimerRef.current = null }
  }

  useEffect(() => {
    return () => stopSudokuTimer()
  }, [])

  function startSudokuGame(puzzleId?: number) {
    const id = puzzleId ?? Math.floor(Math.random() * SUDOKU_PUZZLES.length)
    const p = SUDOKU_PUZZLES[id]
    setSudokuPuzzleId(id)
    setSudokuBoard([...p.puzzle])
    setSudokuLocked(p.puzzle.map((v) => v !== 0))
    setSudokuSelected(null)
    setSudokuMistakes(0)
    setSudokuCompleted(false)
    setSudokuTimer(0)
    setSudokuPage('game')
    setSudokuSubmitting(false)
    setCompletedSessionId(null)
    sudokuSessionIdRef.current = null

    if (sudokuTimerRef.current) clearInterval(sudokuTimerRef.current)
    sudokuTimerRef.current = setInterval(() => setSudokuTimer((t) => t + 1), 1000)

    if (session && supabase) {
      supabase.functions.invoke('process-sudoku', { body: { action: 'start', puzzleId: id } })
        .then(({ data, error }) => {
          if (!error && data?.sessionId) sudokuSessionIdRef.current = data.sessionId
        })
        .catch(() => {})
    }
  }

  // Auto-complete check
  useEffect(() => {
    if (sudokuPage !== 'game' || sudokuCompleted || sudokuBoard.length === 0) return
    if (isSudokuFull(sudokuBoard)) {
      const sol = SUDOKU_PUZZLES[sudokuPuzzleId].solution
      const correct = sudokuBoard.every((v, i) => v === sol[i])
      if (correct) {
        setSudokuCompleted(true)
        stopSudokuTimer()
        if (session && supabase && sudokuSessionIdRef.current) {
          setSudokuSubmitting(true)
          supabase.functions.invoke('process-sudoku', {
            body: {
              action: 'complete',
              sessionId: sudokuSessionIdRef.current,
              puzzleId: sudokuPuzzleId,
              board: sudokuBoard,
            },
          }).then(({ data, error }) => {
            if (!error && data?.success) {
              // Result recorded by the server: this puzzle may now hand off to Chat.
              setCompletedSessionId(sudokuSessionIdRef.current)
              addToast('success', `Puzzle solved! +${data.awardedCoins} coins +${data.awardedXp} XP`)
              wallet.refresh()
            }
          }).catch(() => {}).finally(() => setSudokuSubmitting(false))
        } else {
          addToast('success', 'Puzzle solved! (Demo — no rewards)')
        }
      }
    }
  }, [sudokuBoard, sudokuCompleted, sudokuPage, sudokuPuzzleId, session, wallet, addToast])

  function placeSudokuNumber(num: number) {
    if (sudokuCompleted || sudokuSelected === null || sudokuLocked[sudokuSelected] || sudokuSubmitting) return
    const newBoard = [...sudokuBoard]
    newBoard[sudokuSelected] = num
    if (num !== 0 && num !== SUDOKU_PUZZLES[sudokuPuzzleId].solution[sudokuSelected]) {
      setSudokuMistakes((m) => m + 1)
    }
    setSudokuBoard(newBoard)
  }

  function clearSudokuCell() {
    placeSudokuNumber(0)
  }

  // Keyboard handler
  useEffect(() => {
    if (sudokuPage !== 'game' || sudokuCompleted) return
    function onKey(e: KeyboardEvent) {
      if (e.key >= '1' && e.key <= '9') placeSudokuNumber(parseInt(e.key))
      if (e.key === '0' || e.key === 'Backspace' || e.key === 'Delete') clearSudokuCell()
      if (e.key === 'ArrowUp' && sudokuSelected !== null) { e.preventDefault(); setSudokuSelected((s) => s !== null && s >= 9 ? s - 9 : s) }
      if (e.key === 'ArrowDown' && sudokuSelected !== null) { e.preventDefault(); setSudokuSelected((s) => s !== null && s < 72 ? s + 9 : s) }
      if (e.key === 'ArrowLeft' && sudokuSelected !== null) { e.preventDefault(); setSudokuSelected((s) => s !== null && s % 9 > 0 ? s - 1 : s) }
      if (e.key === 'ArrowRight' && sudokuSelected !== null) { e.preventDefault(); setSudokuSelected((s) => s !== null && s % 9 < 8 ? s + 1 : s) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // Keyboard handler intentionally omits placeSudokuNumber/clearSudokuCell:
    // they close over the current board/selection and must be fresh each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sudokuPage, sudokuCompleted, sudokuSelected, sudokuBoard, sudokuLocked])

  if (sudokuPage === 'menu') {
    return (
      <div className="game-environment game-sudoku">
        <p className="eyebrow">SUDOKU</p>
        <h1>Sudoku</h1>
        <p className="lede">Fill every row, column, and 3×3 box with the digits 1–9. Complete a puzzle to earn 20 NOVA Coins and 40 XP.</p>
        <div className="sudoku-puzzle-grid" role="group" aria-label="Choose a puzzle">
          {SUDOKU_PUZZLES.map((p, i) => (
            <button
              key={i}
              type="button"
              className="puzzle-card"
              onClick={() => startSudokuGame(i)}
              aria-label={`Puzzle ${i + 1}, ${p.puzzle.filter((v) => v === 0).length} empty cells`}
            >
              <span className="puzzle-label" aria-hidden="true">Puzzle {i + 1}</span>
              <span className="puzzle-hint" aria-hidden="true">{p.puzzle.filter((v) => v === 0).length} empty cells</span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={`game-environment game-sudoku${sudokuCompleted ? ' is-completed' : ''}`}>
      <p className="eyebrow">SUDOKU — PUZZLE {sudokuPuzzleId + 1}</p>
      <div className="sudoku-header">
        <div className="sudoku-stat">
          <span className="stat-label">Time</span>
          <span className="stat-value">{formatSudokuTime(sudokuTimer)}</span>
        </div>
        <div className={`sudoku-stat mistakes${sudokuMistakes === 0 ? ' is-zero' : ''}`}>
          <span className="stat-label">Mistakes</span>
          <span className={`stat-value${sudokuMistakes === 0 ? ' is-zero' : ''}`}>{sudokuMistakes}</span>
        </div>
        {sudokuCompleted && (
          <div className="sudoku-stat completed-badge">
            <span className="stat-label">Status</span>
            <span className="stat-value">Solved!</span>
          </div>
        )}
      </div>

      {/* Live announcements: completion + mistakes/conflicts (not the ticking timer) */}
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {sudokuCompleted
          ? `Puzzle solved in ${formatSudokuTime(sudokuTimer)} with ${sudokuMistakes} mistake${sudokuMistakes === 1 ? '' : 's'}.`
          : `Mistakes: ${sudokuMistakes}.`}
      </div>
      {sudokuBoard.some((v, i) => v !== 0 && sudokuConflicts(sudokuBoard, i)) && (
        <div className="visually-hidden" role="alert" aria-live="assertive">
          Conflict error on the board. Check the highlighted cell.
        </div>
      )}

      <div className="sudoku-board" role="group" aria-label="Sudoku board">
        {sudokuBoard.map((val, idx) => {
          const isLocked = sudokuLocked[idx]
          const isSelected = sudokuSelected === idx
          const hasConflict = val !== 0 && sudokuConflicts(sudokuBoard, idx)
          const sameNumber = sudokuSelected !== null && sudokuBoard[sudokuSelected] !== 0 && val === sudokuBoard[sudokuSelected] && sudokuSelected !== idx
          const row = Math.floor(idx / 9), col = idx % 9
          const borderClasses = [
            col % 3 === 0 && col > 0 ? 'box-left' : '',
            row % 3 === 0 && row > 0 ? 'box-top' : '',
          ].filter(Boolean).join(' ')
          const stateBits = [
            isLocked ? 'fixed given number' : 'editable',
            isSelected ? 'selected' : '',
            sameNumber ? 'same number as selected' : '',
            hasConflict ? 'conflict error' : '',
          ].filter(Boolean).join(', ')
          return (
            <button
              key={idx}
              type="button"
              className={[
                'sudoku-cell',
                isLocked ? 'locked' : '',
                isSelected ? 'selected' : '',
                hasConflict ? 'conflict' : '',
                sameNumber ? 'same-number' : '',
                borderClasses,
              ].filter(Boolean).join(' ')}
              onClick={() => !sudokuCompleted && setSudokuSelected(idx)}
              aria-label={`Row ${row + 1}, Column ${col + 1}${val ? `, ${val}` : ', empty'}, ${stateBits}`}
              aria-pressed={isSelected}
              aria-invalid={hasConflict || undefined}
              aria-disabled={sudokuCompleted || undefined}
              aria-readonly={isLocked || undefined}
              data-state={stateBits}
            >
              {val !== 0 ? val : ''}
            </button>
          )
        })}
      </div>

      <div className="sudoku-controls">
        <div className="sudoku-numpad" role="group" aria-label="Number pad">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
            <button
              key={n}
              type="button"
              className="numpad-btn"
              onClick={() => placeSudokuNumber(n)}
              disabled={sudokuCompleted || sudokuSubmitting}
              aria-label={`Enter ${n}`}
            >
              {n}
            </button>
          ))}
          <button
            type="button"
            className="numpad-btn erase"
            onClick={clearSudokuCell}
            disabled={sudokuCompleted || sudokuSubmitting}
            aria-label="Erase number"
          >
            ×
          </button>
        </div>
        <div className="sudoku-actions">
          {completedSessionId && onContinueToChat && (
            <button
              type="button"
              className="btn secondary"
              onClick={() => onContinueToChat(completedSessionId)}
              disabled={sudokuSubmitting}
            >
              Continue to Chat
            </button>
          )}
          <button type="button" className="btn secondary" onClick={() => { stopSudokuTimer(); setSudokuPage('menu') }}>
            Quit
          </button>
          <button type="button" className="btn secondary" onClick={() => startSudokuGame(sudokuPuzzleId)} disabled={sudokuSubmitting}>
            New Puzzle
          </button>
        </div>
      </div>
    </div>
  )
}
