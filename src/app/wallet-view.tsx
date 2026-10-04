import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase/client'
import type { WalletTransaction } from './types'
import { formatDate } from './utils'

type Wallet = {
  earnedCoins: number
  aiCredits: number
  isDemo: boolean
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  exchangeCoins: () => Promise<void>
}

const TYPE_LABELS: Record<string, string> = {
  GAME_REWARD: 'Game reward',
  AI_USAGE: 'AI message',
  COIN_EXCHANGE: 'Coin exchange',
  DAILY_LOGIN: 'Daily login',
  OTHER_VALIDATED_REWARD: 'Validated reward',
}

const CURRENCY_LABELS: Record<string, string> = {
  NOVA_COIN: 'NOVA Coins',
  AI_CREDIT: 'AI Credits',
}

// What actually caused the movement — written by the server that paid it.
const SOURCE_LABELS: Record<string, string> = {
  AI_CHAT: 'Chat with NOVA',
  COIN_EXCHANGE: 'Coin exchange',
  TICTACTOE_WIN: 'Tic-Tac-Toe win',
  SUDOKU_WIN: 'Sudoku win',
  BALL_RUN_WIN: 'Ball Run win',
  WATER_SORT_WIN: 'Water Sort win',
  DAILY_LOGIN: 'Daily login',
  OTHER_VALIDATED_REWARD: 'Validated reward',
}

const HISTORY_LIMIT = 30

function txTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? 'Transaction'
}

function txSourceLabel(source: string | null): string | null {
  if (!source) return null
  return SOURCE_LABELS[source] ?? source
}

function txCurrencyLabel(currency: string): string {
  return CURRENCY_LABELS[currency] ?? currency
}

function txAmountText(amount: number): string {
  return amount > 0 ? `+${amount}` : String(amount)
}

// One row per id: a reload that overlaps an in-flight one must never double
// a transaction in the ledger view.
function dedupeTransactions(rows: WalletTransaction[]): WalletTransaction[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    if (seen.has(row.id)) return false
    seen.add(row.id)
    return true
  })
}

export default function WalletView({
  session,
  wallet,
  addToast,
}: {
  session: Session | null
  wallet: Wallet
  addToast: (kind: 'success' | 'error', text: string) => void
}) {
  const [exchangeBusy, setExchangeBusy] = useState(false)
  const [transactions, setTransactions] = useState<WalletTransaction[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyReady, setHistoryReady] = useState(false)
  const mountedRef = useRef(true)

  const loadHistory = useCallback(async () => {
    if (!supabase || !session || wallet.isDemo) {
      setTransactions([])
      setHistoryError(null)
      setHistoryLoading(false)
      setHistoryReady(true)
      return
    }
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const { data, error: fetchErr } = await supabase
        .from('wallet_transactions')
        .select('id, type, amount, currency, source, created_at')
        .eq('user_id', session.user.id)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(HISTORY_LIMIT)
      if (fetchErr) throw fetchErr
      if (mountedRef.current) {
        setTransactions(dedupeTransactions(data ?? []))
        setHistoryReady(true)
      }
    } catch {
      if (mountedRef.current) {
        setHistoryError('Could not load transaction history')
        setTransactions([])
        setHistoryReady(true)
      }
    } finally {
      if (mountedRef.current) setHistoryLoading(false)
    }
  }, [session, wallet.isDemo])

  useEffect(() => {
    mountedRef.current = true
    let cancelled = false

    async function run() {
      // Defer state updates so the effect body itself stays sync-safe.
      await Promise.resolve()
      if (cancelled || !mountedRef.current) return

      if (!supabase || !session || wallet.isDemo) {
        setTransactions([])
        setHistoryError(null)
        setHistoryLoading(false)
        setHistoryReady(true)
        return
      }

      setHistoryReady(false)
      setHistoryLoading(true)
      setHistoryError(null)
      try {
        const { data, error: fetchErr } = await supabase
          .from('wallet_transactions')
          .select('id, type, amount, currency, source, created_at')
          .eq('user_id', session.user.id)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(HISTORY_LIMIT)
        if (fetchErr) throw fetchErr
        if (!cancelled && mountedRef.current) {
          setTransactions(dedupeTransactions(data ?? []))
          setHistoryReady(true)
        }
      } catch {
        if (!cancelled && mountedRef.current) {
          setHistoryError('Could not load transaction history')
          setTransactions([])
          setHistoryReady(true)
        }
      } finally {
        if (!cancelled && mountedRef.current) setHistoryLoading(false)
      }
    }

    void run()

    return () => {
      cancelled = true
      mountedRef.current = false
    }
  }, [session, wallet.isDemo])

  async function handleExchange() {
    if (wallet.earnedCoins < 10 || exchangeBusy) return
    setExchangeBusy(true)
    try {
      await wallet.exchangeCoins()
      addToast('success', 'Exchanged 10 coins → 1 AI credit')
      setHistoryReady(false)
      await loadHistory()
    } catch {
      addToast('error', wallet.error || 'Exchange failed — try again')
    } finally {
      setExchangeBusy(false)
    }
  }

  const showLoading = !historyReady && !historyError
  const showEmpty = historyReady && !historyLoading && !historyError && transactions.length === 0

  return (
    <>
      <p className="eyebrow">YOUR WALLET</p>
      <h1>Fuel your AI conversations.</h1>
      <div className="wallet-grid">
        <article>
          <p>NOVA COINS</p>
          <strong>{wallet.earnedCoins}</strong>
          <small>Earned by winning games</small>
        </article>
        <article>
          <p>AI CREDITS</p>
          <strong>{wallet.aiCredits}</strong>
          <small>One credit powers one message</small>
        </article>
      </div>
      <article className="exchange">
        <div>
          <p>EXCHANGE RATE</p>
          <h2>10 coins = 1 AI credit</h2>
          <small>Exchange coins to unlock chat with NOVA. Credits are consumed only when a message is sent successfully.</small>
        </div>
        <button
          onClick={handleExchange}
          disabled={wallet.earnedCoins < 10 || exchangeBusy}
          aria-label={exchangeBusy ? 'Exchanging coins' : wallet.earnedCoins < 10 ? `Need ${10 - wallet.earnedCoins} more NOVA Coins to exchange` : 'Exchange 10 NOVA Coins for 1 AI Credit'}
        >
          {exchangeBusy ? 'Exchanging…' : wallet.earnedCoins < 10 ? `Need ${10 - wallet.earnedCoins} more coins` : 'Exchange 10 coins'}
        </button>
      </article>
      {wallet.loading && (
        <p className="wallet-status" role="status" aria-live="polite">
          Syncing wallet…
        </p>
      )}
      {wallet.error && !exchangeBusy && (
        <p className="chat-error" role="alert">
          <span>{wallet.error}</span>
        </p>
      )}

      <p className="eyebrow" style={{ marginTop: 32 }}>TRANSACTION HISTORY</p>

      {showLoading && (
        <p className="wallet-status" role="status" aria-live="polite">
          Loading transactions…
        </p>
      )}

      {historyError && !historyLoading && (
        <div className="chat-error" role="alert">
          <span>{historyError}</span>
          <div className="chat-error-actions">
            <button type="button" onClick={() => { setHistoryReady(false); loadHistory() }}>
              Retry
            </button>
          </div>
        </div>
      )}

      {showEmpty && (
        <div className="wallet-history-empty">
          <p>No transactions yet</p>
          <small>Wallet activity will appear here after you earn or spend NOVA currency.</small>
        </div>
      )}

      {historyReady && !historyLoading && !historyError && transactions.length > 0 && (
        <div className="wallet-history">
          <div className="wallet-history-head" aria-hidden="true">
            <span>What changed</span>
            <span>Balance impact</span>
            <span>When</span>
          </div>
          {transactions.map((tx) => {
            const source = txSourceLabel(tx.source)
            return (
              <div key={tx.id} className="wallet-history-row">
                <span className="wallet-history-meta">
                  <span className="wallet-history-type">{txTypeLabel(tx.type)}</span>
                  {source && <span className="wallet-history-source">{source}</span>}
                </span>
                <span className={`wallet-history-amount ${tx.amount >= 0 ? 'wallet-history-amount-in' : 'wallet-history-amount-out'}`}>
                  {txAmountText(tx.amount)} {txCurrencyLabel(tx.currency)}
                </span>
                <span className="wallet-history-date">{formatDate(tx.created_at)}</span>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
