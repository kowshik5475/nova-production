import React, { useState } from 'react'
import type { FormEvent } from 'react'
import { isValidEmail, validateNewPassword } from './utils'

type SignInFn = (email: string, password: string) => Promise<{ error?: string }>
type SignUpFn = (email: string, password: string) => Promise<{ error?: string }>
type ResetRequestFn = (email: string) => Promise<{ error?: string }>
type UpdatePasswordFn = (password: string) => Promise<{ error?: string }>

type AuthMode = 'signin' | 'signup' | 'forgot' | 'reset'

const NEUTRAL_RESET_SENT =
  'If an account exists for this email, a password reset link has been sent.'

export default function AuthGate({
  signIn,
  signUp,
  resetPasswordForEmail,
  updatePassword,
  completePasswordReset,
  initialMode = 'signin',
}: {
  signIn: SignInFn
  signUp: SignUpFn
  resetPasswordForEmail?: ResetRequestFn
  updatePassword?: UpdatePasswordFn
  completePasswordReset?: () => void
  initialMode?: AuthMode
}) {
  const [authMode, setAuthMode] = useState<AuthMode>(initialMode)
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [authSuccess, setAuthSuccess] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [resetSent, setResetSent] = useState(false)
  const [passwordUpdated, setPasswordUpdated] = useState(false)

  function goSignIn() {
    setAuthMode('signin')
    setAuthError('')
    setAuthSuccess('')
    setResetSent(false)
  }

  function goForgot() {
    setAuthMode('forgot')
    setAuthError('')
    setAuthSuccess('')
    setResetSent(false)
  }

  async function handleAuth(event: FormEvent) {
    event.preventDefault()
    setAuthError('')
    setAuthSuccess('')
    setAuthBusy(true)
    try {
      const result =
        authMode === 'signin'
          ? await signIn(authEmail, authPassword)
          : await signUp(authEmail, authPassword)
      if (result.error) setAuthError(result.error)
    } catch {
      setAuthError('Something went wrong — try again')
    } finally {
      setAuthBusy(false)
    }
  }

  async function handleForgot(event: FormEvent) {
    event.preventDefault()
    setAuthError('')
    setAuthSuccess('')
    if (!isValidEmail(authEmail)) {
      setAuthError('Enter a valid email address')
      return
    }
    if (!resetPasswordForEmail) {
      setAuthError('Password reset is not available')
      return
    }
    setAuthBusy(true)
    try {
      const result = await resetPasswordForEmail(authEmail)
      if (result.error) {
        setAuthError(result.error)
        return
      }
      setResetSent(true)
      setAuthSuccess(NEUTRAL_RESET_SENT)
    } catch {
      setAuthError('Something went wrong — try again')
    } finally {
      setAuthBusy(false)
    }
  }

  async function handleUpdatePassword(event: FormEvent) {
    event.preventDefault()
    setAuthError('')
    setAuthSuccess('')
    const validationError = validateNewPassword(newPassword, confirmPassword)
    if (validationError) {
      setAuthError(validationError)
      return
    }
    if (!updatePassword) {
      setAuthError('Password update is not available')
      return
    }
    setAuthBusy(true)
    try {
      const result = await updatePassword(newPassword)
      if (result.error) {
        setAuthError(result.error)
        return
      }
      setPasswordUpdated(true)
      setAuthSuccess('Password updated successfully.')
      setNewPassword('')
      setConfirmPassword('')
    } catch {
      setAuthError('Could not update password — try again')
    } finally {
      setAuthBusy(false)
    }
  }

  const eyebrow =
    authMode === 'signin'
      ? 'SIGN IN'
      : authMode === 'signup'
        ? 'CREATE ACCOUNT'
        : authMode === 'forgot'
          ? 'FORGOT PASSWORD'
          : 'SET NEW PASSWORD'

  return (
    <main className="nova-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="auth-logo">NOVA</span>
          <span className="auth-subtitle">AI PLAY</span>
        </div>

        <p className="eyebrow">{eyebrow}</p>

        {authError && (
          <p className="auth-error" role="alert">
            {authError}
          </p>
        )}
        {authSuccess && (
          <p className="auth-success" role="status">
            {authSuccess}
          </p>
        )}

        {(authMode === 'signin' || authMode === 'signup') && (
          <form className="auth-form" onSubmit={handleAuth}>
            <input
              type="email"
              placeholder="Email"
              aria-label="Email"
              required
              autoComplete="email"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
            />
            <input
              type="password"
              placeholder="Password"
              aria-label="Password"
              required
              minLength={6}
              autoComplete={authMode === 'signin' ? 'current-password' : 'new-password'}
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
            />
            <button type="submit" disabled={authBusy}>
              {authBusy
                ? 'Please wait…'
                : authMode === 'signin'
                  ? 'Sign in'
                  : 'Create account'}
            </button>
          </form>
        )}

        {authMode === 'forgot' && !resetSent && (
          <form className="auth-form" onSubmit={handleForgot}>
            <label className="auth-label" htmlFor="forgot-email">
              Email
            </label>
            <input
              id="forgot-email"
              type="email"
              placeholder="Email"
              aria-label="Email"
              required
              autoComplete="email"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
            />
            <button type="submit" disabled={authBusy}>
              {authBusy ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        )}

        {authMode === 'forgot' && resetSent && (
          <div className="auth-form" aria-live="polite">
            <button type="button" onClick={goSignIn} disabled={authBusy}>
              Back to sign in
            </button>
          </div>
        )}

        {authMode === 'reset' && !passwordUpdated && (
          <form className="auth-form" onSubmit={handleUpdatePassword}>
            <label className="auth-label" htmlFor="new-password">
              New password
            </label>
            <input
              id="new-password"
              type="password"
              placeholder="New password"
              aria-label="New password"
              required
              minLength={6}
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <label className="auth-label" htmlFor="confirm-password">
              Confirm new password
            </label>
            <input
              id="confirm-password"
              type="password"
              placeholder="Confirm new password"
              aria-label="Confirm new password"
              required
              minLength={6}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
            <button type="submit" disabled={authBusy}>
              {authBusy ? 'Updating…' : 'Set new password'}
            </button>
          </form>
        )}

        {authMode === 'reset' && passwordUpdated && (
          <div className="auth-form" aria-live="polite">
            <button
              type="button"
              onClick={() => completePasswordReset?.()}
              disabled={authBusy}
            >
              Continue to NOVA
            </button>
          </div>
        )}

        {(authMode === 'signin' || authMode === 'signup') && (
          <>
            {authMode === 'signin' && resetPasswordForEmail && (
              <button type="button" className="auth-link" onClick={goForgot} disabled={authBusy}>
                Forgot password?
              </button>
            )}
            <button
              className="auth-toggle"
              onClick={() => {
                setAuthMode(authMode === 'signin' ? 'signup' : 'signin')
                setAuthError('')
                setAuthSuccess('')
              }}
              disabled={authBusy}
            >
              {authMode === 'signin'
                ? 'New here? Create an account'
                : 'Already have an account? Sign in'}
            </button>
          </>
        )}

        {authMode === 'forgot' && !resetSent && (
          <button type="button" className="auth-toggle" onClick={goSignIn} disabled={authBusy}>
            Back to sign in
          </button>
        )}

        {authMode === 'reset' && !passwordUpdated && (
          <p className="auth-hint">
            Open the link from your reset email to choose a new password.
          </p>
        )}
      </div>
    </main>
  )
}
