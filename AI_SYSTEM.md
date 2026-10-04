# NOVA AI Play — AI System

Reference for NOVA's chat pipeline: the four modes, model/secret configuration,
request lifecycle, SSE contract, and failure handling. Every claim below points
at the code that implements it.

---

## 1. Overview

```
src/app/chat.tsx
  └─ POST {VITE_SUPABASE_URL}/functions/v1/nova-chat   (user JWT + anon key)
        supabase/functions/nova-chat/index.ts  (Deno Edge Function)
          ├─ auth.getUser()            caller identity from the JWT
          ├─ validate body             message / mode / conversation / attachment
          ├─ get_chat_request_state    idempotent replay of a completed key
          ├─ reserve_chat_credit       debits 1 AI credit, opens a reservation
          ├─ Gemini                    streamGenerateContent | generateContent
          └─ finalize_chat_credit  or  release_chat_credit
     ←  text/event-stream (start / chunk / media / done / error)
        or application/json when the idempotency key already completed
```

The Edge Function creates its Supabase client from `SUPABASE_URL` +
`SUPABASE_ANON_KEY` and forwards the caller's `Authorization` header
(`supabase/functions/nova-chat/index.ts`), so every read and write it performs
runs under the caller's RLS and `auth.uid()`. It never uses the service-role key.

The request body is typed `ChatRequestBody` and carries routing/validation
fields only — `message`, `idempotencyKey`, `gameSessionId`, `conversationId`,
`mode`, `attachmentPath`. No outcome, reward, identity or context payload can
travel through it.

## 2. Chat modes

The mode allow-list lives in `supabase/functions/_shared/chat_modes.ts`
(`CHAT_MODES`), a pure module shared with the test suite. `normalizeMode()`
maps `undefined` / `null` / `''` to `chat` and rejects anything not on the
list (`'CHAT'`, `'vision '`, arrays, numbers → `null` → HTTP 400
`Unknown chat mode`).

| Mode | UI label (`src/app/chat.tsx`) | Model | Provider call |
|------|------------------------------|-------|---------------|
| `chat` | Chat | `TEXT_MODEL` | `streamGenerateContent?alt=sse` |
| `vision` | See | `VISION_MODEL` | `streamGenerateContent?alt=sse`, image inlined in the user turn |
| `image` | Draw | `IMAGE_MODEL` | `generateContent` (non-streaming, `responseModalities: ['TEXT','IMAGE']`) |
| `speech` | Speak | `TEXT_MODEL` stream + `TTS_MODEL` | stream, then a second `generateContent` call with `responseModalities: ['AUDIO']` |

Additional per-mode rules enforced in `supabase/functions/nova-chat/index.ts`:

- `vision` requires `attachmentPath`; any other mode that sends one is rejected
  (`Attachments are only supported in vision mode`).
- Image mode aborts after 60 s; all other modes abort after 30 s (time to
  provider response headers).
- Streaming requests use `generationConfig.thinkingConfig.thinkingLevel:
  'minimal'` and `maxOutputTokens: 512`; image mode uses `maxOutputTokens: 1024`.

## 3. Model and secret configuration

All model names are configuration with safe fallbacks — never a hard-coded
provider dependency (`supabase/functions/nova-chat/index.ts`, lines 15–23).

| Env var | Read in | Default when unset |
|---------|---------|--------------------|
| `GEMINI_API_KEY` | `nova-chat` | none — request fails 500 `AI provider not configured` |
| `GEMINI_TEXT_MODEL` | `nova-chat` | falls back to `GEMINI_MODEL`, then `gemini-3.6-flash` |
| `GEMINI_MODEL` | `nova-chat` | legacy fallback for `TEXT_MODEL` only |
| `GEMINI_VISION_MODEL` | `nova-chat` | falls back to `TEXT_MODEL` |
| `GEMINI_IMAGE_MODEL` | `nova-chat` | `gemini-2.5-flash-image` |
| `GEMINI_TTS_MODEL` | `nova-chat` | `gemini-2.5-flash-preview-tts` |
| `GEMINI_TTS_SAMPLE_RATE` | `nova-chat` | `24000` (Hz, used for the WAV header) |
| `CORS_ALLOWED_ORIGINS` | `supabase/functions/_shared/cors.ts` | empty; local-dev origins are always added |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | every Edge Function | platform-provided |
| `SUPABASE_SERVICE_ROLE_KEY` | `supabase/functions/delete-account/index.ts` only | none — returns 503 `Deletion unavailable` |

`GEMINI_API_KEY` and the `GEMINI_*` model vars are Supabase Edge secrets
(`supabase secrets set …`, see `DEPLOYMENT.md`). The browser `.env` contains
only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (`.env.example`).

## 4. Why the browser never sees the provider key

- The key is read once per request with `Deno.env.get('GEMINI_API_KEY')` and
  sent to Google as the `x-goog-api-key` header from inside the Edge Function.
  It is never placed in a URL, never logged, and never returned in a response.
- The function logs only structured operational fields (`requestId`, `userId`,
  `op`, `status`, `durationMs`) — never message content, history or secrets.
- `supabase/tests/upgrade_multimodal_storage.test.ts` (M4/M5) asserts that
  `GEMINI_API_KEY` is only ever read through `Deno.env.get`, that `nova-chat`
  never references `SUPABASE_SERVICE_ROLE_KEY`, that `src/app/chat.tsx` and
  `src/app/home.tsx` contain no `GEMINI` / `SERVICE_ROLE` string, and that
  `.env` carries neither.

## 5. Request lifecycle

1. **Preflight / method** — `handlePreflight()` answers `OPTIONS`; non-POST →
   405.
2. **Authenticate** — missing `Authorization` → 401; `auth.getUser()` failure →
   401 `Invalid session`.
3. **Provider configured** — no `GEMINI_API_KEY` → 500
   `AI provider not configured`.
4. **Validate** — `checkMessageText` (non-empty, ≤ `MAX_MESSAGE_LENGTH` = 2000),
   `idempotencyKey` required, `normalizeMode` allow-list, `conversationId` must
   be a UUID, vision attachment gate (§7).
5. **Idempotent replay** — `get_chat_request_state(p_idempotency_key)`; if the
   row is `completed` with an `assistant_reply`, return JSON immediately (§12).
6. **Load context** — `profiles`, `game_progress`, `wallet` (all RLS-scoped),
   then `buildPersonalization()` (§11).
7. **Reserve credit** — `reserve_chat_credit(p_idempotency_key,
   p_conversation_id, p_mode)` locks the wallet, debits 1 credit, inserts a
   `chat_requests` row with `state = 'reserved'`. Returns `request_id`,
   post-reserve balances and state. Failure → 400 with the RPC message
   (e.g. `Insufficient AI Credits`).
8. **Post-game re-entry (optional)** — if `gameSessionId` is a UUID, the
   function re-reads `game_sessions` / `game_results` / `wallet_transactions`
   under RLS and builds `recentActivity`; nothing client-supplied is trusted.
9. **History** — `get_chat_history(p_limit: 20, p_conversation_id)` maps DB
   rows to Gemini `user` / `model` turns (`CONVERSATION_HISTORY_LIMIT = 20`).
10. **Context in the system instruction** — `SYSTEM_PROMPT` + optional
    `[Player Context]` JSON + optional `[Personalization]` block. Context is
    never injected as a fake history turn.
11. **Provider call** — stream for chat/vision/speech, single call for image.
12. **Persist** — `finalize_chat_credit(p_request_id, p_user_content,
    p_assistant_content, p_mode, p_media_path, p_media_kind)` writes both
    messages, the `AI_USAGE` ledger row, marks the request `completed`, updates
    the thread title/activity, touches the streak and awards `first_ai_chat`.
13. **Fail** — any failure path calls `release_chat_credit(p_request_id)`,
    which refunds the credit and marks the request `released`.

## 6. SSE event contract

Successful streaming responses use `Content-Type: text/event-stream` with
`Cache-Control: no-cache` (`sseHeaders()`). Each event is
`event: <name>\ndata: <json>\n\n` (`sseEvent()`).

| Event | Payload | Emitted when |
|-------|---------|--------------|
| `start` | `{ requestId, recentActivity, mode }` | first event of every stream; `requestId` is the reservation id on streaming modes and the local request id in image mode; `recentActivity` echoes the authoritative block sent to the model |
| `chunk` | `{ text }` | one per provider text delta; image mode emits at most one chunk containing the caption |
| `media` | `{ path, kind }` | image mode after upload (`image_output`), speech mode after a successful TTS upload (`audio_output`) |
| `done` | `{ wallet: { earned_coins, ai_credits }, media }` | after a successful finalize; `wallet` holds the post-reserve balances returned by `reserve_chat_credit`; vision carries its input image as `{ path, kind: 'image_input' }` here, without a separate `media` event |
| `error` | `{ message }` | empty response, stream interruption, or finalize failure (§13) |

The client (`src/app/chat.tsx`) does not dispatch on event names — it reads
`data:` lines and branches on payload shape: `data.text` → stream,
`data.media` (without `data.wallet`) → pending media, `data.wallet` → done,
`data.message` → throw. A stream that ends without a `wallet` event raises
`Connection closed before the reply finished — retry to continue` and keeps the
same idempotency key.

Errors before the stream starts are plain JSON with an `error` field and a
4xx/5xx status, not SSE.

## 7. Vision attachments

- **Bucket**: `chat-attachments`, private (`ATTACHMENT_BUCKET` in the Edge
  function; created in `supabase/migrations/20260930000002_chat_attachments_storage.sql`
  with `public = false`, `file_size_limit = 5242880`, and
  `allowed_mime_types = ['image/png','image/jpeg','image/webp','image/gif']`).
- **Path layout**: `{auth.uid()}/{uuid}.{ext}`. The browser uploads under its
  own folder (`src/app/chat.tsx` → `pickAttachment()`); generated/synthesised
  media uses `mediaObjectPath(ownerId, ext)`, which sanitises the extension and
  always lands in the owner folder.
- **Limits** (shared module `supabase/functions/_shared/chat_modes.ts`):
  `MAX_IMAGE_BYTES = 5 * 1024 * 1024`, `IMAGE_MIME_TYPES` allow-list,
  `MAX_MESSAGE_LENGTH = 2000`.
- **Server gate**: the Edge Function downloads the object, then runs
  `checkImageAttachment({ path, ownerId, mimeType, bytes })`, which rejects
  foreign folders, traversal (`..`), absolute paths, empty segments, unknown
  MIME types and anything over 5 MB (`isOwnerPath`). The image is re-checked
  for size immediately before it is inlined, so a vision turn that cannot see
  its image is never billed.
- **Reads**: objects are never public. `src/app/chat.tsx` creates 1-hour
  signed URLs in memory for rendering and never persists them.

## 8. Image generation

One `generateContent` call to `IMAGE_MODEL` with the same history and system
instruction as text modes. On a 200 the function:

1. takes the text parts as the caption and the first `inlineData` part as the
   image;
2. decodes base64 → bytes and uploads to `{userId}/{uuid}.png` (or the
   provider's MIME extension) with `upsert: false`;
3. calls `finalize_chat_credit` with `p_media_path` and
   `p_media_kind = 'image_output'`;
4. only then emits `start`, optional `chunk` (caption, defaulting to
   `Here is the image you asked for.`), `media` and `done`.

No caption and no image part → 502 and the credit is released.

## 9. Text-to-speech

`speech` mode streams the text reply first, then `synthesiseSpeech()`:

1. `generateContent` on `TTS_MODEL` with `responseModalities: ['AUDIO']` and
   prebuilt voice `Kore`;
2. the returned base64 PCM is wrapped in a minimal RIFF/WAVE header at
   `TTS_SAMPLE_RATE` (`pcmToWav()`);
3. uploaded as `{userId}/{uuid}.wav`, `contentType: 'audio/wav'`,
   `upsert: false`;
4. a `media { path, kind: 'audio_output' }` event follows, and the exchange is
   finalized with the audio path.

TTS is best-effort: if the provider call or the upload fails, the text reply is
still finalized and no `media` event is sent (`chat.tts_failed` log).

## 10. Conversation threads

Table `chat_conversations` plus nullable `chat_messages.conversation_id`
(`supabase/migrations/20260930000001_chat_conversations.sql`, backfilled
one-time as `Earlier conversations`).

Client thread CRUD goes through SECURITY DEFINER RPCs only
(`src/lib/supabase/conversations.ts`):

| Action | RPC | Notes |
|--------|-----|-------|
| List | `get_chat_conversations(p_limit = 50)` | ordered by `last_message_at`, includes `message_count` |
| Create | `create_chat_conversation(p_title)` | title normalised: trim, whitespace collapse, 60-char cap, `New conversation` default |
| Rename | `rename_chat_conversation(p_conversation_id, p_title)` | same normalisation, `Title is required` when empty |
| Delete | `delete_chat_conversation(p_conversation_id)` | FK cascade removes the messages in the same definer transaction |

- There is no client `INSERT`/`UPDATE`/`DELETE` policy on `chat_conversations`;
  the table is owner-SELECT only.
- **Ownership**: `reserve_chat_credit` verifies `p_conversation_id` belongs to
  `auth.uid()` before reserving, and `finalize_chat_credit` reads the thread
  from the reservation row — never from the caller.
- **History loading**: `src/app/chat.tsx` calls
  `get_chat_history({ p_limit: 50, p_conversation_id })` per thread. Passing
  `p_conversation_id: null` is the **legacy path** — last N messages across the
  whole account — and is exactly what the Edge Function uses when a request has
  no thread. The function returns the newest `p_limit` rows and re-sorts them
  ascending, breaking `created_at` ties so the user row always precedes its
  assistant row.
- **Auto-title**: on the first finalize, `title` is replaced with the first 60
  characters of the trimmed user message, but only while it is still
  `New conversation` or `Earlier conversations`.

## 11. Server-side context: player data, personalization, recent activity

**Player context** is built in `nova-chat` from RLS-scoped rows: display name,
level, XP, streak, per-game `played`/`won`/`bestScore` (plus win/success rates
for Tic-Tac-Toe and Sudoku), and coin/credit balances. It is serialised into
the system instruction as `[Player Context] … [End Context]`.

**Personalization** — `buildPersonalization()` in
`supabase/functions/_shared/personalization.ts` is rule-based and
deterministic: no model in the loop, no free-form client input, `null` when
nothing applies. Every suggestion states the rule that fired:

| Input | Output line |
|-------|-------------|
| non-empty display name | `The player's name is …` |
| `level >= 5` and `xp` present | `They are level N (X XP) — treat them as an experienced player.` |
| `streak >= 3` | `Rule: streak >= 3 → they are on a N-day streak; …` |
| no games with `played > 0` | `Rule: no completed games yet → … suggest starting with a short game, but only if they ask.` |
| game with `played >= 3` and win rate `< 0.4` | `Rule: <game> win rate below 40% (w/n) → … suggest one concrete opening or scanning habit …` |
| game with `played >= 3` and win rate `>= 0.7` | `Rule: <game> win rate P% (w/n) → … suggest raising difficulty or trying a different game …` |

The block is appended to the system instruction as
`[Personalization] … [End Personalization]`, and the system prompt tells NOVA
to apply a rule only when relevant and never to mention a rule unless asked.

**Recent activity** — `buildRecentActivity()` in
`supabase/functions/_shared/recent_activity.ts` produces the one-time
post-game re-entry block. Contract (from the module header):

- every field is derived from rows already loaded under the requester's RLS
  scope (`game_sessions`, `game_results`, `wallet_transactions`, `profiles`);
- the result is allow-listed — game ∈ `tictactoe | sudoku | ball-run |
  water-sort`, outcome ∈ `win | loss | draw | complete`, plus optional
  `progression` and `reward.coins`;
- no user id, email, auth metadata, wallet balance, credit balance or RPC
  internals;
- coins surface only when a `GAME_REWARD` transaction already exists for that
  session — it never mints rewards.

The block appears once per request (the client consumes its `PostGameContext`
after `done`) and is echoed verbatim in the `start` event so the caller and the
Phase 13 suite can verify what the model was given.

## 12. Retry and replay

`src/app/chat.tsx` keeps a sticky `{ message, idempotencyKey }` pair for a
failed send, so a retry reuses the same key.

Server side (`supabase/functions/nova-chat/index.ts`):

- If `get_chat_request_state` reports `state = 'completed'` with an
  `assistant_reply`, the function does **not** call the provider again. It
  returns `application/json`:

  ```json
  { "reply": "<stored assistant text>",
    "wallet": { "earned_coins": n, "ai_credits": n },
    "media": { "path": "...", "kind": "image_output" } | null,
    "retried": true }
  ```

  `media` is `null` when the stored request produced no object. The client
  detects the JSON content type, appends the reply once and refreshes the
  wallet.
- `state = 'reserved'` returns the existing reservation (in-flight or stale);
  `state = 'released'` falls through to a fresh reservation and debit.
- The replay is scoped to the reservation: `get_chat_request_state`
  (`supabase/migrations/20261001000001_chat_replay_scope_media.sql`) returns
  the **first** assistant message at/after the request started, matched to the
  reservation's thread (or to thread-less messages for a legacy request), plus
  `media_path` / `media_kind`.
- Stale housekeeping: reservations older than 5 minutes are converted to
  `released` and refunded inside `reserve_chat_credit`; already-released rows
  are deleted without a second refund
  (`supabase/migrations/20260924000002_phase2c_reserve_chat_credit_refund_fix.sql`).

## 13. Failure modes and credit release

Every failure after a successful reserve releases the reservation. Messages
shown to the user say so explicitly.

| Condition | Response | Credit |
|-----------|----------|--------|
| Provider timeout (30 s; 60 s for image) | 504 JSON `AI service timed out -- credit released, try again` | released |
| Provider returns non-2xx | 502 JSON `AI service temporarily unavailable -- credit released, try again` (image: `Image generation temporarily unavailable …`) | released |
| Provider stream ends with no text | SSE `error` `AI returned an empty response -- credit released, try again` | released |
| Image mode: 200 but no image part | 502 JSON `No image was returned -- credit released, try again` | released |
| Generated image upload fails | 502 JSON `Image could not be saved -- credit released, try again` | released |
| Vision attachment unreadable or > 5 MB at send time | thrown error → outer catch → 500 JSON with the thrown message | released (outer catch) |
| Stream throws mid-flight | SSE `error` `Stream interrupted -- credit released, try again` | released |
| `finalize_chat_credit` fails | SSE `error` `Message generated but could not be saved -- credit released, try again` (image mode: 500 JSON) | released best-effort, then the reply is not persisted |
| TTS fails | no `media` event; text still finalized | credit kept (reply delivered) |
| Process dies while `reserved` | row ages out; next `reserve_chat_credit` converts and refunds it | refunded after 5 minutes |
| Unexpected error before/around the stream | outer catch → 500 JSON | released if a reservation was held |

`release_chat_credit` is idempotent: it no-ops when the request is already
`released` or already `completed`, so a double release never mints a credit.
Releases are best-effort inside the function; if the call itself fails, stale
cleanup recovers the credit on the next request.

## 14. Logging

`log()` / `logErr()` emit single-line JSON with fixed operational fields —
`chat.start`, `chat.retry`, `chat.first_chunk`, `chat.done`, `chat.reserve_fail`,
`chat.finalize_fail`, `chat.provider_timeout`, `chat.provider_error`,
`chat.empty_response`, `chat.media_upload_fail`, `chat.tts_failed`,
`chat.stream_error`, `chat.error`. Provider response bodies are deliberately
not logged, and neither message content, conversation history, nor secrets are
ever written to the log stream.
