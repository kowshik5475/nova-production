import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '@/lib/supabase/client'
import type { Session } from '@supabase/supabase-js'
import type {
  ChatAttachment,
  ChatMedia,
  ChatMessage,
  ChatMode,
  Conversation,
  PostGameContext,
} from './types'
import {
  createConversation,
  deleteConversation,
  listConversations,
  renameConversation,
} from '@/lib/supabase/conversations'
import { downloadMarkdown, conversationToMarkdown } from './export'
import MarkdownText from './MarkdownText'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

const ATTACHMENT_BUCKET = 'chat-attachments'
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const HISTORY_LIMIT = 50

// UI-only suggestion the player can choose. It is never sent on its own and it
// never carries reward values — the server re-derives all context.
const POST_GAME_SUGGESTION: Record<PostGameContext['game'], { label: string; prompt: string }> = {
  tictactoe: {
    label: 'Tic-Tac-Toe',
    prompt: 'I just finished a Tic-Tac-Toe game — how did I do, and what should I work on next?',
  },
  sudoku: {
    label: 'Sudoku',
    prompt: 'I just completed a Sudoku puzzle — how is my progress, and what should I try next?',
  },
  'ball-run': {
    label: 'Ball Run',
    prompt: 'I just finished a Ball Run — how did my run look, and how can I survive longer?',
  },
  'water-sort': {
    label: 'Water Sort',
    prompt: 'I just solved a Water Sort puzzle — how efficient were my moves, and what should I try next?',
  },
}

const MODE_LABELS: Record<ChatMode, string> = {
  chat: 'Chat',
  vision: 'See',
  image: 'Draw',
  speech: 'Speak',
}

const MODE_HINTS: Record<ChatMode, string> = {
  chat: 'Ask NOVA anything — text only.',
  vision: 'Attach an image and ask NOVA about it.',
  image: 'Describe a picture and NOVA will draw it.',
  speech: 'NOVA replies with text and a spoken summary.',
}

type Wallet = {
  earnedCoins: number
  aiCredits: number
  isDemo: boolean
  loading: boolean
  error: string | null
  spendCredit: () => void
  refresh: () => Promise<void>
  exchangeCoins: () => Promise<void>
}

const WELCOME_MESSAGE: ChatMessage = {
  id: 'welcome',
  role: 'nova',
  text: 'I am NOVA, your AI companion. I can see your game progress and help you improve. Ask me anything — about your stats, strategy tips, or any topic you like.',
  created_at: new Date().toISOString(),
}

type HistoryRow = {
  id: string
  role: string
  content: string
  created_at: string
  media_path?: string | null
  media_kind?: string | null
}

function mapHistory(rows: HistoryRow[]): ChatMessage[] {
  return rows.map((row) => ({
    id: row.id,
    role: row.role === 'assistant' ? 'nova' : 'you',
    text: row.content,
    created_at: row.created_at,
    media:
      row.media_path && row.media_kind
        ? { path: row.media_path, kind: row.media_kind as ChatMedia['kind'] }
        : null,
  }))
}

function readUrlConversation(): string | null {
  if (typeof window === 'undefined') return null
  const value = new URLSearchParams(window.location.search).get('conversation')
  return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null
}

function writeUrlConversation(id: string | null) {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (id) url.searchParams.set('conversation', id)
  else url.searchParams.delete('conversation')
  window.history.replaceState({}, '', url.toString())
}

function getDemoReply(input: string): string {
  const lower = input.toLowerCase()
  if (lower.includes('gpt')) {
    return 'GPT (Generative Pre-trained Transformer) is a family of large language models developed by OpenAI. GPT models are trained on vast amounts of text data and can generate human-like text, answer questions, write code, and more. The most well-known versions are GPT-3.5, GPT-4, and GPT-4o.'
  }
  if (lower.includes('python')) {
    return 'Python is a high-level, interpreted programming language known for its simple syntax and readability. It\'s widely used in web development, data science, AI/ML, automation, and scripting. Popular frameworks include Django, Flask, NumPy, and PyTorch.'
  }
  if (lower.includes('joke')) {
    return 'Why do programmers prefer dark mode? Because light attracts bugs.'
  }
  if (lower.includes('recursion')) {
    return 'Recursion is a technique where a function calls itself to solve a problem by breaking it into smaller sub-problems. Each recursive call works on a reduced input until reaching a base case. Think of Russian nesting dolls — each one contains a smaller version of itself.'
  }
  if (lower.includes('how am i doing') || lower.includes('my progress') || lower.includes('stats')) {
    return 'In demo mode, your real stats aren\'t loaded. Sign in and play some games to see your actual progress — I can give you a detailed breakdown of your Tic-Tac-Toe and Sudoku performance.'
  }
  if (lower.includes('improve') || lower.includes('get better')) {
    return 'To improve at Tic-Tac-Toe: always take the center first, then control corners. For Sudoku: scan rows and columns for missing numbers, use pencil marks for candidates, and look for hidden singles. Practice both regularly!'
  }
  return `I received your message: "${input}". In demo mode, I can only respond to a few topics. Sign in with real credits to chat freely — I can discuss anything and track your game progress.`
}

export default function Chat({
  session,
  wallet,
  postGame,
  onPostGameConsumed,
}: {
  session: Session | null
  wallet: Wallet
  postGame: PostGameContext | null
  onPostGameConsumed: () => void
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME_MESSAGE])
  const [prompt, setPrompt] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [streamingText, setStreamingText] = useState('')
  const [mode, setMode] = useState<ChatMode>('chat')
  const [attachment, setAttachment] = useState<ChatAttachment | null>(null)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(() => readUrlConversation())
  const [threadsError, setThreadsError] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({})
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const chatRetryRef = useRef<{ message: string; idempotencyKey: string } | null>(null)
  const [hasRetry, setHasRetry] = useState(false)
  const activeIdRef = useRef<string | null>(activeId)
  const justCreatedRef = useRef<string | null>(null)
  const historyRunRef = useRef(0)

  // The active thread survives navigation through the URL, never through
  // local/session storage — a refresh deliberately returns to the newest thread.
  useEffect(() => {
    writeUrlConversation(activeId)
  }, [activeId])

  const refreshThreads = useCallback(async () => {
    if (!supabase || !session) return
    try {
      const rows = await listConversations()
      setThreadsError(null)
      setConversations(rows)
      setActiveId((current) => {
        if (current && rows.some((row) => row.id === current)) return current
        const fromUrl = readUrlConversation()
        if (fromUrl && rows.some((row) => row.id === fromUrl)) return fromUrl
        return rows[0]?.id ?? null
      })
    } catch {
      setThreadsError('Conversations are unavailable right now.')
    }
  }, [session])

  useEffect(() => {
    void refreshThreads()
  }, [refreshThreads])

  const loadHistory = useCallback(
    async (conversationId: string) => {
      if (!supabase || !session) return
      const run = ++historyRunRef.current
      try {
        const { data, error } = await supabase.rpc('get_chat_history', {
          p_limit: HISTORY_LIMIT,
          p_conversation_id: conversationId,
        })
        if (error) throw error
        if (historyRunRef.current !== run) return
        const loaded = mapHistory((data ?? []) as HistoryRow[])
        setMessages((prev) => {
          const welcome = prev.find((m) => m.id === 'welcome')
          return loaded.length > 0 ? loaded : welcome ? [welcome] : [WELCOME_MESSAGE]
        })
      } catch {
        // History is non-critical — the composer still works.
      }
    },
    [session],
  )

  useEffect(() => {
    const prev = activeIdRef.current
    activeIdRef.current = activeId
    if (!activeId || !supabase || !session) return
    if (prev === activeId) return
    if (prev === null && justCreatedRef.current === activeId) return
    setChatError(null)
    setStreamingText('')
    setAttachment(null)
    void loadHistory(activeId)
  }, [activeId, session, loadHistory])

  // Signed URLs for private media. Never persisted, only kept in memory.
  useEffect(() => {
    const client = supabase
    if (!client) return
    let cancelled = false
    const missing = messages
      .map((m) => m.media?.path)
      .filter((p): p is string => Boolean(p) && !mediaUrls[p as string])
    if (missing.length === 0) return
    void Promise.all(
      missing.map(async (path) => {
        const { data } = await client.storage.from(ATTACHMENT_BUCKET).createSignedUrl(path, 3600)
        return data?.signedUrl ? ([path, data.signedUrl] as const) : null
      }),
    ).then((pairs) => {
      if (cancelled) return
      const next = { ...mediaUrls }
      let changed = false
      for (const pair of pairs) {
        if (pair) {
          next[pair[0]] = pair[1]
          changed = true
        }
      }
      if (changed) setMediaUrls(next)
    })
    return () => {
      cancelled = true
    }
  }, [messages, mediaUrls])

  function retryChat() {
    if (!chatRetryRef.current) return
    setPrompt(chatRetryRef.current.message)
    setChatError(null)
  }

  async function pickAttachment(file: File | null) {
    setAttachmentError(null)
    if (!file) {
      setAttachment(null)
      return
    }
    if (!IMAGE_TYPES.includes(file.type)) {
      setAttachmentError('Use a PNG, JPEG, WebP or GIF image.')
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setAttachmentError('Images must be 5 MB or smaller.')
      return
    }
    if (!supabase || !session) {
      setAttachmentError('Sign in to attach images.')
      return
    }
    setUploading(true)
    try {
      const extension = file.name.split('.').pop()?.toLowerCase() || 'png'
      // Owner folder first: storage RLS only allows ${uid}/<object>.
      const path = `${session.user.id}/${crypto.randomUUID()}.${extension}`
      const { error } = await supabase.storage.from(ATTACHMENT_BUCKET).upload(path, file, {
        contentType: file.type,
        upsert: false,
      })
      if (error) throw error
      setAttachment({ path, name: file.name, mimeType: file.type, size: file.size })
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : 'Could not upload the image.')
    } finally {
      setUploading(false)
    }
  }

  async function startNewConversation() {
    if (!supabase || !session) {
      setMessages([WELCOME_MESSAGE])
      return
    }
    try {
      // Default title so finalize's first-turn auto-title rule can fire.
      const created = await createConversation()
      justCreatedRef.current = created.id
      setConversations((prev) => [created, ...prev.filter((row) => row.id !== created.id)])
      setMessages([WELCOME_MESSAGE])
      setChatError(null)
      setStreamingText('')
      setAttachment(null)
      setActiveId(created.id)
    } catch (err) {
      setThreadsError(err instanceof Error ? err.message : 'Could not start a new chat.')
    }
  }

  async function selectConversation(id: string) {
    setSidebarOpen(false)
    if (id === activeIdRef.current) {
      return
    }
    activeIdRef.current = id
    setChatError(null)
    setStreamingText('')
    setAttachment(null)
    await loadHistory(id)
    setActiveId(id)
  }

  async function commitRename(id: string) {
    try {
      const updated = await renameConversation(id, renameValue)
      setConversations((prev) => prev.map((row) => (row.id === id ? updated : row)))
      setRenamingId(null)
      setThreadsError(null)
    } catch (err) {
      setThreadsError(err instanceof Error ? err.message : 'Could not rename the conversation.')
    }
  }

  async function removeConversation(id: string) {
    try {
      await deleteConversation(id)
      const remaining = conversations.filter((row) => row.id !== id)
      setConversations(remaining)
      if (activeId === id) {
        justCreatedRef.current = null
        setMessages([WELCOME_MESSAGE])
        setActiveId(remaining[0]?.id ?? null)
      }
    } catch (err) {
      setThreadsError(err instanceof Error ? err.message : 'Could not delete the conversation.')
    }
  }

  function exportConversation() {
    const title =
      conversations.find((row) => row.id === activeId)?.title ?? 'NOVA conversation'
    downloadMarkdown(
      `${title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'nova-chat'}.md`,
      conversationToMarkdown(title, messages),
    )
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault()
    const text = prompt.trim()
    if (!text || wallet.aiCredits < 1 || chatSending) return
    if (mode === 'vision' && !attachment) {
      setChatError('Attach an image before sending in See mode.')
      return
    }

    // Demo mode: local echo
    if (!supabase || !session) {
      const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'you', text, created_at: new Date().toISOString() }
      const demoReply = getDemoReply(text)
      const novaMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'nova',
        text: demoReply,
        created_at: new Date().toISOString(),
      }
      setMessages((prev) => [...prev, userMsg, novaMsg])
      setPrompt('')
      wallet.spendCredit()
      return
    }

    setChatSending(true)
    setChatError(null)
    setStreamingText('')
    const idempotencyKey = chatRetryRef.current?.idempotencyKey ?? crypto.randomUUID()
    // One-time post-game re-entry: snapshot so this request (and its retry)
    // references the same session. The server re-derives everything from it.
    const context = postGame
    const tReq = Date.now()
    console.log('nova-client: request-start')

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'you',
      text,
      created_at: new Date().toISOString(),
      media: attachment ? { path: attachment.path, kind: 'image_input' } : null,
    }
    setMessages((prev) => [...prev, userMsg])
    try {
      const { data: { session: currentSession } } = await supabase.auth.getSession()
      if (!currentSession?.access_token) throw new Error('Not authenticated')

      // A first message opens a thread so the reply lands somewhere durable.
      let conversationId = activeId
      if (!conversationId) {
        try {
          const created = await createConversation(text)
          conversationId = created.id
          justCreatedRef.current = created.id
          setConversations((prev) => [created, ...prev])
          setActiveId(created.id)
        } catch {
          conversationId = null
        }
      }

      const response = await fetch(`${supabaseUrl}/functions/v1/nova-chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${currentSession.access_token}`,
          'apikey': supabaseAnonKey,
        },
        body: JSON.stringify({
          message: text,
          idempotencyKey,
          ...(context ? { gameSessionId: context.sessionId } : {}),
          conversationId,
          mode,
          attachmentPath: attachment?.path ?? null,
        }),
      })

      if (!response.ok) {
        const errData = await response.json().catch(() => null)
        throw new Error(errData?.error || `HTTP ${response.status}`)
      }

      // A completed idempotency key replays as plain JSON instead of an SSE
      // stream — the server never regenerates the same reply twice.
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('application/json')) {
        const replay = (await response.json()) as { reply?: string; media?: ChatMedia | null }
        if (!replay.reply) throw new Error('Replay returned no reply — retry to continue')
        const replyText: string = replay.reply
        const replyMedia: ChatMedia | null = replay.media?.path ? replay.media : null
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'nova',
            text: replyText,
            created_at: new Date().toISOString(),
            media: replyMedia,
          },
        ])
        setStreamingText('')
        setPrompt('')
        setAttachment(null)
        chatRetryRef.current = null
        setHasRetry(false)
        wallet.refresh()
        void refreshThreads()
        if (context) onPostGameConsumed()
        console.log('nova-client: ui-complete=%dms', Date.now() - tReq)
        return
      }

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let accumulatedText = ''
      let firstChunkTime: number | null = null
      let sawDone = false
      let pendingMedia: ChatMedia | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const jsonStr = line.slice(6).trim()
          if (!jsonStr) continue

          let data: Record<string, unknown>
          try {
            data = JSON.parse(jsonStr) as Record<string, unknown>
          } catch {
            continue
          }

          if (data.text !== undefined) {
            if (!firstChunkTime) {
              firstChunkTime = Date.now()
              console.log('nova-client: first-chunk=%dms', firstChunkTime - tReq)
            }
            accumulatedText += String(data.text)
            setStreamingText(accumulatedText)
          } else if (data.media !== undefined && data.wallet === undefined) {
            const media = data.media as ChatMedia | null
            pendingMedia = media && media.path ? media : pendingMedia
          } else if (data.wallet !== undefined) {
            // Done event
            sawDone = true
            console.log('nova-client: stream-complete=%dms', Date.now() - tReq)
            const finalMedia =
              pendingMedia ??
              (data.media && (data.media as ChatMedia)?.path
                ? (data.media as ChatMedia)
                : null)
            const novaMsg: ChatMessage = {
              id: crypto.randomUUID(),
              role: 'nova',
              text: accumulatedText,
              created_at: new Date().toISOString(),
              media: finalMedia,
            }
            setMessages((prev) => [...prev, novaMsg])
            setStreamingText('')
            setPrompt('')
            setAttachment(null)
            chatRetryRef.current = null
            setHasRetry(false)
            wallet.refresh()
            void refreshThreads()
            // Consumed exactly once — the next message sends no session ref.
            if (context) onPostGameConsumed()
            console.log('nova-client: ui-complete=%dms', Date.now() - tReq)
          } else if (data.message !== undefined) {
            throw new Error(String(data.message))
          }
        }
      }

      if (!sawDone) {
        // Connection ended before the server sent done — keep the same
        // idempotency key so retry replays or re-runs safely.
        throw new Error('Connection closed before the reply finished — retry to continue')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not send message'
      setChatError(msg)
      setStreamingText('')
      chatRetryRef.current = { message: text, idempotencyKey }
      setHasRetry(true)
      // Nova never received it — drop the optimistic bubble so the retry's
      // own bubble is not a duplicate.
      setMessages((prev) => prev.filter((m) => m.id !== userMsg.id))
    } finally {
      setChatSending(false)
    }
  }

  const mediaDisabled = mode === 'vision' && (!attachment || uploading)

  return (
    <div className="chat-layout">
      <button
        type="button"
        className="chat-sidebar-toggle"
        onClick={() => setSidebarOpen((open) => !open)}
        aria-expanded={sidebarOpen}
        aria-controls="chat-threads"
      >
        {sidebarOpen ? 'Hide threads' : 'Threads'}
      </button>

      <aside className={`chat-sidebar${sidebarOpen ? ' is-open' : ''}`} id="chat-threads">
        <button type="button" className="chat-new-thread" onClick={() => void startNewConversation()}>
          New chat
        </button>
        {threadsError && (
          <p className="chat-threads-error" role="status">{threadsError}</p>
        )}
        <ul className="chat-thread-list">
          {conversations.map((row) => (
            <li key={row.id} className={row.id === activeId ? 'is-active' : undefined}>
              {renamingId === row.id ? (
                <form
                  className="chat-thread-rename"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void commitRename(row.id)
                  }}
                >
                  <input
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    aria-label="Conversation title"
                    autoFocus
                  />
                  <button type="submit">Save</button>
                  <button type="button" onClick={() => setRenamingId(null)}>Cancel</button>
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    className="chat-thread"
                    onClick={() => void selectConversation(row.id)}
                    aria-current={row.id === activeId ? 'true' : undefined}
                    title={row.title}
                  >
                    {row.title}
                  </button>
                  <span className="chat-thread-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setRenamingId(row.id)
                        setRenameValue(row.title)
                      }}
                      aria-label={`Rename ${row.title}`}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeConversation(row.id)}
                      aria-label={`Delete ${row.title}`}
                    >
                      Delete
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
          {conversations.length === 0 && (
            <li className="chat-thread-empty">No conversations yet.</li>
          )}
        </ul>
      </aside>

      <section className="chat-panel">
        <p className="eyebrow">NOVA CONVERSATION</p>
        <h1>Ask NOVA.</h1>
        <p className="lede">
          {wallet.aiCredits > 0
            ? `You have ${wallet.aiCredits} AI credit${wallet.aiCredits !== 1 ? 's' : ''}. Each message costs 1 credit.`
            : 'Exchange 10 NOVA Coins for 1 AI credit to start chatting.'}
        </p>

        <div className="chat-toolbar">
          <div className="chat-modes" role="group" aria-label="Reply mode">
            {(Object.keys(MODE_LABELS) as ChatMode[]).map((value) => (
              <button
                key={value}
                type="button"
                className={mode === value ? 'is-active' : ''}
                onClick={() => {
                  setMode(value)
                  setAttachmentError(null)
                }}
                aria-pressed={mode === value}
              >
                {MODE_LABELS[value]}
              </button>
            ))}
          </div>
          <span className="chat-mode-hint" role="status">{MODE_HINTS[mode]}</span>
          <button
            type="button"
            className="chat-export"
            onClick={exportConversation}
            disabled={messages.length <= 1}
          >
            Export
          </button>
        </div>

        {chatError && (
          <div className="chat-error" role="alert">
            <span>{chatError}</span>
            <div className="chat-error-actions">
              {hasRetry && (
                <button onClick={retryChat}>Retry</button>
              )}
              <button onClick={() => { setChatError(null); chatRetryRef.current = null; setHasRetry(false) }}>Dismiss</button>
            </div>
          </div>
        )}

        <div className="chat-log">
          {messages.map((message) => (
            <div key={message.id} className={`chat-message ${message.role}`}>
              <b>{message.role === 'nova' ? 'NOVA' : 'YOU'}</b>
              {message.media?.kind === 'image_input' && mediaUrls[message.media.path] && (
                <img className="chat-media" src={mediaUrls[message.media.path]} alt="Attached image" />
              )}
              {message.media?.kind === 'image_output' && mediaUrls[message.media.path] && (
                <img className="chat-media" src={mediaUrls[message.media.path]} alt="Generated by NOVA" />
              )}
              {message.media?.kind === 'audio_output' && mediaUrls[message.media.path] && (
                <audio className="chat-audio" controls src={mediaUrls[message.media.path]} />
              )}
              {message.role === 'nova' ? (
                <MarkdownText text={message.text} />
              ) : (
                message.text
              )}
            </div>
          ))}
          {chatSending && streamingText && (
            <div className="chat-message nova" aria-live="polite" aria-atomic="true">
              <b>NOVA</b>
              <MarkdownText text={streamingText} />
            </div>
          )}
          {chatSending && !streamingText && (
            <div className="chat-message nova chat-thinking" role="status" aria-live="polite" aria-atomic="true">
              <b>NOVA</b>
              <span className="thinking-dots">Thinking</span>
            </div>
          )}
          {!chatSending && !streamingText && (
            <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
              {messages.length > 1 ? 'NOVA response received' : ''}
            </div>
          )}
        </div>

        {postGame && !chatSending && (
          <div className="chat-postgame">
            <span className="chat-postgame-label">
              Just completed {POST_GAME_SUGGESTION[postGame.game].label} — ask NOVA about it?
            </span>
            <button
              type="button"
              onClick={() => setPrompt(POST_GAME_SUGGESTION[postGame.game].prompt)}
            >
              Suggest a message
            </button>
          </div>
        )}

        {mode === 'vision' && (
          <div className="chat-attach">
            <label htmlFor="chat-attachment" className="chat-attach-label">
              {attachment ? attachment.name : 'Choose an image'}
            </label>
            <input
              id="chat-attachment"
              type="file"
              accept={IMAGE_TYPES.join(',')}
              onChange={(event) => void pickAttachment(event.target.files?.[0] ?? null)}
              disabled={uploading || chatSending}
            />
            {attachment && (
              <button
                type="button"
                onClick={() => {
                  setAttachment(null)
                  setAttachmentError(null)
                }}
                disabled={chatSending}
              >
                Remove
              </button>
            )}
            {uploading && <span role="status">Uploading…</span>}
            {attachmentError && <span className="chat-attach-error" role="alert">{attachmentError}</span>}
          </div>
        )}

        <form className="composer" onSubmit={sendMessage}>
          <label htmlFor="chat-prompt" className="visually-hidden">
            Message for NOVA
          </label>
          <input
            id="chat-prompt"
            name="prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={
              !wallet.aiCredits
                ? 'Exchange coins to unlock chat'
                : chatSending
                  ? 'NOVA is responding…'
                  : 'Ask me anything…'
            }
            aria-label="Message for NOVA"
            disabled={!wallet.aiCredits || chatSending}
          />
          <button
            type="submit"
            disabled={!wallet.aiCredits || chatSending || !prompt.trim() || mediaDisabled}
            aria-label={chatSending ? 'Sending message' : 'Send message, costs 1 AI credit'}
          >
            {chatSending ? 'Sending…' : 'Send · 1 credit'}
          </button>
        </form>
      </section>
    </div>
  )
}
