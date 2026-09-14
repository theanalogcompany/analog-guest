import {
  INTENTION_DEFINITIONS,
  type IntentionArmsOn,
  type IntentionDefinition,
  type IntentionGate,
} from '@/lib/agent/intentions/definitions'

// TAC-379: pure display helpers for the read-only intentions viewer. Split out
// of the components so they're unit-testable — this repo has no React
// component test harness (no .test.tsx anywhere, no jsdom in vitest.config).

const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_DAY = 24 * MS_PER_HOUR

const BY_KEY: ReadonlyMap<string, IntentionDefinition> = new Map(
  INTENTION_DEFINITIONS.map((d) => [d.key as string, d]),
)

export type ResolvedDefinition =
  | { known: true; definition: IntentionDefinition }
  | { known: false }

/**
 * Resolve a raw `guest_intention_prompts.intention_key` against the live
 * definitions.
 *
 * Takes a bare `string`, not an `IntentionKey`, on purpose: the column has no
 * FK (migration 035), so a recorded key genuinely may not correspond to any
 * definition after a rename or removal. `known: false` is a real state the
 * viewer renders, not an error path.
 */
export function resolveDefinition(key: string): ResolvedDefinition {
  const definition = BY_KEY.get(key)
  return definition ? { known: true, definition } : { known: false }
}

/**
 * Render `expiresAfterMs` as the window an admin would recognise. Exact
 * divisors only — a value that isn't a whole number of days or hours falls
 * back to raw milliseconds rather than rounding, because a rounded window
 * that reads "3 days" while the code means something else is the kind of
 * quiet misreport this surface exists to prevent.
 */
export function formatExpiryWindow(expiresAfterMs: number): string {
  if (!Number.isFinite(expiresAfterMs) || expiresAfterMs <= 0) {
    return `${expiresAfterMs} ms`
  }
  if (expiresAfterMs % MS_PER_DAY === 0) {
    const days = expiresAfterMs / MS_PER_DAY
    return `${days} ${days === 1 ? 'day' : 'days'}`
  }
  if (expiresAfterMs % MS_PER_HOUR === 0) {
    const hours = expiresAfterMs / MS_PER_HOUR
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  }
  return `${expiresAfterMs} ms`
}

/**
 * TAC-380: what makes an intention relevant, in words. An exhaustive switch, so
 * a new arming kind fails `tsc` here until someone says how to describe it.
 */
export function formatArmsOn(armsOn: IntentionArmsOn): string {
  switch (armsOn.kind) {
    case 'qr_scan_enrollment':
      return 'The guest texts in by scanning the sign'
    case 'first_contact':
      return 'Any guest, once the gate opens'
    case 'open_recommendation':
      return 'The newest open recommendation to the guest, from an earlier conversation. A newer one re-arms it'
    case 'recorded_order':
      return "The guest's newest recorded order, from an earlier conversation. A newer one re-arms it"
  }
}

/**
 * TAC-380: the gate, in words. The reply count is the definition's DEFAULT; a
 * venue can override it in venue_configs.intention_rules, which this page does
 * not read, so the copy says so rather than presenting the default as the
 * value in force everywhere.
 */
export function formatGate(gate: IntentionGate): string {
  if (gate.kind === 'none') return 'None'
  const replies = gate.defaultMinReplies
  return `Response rate at or above the venue floor, and at least ${replies} ${
    replies === 1 ? 'reply' : 'replies'
  } (venue can override)`
}

/**
 * Render a `prompted_at` timestamp for the recorded-prompts list.
 *
 * Explicit UTC, fixed format, no locale: this is an internal debugging
 * surface, the server's timezone is not the reader's, and a bare "Sep 13,
 * 10:00" that silently means something different to whoever opens it is worse
 * than an unglamorous absolute. Unparseable input renders as itself rather
 * than as "Invalid Date".
 */
export function formatPromptedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
