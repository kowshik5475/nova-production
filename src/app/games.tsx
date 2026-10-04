import React from 'react'
import type { Session } from '@supabase/supabase-js'
import type { GameKey } from './types'

type WalletInfo = {
  earnedCoins: number
  aiCredits: number
  loading: boolean
  error: string | null
}

type GameCard = {
  key: GameKey
  index: string
  genre: string
  name: string
  blurb: string
  reward: string
}

const GAMES: GameCard[] = [
  {
    key: 'tictactoe',
    index: 'GAME 01',
    genre: 'STRATEGY',
    name: 'Tic-Tac-Toe',
    blurb: 'Outthink NOVA on a 3×3 grid.',
    reward: 'Win to earn 10 NOVA Coins + 25 XP',
  },
  {
    key: 'sudoku',
    index: 'GAME 02',
    genre: 'LOGIC',
    name: 'Sudoku',
    blurb: 'Fill the grid with pencil marks and patience.',
    reward: 'Solve to earn 20 NOVA Coins + 40 XP',
  },
  {
    key: 'ball-run',
    index: 'GAME 03',
    genre: 'REFLEX',
    name: 'Ball Run',
    blurb: 'Switch lanes and survive for 60 seconds.',
    reward: 'Survive 60s to earn 15 NOVA Coins + 30 XP',
  },
  {
    key: 'water-sort',
    index: 'GAME 04',
    genre: 'PUZZLE',
    name: 'Water Sort',
    blurb: 'Pour colour by colour until every tube is pure.',
    reward: 'Solve to earn 15 NOVA Coins + 35 XP',
  },
]

export default function Games({
  session,
  wallet,
  onSelect,
}: {
  session: Session | null
  wallet: WalletInfo
  onSelect: (game: GameKey) => void
}) {
  return (
    <>
      <p className="eyebrow">GAME HUB</p>
      <h1>Pick a game.</h1>
      <p className="lede">
        Every game pays NOVA Coins server-side. Exchange them for AI credits, then ask NOVA to
        review how you played.
        {wallet.loading ? '' : ` You currently hold ${wallet.earnedCoins} NOVA Coins.`}
      </p>

      <div className="hero-grid">
        {GAMES.map((game) => (
          <article className="insight-card game-card" key={game.key}>
            <p>
              {game.index} · {game.genre}
            </p>
            <h2>{game.name}</h2>
            <span>{game.blurb}</span>
            <small className="game-card-reward">{game.reward}</small>
            <button type="button" onClick={() => onSelect(game.key)}>
              {session ? 'Play now' : 'Sign in to play'}
            </button>
          </article>
        ))}
      </div>

      <div className="flow">
        <span>Play</span><b>→</b>
        <span>Earn Coins</span><b>→</b>
        <span>Exchange</span><b>→</b>
        <span>Chat</span>
      </div>
    </>
  )
}