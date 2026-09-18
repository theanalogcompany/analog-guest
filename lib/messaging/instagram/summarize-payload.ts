// Non-PII shape summary of an Instagram webhook payload. Since TAC-458 removed
// the raw-body capture, this is the ONLY thing the route logs about a payload,
// so this file is what holds "no secrets, no guest content in log output".
//
// Deliberately excluded, and each for its own reason:
//   - message text / attachments / reactions — guest content, the PII
//   - sender.id / recipient.id — IGSIDs, stable per-person identifiers
//   - entry.id — the venue's Instagram account id
// What survives is shape: which kinds of event arrived, and when. That is the
// question the stub exists to answer before handling logic is written.
//
// The caps were written when the endpoint did not enforce its signature
// (TAC-445) and anyone could POST arbitrary JSON to it. Since TAC-458 only a
// signed delivery reaches this summary, so they are defence in depth rather
// than the only bound: `types` is still derived from object KEYS, and a leaked
// app secret would put this back in a stranger's hands. They cost nothing on
// real traffic, so they stay.

/** Per-item keys that route the event rather than name it. */
const ROUTING_KEYS: ReadonlySet<string> = new Set(['sender', 'recipient', 'timestamp'])

const MAX_TYPE_KEY_LENGTH = 64
const MAX_TYPES_PER_ENTRY = 12
// Meta batches deliveries, but a body near the platform's request cap can
// carry entries by the hundred thousand, and one object each turns a large
// request into a far larger log line. `entryCount` stays the true total, so
// capping what we RENDER costs no accuracy about what arrived.
const MAX_ENTRIES_LOGGED = 20

export type InstagramEntrySummary = {
  /** `entry[].time`, Meta's own epoch-ms stamp. Null when absent or non-numeric. */
  time: number | null
  /**
   * The event-discriminating keys present across this entry's `messaging[]`
   * items — `message`, `referral`, `read`, `postback`, and so on. Sorted so
   * the log line is stable run to run. Never the values.
   */
  types: string[]
}

export type InstagramPayloadSummary = {
  /** Meta's top-level `object` field, expected to be `'instagram'`. */
  object: string | null
  /**
   * True number of entries, and deliberately NOT `events.length` — `events`
   * is capped, this is not, so a capped summary still reports honestly how
   * much arrived.
   */
  entryCount: number
  events: InstagramEntrySummary[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function summarizeEntry(entry: unknown): InstagramEntrySummary {
  if (!isRecord(entry)) return { time: null, types: [] }

  const time = typeof entry.time === 'number' ? entry.time : null
  const items = Array.isArray(entry.messaging) ? entry.messaging : []

  const types = new Set<string>()
  for (const item of items) {
    if (!isRecord(item)) continue
    for (const key of Object.keys(item)) {
      if (ROUTING_KEYS.has(key)) continue
      if (key.length > MAX_TYPE_KEY_LENGTH) continue
      if (types.size >= MAX_TYPES_PER_ENTRY) break
      types.add(key)
    }
  }

  return { time, types: [...types].sort() }
}

/**
 * Reduce a parsed Instagram webhook payload to loggable shape. Never throws:
 * the input is whatever JSON.parse returned from an unauthenticated request,
 * so every level is guarded and an unrecognizable payload degrades to empty
 * rather than to an exception.
 */
export function summarizeInstagramPayload(parsed: unknown): InstagramPayloadSummary {
  if (!isRecord(parsed)) return { object: null, entryCount: 0, events: [] }

  const object = typeof parsed.object === 'string' ? parsed.object : null
  const entries = Array.isArray(parsed.entry) ? parsed.entry : []

  return {
    object,
    entryCount: entries.length,
    events: entries.slice(0, MAX_ENTRIES_LOGGED).map(summarizeEntry),
  }
}
