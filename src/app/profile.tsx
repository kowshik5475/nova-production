import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '@/lib/supabase/client'
import type { Session } from '@supabase/supabase-js'
import type { LeaderboardRow, ProfileState } from './types'
import { formatDate, getInsight, validateDisplayName } from './utils'

type Wallet = {
  earnedCoins: number
  aiCredits: number
  isDemo: boolean
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  exchangeCoins: () => Promise<void>
}

type NameEditState = 'viewing' | 'editing' | 'saving'
type DeleteState = 'idle' | 'confirming' | 'deleting' | 'success' | 'error'
type LeaderboardState = {
  rows: LeaderboardRow[]
  myRank: LeaderboardRow | null
  loading: boolean
  error: boolean
}

const LEADERBOARD_LIMIT = 50

export default function Profile({
  session,
  wallet,
  isDemo,
  onDisplayNameSaved,
  onAccountDeleted,
}: {
  session: Session | null
  wallet: Wallet
  isDemo: boolean
  onDisplayNameSaved?: () => void
  onAccountDeleted?: () => void
}) {
  const [profileData, setProfileData] = useState<ProfileState>(
    isDemo
      ? { profile: { display_name: 'Player', level: 1, xp: 40, streak: 0 }, progress: { games_played: 5, games_won: 2, best_score: null, total_xp: 50 }, sudokuProgress: { games_played: 2, games_won: 1, best_score: null, total_xp: 40 }, ballProgress: { games_played: 3, games_won: 1, best_score: null, total_xp: 30 }, waterProgress: { games_played: 2, games_won: 1, best_score: null, total_xp: 20 }, recentResults: [{ id: '1', outcome: 'win', created_at: new Date(Date.now() - 3600000).toISOString() }, { id: '2', outcome: 'loss', created_at: new Date(Date.now() - 7200000).toISOString() }, { id: '3', outcome: 'draw', created_at: new Date(Date.now() - 10800000).toISOString() }], achievements: [], loading: false, error: null }
      : { profile: null, progress: null, sudokuProgress: null, ballProgress: null, waterProgress: null, recentResults: [], achievements: [], loading: false, error: null },
  )
  const profileLoadedRef = useRef(false)
  const [nameEdit, setNameEdit] = useState<NameEditState>('viewing')
  const [nameDraft, setNameDraft] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [nameServerMessage, setNameServerMessage] = useState<string | null>(null)
  const [deleteState, setDeleteState] = useState<DeleteState>('idle')
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const loadProfile = useCallback(async () => {
    if (!supabase || !session || profileLoadedRef.current) return
    setProfileData((prev) => ({ ...prev, loading: true, error: null }))
    try {
      const [profileRes, progressRes, sudokuProgressRes, ballProgressRes, waterProgressRes, resultsRes, catalogRes, earnedRes] = await Promise.all([
        supabase.from('profiles').select('display_name, level, xp, streak').eq('id', session.user.id).single(),
        supabase.from('game_progress').select('games_played, games_won, best_score, total_xp').eq('user_id', session.user.id).eq('game_id', 'tictactoe').maybeSingle(),
        supabase.from('game_progress').select('games_played, games_won, best_score, total_xp').eq('user_id', session.user.id).eq('game_id', 'sudoku').maybeSingle(),
        supabase.from('game_progress').select('games_played, games_won, best_score, total_xp').eq('user_id', session.user.id).eq('game_id', 'ball-run').maybeSingle(),
        supabase.from('game_progress').select('games_played, games_won, best_score, total_xp').eq('user_id', session.user.id).eq('game_id', 'water-sort').maybeSingle(),
        supabase.from('game_results').select('id, outcome, created_at').eq('user_id', session.user.id).order('created_at', { ascending: false }).limit(5),
        supabase.from('achievements').select('id, name, description, category, icon').order('id'),
        supabase.from('user_achievements').select('achievement_id, earned_at').eq('user_id', session.user.id),
      ])
      if (profileRes.error) throw profileRes.error
      const earnedMap = new Map(
        ((earnedRes.data ?? []) as { achievement_id: string; earned_at: string }[]).map((e) => [
          e.achievement_id,
          e.earned_at,
        ]),
      )
      const achievements = ((catalogRes.data ?? []) as {
        id: string
        name: string
        description: string
        category: string
        icon: string | null
      }[]).map((a) => ({
        ...a,
        earned: earnedMap.has(a.id),
        earned_at: earnedMap.get(a.id) ?? null,
      }))
      setProfileData({
        profile: profileRes.data,
        progress: progressRes.data ?? { games_played: 0, games_won: 0, best_score: null, total_xp: 0 },
        sudokuProgress: sudokuProgressRes.data ?? { games_played: 0, games_won: 0, best_score: null, total_xp: 0 },
        ballProgress: ballProgressRes.data ?? { games_played: 0, games_won: 0, best_score: null, total_xp: 0 },
        waterProgress: waterProgressRes.data ?? { games_played: 0, games_won: 0, best_score: null, total_xp: 0 },
        recentResults: resultsRes.data ?? [],
        achievements,
        loading: false,
        error: null,
      })
      profileLoadedRef.current = true
    } catch (err) {
      setProfileData((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load profile',
      }))
    }
  }, [session])

  useEffect(() => {
    if (session && !profileLoadedRef.current) {
      loadProfile()
    }
  }, [session, loadProfile])

  const startEditName = () => {
    if (!profileData.profile) return
    setNameDraft(profileData.profile.display_name)
    setNameError(null)
    setNameServerMessage(null)
    setNameEdit('editing')
  }

  const cancelEditName = () => {
    if (nameEdit === 'saving') return
    setNameDraft('')
    setNameError(null)
    setNameServerMessage(null)
    setNameEdit('viewing')
  }

  const saveDisplayName = useCallback(
    async (event: FormEvent) => {
      event.preventDefault()
      if (nameEdit === 'saving' || !session || !supabase || !profileData.profile) return

      const validation = validateDisplayName(nameDraft)
      if (!validation.ok) {
        setNameError(validation.error)
        return
      }

      const current = profileData.profile.display_name
      if (validation.value === current) {
        setNameError(null)
        setNameServerMessage('Display name is already up to date.')
        setNameEdit('viewing')
        setNameDraft('')
        return
      }

      setNameEdit('saving')
      setNameError(null)
      setNameServerMessage(null)

      try {
        const { data, error } = await supabase.rpc('update_own_display_name', {
          p_display_name: validation.value,
        })
        if (error) {
          const msg = (error.message || '').toLowerCase()
          if (msg.includes('required') || msg.includes('50 characters')) {
            setNameError(error.message)
          } else if (msg.includes('not authenticated') || msg.includes('jwt') || msg.includes('session')) {
            setNameError('Your session expired — sign in again and retry')
          } else {
            setNameError('Could not save display name — try again')
          }
          setNameEdit('editing')
          return
        }

        const saved = typeof data === 'string' && data ? data : validation.value
        setProfileData((prev) =>
          prev.profile
            ? { ...prev, profile: { ...prev.profile, display_name: saved }, error: null }
            : prev,
        )
        setNameDraft('')
        setNameServerMessage('Display name updated.')
        setNameEdit('viewing')
        onDisplayNameSaved?.()
      } catch {
        setNameError('Could not save display name — try again')
        setNameEdit('editing')
      }
    },
    [nameDraft, nameEdit, onDisplayNameSaved, profileData.profile, session],
  )

  const canEditName = Boolean(!isDemo && session && supabase && profileData.profile)
  const canDeleteAccount = Boolean(!isDemo && session && supabase)

  // Only the games this player has actually entered — no empty stat cards.
  const extraGames = (
    [
      { key: 'ball-run', label: 'BALL RUN', stats: profileData.ballProgress },
      { key: 'water-sort', label: 'WATER SORT', stats: profileData.waterProgress },
    ] as const
  ).filter((game) => (game.stats?.games_played ?? 0) > 0)

  const openDeleteConfirm = () => {
    if (!canDeleteAccount || deleteState === 'deleting') return
    setDeleteConfirm('')
    setDeleteError(null)
    setDeleteState('confirming')
  }

  const cancelDelete = () => {
    if (deleteState === 'deleting' || deleteState === 'success') return
    setDeleteConfirm('')
    setDeleteError(null)
    setDeleteState('idle')
  }

  const submitDelete = useCallback(
    async (event: FormEvent) => {
      event.preventDefault()
      if (deleteState !== 'confirming' || !supabase || !session) return

      if (deleteConfirm.trim() !== 'DELETE') {
        setDeleteError('Type DELETE exactly to confirm')
        return
      }

      setDeleteState('deleting')
      setDeleteError(null)

      try {
        const { error } = await supabase.functions.invoke('delete-account', {
          body: { confirmation: 'DELETE' },
        })
        if (error) {
          const msg = (error.message || '').toLowerCase()
          if (msg.includes('401') || msg.includes('session') || msg.includes('jwt')) {
            setDeleteError('Your session expired — sign in again and retry')
          } else if (msg.includes('400') || msg.includes('confirmation')) {
            setDeleteError('Confirmation required')
          } else {
            setDeleteError('Could not delete account — try again')
          }
          setDeleteState('error')
          return
        }

        setDeleteState('success')
        // Local session teardown; existing onAuthStateChange clears app state.
        await supabase.auth.signOut()
        onAccountDeleted?.()
      } catch {
        setDeleteError('Could not delete account — try again')
        setDeleteState('error')
      }
    },
    [deleteConfirm, deleteState, onAccountDeleted, session],
  )

  return (
    <>
      <p className="eyebrow">PROFILE &amp; PROGRESS</p>
      <h1>Your journey.</h1>

      {profileData.loading && <p className="wallet-status" role="status">Loading profile…</p>}
      {profileData.error && <p className="chat-error" role="alert"><span>{profileData.error}</span></p>}

      {!profileData.loading && profileData.profile && (
        <>
          <div className="profile-grid">
            <article className="primary-card">
              <div className="profile-name-block">
                {nameEdit === 'editing' || nameEdit === 'saving' ? (
                  <form className="profile-name-form" onSubmit={saveDisplayName} noValidate>
                    <label className="profile-name-label" htmlFor="display-name-input">
                      Display name
                    </label>
                    <input
                      id="display-name-input"
                      className="profile-name-input"
                      type="text"
                      value={nameDraft}
                      onChange={(e) => {
                        setNameDraft(e.target.value)
                        if (nameError) setNameError(null)
                      }}
                      maxLength={60}
                      autoComplete="nickname"
                      disabled={nameEdit === 'saving'}
                      aria-invalid={nameError ? true : undefined}
                      aria-describedby={nameError ? 'display-name-error' : undefined}
                      autoFocus
                    />
                    {nameError && (
                      <p id="display-name-error" className="profile-name-error" role="alert">
                        {nameError}
                      </p>
                    )}
                    <div className="profile-name-actions">
                      <button type="submit" disabled={nameEdit === 'saving'}>
                        {nameEdit === 'saving' ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        type="button"
                        className="profile-name-cancel"
                        onClick={cancelEditName}
                        disabled={nameEdit === 'saving'}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <p className="profile-name-text">{profileData.profile.display_name}</p>
                    {nameServerMessage && (
                      <p className="profile-name-success" role="status">
                        {nameServerMessage}
                      </p>
                    )}
                    {canEditName && (
                      <button
                        type="button"
                        className="profile-name-edit-btn"
                        onClick={startEditName}
                        aria-label="Edit display name"
                      >
                        Edit
                      </button>
                    )}
                  </>
                )}
              </div>
              <p>LEVEL {profileData.profile.level}</p>
              <strong>{profileData.profile.xp} XP</strong>
              <div className="progress"><i style={{ width: `${profileData.profile.xp % 100}%` }} /></div>
              <small>{100 - (profileData.profile.xp % 100)} XP to Level {profileData.profile.level + 1}</small>
            </article>

            <article className="profile-stat-card">
              <p>NOVA COINS</p>
              <strong>{wallet.earnedCoins}</strong>
            </article>
            <article className="profile-stat-card">
              <p>AI CREDITS</p>
              <strong>{wallet.aiCredits}</strong>
            </article>
            <article className="profile-stat-card">
              <p>Current Streak</p>
              <strong>{profileData.profile.streak} days</strong>
            </article>
          </div>

          {!isDemo && session?.user.email && (
            <div className="profile-account">
              <span className="profile-account-email" title="Account email">
                {session.user.email}
              </span>
              <button type="button" className="profile-account-signout" onClick={() => void supabase?.auth.signOut()}>
                Sign out
              </button>
            </div>
          )}

          {profileData.progress && (
            <>
              <p className="eyebrow" style={{ marginTop: 32 }}>TIC-TAC-TOE STATS</p>
              <div className="profile-grid">
                <article className="profile-stat-card">
                  <p>PLAYED</p>
                  <strong>{profileData.progress.games_played}</strong>
                </article>
                <article className="profile-stat-card">
                  <p>WON</p>
                  <strong>{profileData.progress.games_won}</strong>
                </article>
                <article className="profile-stat-card">
                  <p>WIN RATE</p>
                  <strong>{profileData.progress.games_played > 0 ? Math.round((profileData.progress.games_won / profileData.progress.games_played) * 100) : 0}%</strong>
                </article>
                <article className="profile-stat-card">
                  <p>LOSSES / DRAWS</p>
                  <strong>{profileData.progress.games_played - profileData.progress.games_won}</strong>
                </article>
              </div>
            </>
          )}

          {profileData.sudokuProgress && (
            <>
              <p className="eyebrow" style={{ marginTop: 32 }}>SUDOKU STATS</p>
              <div className="profile-grid">
                <article className="profile-stat-card">
                  <p>PUZZLES SOLVED</p>
                  <strong>{profileData.sudokuProgress.games_won}</strong>
                </article>
                <article className="profile-stat-card">
                  <p>PLAYED</p>
                  <strong>{profileData.sudokuProgress.games_played}</strong>
                </article>
                <article className="profile-stat-card">
                  <p>SUCCESS RATE</p>
                  <strong>{profileData.sudokuProgress.games_played > 0 ? Math.round((profileData.sudokuProgress.games_won / profileData.sudokuProgress.games_played) * 100) : 0}%</strong>
                </article>
              </div>
            </>
          )}

          {extraGames.length > 0 && (
            <>
              <p className="eyebrow" style={{ marginTop: 32 }}>MORE GAME STATS</p>
              <div className="profile-grid">
                {extraGames.map((game) => (
                  <article key={game.key} className="profile-stat-card">
                    <p>{game.label}</p>
                    <strong>{game.stats?.games_won ?? 0}/{game.stats?.games_played ?? 0} won</strong>
                    <small>
                      Played {game.stats?.games_played ?? 0}
                      {typeof game.stats?.best_score === 'number' ? ` · Best ${game.stats.best_score}` : ''}
                    </small>
                  </article>
                ))}
              </div>
            </>
          )}

          {profileData.recentResults.length > 0 && (
            <>
              <p className="eyebrow" style={{ marginTop: 32 }}>RECENT ACTIVITY</p>
              <div className="profile-activity">
                {profileData.recentResults.map((r) => (
                  <div key={r.id} className="profile-activity-row">
                    <span className={`profile-outcome profile-outcome-${r.outcome}`}>{r.outcome === 'win' ? 'Won' : r.outcome === 'loss' ? 'Lost' : 'Draw'}</span>
                    <span className="profile-activity-date">{formatDate(r.created_at)}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          <p className="eyebrow" style={{ marginTop: 32 }}>ACHIEVEMENTS</p>
          {profileData.achievements.length === 0 ? (
            <p className="profile-achievements-empty">
              No achievements yet — complete a game to earn your first.
            </p>
          ) : (
            <div className="profile-achievements" role="list">
              {profileData.achievements.map((a) => (
                <div
                  key={a.id}
                  role="listitem"
                  className={`profile-achievement ${a.earned ? 'profile-achievement-earned' : 'profile-achievement-locked'}`}
                >
                  <span className="profile-achievement-icon" aria-hidden="true">
                    {a.icon ?? '★'}
                  </span>
                  <div className="profile-achievement-body">
                    <p className="profile-achievement-name">
                      {a.name}
                      <span
                        className={`profile-achievement-state ${a.earned ? '' : 'profile-achievement-state-locked'}`}
                      >
                        {a.earned ? 'Earned' : 'Locked'}
                      </span>
                    </p>
                    <p className="profile-achievement-desc">{a.description}</p>
                    {a.earned && a.earned_at && (
                      <p className="profile-achievement-date">{formatDate(a.earned_at)}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <Leaderboard session={session} isDemo={isDemo} />

          <div className="profile-insight">
            <p className="eyebrow">NOVA INSIGHT</p>
            <p>{getInsight(profileData.progress, wallet.earnedCoins, wallet.aiCredits)}</p>
          </div>

          {canDeleteAccount && (
            <section className="profile-danger" aria-labelledby="danger-zone-heading">
              <p className="eyebrow" id="danger-zone-heading">DANGER ZONE</p>
              {deleteState === 'success' ? (
                <p className="profile-danger-status" role="status">
                  Account deleted. You have been signed out.
                </p>
              ) : deleteState === 'confirming' || deleteState === 'deleting' || deleteState === 'error' ? (
                <form className="profile-danger-form" onSubmit={submitDelete} noValidate>
                  <p className="profile-danger-copy">
                    This permanently deletes your account and personal data (profile, wallet,
                    game history, and chat history). This cannot be undone.
                  </p>
                  <label className="profile-name-label" htmlFor="delete-confirm-input">
                    Type DELETE to confirm
                  </label>
                  <input
                    id="delete-confirm-input"
                    className="profile-name-input"
                    type="text"
                    value={deleteConfirm}
                    onChange={(e) => {
                      setDeleteConfirm(e.target.value)
                      if (deleteError) setDeleteError(null)
                    }}
                    disabled={deleteState === 'deleting'}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={deleteError ? true : undefined}
                    aria-describedby={deleteError ? 'delete-confirm-error' : undefined}
                    autoFocus={deleteState === 'confirming'}
                  />
                  {deleteError && (
                    <p id="delete-confirm-error" className="profile-name-error" role="alert">
                      {deleteError}
                    </p>
                  )}
                  <div className="profile-name-actions">
                    <button
                      type="submit"
                      className="profile-danger-submit"
                      disabled={deleteState === 'deleting'}
                    >
                      {deleteState === 'deleting' ? 'Deleting…' : 'Permanently delete account'}
                    </button>
                    <button
                      type="button"
                      className="profile-name-cancel"
                      onClick={cancelDelete}
                      disabled={deleteState === 'deleting'}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <p className="profile-danger-copy">
                    Deleting your account permanently removes your personal data. This cannot be undone.
                  </p>
                  <button
                    type="button"
                    className="profile-danger-btn"
                    onClick={openDeleteConfirm}
                    aria-label="Delete account"
                  >
                    Delete account
                  </button>
                </>
              )}
            </section>
          )}
        </>
      )}
    </>
  )
}

// ── Leaderboard ────────────────────────────────────────────────────────────────
// Shared by Profile and Progression so there is exactly one authoritative
// leaderboard query in the app. Strictly read-only: no insert/update/delete.
export function Leaderboard({
  session,
  isDemo,
}: {
  session: Session | null
  isDemo: boolean
}) {
  const leaderboardLoadedRef = useRef(false)
  const [leaderboard, setLeaderboard] = useState<LeaderboardState>({
    rows: [],
    myRank: null,
    loading: true,
    error: false,
  })

  const loadLeaderboard = useCallback(async () => {
    if (!supabase || !session || isDemo) return
    try {
      const [topRes, meRes] = await Promise.all([
        supabase
          .from('leaderboard_ranked')
          .select('rank, display_name, xp, level, is_me')
          .order('rank', { ascending: true })
          .limit(LEADERBOARD_LIMIT),
        supabase
          .from('leaderboard_ranked')
          .select('rank, display_name, xp, level, is_me')
          .eq('is_me', true)
          .maybeSingle(),
      ])
      if (topRes.error) throw topRes.error
      if (meRes.error) throw meRes.error
      setLeaderboard({
        rows: (topRes.data ?? []) as LeaderboardRow[],
        myRank: (meRes.data ?? null) as LeaderboardRow | null,
        loading: false,
        error: false,
      })
    } catch {
      setLeaderboard((prev) => ({ ...prev, loading: false, error: true }))
    }
  }, [session, isDemo])

  const retryLeaderboard = useCallback(() => {
    setLeaderboard((prev) => ({ ...prev, loading: true, error: false }))
    void loadLeaderboard()
  }, [loadLeaderboard])

  // Re-fetches each time the view opens (it remounts). No polling.
  useEffect(() => {
    if (session && !isDemo && supabase && !leaderboardLoadedRef.current) {
      leaderboardLoadedRef.current = true
      loadLeaderboard()
    }
  }, [session, isDemo, loadLeaderboard])

  const canViewLeaderboard = Boolean(!isDemo && session && supabase)
  if (!canViewLeaderboard) return null

  return (
    <>
      <p className="eyebrow" style={{ marginTop: 32 }}>LEADERBOARD</p>
      {leaderboard.loading ? (
        <p className="wallet-status" role="status">Loading leaderboard…</p>
      ) : leaderboard.error ? (
        <div className="profile-leaderboard-error">
          <p className="chat-error" role="alert"><span>Couldn&apos;t load leaderboard.</span></p>
          <button type="button" className="profile-leaderboard-retry" onClick={retryLeaderboard}>
            Retry
          </button>
        </div>
      ) : leaderboard.rows.length === 0 ? (
        <p className="profile-achievements-empty">No leaderboard data yet.</p>
      ) : (
        <>
          <div className="profile-leaderboard-you">
            <span className="profile-leaderboard-you-label">Your Rank</span>
            {leaderboard.myRank ? (
              <strong className="profile-leaderboard-you-rank">#{leaderboard.myRank.rank}</strong>
            ) : (
              <span className="profile-leaderboard-you-none">No rank yet</span>
            )}
          </div>
          <div className="profile-leaderboard" role="list">
            <div className="profile-leaderboard-head" aria-hidden="true">
              <span>#</span>
              <span>Player</span>
              <span>XP</span>
            </div>
            {leaderboard.rows.map((row) => (
              <div
                key={`${row.rank}-${row.display_name}`}
                role="listitem"
                className={`profile-leaderboard-row${row.is_me ? ' profile-leaderboard-row-you' : ''}`}
              >
                <span>#{row.rank}</span>
                <span className="profile-leaderboard-name">{row.display_name}</span>
                <span className="profile-leaderboard-xp">{row.xp} XP</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}