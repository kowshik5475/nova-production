import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase/client'
import type { Page } from './types'
import type { ProfileInfo } from '@/lib/supabase/useProfile'
import { formatDate } from './utils'
import { Leaderboard } from './profile'
import {
  HOME_GAME_IDS,
  describeAchievements,
  gameLabel,
  mapActivityRows,
  summarizeAchievements,
  type HomeAchievementSummary,
  type HomeActivityRow,
} from './home-data'

type WalletInfo = {
  earnedCoins: number
  aiCredits: number
  isDemo: boolean
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

type SectionState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error' }

type ProgressRow = {
  game_id: string
  games_played: number
  games_won: number
  best_score: number | null
  total_xp: number
}

type ProgressionProps = {
  session: Session | null
  wallet: WalletInfo
  profile: ProfileInfo
  isDemo: boolean
  setPage: (page: Page) => void
  onRefreshProfile: () => Promise<unknown>
}

function winRate(row: ProgressRow): string {
  if (row.games_played <= 0) return '—'
  return `${Math.round((row.games_won / row.games_played) * 100)}%`
}

export default function Progression({
  session,
  wallet,
  profile,
  isDemo,
  setPage,
  onRefreshProfile,
}: ProgressionProps) {
  const { level, xp } = profile
  const progress = xp % 100

  const [progressRows, setProgressRows] = useState<SectionState<ProgressRow[]>>({ status: 'loading' })
  const [achievements, setAchievements] = useState<SectionState<HomeAchievementSummary>>({
    status: 'loading',
  })
  const [activity, setActivity] = useState<SectionState<HomeActivityRow[]>>({ status: 'loading' })
  const mountedRef = useRef(true)
  const runRef = useRef(0)
  const refreshRef = useRef(onRefreshProfile)

  useEffect(() => {
    refreshRef.current = onRefreshProfile
  })

  const load = useCallback(async () => {
    await Promise.resolve()
    if (!supabase || !session) return
    const run = ++runRef.current
    setProgressRows({ status: 'loading' })
    setAchievements({ status: 'loading' })
    setActivity({ status: 'loading' })
    try {
      const userId = session.user.id
      const [progressRes, achievementRes, results, rewards] = await Promise.all([
        supabase
          .from('game_progress')
          .select('game_id, games_played, games_won, best_score, total_xp')
          .eq('user_id', userId)
          .order('game_id'),
        supabase
          .from('achievements')
          .select('id, name, target_type, user_achievements(user_id, earned_at)')
          .order('id'),
        supabase
          .from('game_results')
          .select('id, session_id, game_id, outcome, created_at')
          .eq('user_id', userId)
          .in('game_id', [...HOME_GAME_IDS])
          .order('created_at', { ascending: false })
          .limit(5),
        supabase
          .from('wallet_transactions')
          .select('reference_id, amount')
          .eq('user_id', userId)
          .eq('type', 'GAME_REWARD')
          .order('created_at', { ascending: false })
          .limit(10),
      ])
      if (runRef.current !== run) return
      if (progressRes.error) throw progressRes.error
      if (achievementRes.error) throw achievementRes.error
      if (results.error) throw results.error
      if (rewards.error) throw rewards.error
      setProgressRows({ status: 'ready', data: (progressRes.data ?? []) as ProgressRow[] })
      setAchievements({
        status: 'ready',
        data: summarizeAchievements(achievementRes.data ?? [], userId),
      })
      setActivity({ status: 'ready', data: mapActivityRows(results.data ?? [], rewards.data ?? []) })
    } catch {
      if (runRef.current !== run) return
      setProgressRows({ status: 'error' })
      setAchievements({ status: 'error' })
      setActivity({ status: 'error' })
    }
  }, [session])

  useEffect(() => {
    mountedRef.current = true
    if (!session) {
      return () => {
        mountedRef.current = false
      }
    }
    async function run() {
      await Promise.resolve()
      if (!mountedRef.current) return
      void refreshRef.current()
      void load()
    }
    void run()
    return () => {
      mountedRef.current = false
    }
  }, [session, load])

  return (
    <>
      <p className="eyebrow">PROGRESSION</p>
      <h1>How you are doing, {profile.displayName || 'Player'}.</h1>
      <p className="lede">
        Levels, streaks and achievements are written by the server after every completed game.
        {isDemo ? ' Sign in to load your real progression.' : ''}
      </p>

      <div className="hero-grid">
        <article className="primary-card">
          <p>LEVEL {level}</p>
          <strong>{xp} XP</strong>
          <div className="progress"><i style={{ width: `${progress}%` }} /></div>
          <small>{100 - progress} XP to Level {level + 1}</small>
        </article>
        <article className="insight-card">
          <p>DAY STREAK</p>
          <h2>{profile.streak}</h2>
          <span>Consecutive active days</span>
        </article>
        <article className="insight-card">
          <p>NOVA COINS</p>
          <h2>{wallet.error ? '—' : wallet.earnedCoins}</h2>
          <span>Earned by winning games</span>
          <button type="button" onClick={() => setPage('wallet')}>View wallet</button>
        </article>
        <article className="insight-card">
          <p>AI CREDITS</p>
          <h2>{wallet.error ? '—' : wallet.aiCredits}</h2>
          <span>Each credit powers one chat</span>
          <button type="button" onClick={() => setPage('chat')}>Chat with NOVA</button>
        </article>
      </div>

      <p className="eyebrow" style={{ marginTop: 32 }}>GAME PROGRESSION</p>
      {progressRows.status === 'loading' && (
        <p className="wallet-status" role="status">Loading progression…</p>
      )}
      {progressRows.status === 'error' && (
        <div className="chat-error" role="alert">
          <span>Couldn&apos;t load progression.</span>
          <div className="chat-error-actions">
            <button type="button" onClick={() => void load()}>Retry</button>
          </div>
        </div>
      )}
      {progressRows.status === 'ready' && progressRows.data.length === 0 && (
        <div className="wallet-history-empty">
          <p>No games yet</p>
          <small>Play a game to start filling this in.</small>
        </div>
      )}
      {progressRows.status === 'ready' && progressRows.data.length > 0 && (
        <div className="progression-table" role="table" aria-label="Game progression">
          <div className="progression-row progression-head" role="row">
            <span role="columnheader">Game</span>
            <span role="columnheader">Played</span>
            <span role="columnheader">Won</span>
            <span role="columnheader">Win rate</span>
            <span role="columnheader">Best</span>
            <span role="columnheader">XP</span>
          </div>
          {progressRows.data.map((row) => (
            <div className="progression-row" role="row" key={row.game_id}>
              <span role="cell">{gameLabel(row.game_id)}</span>
              <span role="cell">{row.games_played}</span>
              <span role="cell">{row.games_won}</span>
              <span role="cell">{winRate(row)}</span>
              <span role="cell">{row.best_score ?? '—'}</span>
              <span role="cell">{row.total_xp} XP</span>
            </div>
          ))}
        </div>
      )}

      <p className="eyebrow" style={{ marginTop: 32 }}>ACHIEVEMENTS</p>
      {achievements.status === 'loading' && (
        <p className="wallet-status" role="status">Loading achievements…</p>
      )}
      {achievements.status === 'error' && (
        <div className="chat-error" role="alert">
          <span>Couldn&apos;t load achievements.</span>
          <div className="chat-error-actions">
            <button type="button" onClick={() => void load()}>Retry</button>
          </div>
        </div>
      )}
      {achievements.status === 'ready' && (
        <div className="profile-stat-card">
          <p>Earned</p>
          <strong>{achievements.data.earned} / {achievements.data.total}</strong>
          <span>{describeAchievements(achievements.data)}</span>
        </div>
      )}

      <p className="eyebrow" style={{ marginTop: 32 }}>RECENT ACTIVITY</p>
      {activity.status === 'loading' && (
        <p className="wallet-status" role="status">Loading recent activity…</p>
      )}
      {activity.status === 'ready' && activity.data.length === 0 && (
        <div className="wallet-history-empty">
          <p>No games yet</p>
          <small>Completed sessions will appear here.</small>
        </div>
      )}
      {activity.status === 'ready' && activity.data.length > 0 && (
        <div className="profile-activity">
          {activity.data.map((row) => (
            <div key={row.id} className="profile-activity-row">
              <span
                className={row.outcomeClass ? `profile-outcome ${row.outcomeClass}` : 'profile-outcome'}
              >
                {row.outcomeLabel}
              </span>
              <span className="profile-activity-date">
                {row.game}
                {row.coins !== null ? ` · +${row.coins} NOVA Coins` : ''}
                {' · '}{formatDate(row.createdAt)}
              </span>
            </div>
          ))}
        </div>
      )}

      <Leaderboard session={session} isDemo={isDemo} />

      <div className="flow">
        <span>Play</span><b>→</b>
        <span>Level up</span><b>→</b>
        <span>Earn badges</span><b>→</b>
        <span>Chat</span>
      </div>
    </>
  )
}
