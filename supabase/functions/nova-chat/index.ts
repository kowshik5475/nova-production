import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildCorsHeaders, handlePreflight } from '../_shared/cors.ts'
import { buildRecentActivity, isUuid } from '../_shared/recent_activity.ts'
import {
  CHAT_MODES,
  checkImageAttachment,
  checkMessageText,
  MAX_IMAGE_BYTES,
  mediaObjectPath,
  normalizeMode,
  type ChatMode,
} from '../_shared/chat_modes.ts'
import { buildPersonalization } from '../_shared/personalization.ts'

// Model selection is configuration, never a hard-coded provider dependency.
// GEMINI_MODEL is retained as the legacy fallback so existing deployments keep
// working unchanged.
const TEXT_MODEL =
  Deno.env.get('GEMINI_TEXT_MODEL') || Deno.env.get('GEMINI_MODEL') || 'gemini-3.6-flash'
const VISION_MODEL = Deno.env.get('GEMINI_VISION_MODEL') || TEXT_MODEL
const IMAGE_MODEL = Deno.env.get('GEMINI_IMAGE_MODEL') || 'gemini-2.5-flash-image'
const TTS_MODEL = Deno.env.get('GEMINI_TTS_MODEL') || 'gemini-2.5-flash-preview-tts'
const TTS_SAMPLE_RATE = Number(Deno.env.get('GEMINI_TTS_SAMPLE_RATE') || 24000)

const ATTACHMENT_BUCKET = 'chat-attachments'
const CONVERSATION_HISTORY_LIMIT = 20

const SYSTEM_PROMPT = `You are NOVA, the AI companion inside NOVA AI Play.

Identity:
- Your name is NOVA. You are an AI companion built for NOVA AI Play.
- Never invent an acronym, expansion, or alternative meaning for "NOVA".
- If asked what your name means or what NOVA stands for, say you are simply NOVA — the AI companion inside NOVA AI Play.

Behavior:
- Answer the user's CURRENT message directly and specifically.
- Use the conversation history ONLY when it is relevant to the current question.
- Never assume the user asked a different question than the one they asked.
- Give concise, natural responses under 200 words unless the user asks for more detail.
- Be warm, supportive, and conversational.
- You can discuss any topic: technology, science, general knowledge, study help, gaming strategy, casual conversation, jokes, and more.
- Format answers in Markdown. Put code inside fenced blocks that name the language.

Player context:
- Player context is supplied in the system instruction as authoritative server data.
- Use it ONLY when the user asks about their progress, performance, or improvement.
- When the user asks a general question (e.g. "What is GPT?"), answer directly — do NOT redirect to games.
- If player information is unavailable, say so rather than guessing.
- Never invent player statistics, game results, XP, coins, credits, level, streak, or play history.
- When discussing stats, use ONLY the real numbers provided in the context.

Recent activity:
- A recentActivity block describes the player's most recently completed game for this conversation.
- It is authoritative server data for exactly one game — never treat it as a list or a history.
- Reference it only when it is relevant to the current message.
- Never invent another game result, reward, timestamp, XP, or coin amount.

Personalization:
- A Personalization block lists rules that fired for this player, each stating its own reason.
- Apply a rule only when it is relevant to what the user is asking.
- Never mention that a rule exists unless the user asks how you decide what to suggest.

Hard rules:
- Never claim to access external systems, make purchases, or perform actions outside this chat.
- Never fabricate data the user did not provide.
- If unsure about something, say so honestly.`

function sseEvent(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** Structured, minimal operational log — never message content, history, or secrets. */
function log(evt: string, fields: Record<string, string | number | boolean | null> = {}) {
  console.log(JSON.stringify({ evt, ...fields }))
}

function logErr(evt: string, fields: Record<string, string | number | boolean | null> = {}) {
  console.error(JSON.stringify({ evt, ...fields }))
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/** Wraps little-endian 16-bit mono PCM in a minimal RIFF/WAVE container. */
function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, pcm.length, true)
  const out = new Uint8Array(44 + pcm.length)
  out.set(new Uint8Array(header), 0)
  out.set(pcm, 44)
  return out
}

type SupabaseClient = ReturnType<typeof createClient>
type Media = { path: string; kind: 'image_input' | 'image_output' | 'audio_output' }

/**
 * Everything nova-chat will ever read from the request body. Fields are
 * routing + validation only: no outcome, reward, identity or context payload
 * can travel through them.
 */
type ChatRequestBody = {
  message?: string
  idempotencyKey?: string
  gameSessionId?: string
  conversationId?: string | null
  mode?: string
  attachmentPath?: string | null
}

function sseHeaders(cors: Record<string, string>): Record<string, string> {
  return {
    ...cors,
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  }
}

/** Persists the exchange, or refunds it. Returns an error message on failure. */
async function persistExchange(
  client: SupabaseClient,
  args: {
    requestId: string
    reserveRequestId: string | null
    userContent: string
    assistantContent: string
    chatMode: ChatMode
    media: Media | null
  },
): Promise<string | null> {
  const { error } = await client.rpc('finalize_chat_credit', {
    p_request_id: args.reserveRequestId,
    p_user_content: args.userContent,
    p_assistant_content: args.assistantContent,
    p_mode: args.chatMode,
    p_media_path: args.media?.path ?? null,
    p_media_kind: args.media?.kind ?? null,
  })

  if (error) {
    logErr('chat.finalize_fail', { requestId: args.requestId, code: 'finalize' })
    try {
      await client.rpc('release_chat_credit', { p_request_id: args.reserveRequestId })
    } catch {
      // Best-effort release
    }
    return 'Message generated but could not be saved -- credit released, try again'
  }
  return null
}

/**
 * Text-to-speech for `speech` mode. Returns the stored object path when the
 * provider answered, or null so the text reply is still finalised.
 */
async function synthesiseSpeech(
  client: SupabaseClient,
  geminiKey: string,
  text: string,
  userId: string,
  requestId: string,
): Promise<Media | null> {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
            },
          },
        }),
      },
    )
    if (!response.ok) {
      logErr('chat.tts_error', { requestId, status: response.status })
      return null
    }
    const payload = await response.json()
    const audioPart = payload?.candidates?.[0]?.content?.parts?.find(
      (p: { inlineData?: { data?: string } }) => Boolean(p?.inlineData?.data),
    )
    if (!audioPart?.inlineData?.data) return null

    const pcm = fromBase64(audioPart.inlineData.data)
    const wav = pcmToWav(pcm, TTS_SAMPLE_RATE)
    // Storage RLS only allows the owner's own folder — never a request id.
    const path = mediaObjectPath(userId, 'wav')
    const upload = await client.storage.from(ATTACHMENT_BUCKET).upload(path, wav, {
      contentType: 'audio/wav',
      upsert: false,
    })
    if (upload.error) {
      logErr('chat.media_upload_fail', { requestId, code: 'audio' })
      return null
    }
    return { path, kind: 'audio_output' }
  } catch {
    return null
  }
}

Deno.serve(async (request) => {
  const preflight = handlePreflight(request)
  if (preflight) return preflight
  const cors = buildCorsHeaders(request)

  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: cors })
  }

  const t0 = Date.now()
  const requestId = crypto.randomUUID().slice(0, 8)

  // -- Authenticate --------------------------------------------------
  const authHeader = request.headers.get('Authorization')
  if (!authHeader) {
    return Response.json({ error: 'Authentication required' }, { status: 401, headers: cors })
  }

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

  const client: SupabaseClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })

  const {
    data: { user },
    error: authError,
  } = await client.auth.getUser()
  if (authError || !user) {
    return Response.json({ error: 'Invalid session' }, { status: 401, headers: cors })
  }

  const geminiKey = Deno.env.get('GEMINI_API_KEY')
  if (!geminiKey) {
    return Response.json({ error: 'AI provider not configured' }, { status: 500, headers: cors })
  }

  let reserveRequestId: string | null = null
  let creditHeld = false

  try {
    const body = await request.json()
    const { message, idempotencyKey, gameSessionId, conversationId, mode, attachmentPath } = body as ChatRequestBody

    // -- Validate ----------------------------------------------------
    const textCheck = checkMessageText(message)
    if (!textCheck.ok) {
      return Response.json({ error: textCheck.error }, { status: 400, headers: cors })
    }
    const trimmed = textCheck.text
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      return Response.json({ error: 'idempotencyKey is required' }, { status: 400, headers: cors })
    }

    const chatMode = normalizeMode(mode)
    if (!chatMode) {
      return Response.json({ error: 'Unknown chat mode' }, { status: 400, headers: cors })
    }
    if (!CHAT_MODES.includes(chatMode)) {
      return Response.json({ error: 'Unknown chat mode' }, { status: 400, headers: cors })
    }

    if (conversationId !== undefined && conversationId !== null && !isUuid(conversationId)) {
      return Response.json(
        { error: 'conversationId must be a valid UUID' },
        { status: 400, headers: cors },
      )
    }
    const targetConversation: string | null =
      typeof conversationId === 'string' && isUuid(conversationId) ? conversationId : null

    // Vision is the only mode that accepts an uploaded image, and the object
    // must already live in this user's own folder.
    let inputAttachment: { path: string; mimeType: string } | null = null
    if (chatMode === 'vision') {
      if (!attachmentPath) {
        return Response.json(
          { error: 'An image is required for vision mode' },
          { status: 400, headers: cors },
        )
      }
      const { data: file, error: downloadErr } = await client.storage
        .from(ATTACHMENT_BUCKET)
        .download(attachmentPath)
      if (downloadErr || !file) {
        return Response.json({ error: 'Attachment could not be read' }, { status: 400, headers: cors })
      }
      const check = checkImageAttachment({
        path: attachmentPath,
        ownerId: user.id,
        mimeType: file.type,
        bytes: file.size,
      })
      if (!check.ok) {
        return Response.json({ error: check.error }, { status: 400, headers: cors })
      }
      inputAttachment = { path: check.path, mimeType: file.type }
    } else if (attachmentPath) {
      return Response.json(
        { error: 'Attachments are only supported in vision mode' },
        { status: 400, headers: cors },
      )
    }

    log('chat.start', {
      requestId,
      userId: user.id,
      op: chatMode,
      conversation: targetConversation ? 'threaded' : 'none',
    })

    // -- Idempotent retry: return stored reply if completed ---------
    const { data: existingState } = await client.rpc('get_chat_request_state', {
      p_idempotency_key: idempotencyKey,
    })

    const existing = existingState?.[0]
    if (existing?.state === 'completed' && existing.assistant_reply) {
      const { data: wallet } = await client
        .from('wallet')
        .select('earned_coins, ai_credits')
        .eq('user_id', user.id)
        .maybeSingle()

      log('chat.retry', { requestId, userId: user.id, result: 'replayed' })
      return Response.json(
        {
          reply: existing.assistant_reply,
          wallet: wallet ?? { earned_coins: 0, ai_credits: 0 },
          media: existing.media_path
            ? { path: existing.media_path, kind: existing.media_kind ?? 'image_output' }
            : null,
          retried: true,
        },
        { headers: cors },
      )
    }

    // -- Load profile context ----------------------------------------
    const { data: profile } = await client
      .from('profiles')
      .select('display_name, level, xp, streak')
      .eq('id', user.id)
      .maybeSingle()

    const { data: progressRows } = await client
      .from('game_progress')
      .select('game_id, games_played, games_won, best_score')
      .eq('user_id', user.id)

    const { data: wallet } = await client
      .from('wallet')
      .select('earned_coins, ai_credits')
      .eq('user_id', user.id)
      .maybeSingle()

    const progressById = new Map<
      string,
      { games_played: number; games_won: number; best_score: number | null }
    >()
    for (const row of progressRows ?? []) {
      progressById.set(row.game_id, row)
    }

    const playerCtx: Record<string, unknown> = {}
    if (profile) {
      playerCtx.player = profile.display_name
      playerCtx.level = profile.level
      playerCtx.xp = profile.xp
      if (profile.streak) playerCtx.streak = profile.streak
    }

    const keys: Record<string, string> = {
      tictactoe: 'tictactoe',
      sudoku: 'sudoku',
      'ball-run': 'ballRun',
      'water-sort': 'waterSort',
    }
    for (const [gameId, key] of Object.entries(keys)) {
      const row = progressById.get(gameId)
      if (!row || row.games_played <= 0) continue
      const entry: Record<string, number> = { played: row.games_played, won: row.games_won }
      if (gameId === 'tictactoe') {
        entry.winRate = Math.round((row.games_won / row.games_played) * 100)
      }
      if (gameId === 'sudoku') {
        entry.successRate = Math.round((row.games_won / row.games_played) * 100)
      }
      if (typeof row.best_score === 'number') entry.bestScore = row.best_score
      playerCtx[key] = entry
    }
    if (wallet) {
      playerCtx.coins = wallet.earned_coins
      playerCtx.credits = wallet.ai_credits
    }

    // Rule-based personalization: every line states the rule that fired.
    const personalization = buildPersonalization({
      displayName: profile?.display_name ?? null,
      level: profile?.level ?? null,
      xp: profile?.xp ?? null,
      streak: profile?.streak ?? null,
      games: Object.entries(keys).map(([gameId, key]) => ({
        id: key,
        label: gameId === 'ball-run' ? 'Ball Run' : gameId === 'water-sort' ? 'Water Sort' : gameId,
        played: progressById.get(gameId)?.games_played ?? 0,
        won: progressById.get(gameId)?.games_won ?? 0,
      })),
    })

    // -- AI Rate Limiting (server-side, before provider call) ----------
    const now = new Date()
    const minuteBucket = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes())
    const hourBucket = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours())
    const { data: rateLimitData, error: rateLimitErr } = await client
      .from('ai_rate_limits')
      .select('request_count, minute_bucket, hour_bucket')
      .eq('user_id', user.id)
      .eq('minute_bucket', minuteBucket.toISOString())
      .eq('hour_bucket', hourBucket.toISOString())
      .single()
    if (rateLimitErr && rateLimitErr.code !== 'PGRST116') {
      logErr('chat.rate_limit_db_error', { requestId, error: rateLimitErr.message })
      // Continue anyway — rate limit is best-effort; do not block the user
    }
    // Configurable limits — adjust these per your deployment.
    // Example: max 10 requests per minute, max 50 requests per hour.
    const MAX_PER_MINUTE = 10
    const MAX_PER_HOUR = 50
    const minuteExceeded = rateLimitData && rateLimitData.request_count >= MAX_PER_MINUTE
    const hourExceeded = rateLimitData && rateLimitData.request_count >= MAX_PER_HOUR
    if (minuteExceeded || hourExceeded) {
      // Best-effort: release any held credit and return a clear error
      if (creditHeld) {
        try {
          await client.rpc('release_chat_credit', { p_request_id: reserveRequestId })
        } catch {}
      }
      return Response.json(
        { error: 'Too many AI requests. Please try again shortly.' },
        { status: 429, headers: cors }
      )
    }
    // Increment the count atomically
    if (rateLimitData) {
      await client
        .from('ai_rate_limits')
        .update({ request_count: rateLimitData.request_count + 1 })
        .eq('user_id', user.id)
        .eq('minute_bucket', minuteBucket.toISOString())
        .eq('hour_bucket', hourBucket.toISOString())
    } else {
      await client.from('ai_rate_limits').insert({
        user_id: user.id,
        minute_bucket: minuteBucket.toISOString(),
        hour_bucket: hourBucket.toISOString(),
        request_count: 1,
      })
    }
    // ---------------------------------------------------------------
    // -- Reserve credit (handles stale cleanup + re-reserve) ---------
    const { data: reserveData, error: reserveErr } = await client.rpc('reserve_chat_credit', {
      p_idempotency_key: idempotencyKey,
      p_conversation_id: targetConversation,
      p_mode: chatMode,
    })
    if (reserveErr) {
      logErr('chat.reserve_fail', { requestId, code: 'reserve' })
      return Response.json({ error: reserveErr.message }, { status: 400, headers: cors })
    }

    const reserveRow = reserveData?.[0]
    if (!reserveRow) {
      logErr('chat.reserve_fail', { requestId, code: 'reserve_empty' })
      return Response.json({ error: 'Failed to reserve credit' }, { status: 500, headers: cors })
    }
    reserveRequestId = reserveRow.request_id
    creditHeld = true

    // -- One-time post-game re-entry context (Phase 13) ---------------
    // The client may reference exactly one of its own completed game sessions.
    // Every value below is re-derived from rows RLS already scopes to this
    // user — no client-supplied outcome, XP, coins, or user id is trusted.
    if (isUuid(gameSessionId)) {
      const { data: sessionRow } = await client
        .from('game_sessions')
        .select('id, game_id, status')
        .eq('id', gameSessionId)
        .maybeSingle()

      if (sessionRow && sessionRow.status === 'COMPLETED') {
        const { data: resultRow } = await client
          .from('game_results')
          .select('game_id, outcome, created_at')
          .eq('session_id', gameSessionId)
          .maybeSingle()

        const { data: rewardRows } = await client
          .from('wallet_transactions')
          .select('amount, type, reference_id')
          .eq('user_id', user.id)
          .eq('type', 'GAME_REWARD')
          .eq('reference_id', gameSessionId)
          .limit(1)

        const recentActivity = buildRecentActivity({
          game: resultRow?.game_id,
          outcome: resultRow?.outcome,
          completedAt: resultRow?.created_at,
          coinsEarned: rewardRows?.[0]?.amount ?? 0,
          profile: profile
            ? { xp: profile.xp, level: profile.level, streak: profile.streak }
            : null,
        })
        if (recentActivity) playerCtx.recentActivity = recentActivity
      }
    }

    // -- Load recent conversation history ----------------------------
    const { data: historyRows } = await client.rpc('get_chat_history', {
      p_limit: CONVERSATION_HISTORY_LIMIT,
      p_conversation_id: targetConversation,
    })

    const historyTurns: Array<{ role: string; parts: Array<{ text: string }> }> = []
    if (historyRows && historyRows.length > 0) {
      for (const row of historyRows as Array<{ role: string; content: string }>) {
        historyTurns.push({
          role: row.role === 'user' ? 'user' : 'model',
          parts: [{ text: row.content }],
        })
      }
    }

    // -- Build Gemini request ----------------------------------------
    // Context lives in the system instruction, never as a fake history turn,
    // so a thread never contains injected pseudo-messages.
    const instructionSections = [SYSTEM_PROMPT]
    const contextJson = Object.keys(playerCtx).length > 0 ? JSON.stringify(playerCtx) : null
    if (contextJson) {
      instructionSections.push(`[Player Context]\n${contextJson}\n[End Context]`)
    }
    if (personalization) {
      instructionSections.push(`[Personalization]\n${personalization}\n[End Personalization]`)
    }
    const systemInstruction = { parts: [{ text: instructionSections.join('\n\n') }] }

    const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [
      ...historyTurns,
    ]
    const userParts: Array<Record<string, unknown>> = [{ text: trimmed }]
    if (inputAttachment) {
      const { data: file, error: readErr } = await client.storage
        .from(ATTACHMENT_BUCKET)
        .download(inputAttachment.path)
      // Never bill a vision turn that cannot see its image: the outer catch
      // releases the reserved credit before this turns into a reply.
      if (readErr || !file) {
        throw new Error('Attached image could not be read -- credit released, try again')
      }
      if (file.size > MAX_IMAGE_BYTES) {
        throw new Error('Attached image is larger than 5 MB -- credit released, try again')
      }
      userParts.push({
        inlineData: {
          mimeType: file.type || inputAttachment.mimeType,
          data: toBase64(new Uint8Array(await file.arrayBuffer())),
        },
      })
    }
    contents.push({ role: 'user', parts: userParts })

    const releaseCredit = async () => {
      if (!creditHeld) return
      creditHeld = false
      try {
        await client.rpc('release_chat_credit', { p_request_id: reserveRequestId })
      } catch {
        // Best-effort release; stale cleanup recovers on the next request.
      }
    }

    const walletAfter = {
      earned_coins: reserveRow.earned_coins,
      ai_credits: reserveRow.ai_credits,
    }

    const abortCtrl = new AbortController()
    const timeoutId = setTimeout(
      () => abortCtrl.abort(),
      chatMode === 'image' ? 60_000 : 30_000,
    )
    const providerHeaders = {
      'Content-Type': 'application/json',
      'x-goog-api-key': geminiKey,
    }

    // ════════════════════════════════════════════════════════════
    //  IMAGE MODE — single call, then a caption + stored image
    // ════════════════════════════════════════════════════════════
    if (chatMode === 'image') {
      let imageResponse: Response
      try {
        imageResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent`,
          {
            method: 'POST',
            headers: providerHeaders,
            body: JSON.stringify({
              contents,
              systemInstruction,
              generationConfig: {
                responseModalities: ['TEXT', 'IMAGE'],
                maxOutputTokens: 1024,
              },
            }),
            signal: abortCtrl.signal,
          },
        )
      } catch (fetchErr) {
        clearTimeout(timeoutId)
        if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
          logErr('chat.provider_timeout', { requestId, durationMs: Date.now() - t0 })
          await releaseCredit()
          return Response.json(
            { error: 'AI service timed out -- credit released, try again' },
            { status: 504, headers: cors },
          )
        }
        await releaseCredit()
        throw fetchErr
      }
      clearTimeout(timeoutId)

      if (!imageResponse.ok) {
        logErr('chat.provider_error', {
          requestId,
          status: imageResponse.status,
          durationMs: Date.now() - t0,
        })
        await releaseCredit()
        return Response.json(
          { error: 'Image generation temporarily unavailable -- credit released, try again' },
          { status: 502, headers: cors },
        )
      }

      const generated = await imageResponse.json()
      const parts: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> =
        generated?.candidates?.[0]?.content?.parts ?? []
      const caption = parts.map((part) => part.text ?? '').join('').trim()
      const imagePart = parts.find((part) => part.inlineData?.data)

      if (!imagePart?.inlineData?.data) {
        logErr('chat.empty_response', { requestId })
        await releaseCredit()
        return Response.json(
          { error: 'No image was returned -- credit released, try again' },
          { status: 502, headers: cors },
        )
      }

      const bytes = fromBase64(imagePart.inlineData.data)
      const path = mediaObjectPath(user.id, 'png')
      const upload = await client.storage.from(ATTACHMENT_BUCKET).upload(path, bytes, {
        contentType: imagePart.inlineData.mimeType || 'image/png',
        upsert: false,
      })
      if (upload.error) {
        logErr('chat.media_upload_fail', { requestId, code: 'image' })
        await releaseCredit()
        return Response.json(
          { error: 'Image could not be saved -- credit released, try again' },
          { status: 502, headers: cors },
        )
      }

      const media: Media = { path, kind: 'image_output' }
      const finalText = caption || 'Here is the image you asked for.'
      const finalizeError = await persistExchange(client, {
        requestId,
        reserveRequestId,
        userContent: trimmed,
        assistantContent: finalText,
        chatMode,
        media,
      })
      if (finalizeError) {
        return Response.json({ error: finalizeError }, { status: 500, headers: cors })
      }
      creditHeld = false
      log('chat.done', { requestId, durationMs: Date.now() - t0, result: 'ok' })

      const events = [
        sseEvent('start', { requestId, recentActivity: playerCtx.recentActivity ?? null, mode: chatMode }),
        ...(caption ? [sseEvent('chunk', { text: caption })] : []),
        sseEvent('media', { path, kind: 'image_output' }),
        sseEvent('done', { wallet: walletAfter, media: { path, kind: 'image_output' } }),
      ]
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(event)
          controller.close()
        },
      })
      return new Response(stream, { headers: sseHeaders(cors) })
    }

    // ════════════════════════════════════════════════════════════
    //  CHAT / VISION / SPEECH — streaming text
    // ════════════════════════════════════════════════════════════
    const streamModel = chatMode === 'vision' ? VISION_MODEL : TEXT_MODEL
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${streamModel}:streamGenerateContent?alt=sse`

    let geminiResponse: Response
    try {
      geminiResponse = await fetch(geminiUrl, {
        method: 'POST',
        headers: providerHeaders,
        body: JSON.stringify({
          contents,
          systemInstruction,
          generationConfig: {
            thinkingConfig: {
              thinkingLevel: 'minimal',
            },
            maxOutputTokens: 512,
          },
        }),
        signal: abortCtrl.signal,
      })
    } catch (fetchErr) {
      clearTimeout(timeoutId)
      if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
        logErr('chat.provider_timeout', { requestId, durationMs: Date.now() - t0 })
        await releaseCredit()
        return Response.json(
          { error: 'AI service timed out -- credit released, try again' },
          { status: 504, headers: cors },
        )
      }
      await releaseCredit()
      throw fetchErr
    }
    clearTimeout(timeoutId)

    if (!geminiResponse.ok) {
      // Do not log provider response body (may echo request details).
      logErr('chat.provider_error', {
        requestId,
        status: geminiResponse.status,
        durationMs: Date.now() - t0,
      })
      await releaseCredit()
      return Response.json(
        { error: 'AI service temporarily unavailable -- credit released, try again' },
        { status: 502, headers: cors },
      )
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const reader = geminiResponse.body!.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let accumulatedText = ''
          let firstChunkReceived = false

          controller.enqueue(
            sseEvent('start', {
              requestId: reserveRequestId,
              // Echo of the authoritative block above: lets the caller (and the
              // Phase 13 suite) verify what the model was actually given.
              recentActivity: playerCtx.recentActivity ?? null,
              mode: chatMode,
            }),
          )

          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue
              const jsonStr = line.slice(6).trim()
              if (!jsonStr || jsonStr === '[DONE]') continue

              try {
                const chunk = JSON.parse(jsonStr)
                const text = chunk?.candidates?.[0]?.content?.parts?.[0]?.text
                if (text) {
                  if (!firstChunkReceived) {
                    firstChunkReceived = true
                    log('chat.first_chunk', { requestId, durationMs: Date.now() - t0 })
                  }
                  accumulatedText += text
                  controller.enqueue(sseEvent('chunk', { text }))
                }
              } catch {
                // Skip malformed JSON lines
              }
            }
          }

          if (buffer.startsWith('data: ')) {
            const jsonStr = buffer.slice(6).trim()
            if (jsonStr && jsonStr !== '[DONE]') {
              try {
                const chunk = JSON.parse(jsonStr)
                const text = chunk?.candidates?.[0]?.content?.parts?.[0]?.text
                if (text) {
                  accumulatedText += text
                  controller.enqueue(sseEvent('chunk', { text }))
                }
              } catch {
                // Skip
              }
            }
          }

          if (!accumulatedText) {
            logErr('chat.empty_response', { requestId })
            await releaseCredit()
            controller.enqueue(
              sseEvent('error', {
                message: 'AI returned an empty response -- credit released, try again',
              }),
            )
            controller.close()
            return
          }

          // -- Optional media stage ------------------------------------
          let media: Media | null =
            chatMode === 'vision' && inputAttachment
              ? { path: inputAttachment.path, kind: 'image_input' }
              : null

          if (chatMode === 'speech') {
            const audio = await synthesiseSpeech(client, geminiKey, accumulatedText, user.id, requestId)
            if (audio) {
              media = audio
              controller.enqueue(sseEvent('media', { path: audio.path, kind: audio.kind }))
            } else {
              // Text is still delivered; audio is simply not attached.
              log('chat.tts_failed', { requestId })
            }
          }

          const finalizeError = await persistExchange(client, {
            requestId,
            reserveRequestId,
            userContent: trimmed,
            assistantContent: accumulatedText,
            chatMode,
            media,
          })
          if (finalizeError) {
            controller.enqueue(sseEvent('error', { message: finalizeError }))
            controller.close()
            return
          }
          creditHeld = false

          log('chat.done', { requestId, durationMs: Date.now() - t0, result: 'ok' })
          controller.enqueue(
            sseEvent('done', { wallet: walletAfter, media: media ?? null }),
          )
          controller.close()
        } catch (err) {
          logErr('chat.stream_error', {
            requestId,
            code: err instanceof Error ? err.name : 'unknown',
          })
          await releaseCredit()
          controller.enqueue(
            sseEvent('error', { message: 'Stream interrupted -- credit released, try again' }),
          )
          controller.close()
        }
      },
    })

    return new Response(stream, { headers: sseHeaders(cors) })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    logErr('chat.error', {
      requestId,
      code: err instanceof Error ? err.name : 'unknown',
      durationMs: Date.now() - t0,
    })

    if (reserveRequestId && creditHeld) {
      try {
        await client.rpc('release_chat_credit', { p_request_id: reserveRequestId })
      } catch {
        // Best-effort release; stale cleanup will recover on next request
      }
    }

    return Response.json({ error: message }, { status: 500, headers: cors })
  }
})
