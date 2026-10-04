// Shared CORS helper for NOVA AI Play edge functions.
// Allowlist comes from CORS_ALLOWED_ORIGINS (comma-separated).
// Local dev origins are always allowed so `npm run dev` keeps working.
// Production domains must be configured via secrets — never hardcode guesses.

const LOCAL_DEV_ORIGINS = new Set([
  'http://localhost:5173',
  'http://localhost:4173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
  'http://127.0.0.1:3000',
])

function parseAllowedOrigins(): Set<string> {
  const raw = Deno.env.get('CORS_ALLOWED_ORIGINS') ?? ''
  const fromEnv = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return new Set([...fromEnv, ...LOCAL_DEV_ORIGINS])
}

export function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false
  return parseAllowedOrigins().has(origin)
}

/** Headers for a single request. Echoes Origin only when allowlisted. */
export function buildCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin')
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  }
  if (origin && isOriginAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
    headers.Vary = 'Origin'
  }
  return headers
}

/** Handle OPTIONS preflight. Returns null when origin is not allowlisted. */
export function handlePreflight(request: Request): Response | null {
  if (request.method !== 'OPTIONS') return null
  const headers = buildCorsHeaders(request)
  const origin = request.headers.get('Origin')
  if (origin && !headers['Access-Control-Allow-Origin']) {
    return new Response(null, { status: 403, headers })
  }
  return new Response(null, { status: 204, headers })
}
