import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase/client'

export interface ProfileInfo {
  displayName: string
  level: number
  xp: number
  streak: number
}

export type ProfileStatus = 'loading' | 'ready' | 'error'

export type UseProfileResult = ProfileInfo & {
  status: ProfileStatus
  refresh: () => Promise<boolean>
  retry: () => Promise<boolean>
}

const DEMO_PROFILE_INFO: ProfileInfo = { displayName: 'Player', level: 1, xp: 40, streak: 0 }
const EMPTY_PROFILE_INFO: ProfileInfo = { displayName: '', level: 1, xp: 0, streak: 0 }

function toProfileInfo(data: {
  display_name?: string | null
  level?: number | null
  xp?: number | null
  streak?: number | null
} | null): ProfileInfo {
  if (!data) return { ...EMPTY_PROFILE_INFO }
  return {
    displayName: data.display_name ?? '',
    level: data.level ?? 1,
    xp: data.xp ?? 0,
    streak: data.streak ?? 0,
  }
}

export function useProfile(session: Session | null): UseProfileResult {
  const isDemo = !supabase || !session
  const [profile, setProfile] = useState<ProfileInfo>(isDemo ? DEMO_PROFILE_INFO : EMPTY_PROFILE_INFO)
  // Tracks which user's profile has been resolved — prevents onboarding flicker
  // on session restore and prevents a stale ready state for a new session.
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)

  const status: ProfileStatus = !supabase || !session
    ? 'ready'
    : loadedFor === session.user.id
      ? loadError
        ? 'error'
        : 'ready'
      : 'loading'

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!supabase || !session) return false
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('display_name, level, xp, streak')
        .eq('id', session.user.id)
        .maybeSingle()
      if (error) throw error
      setProfile(toProfileInfo(data))
      setLoadError(false)
      setLoadedFor(session.user.id)
      return true
    } catch {
      // Silent refresh keeps last known good profile.
      return loadedFor === session.user.id && !loadError
    }
  }, [session, loadedFor, loadError])

  const retry = useCallback(async (): Promise<boolean> => {
    if (!supabase || !session) return false
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('display_name, level, xp, streak')
        .eq('id', session.user.id)
        .maybeSingle()
      if (error) throw error
      setProfile(toProfileInfo(data))
      setLoadError(false)
      setLoadedFor(session.user.id)
      return true
    } catch {
      setLoadError(true)
      setLoadedFor(session.user.id)
      return false
    }
  }, [session])

  useEffect(() => {
    if (!supabase || !session) return
    let cancelled = false

    void (async () => {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('display_name, level, xp, streak')
          .eq('id', session.user.id)
          .maybeSingle()
        if (cancelled) return
        if (error) throw error
        setProfile(toProfileInfo(data))
        setLoadError(false)
        setLoadedFor(session.user.id)
      } catch {
        if (cancelled) return
        setLoadError(true)
        setLoadedFor(session.user.id)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [session])

  return { ...profile, status, refresh, retry }
}
