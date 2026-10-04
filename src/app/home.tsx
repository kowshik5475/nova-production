import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import type { Conversation, GameKey, Page } from './types'
import type { ProfileInfo } from '@/lib/supabase/useProfile'
import { supabase } from '@/lib/supabase/client'
import { listConversations } from '@/lib/supabase/conversations'
import { formatDate } from './utils'
import {
  HOME_GAME_IDS,
  buildHomeSuggestions,
  describeAchievements,
  mapActivityRows,
  summarizeAchievements,
  type HomeAchievementSummary,
  type HomeActivityRow,
} from './home-data'

type WalletInfo = {
  earnedCoins: number
  aiCredits: number
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

type SectionState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error' }

type HomeProps = {
  setPage: (p: Page, game?: GameKey) => void
  profile: ProfileInfo
  wallet: WalletInfo
  session: Session | null
  onRefreshProfile: () => Promise<unknown>
}

export default function Home({ setPage, profile, wallet, session, onRefreshProfile }: HomeProps) {
  const { level, xp } = profile
  const progress = xp % 100

  const [activity, setActivity] = useState<SectionState<HomeActivityRow[]>>({ status: 'loading' })
  const [achievements, setAchievements] = useState<SectionState<HomeAchievementSummary>>({
    status: 'loading',
  })
  const [threads, setThreads] = useState<SectionState<Conversation[]>>({ status: 'loading' })
  const mountedRef = useRef(true)
  // Per-section run tokens: a re-entered effect supersedes in-flight loads, so
  // only the latest run may settle the section (error states never get dropped).
  const activityRunRef = useRef(0)
  const achievementsRunRef = useRef(0)
  const threadsRunRef = useRef(0)
  const refreshRef = useRef(onRefreshProfile)

  // Keep the view-entry refresh pointed at the current loader identity.
  useEffect(() => {
    refreshRef.current = onRefreshProfile
  })

  // Recent activity: own completed TTT/Sudoku results plus the authoritative
  // GAME_REWARD rows that carry each session's coin payout.
  const loadActivity = useCallback(async () => {
    // Defer state updates so the effect body itself stays sync-safe.
    await Promise.resolve()
    if (!supabase || !session) return
    const run = ++activityRunRef.current
    setActivity({ status: 'loading' })
    try {
      const userId = session.user.id
      const [results, rewards] = await Promise.all([
        supabase
          .from('game_results')
          .select('id, session_id, game_id, outcome, created_at')
          .eq('user_id', userId)
          .in('game_id', [...HOME_GAME_IDS])
          .order('created_at', { ascending: false })
          .limit(3),
        supabase
          .from('wallet_transactions')
          .select('reference_id, amount')
          .eq('user_id', userId)
          .eq('type', 'GAME_REWARD')
          .order('created_at', { ascending: false })
          .limit(5),
      ])
      if (results.error) throw results.error
      if (rewards.error) throw rewards.error
      if (activityRunRef.current !== run) return
      setActivity({ status: 'ready', data: mapActivityRows(results.data ?? [], rewards.data ?? []) })
    } catch {
      if (activityRunRef.current !== run) return
      setActivity({ status: 'error' })
    }
  }, [session])

  // Achievement summary: the public catalog with this player's earned rows
  // attached by RLS — counts are read from rows, never computed from stats.
  const loadAchievements = useCallback(async () => {
    // Defer state updates so the effect body itself stays sync-safe.
    await Promise.resolve()
    if (!supabase || !session) return
    const run = ++achievementsRunRef.current
    setAchievements({ status: 'loading' })
    try {
      const userId = session.user.id
      const { data, error } = await supabase
        .from('achievements')
        .select('id, name, target_type, user_achievements(user_id, earned_at)')
        .order('id')
      if (error) throw error
      if (achievementsRunRef.current !== run) return
      setAchievements({ status: 'ready', data: summarizeAchievements(data ?? [], userId) })
    } catch {
      if (achievementsRunRef.current !== run) return
      setAchievements({ status: 'error' })
    }
  }, [session])

  // Recent conversations: the thread list behind the sidebar, loaded through
  // the same SECURITY DEFINER RPCs (no new client write path).
  const loadThreads = useCallback(async () => {
    // Defer state updates so the effect body itself stays sync-safe.
    await Promise.resolve()
    if (!session) return
    const run = ++threadsRunRef.current
    setThreads({ status: 'loading' })
    try {
      const rows = await listConversations(5)
      if (threadsRunRef.current !== run) return
      setThreads({ status: 'ready', data: rows })
    } catch {
      if (threadsRunRef.current !== run) return
      setThreads({ status: 'error' })
    }
  }, [session])

  // Resuming a thread: the conversation id travels through the URL, so Chat
  // picks it up on mount and a refresh lands on the same conversation.
  const openConversation = (id: string) => {
    const url = new URL(window.location.href)
    url.searchParams.set('conversation', id)
    window.history.replaceState({}, '', url.toString())
    setPage('chat')
  }

  // Home entry: re-read authoritative progression (a game/chat may have
  // changed XP, level, streak or achievements), then load both sections.
  // Demo/no-session entry performs no network work at all.
  useEffect(() => {
    mountedRef.current = true
    if (!session) {
      return () => {
        mountedRef.current = false
      }
    }
    async function run() {
      // Defer state updates so the effect body itself stays sync-safe.
      await Promise.resolve()
      if (!mountedRef.current) return
      void refreshRef.current()
      void loadActivity()
      void loadAchievements()
      void loadThreads()
    }
    void run()
    return () => {
      mountedRef.current = false
    }
  }, [session, loadActivity, loadAchievements, loadThreads])

  // One line per fired rule, straight from values already on screen.
  const suggestions = buildHomeSuggestions({
    level,
    streak: profile.streak,
    aiCredits: wallet.aiCredits,
    earnedCoins: wallet.earnedCoins,
    recentGames: activity.status === 'ready' ? activity.data.length : 0,
    conversationCount: threads.status === 'ready' ? threads.data.length : 0,
    walletReady: !wallet.error,
  })

  return (
    <>
      <p className="eyebrow">NOVA · YOUR AI COMPANION</p>
      <h1>Welcome back, {profile.displayName || 'Player'}.</h1>
      <p className="lede">
        Ask NOVA anything — homework, code, a screenshot to look at, a picture to draw, a reply to
        read aloud. Every conversation is saved as a thread you can resume any time. Challenges are
        optional: play one whenever you want to earn Coins and Credits.
      </p>

      <article className="ai-hero">
        <p className="eyebrow">ASK NOVA</p>
        <h2>Start a conversation with your AI companion.</h2>
        <p className="ai-hero-copy">
          Chat, attach a screenshot for it to look at, ask it to draw a picture, or have it read a
          reply aloud. Your game progress is shared only when it is useful.
        </p>
        <div className="ai-hero-actions">
          <button type="button" onClick={() => setPage('chat')}>
            {wallet.aiCredits > 0 ? 'Start Chatting' : 'Start Chatting · need credits'}
          </button>
          <button type="button" className="btn secondary" onClick={() => setPage('games')}>
            Explore Challenges
          </button>
        </div>
      </article>

      {session && suggestions.length > 0 && (
        <ul className="home-suggestions" aria-label="Personalized suggestions">
          {suggestions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

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
          <button onClick={() => setPage('wallet')}>View wallet</button>
        </article>
        <article className="insight-card">
          <p>AI CREDITS</p>
          <h2>{wallet.error ? '—' : wallet.aiCredits}</h2>
          <span>Each credit powers one chat</span>
          <button onClick={() => setPage('chat')}>Chat with NOVA</button>
        </article>
      </div>

      {wallet.loading && (
        <p className="wallet-status" role="status">Syncing wallet…</p>
      )}
      {wallet.error && (
        <div className="chat-error" role="alert">
          <span>{wallet.error}</span>
          <div className="chat-error-actions">
            <button type="button" onClick={() => void wallet.refresh()}>Retry</button>
          </div>
        </div>
      )}

      {session && (
        <>
          <p className="eyebrow" style={{ marginTop: 32 }}>RECENT CONVERSATIONS</p>
          {threads.status === 'loading' && (
            <p className="wallet-status" role="status">Loading conversations…</p>
          )}
          {threads.status === 'error' && (
            <div className="chat-error" role="alert">
              <span>Couldn&apos;t load conversations.</span>
              <div className="chat-error-actions">
                <button type="button" onClick={() => void loadThreads()}>Retry</button>
              </div>
            </div>
          )}
          {threads.status === 'ready' && threads.data.length === 0 && (
            <div className="wallet-history-empty">
              <p>No conversations yet</p>
              <small>Start chatting with NOVA — threads are saved server-side and survive a refresh.</small>
            </div>
          )}
          {threads.status === 'ready' && threads.data.length > 0 && (
            <div className="profile-activity">
              {threads.data.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className="profile-activity-row home-thread-row"
                  onClick={() => openConversation(row.id)}
                  aria-label={`Resume conversation ${row.title}`}
                >
                  <span className="home-thread-title">{row.title}</span>
                  <span className="profile-activity-date">
                    {formatDate(row.last_message_at)} · Resume →
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <div className="hero-grid" style={{ marginTop: 16 }}>
        <article className="insight-card">
          <p>OPTIONAL CHALLENGE</p>
          <h2>Tic-Tac-Toe</h2>
          <span>Win to earn 10 NOVA Coins + 25 XP</span>
          <button onClick={() => setPage('games', 'tictactoe')}>Play now</button>
        </article>
        <article className="insight-card">
          <p>OPTIONAL CHALLENGE</p>
          <h2>Sudoku</h2>
          <span>Solve to earn 20 NOVA Coins + 40 XP</span>
          <button onClick={() => setPage('games', 'sudoku')}>Play now</button>
        </article>
        <article className="insight-card">
          <p>OPTIONAL CHALLENGES</p>
          <h2>Ball Run & Water Sort</h2>
          <span>Survive 60s, or pour every tube clean</span>
          <button onClick={() => setPage('games')}>Open game hub</button>
        </article>
        {session && (
          <article className="insight-card">
            <p>ACHIEVEMENTS</p>
            {achievements.status === 'error' ? (
              <>
                <h2>—</h2>
                <span>Couldn&apos;t load achievements.</span>
                <button type="button" onClick={() => void loadAchievements()}>Retry</button>
              </>
            ) : achievements.status === 'ready' ? (
              <>
                <h2>{achievements.data.earned} / {achievements.data.total}</h2>
                <span>{describeAchievements(achievements.data)}</span>
                <button onClick={() => setPage('profile')}>View profile</button>
              </>
            ) : (
              <>
                <h2>—</h2>
                <span role="status">Loading achievements…</span>
              </>
            )}
          </article>
        )}
      </div>

      {session && (
        <>
          <p className="eyebrow" style={{ marginTop: 32 }}>RECENT ACTIVITY</p>
          {activity.status === 'loading' && (
            <p className="wallet-status" role="status">Loading recent activity…</p>
          )}
          {activity.status === 'error' && (
            <div className="chat-error" role="alert">
              <span>Couldn&apos;t load recent activity.</span>
              <div className="chat-error-actions">
                <button type="button" onClick={() => void loadActivity()}>Retry</button>
              </div>
            </div>
          )}
          {activity.status === 'ready' && activity.data.length === 0 && (
            <div className="wallet-history-empty">
              <p>No games yet</p>
              <small>Completed Tic-Tac-Toe, Sudoku, Ball Run and Water Sort sessions will appear here.</small>
            </div>
          )}
          {activity.status === 'ready' && activity.data.length > 0 && (
            <div className="profile-activity">
              {activity.data.map((row) => (
                <div key={row.id} className="profile-activity-row">
                  <span
                    className={
                      row.outcomeClass ? `profile-outcome ${row.outcomeClass}` : 'profile-outcome'
                    }
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
        </>
      )}
    </>
  )
}
