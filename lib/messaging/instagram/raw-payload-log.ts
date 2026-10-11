// TEMPORARY. Remove with the media-messages ticket (inbound guest media:
// images, GIFs, video, voice notes, stickers, Instagram shares), once one real
// payload of each attachment kind has been read. Removal is:
//   - this file and scripts/harness/instagram-raw-payload/
//   - its one call in app/api/webhooks/instagram/route.ts, and the "unless
//     the temporary capture..." clause in the comment just above that call
//   - the same clause in summarize-payload.ts's header
//   - the INSTAGRAM_LOG_RAW_PAYLOADS entry in .env.local.example
//   - the note in this directory's CLAUDE.md
//
// WHY IT EXISTS. The route's `instagram_event` line is shape only
// (summarize-payload.ts), and parse-events.ts keeps an attachment's
// `payload.url` and throws its `type` away. So nothing we log or store says
// what Meta sends for a GIF, a sticker, a voice note, a reel share or a story
// reply, and Meta's own pages disagree about two of them. This prints the
// whole verified body as one JSON line so those payloads can be read once.
//
// IT LEAKS GUEST CONTENT ON PURPOSE: message text, IGSIDs, mids and signed
// media links. That is the TAC-458 guarantee switched off for as long as the
// flag is on, which is why it is strict-'true', off by default, and only ever
// reached AFTER the signature has verified. Unset it as soon as the payloads
// are captured.
//
// WHAT IS REDACTED. Anything token- or signature-shaped, by key name and by
// value shape. A webhook body is not expected to carry either; this is here
// so that a field Meta adds later cannot put a credential in the logs.
//
// WHAT IS NOT. Any http(s) URL is kept whole, including its query string. The
// attachment link is the thing being captured, and its signature is in the
// query, so a URL is never matched against the value shapes below. Every
// shape is anchored at the start today, so none of them could match a URL
// anyway; the explicit check is what keeps that true if someone adds one that
// is not.

const FLAG_ON = 'true'

export const INSTAGRAM_RAW_PAYLOAD_EVENT = 'instagram_raw_payload'

const REDACTED = '[redacted]'

/** A key whose value is a credential whatever it looks like. */
const SECRET_KEY = /token|secret|signature|authorization|password/i

const SECRET_VALUE_SHAPES: readonly RegExp[] = [
  // x-hub-signature style: an algorithm, then a hex digest.
  /^sha(1|256)=[0-9a-f]{16,}$/i,
  // Instagram User tokens (IGAA..., IGQV...) and Facebook tokens (EAA...).
  /^(IG[A-Z]{2}|EAA)[A-Za-z0-9_-]{40,}$/,
  // A JWT: three base64url segments, the first a JSON header.
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  // Case-sensitive: a guest can write "bearer bonds".
  /^Bearer\s+\S+$/,
]

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    if (isUrl(value)) return value
    return SECRET_VALUE_SHAPES.some((shape) => shape.test(value))
      ? REDACTED
      : value
  }
  if (Array.isArray(value)) return value.map(redact)
  if (typeof value === 'object' && value !== null) {
    // No prototype, so a `__proto__` key in the body is kept as a key.
    const out: Record<string, unknown> = Object.create(null)
    for (const [key, child] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redact(child)
    }
    return out
  }
  return value
}

/**
 * The line to log for a verified delivery, or null when the flag is off.
 *
 * The gate is in here rather than in the route so that both flag states are
 * one pure call: anything other than the exact string 'true' is off.
 *
 * A string, not an object, because console.log renders a nested object only
 * two levels deep and that is how `types: [Array]` hid the attachment type.
 *
 * Never throws. The input is JSON.parse's output, which cannot be cyclic, but
 * a diagnostic must not be able to cost a delivery its 200.
 */
export function instagramRawPayloadLine(
  parsed: unknown,
  flag: string | undefined,
): string | null {
  if (flag !== FLAG_ON) return null
  try {
    return JSON.stringify({
      event: INSTAGRAM_RAW_PAYLOAD_EVENT,
      payload: redact(parsed),
    })
  } catch {
    return JSON.stringify({
      event: INSTAGRAM_RAW_PAYLOAD_EVENT,
      error: 'unserializable',
    })
  }
}
