// Upgrade Phase F/G/H — chat mode + attachment validation.
//
// Pure helpers shared by the nova-chat Edge Function and the upgrade test
// suite. No Deno, Supabase or network APIs, so the exact rules the AI path
// enforces can be exercised directly under `node --experimental-strip-types`.
//
// Everything here is an allow-list. Callers never pass a mime type, path or
// mode through unchecked.

export const CHAT_MODES = ['chat', 'vision', 'image', 'speech'] as const

export type ChatMode = (typeof CHAT_MODES)[number]

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export const MAX_MESSAGE_LENGTH = 2000

export const IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const

const MODE_SET: ReadonlySet<string> = new Set(CHAT_MODES)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/** Normalises an untrusted mode value onto the allow-list, else null. */
export function normalizeMode(value: unknown): ChatMode | null {
  if (value === undefined || value === null || value === '') return 'chat'
  if (typeof value !== 'string') return null
  return MODE_SET.has(value) ? (value as ChatMode) : null
}

/**
 * A storage path is usable only when it lives in the owner's own folder.
 * The bucket layout is always `{userId}/{fileName}` — anything else is
 * rejected before the object is ever read.
 */
export function isOwnerPath(path: unknown, ownerId: string): path is string {
  if (typeof path !== 'string' || path.length === 0) return false
  if (path.includes('..') || path.startsWith('/')) return false
  const [folder, ...rest] = path.split('/')
  if (!folder || rest.length === 0) return false
  if (rest.some((segment) => segment.length === 0)) return false
  return folder === ownerId
}

export type AttachmentCheck =
  | { ok: true; path: string }
  | { ok: false; error: string }

/** Full attachment gate: owner folder + mime allow-list + size ceiling. */
export function checkImageAttachment(input: {
  path: unknown
  ownerId: string
  mimeType?: unknown
  bytes?: unknown
}): AttachmentCheck {
  if (!isOwnerPath(input.path, input.ownerId)) {
    return { ok: false, error: 'Attachment path is not yours' }
  }
  if (typeof input.mimeType !== 'string' || !(IMAGE_MIME_TYPES as readonly string[]).includes(input.mimeType)) {
    return { ok: false, error: 'Unsupported image type' }
  }
  if (typeof input.bytes !== 'number' || !Number.isFinite(input.bytes) || input.bytes <= 0) {
    return { ok: false, error: 'Attachment size is missing' }
  }
  if (input.bytes > MAX_IMAGE_BYTES) {
    return { ok: false, error: 'Image is larger than 5 MB' }
  }
  return { ok: true, path: input.path }
}

export function checkMessageText(value: unknown):
  | { ok: true; text: string }
  | { ok: false; error: string } {
  if (typeof value !== 'string') return { ok: false, error: 'Message is required' }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: false, error: 'Message cannot be empty' }
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: `Message exceeds ${MAX_MESSAGE_LENGTH} characters` }
  }
  return { ok: true, text: trimmed }
}

/** Folder prefix used for generated/synthesised media owned by this user. */
export function mediaObjectPath(ownerId: string, extension: string): string {
  const safeExtension = extension.replace(/[^a-z0-9]/gi, '') || 'bin'
  return `${ownerId}/${crypto.randomUUID()}.${safeExtension}`
}
