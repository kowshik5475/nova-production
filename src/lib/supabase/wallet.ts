import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase/client'

export interface WalletState {
  earnedCoins: number
  aiCredits: number
  loading: boolean
  error: string | null
  isDemo: boolean
  exchangeCoins: () => Promise<void>
  spendCredit: () => void
  refresh: () => Promise<void>
}

export function useWallet(session: Session | null): WalletState {
  const isDemo = !supabase || !session

  const [earnedCoins, setEarnedCoins] = useState(isDemo ? 20 : 0)
  const [aiCredits, setAiCredits] = useState(isDemo ? 0 : 0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  // Sticky key: reuse across retries until the exchange is confirmed so a
  // lost response cannot double-spend the same logical exchange.
  const pendingExchangeKeyRef = useRef<string | null>(null)

  // ── Fetch wallet from Supabase ─────────────────────────────
  const fetchWallet = useCallback(async () => {
    if (!supabase || !session) return
    setLoading(true)
    setError(null)
    try {
      const { data, error: fetchErr } = await supabase
        .from('wallet')
        .select('earned_coins, ai_credits')
        .eq('user_id', session.user.id)
        .maybeSingle()
      if (fetchErr) throw fetchErr
      if (mountedRef.current && data) {
        setEarnedCoins(data.earned_coins)
        setAiCredits(data.ai_credits)
      }
    } catch (err: unknown) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load wallet')
      }
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [session])

  // ── Load wallet on mount / session change ───────────────────
  useEffect(() => {
    mountedRef.current = true
    if (supabase && session) {
      fetchWallet()
    }
    return () => { mountedRef.current = false }
  }, [session, fetchWallet])

  // ── Exchange 10 coins → 1 credit via edge function ──────────
  const exchangeCoins = useCallback(async () => {
    if (!supabase || !session) {
      // Demo mode: local state only
      setEarnedCoins((c) => c - 10)
      setAiCredits((c) => c + 1)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const idempotencyKey = pendingExchangeKeyRef.current ?? crypto.randomUUID()
      pendingExchangeKeyRef.current = idempotencyKey
      const { error: rpcErr } = await supabase.functions.invoke('exchange-nova-coins', {
        body: { idempotencyKey },
      })
      if (rpcErr) throw rpcErr
      pendingExchangeKeyRef.current = null
      await fetchWallet()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Exchange failed'
      if (mountedRef.current) setError(msg)
      throw err
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [session, fetchWallet])

  // ── Public refresh ──────────────────────────────────────────
  const refresh = useCallback(async () => {
    if (supabase && session) await fetchWallet()
  }, [session, fetchWallet])

  // ── Deduct one credit locally (demo mode) ──────────────────
  const spendCredit = useCallback(() => {
    if (!supabase || !session) {
      setAiCredits((c) => Math.max(0, c - 1))
    }
  }, [session])

  return { earnedCoins, aiCredits, loading, error, isDemo, exchangeCoins, spendCredit, refresh }
}
