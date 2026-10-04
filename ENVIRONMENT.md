# NOVA — Environment Configuration

This document describes the environment variables required to run NOVA AI Play,
distinguishing between **public/client variables** and **server-only secrets**.

---

## 1. Frontend Environment (`.env`)

Copy `.env.example` to `.env` and fill in your values. Leave both unset to run
in demo mode (no Supabase required).

| Variable | Required | Description |
|---|---|---|
| `VITE_SUPABASE_URL` | Yes (non-demo) | Supabase project URL, e.g. `https://<project>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Yes (non-demo) | Supabase anonymous/public API key |

### Frontend behavior

- These are the **only** variables that Vite inlines into the client bundle.
- The `VITE_SUPABASE_ANON_KEY` is designed to be public — it authorizes
  PostgREST reads/writes under the user's RLS policy.
- Without both variables set, `src/lib/supabase/client.ts` returns `null` and the
  app runs in demo mode.
- These variables **must never** include a Gemini API key or service-role key.

---

## 2. Edge Function Secrets

All secrets below are stored in the Supabase project Edge runtime (`supabase
secrets set …`). They are **never** in the frontend bundle or `.env`.

| Variable | Used by | Description |
|---|---|---|
| `GEMINI_API_KEY` | `nova-chat` Edge Function | Google Gemini provider key. Sent as `x-goog-api-key` header. |
| `GEMINI_TEXT_MODEL` | `nova-chat` Edge Function | Text model (falls back to `GEMINI_MODEL`, then `gemini-3.6-flash`). |
| `GEMINI_MODEL` | `nova-chat` Edge Function | Legacy fallback for `TEXT_MODEL` only. |
| `GEMINI_VISION_MODEL` | `nova-chat` Edge Function | Vision model (falls back to `GEMINI_TEXT_MODEL`). |
| `GEMINI_IMAGE_MODEL` | `nova-chat` Edge Function | Image generation model (falls back to `gemini-2.5-flash-image`). |
| `GEMINI_TTS_MODEL` | `nova-chat` Edge Function | TTS model (falls back to `gemini-2.5-flash-preview-tts`). |
| `GEMINI_TTS_SAMPLE_RATE` | `nova-chat` Edge Function | TTS sample rate in Hz for WAV header (falls back to `24000`). |
| `CORS_ALLOWED_ORIGINS` | All Edge Functions | Comma-separated production origins. Local-dev origins are always added by `cors.ts`. |
| `SUPABASE_SERVICE_ROLE_KEY` | `delete-account` Edge Function | Service-role key for admin.auth.deleteUser(). Returns 503 if absent. |

### Model name resolution order

```
GEMINI_TEXT_MODEL
  └─ if unset → GEMINI_MODEL
    └─ if unset → 'gemini-3.6-flash'

GEMINI_VISION_MODEL
  └─ if unset → GEMINI_TEXT_MODEL

GEMINI_IMAGE_MODEL
  └─ if unset → 'gemini-2.5-flash-image' (hard-coded safe fallback)

GEMINI_TTS_MODEL
  └─ if unset → 'gemini-2.5-flash-preview-tts' (hard-coded safe fallback)
```

### Per-mode model and call type

| Mode | Model Env Var | Provider Call |
|---|---|---|
| `chat` | `GEMINI_TEXT_MODEL` | `streamGenerateContent?alt=sse` |
| `vision` | `GEMINI_VISION_MODEL` | `streamGenerateContent?alt=sse` (image inlined in user turn) |
| `image` | `GEMINI_IMAGE_MODEL` | `generateContent` (non-streaming, `responseModalities: ['TEXT','IMAGE']`) |
| `speech` | `GEMINI_TEXT_MODEL` + `GEMINI_TTS_MODEL` | stream + `generateContent` with `responseModalities: ['AUDIO']` |

---

## 3. Verifying No Secret Reaches the Browser

Run the following checks:

1. **Grep for `GEMINI_API_KEY` in `src/`**: must find zero matches.
2. **Grep for `SERVICE_ROLE` in `src/`**: must find zero matches (asserted by
   `upgrade_multimodal_storage.test.ts` M5).
3. **Grep for `GEMINI` in `src/`**: must find zero matches (the model names are
   not in the frontend code; they are read at runtime from env vars).
4. **Grep for `SUPABASE_SERVICE_ROLE_KEY` in `src/`**: must find zero matches.
5. **`.env`**: must contain only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
6. **Build artifact check**: `npm run build` then inspect `dist/`. No Gemini key
   or service-role key should appear in the bundle.

All of the above are verified by `supabase/tests/upgrade_multimodal_storage.test.ts`
(M4/M5).

---

## 4. Running in Demo Mode

Set **neither** `VITE_SUPABASE_URL` nor `VITE_SUPABASE_ANON_KEY` in `.env`. The
app will:

- Run entirely in the browser with local state.
- Wallet starts at 20 NOVA Coins / 0 AI Credits.
- Tic-Tac-Toe and Sudoku play locally (no rewards).
- Ball Run and Water Sort refuse to start ("Sign in to record a run/solve.").
- Profile shows static demo values.
- Chat uses canned demo replies.
- No Edge Functions are called.

---

## 4. Local Development CORS

Edge Functions (`cors.ts`) add these local-dev origins to the allow-list
automatically:

- `http://localhost:5173` (Vite dev server)
- `http://127.0.0.1:5173`
- `http://localhost:4173` (Vite preview)
- `http://127.0.0.1:4173`
- `http://localhost:3000` (Create React App fallback)
- `http://127.0.0.1:3000`

For production, set `CORS_ALLOWED_ORIGINS` as a comma-separated list of your
production origins in the Supabase Edge runtime secrets.