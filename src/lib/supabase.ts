import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase/client'

const RECOVERY_FLAG_KEY = 'nova_password_recovery'

function readRecoveryFlag(): boolean {
  try {
    return sessionStorage.getItem(RECOVERY_FLAG_KEY) === '1'
  } catch {
    return false
  }
}

function writeRecoveryFlag(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(RECOVERY_FLAG_KEY, '1')
    else sessionStorage.removeItem(RECOVERY_FLAG_KEY)
  } catch {
    /* ignore storage failures */
  }
}

/** True when the current URL looks like a Supabase recovery return. */
export function urlIndicatesPasswordRecovery(): boolean {
  if (typeof window === 'undefined') return false
  const raw = `${window.location.hash}&${window.location.search}`
  const params = new URLSearchParams(raw.replace(/^#/, ''))
  const type = params.get('type')
  const error = params.get('error')
  const errorDescription = params.get('error_description')
  if (type === 'recovery') return true
  // Expired/invalid recovery links often land with auth error params.
  if (error || errorDescription) {
    const desc = `${error ?? ''} ${errorDescription ?? ''}`.toLowerCase()
    if (desc.includes('recovery') || desc.includes('otp') || desc.includes('token') || desc.includes('hash')) {
      return true
    }
  }
  return false
}

function friendlyAuthError(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('password') && m.includes('least')) {
    return 'Password must be at least 6 characters'
  }
  if (m.includes('session') || m.includes('jwt') || m.includes('token') || m.includes('expired')) {
    return 'Recovery session expired — request a new reset link'
  }
  if (m.includes('network') || m.includes('fetch')) {
    return 'Network error — try again'
  }
  if (m.includes('rate') || m.includes('security purposes')) {
    return 'Too many attempts — wait a moment and try again'
  }
  return 'Something went wrong — try again'
}

export interface AuthState {
  supabase: typeof supabase
  session: Session | null
  user: Session['user'] | null
  loading: boolean
  needsPasswordReset: boolean
  signIn: (email: string, password: string) => Promise<{ error?: string }>
  signUp: (email: string, password: string) => Promise<{ error?: string }>
  signOut: () => Promise<void>
  resetPasswordForEmail: (email: string) => Promise<{ error?: string }>
  updatePassword: (password: string) => Promise<{ error?: string }>
  completePasswordReset: () => void
}

export function useSupabaseSession(): AuthState {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [needsPasswordReset, setNeedsPasswordReset] = useState(() => readRecoveryFlag())

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      return
    }

    let cancelled = false

    async function run() {
      // Yield so recovery URL detection does not setState synchronously in the effect.
      await Promise.resolve()
      if (cancelled) return

      if (urlIndicatesPasswordRecovery()) {
        writeRecoveryFlag(true)
        setNeedsPasswordReset(true)
      }

      const { data } = await supabase!.auth.getSession()
      if (cancelled) return
      setSession(data.session)
      setLoading(false)
    }

    void run()

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, sess) => {
      if (cancelled) return
      setSession(sess)
      setLoading(false)
      if (event === 'PASSWORD_RECOVERY') {
        writeRecoveryFlag(true)
        setNeedsPasswordReset(true)
      }
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    if (!supabase) return { error: 'Supabase not configured' }
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return error ? { error: error.message } : {}
  }, [])

  const signUp = useCallback(async (email: string, password: string) => {
    if (!supabase) return { error: 'Supabase not configured' }
    // Phase 8: seed display_name as empty string so handle_new_user's
    // coalesce(meta.display_name, email-prefix) stores '' for new users.
    // Existing users keep their non-empty names and bypass onboarding.
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: '' } },
    })
    return error ? { error: error.message } : {}
  }, [])

  const signOut = useCallback(async () => {
    if (!supabase) return
    writeRecoveryFlag(false)
    setNeedsPasswordReset(false)
    await supabase.auth.signOut()
  }, [])

  const resetPasswordForEmail = useCallback(async (email: string) => {
    if (!supabase) return { error: 'Supabase not configured' }
    const redirectTo = typeof window !== 'undefined' ? window.location.origin : undefined
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      ...(redirectTo ? { redirectTo } : {}),
    })
    // Anti-enumeration: callers treat valid-format email as neutral success
    // even when Supabase returns an opaque error (unknown user, etc.).
    // Surface only clearly actionable operational errors to the UI layer
    // via a dedicated flag; message text stays non-enumerating.
    if (error) {
      const msg = error.message.toLowerCase()
      if (msg.includes('network') || msg.includes('fetch')) {
        return { error: 'Network error — try again' }
      }
      if (msg.includes('rate') || msg.includes('security purposes')) {
        return { error: 'Too many attempts — wait a moment and try again' }
      }
    }
    return {}
  }, [])

  const updatePassword = useCallback(async (password: string) => {
    if (!supabase) return { error: 'Supabase not configured' }
    const { error } = await supabase.auth.updateUser({ password })
    if (error) return { error: friendlyAuthError(error.message) }
    // Recovery flag stays set until completePasswordReset() so the success
    // state can render before the app shell opens.
    return {}
  }, [])

  const completePasswordReset = useCallback(() => {
    writeRecoveryFlag(false)
    setNeedsPasswordReset(false)
  }, [])

  return {
    supabase,
    session,
    user: session?.user ?? null,
    loading,
    needsPasswordReset,
    signIn,
    signUp,
    signOut,
    resetPasswordForEmail,
    updatePassword,
    completePasswordReset,
  }
}
