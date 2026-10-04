import React, { useState, lazy, Suspense } from 'react'
import { useSupabaseSession } from '@/lib/supabase'
import { useWallet } from '@/lib/supabase/wallet'
import { useProfile } from '@/lib/supabase/useProfile'

import type { GameKey, Page, PostGameContext } from './types'
import { useToasts } from './hooks/useToasts'
import AuthGate from './auth'
import Home from './home'
import Games from './games'
import Progression from './progression'
import WalletView from './wallet-view'
import Chat from './chat'
import Profile from './profile'
import Onboarding from './onboarding'

const TicTacToe = lazy(() => import('./tictactoe'))
const Sudoku = lazy(() => import('./sudoku'))
const BallRun = lazy(() => import('./ballrun'))
const WaterSort = lazy(() => import('./watersort'))

const NAV_ITEMS: Page[] = ['home', 'chat', 'games', 'progression', 'wallet', 'profile']

export default function App() {
  const {
    supabase: supabaseClient,
    session,
    user,
    loading: authLoading,
    needsPasswordReset,
    signIn,
    signUp,
    signOut,
    resetPasswordForEmail,
    updatePassword,
    completePasswordReset,
  } = useSupabaseSession()
  const wallet = useWallet(session)
  const { refresh: refreshProfile, retry: retryProfile, status: profileStatus, ...profile } =
    useProfile(session)
  const { toasts, addToast, dismissToast } = useToasts()
  const [page, setPage] = useState<Page>('home')
  const [selectedGame, setSelectedGame] = useState<GameKey | null>(null)
  // In-memory only: a completed game's re-entry reference survives navigation
  // but never persists across a refresh, so old context cannot repeat.
  const [postGame, setPostGame] = useState<PostGameContext | null>(null)

  const openPage = (target: Page, game?: GameKey) => {
    setSelectedGame(game ?? null)
    setPage(target)
  }

  const goTo = (target: Page) => openPage(target)

  const continueToChat = (sessionId: string, game: PostGameContext['game']) => {
    setPostGame({ sessionId, game })
    setPage('chat')
  }

  // Auth loading gate
  if (authLoading) {
    return (
      <main className="nova-shell">
        <div className="auth-loading">
          <div className="auth-loading-spinner" />
        </div>
      </main>
    )
  }

  // Password recovery: force set-new-password before normal app usage.
  if (supabaseClient && needsPasswordReset) {
    return (
      <AuthGate
        initialMode="reset"
        signIn={signIn}
        signUp={signUp}
        resetPasswordForEmail={resetPasswordForEmail}
        updatePassword={updatePassword}
        completePasswordReset={completePasswordReset}
      />
    )
  }

  // Production auth gate: show login when Supabase is configured but no session
  if (supabaseClient && !session) {
    return (
      <AuthGate
        signIn={signIn}
        signUp={signUp}
        resetPasswordForEmail={resetPasswordForEmail}
        updatePassword={updatePassword}
        completePasswordReset={completePasswordReset}
      />
    )
  }

  // Profile check gate: avoid flashing the shell before profile state is known.
  if (supabaseClient && session && !needsPasswordReset && profileStatus === 'loading') {
    return (
      <main className="nova-shell">
        <div className="auth-loading">
          <div className="auth-loading-spinner" />
        </div>
      </main>
    )
  }

  // Profile fetch failed: show retry instead of guessing onboarding vs shell.
  if (supabaseClient && session && !needsPasswordReset && profileStatus === 'error') {
    return (
      <main className="nova-shell">
        <main className="auth-card">
          <div className="auth-brand">
            <span className="auth-logo">NOVA</span>
            <span className="auth-subtitle">AI PLAY</span>
          </div>
          <p className="eyebrow">PROFILE</p>
          <p className="auth-error" role="alert">
            Could not load your profile — check your connection and try again.
          </p>
          <div className="auth-form">
            <button type="button" onClick={() => void retryProfile()}>
              Retry
            </button>
          </div>
        </main>
      </main>
    )
  }

  // Onboarding gate: authenticated users whose display_name is still empty.
  if (
    supabaseClient &&
    session &&
    !needsPasswordReset &&
    profileStatus === 'ready' &&
    !profile.displayName.trim()
  ) {
    return (
      <Onboarding
        onComplete={async () => {
          const ok = await refreshProfile()
          return ok
        }}
      />
    )
  }

  const appClass = page === 'games' && selectedGame ? 'game-mode' : 'app-mode'

  return (
    <main className={`nova-shell ${appClass}`}>
      {/* Top bar */}
      <header className="topbar">
        <button className="brand" onClick={() => goTo('home')} aria-label="NOVA AI Play — go to home">
          NOVA<span>AI PLAY</span>
        </button>
        <div className="topbar-right">
          {wallet.isDemo && <span className="mode-badge">DEMO</span>}
          <div className="balances">
            <span>{wallet.earnedCoins} <small>NOVA Coins</small></span>
            <span>{wallet.aiCredits} <small>AI Credits</small></span>
          </div>
          {supabaseClient && user && (
            <button className="signout-btn" onClick={signOut} aria-label={`Sign out ${user.email}`}>
              {user.email}
              <small>sign out</small>
            </button>
          )}
        </div>
      </header>

      {/* Body */}
      <section className="app-frame">
        <aside className="sidebar" aria-label="Main navigation">
          {NAV_ITEMS.map((item) => (
            <button key={item} className={page === item ? 'active' : ''} onClick={() => goTo(item)} aria-current={page === item ? 'page' : undefined}>
              {item}
            </button>
          ))}
        </aside>

        <section className="content">
          {page === 'games' && selectedGame && (
            <div className="game-backbar">
              <button type="button" onClick={() => setSelectedGame(null)}>
                ← All games
              </button>
            </div>
          )}

          {page === 'home' && (
            <Home
              setPage={openPage}
              profile={profile}
              wallet={wallet}
              session={session}
              onRefreshProfile={refreshProfile}
            />
          )}
          {page === 'games' && !selectedGame && (
            <Games session={session} wallet={wallet} onSelect={setSelectedGame} />
          )}
          {page === 'games' && selectedGame === 'tictactoe' && (
            <Suspense fallback={<div className="game-loading">Loading Tic-Tac-Toe...</div>}>
              <TicTacToe
                session={session}
                wallet={wallet}
                addToast={addToast}
                onContinueToChat={(sessionId) => continueToChat(sessionId, 'tictactoe')}
              />
            </Suspense>
          )}
          {page === 'games' && selectedGame === 'sudoku' && (
            <Suspense fallback={<div className="game-loading">Loading Sudoku...</div>}>
              <Sudoku
                session={session}
                wallet={wallet}
                addToast={addToast}
                onContinueToChat={(sessionId) => continueToChat(sessionId, 'sudoku')}
              />
            </Suspense>
          )}
          {page === 'games' && selectedGame === 'ball-run' && (
            <Suspense fallback={<div className="game-loading">Loading Ball Run...</div>}>
              <BallRun
                session={session}
                wallet={wallet}
                addToast={addToast}
                onContinueToChat={(sessionId) => continueToChat(sessionId, 'ball-run')}
              />
            </Suspense>
          )}
          {page === 'games' && selectedGame === 'water-sort' && (
            <Suspense fallback={<div className="game-loading">Loading Water Sort...</div>}>
              <WaterSort
                session={session}
                wallet={wallet}
                addToast={addToast}
                onContinueToChat={(sessionId) => continueToChat(sessionId, 'water-sort')}
              />
            </Suspense>
          )}
          {page === 'progression' && (
            <Progression
              session={session}
              wallet={wallet}
              profile={profile}
              isDemo={wallet.isDemo}
              setPage={openPage}
              onRefreshProfile={refreshProfile}
            />
          )}
          {page === 'wallet' && <WalletView session={session} wallet={wallet} addToast={addToast} />}
          {page === 'chat' && (
            <Chat
              session={session}
              wallet={wallet}
              postGame={postGame}
              onPostGameConsumed={() => setPostGame(null)}
            />
          )}
          {page === 'profile' && (
            <Profile
              session={session}
              wallet={wallet}
              isDemo={wallet.isDemo}
              onDisplayNameSaved={() => void refreshProfile()}
              onAccountDeleted={() => {
                goTo('home')
                void refreshProfile()
              }}
            />
          )}
        </section>
      </section>

      {/* Footer */}
      <footer>
        {wallet.isDemo
          ? 'Demo mode — balances are local to this browser session. Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable real accounts.'
          : 'Wallet synced with Supabase. Balances are authoritative server-side.'}
      </footer>

      {/* Toasts */}
      <div className="toast-container" aria-live="polite" aria-relevant="additions text">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.kind}`}
            role={t.kind === 'error' ? 'alert' : 'status'}
          >
            <span className="toast-text">{t.text}</span>
            <button
              type="button"
              className="toast-dismiss"
              onClick={() => dismissToast(t.id)}
              aria-label={`Dismiss notification: ${t.text}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </main>
  )
}