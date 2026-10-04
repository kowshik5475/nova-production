import React, { useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '@/lib/supabase/client'
import { validateDisplayName } from './utils'

type OnboardingState = 'idle' | 'saving' | 'success' | 'error'

export default function Onboarding({
  onComplete,
}: {
  onComplete: () => Promise<boolean> | void
}) {
  const [draft, setDraft] = useState('')
  const [state, setState] = useState<OnboardingState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (state === 'saving') return

    const validation = validateDisplayName(draft)
    if (!validation.ok) {
      setErrorMessage(validation.error)
      setState('error')
      return
    }
    if (!supabase) {
      setErrorMessage('Onboarding is not available')
      setState('error')
      return
    }

    setState('saving')
    setErrorMessage(null)

    try {
      const { error } = await supabase.rpc('update_own_display_name', {
        p_display_name: validation.value,
      })
      if (error) {
        const msg = (error.message || '').toLowerCase()
        if (msg.includes('required') || msg.includes('50 characters')) {
          setErrorMessage(error.message)
        } else if (msg.includes('not authenticated') || msg.includes('jwt') || msg.includes('session')) {
          setErrorMessage('Your session expired — sign in again and retry')
        } else {
          setErrorMessage('Could not save display name — try again')
        }
        setState('error')
        return
      }

      setState('success')
      const refreshed = await Promise.resolve(onComplete())
      if (refreshed === false) {
        setErrorMessage('Could not refresh profile — try again')
        setState('error')
      }
    } catch {
      setErrorMessage('Could not save display name — try again')
      setState('error')
    }
  }

  return (
    <main className="nova-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="auth-logo">NOVA</span>
          <span className="auth-subtitle">AI PLAY</span>
        </div>

        <p className="eyebrow">WELCOME TO NOVA</p>
        <p className="auth-hint">Choose your display name to get started.</p>

        {errorMessage && (
          <p id="onboarding-error" className="auth-error" role="alert">
            {errorMessage}
          </p>
        )}
        {state === 'success' && !errorMessage && (
          <p className="auth-success" role="status">
            Display name saved.
          </p>
        )}

        <form className="auth-form" onSubmit={submit} noValidate>
          <label className="auth-label" htmlFor="onboarding-display-name">
            Display name
          </label>
          <input
            id="onboarding-display-name"
            type="text"
            placeholder="Display name"
            autoComplete="nickname"
            maxLength={60}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              if (errorMessage) setErrorMessage(null)
            }}
            disabled={state === 'saving'}
            aria-invalid={errorMessage ? true : undefined}
            aria-describedby={errorMessage ? 'onboarding-error' : undefined}
            autoFocus
          />
          <button type="submit" disabled={state === 'saving'}>
            {state === 'saving' ? 'Saving…' : 'Continue'}
          </button>
        </form>
      </div>
    </main>
  )
}
