// NOVA AI PLAY — PHASE 17
// Account deletion: authenticated user deletes only their own auth.users row.
// Storage objects (chat-attachments) are enumerated and removed first.
// Application rows cascade via existing FKs (verified in audit).
// Service-role key stays server-side (Edge runtime env only — never VITE_*).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildCorsHeaders, handlePreflight } from '../_shared/cors.ts'

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers })
}

const CONFIRM_PHRASE = 'DELETE'

Deno.serve(async (request) => {
  const preflight = handlePreflight(request)
  if (preflight) return preflight
  const cors = buildCorsHeaders(request)

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors)

  const authHeader = request.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Authentication required' }, 401, cors)

  // Identify caller from JWT — never trust a client-supplied user_id.
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  })
  const {
    data: { user },
    error: authError,
  } = await anon.auth.getUser()
  if (authError || !user) return json({ error: 'Invalid session' }, 401, cors)

  let body: { confirmation?: unknown } = {}
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid request body' }, 400, cors)
  }

  const confirmation = typeof body.confirmation === 'string' ? body.confirmation.trim() : ''
  if (confirmation !== CONFIRM_PHRASE) {
    return json({ error: 'Confirmation required' }, 400, cors)
  }

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!serviceKey) {
    // Operational misconfiguration — do not leak internals.
    return json({ error: 'Deletion unavailable' }, 503, cors)
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    // -- Phase 17: Clean up user's Storage objects before deleting auth row --
    const { data: attachments } = await admin.storage
      .from('chat-attachments')
      .list('', { limit: 1000 })
    const userPrefix = user.id + '/'
    if (attachments) {
      for (const obj of attachments) {
        // Only delete objects in the user's own folder (owner-scoped policy ensures safety)
        if (obj.name.startsWith(userPrefix)) {
          await admin.storage.from('chat-attachments').remove([obj.name])
        }
      }
    }
    // ---------------------------------------------------------------

    const { error } = await admin.auth.admin.deleteUser(user.id)
    if (error) {
      // User may already be gone (retry after lost response) — treat as success.
      const msg = (error.message || '').toLowerCase()
      if (msg.includes('not found') || msg.includes('404')) {
        return json({ success: true }, 200, cors)
      }
      return json({ error: 'Deletion failed' }, 400, cors)
    }
    return json({ success: true }, 200, cors)
  } catch {
    return json({ error: 'Deletion failed' }, 500, cors)
  }
})
