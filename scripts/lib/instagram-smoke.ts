// TAC-469: the pure halves of the Instagram outbound smoke test, split out so
// they can be tested. The entry script calls main() at the top level, so
// importing it would start a run that sends real messages.
//
// Two things here are worth testing rather than reading.
//
// textOfBytes, because check B is a BOUNDARY test: a padding one byte out
// would send 999 where it means 1000 and report a pass that proves nothing
// about the line Meta actually draws.
//
// capVerdictBlocker, because check B drew BOTH of its verdicts from a refusal
// without reading why Meta refused. On 2026-09-19 a run 25 minutes outside the
// 24-hour reply window reported "Meta refused 1001 bytes (code 10)" as a PASS
// and "Meta refused exactly 1000 bytes" as a FAIL advising a lower cap. Code 10
// is the window, not the size: both verdicts were about the window, one of them
// would have lowered a correct cap, and neither was evidence about bytes at all.

import type { InstagramSendFailureKind } from '@/lib/messaging/instagram/send'

export type SmokeArgs = {
  venue?: string
  guest?: string
  confirm: boolean
  showIds: boolean
}

export function parseSmokeArgs(argv: readonly string[]): SmokeArgs {
  const out: SmokeArgs = { confirm: false, showIds: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--venue') out.venue = argv[++i]
    else if (arg === '--guest') out.guest = argv[++i]
    else if (arg === '--confirm') out.confirm = true
    else if (arg === '--show-ids') out.showIds = true
  }
  return out
}

/**
 * Why a refusal says nothing about the byte cap, or null when it might.
 *
 * Check B is the only check that reads a refusal as evidence, and it may do so
 * ONLY when Meta was judging the message itself. Every other cause — the reply
 * window, the token, throttling, a dead socket — refuses a 1000-byte message
 * and a 1001-byte message identically, so concluding from one is reading a
 * verdict out of noise.
 *
 * `graph_error` is the one kind that maps to null: Meta refused it with a code
 * the transport does not recognise, which is the shape a size refusal would
 * arrive in. The caller still prints the code rather than asserting the cause.
 *
 * TOTAL over InstagramSendFailureKind, so a new failure kind fails `tsc` here
 * until someone decides whether it is evidence about size. That is the whole
 * point: the bug this exists to stop was a cause nobody had considered being
 * read as one.
 */
const CAP_VERDICT_BLOCKERS = {
  window_closed: 'the 24-hour reply window was shut',
  token_rejected: 'Meta rejected the token',
  rate_limited: 'Meta throttled the send',
  recipient_unavailable: 'Meta says the recipient is unavailable (blocked the account, or gone)',
  timeout: 'the send timed out',
  network: 'the network failed',
  malformed_response: 'the response could not be read',
  empty_text: 'our own guard refused an empty message before the network',
  over_byte_cap: 'our own guard refused it before the network, so Meta never saw it',
  graph_error: null,
} as const satisfies Record<InstagramSendFailureKind, string | null>

export function capVerdictBlocker(kind: InstagramSendFailureKind): string | null {
  return CAP_VERDICT_BLOCKERS[kind]
}

/** The failure kinds this module knows about, for a test that the map is total. */
export const CAP_VERDICT_BLOCKER_KINDS = Object.keys(CAP_VERDICT_BLOCKERS) as InstagramSendFailureKind[]

/**
 * A message of EXACTLY `bytes` UTF-8 bytes, opening with `label` so a person
 * reading the thread knows what it is. ASCII only, so bytes and characters
 * agree and the count is the thing being tested rather than an accident of
 * the label. Throws rather than return a message of the wrong length: a
 * boundary test built on the wrong length proves nothing.
 */
export function textOfBytes(bytes: number, label: string): string {
  const prefix = `${label} `
  if (Buffer.byteLength(prefix, 'utf8') > bytes) {
    throw new Error(`textOfBytes: the label alone is longer than ${bytes} bytes`)
  }
  const text = prefix + 'a'.repeat(bytes - Buffer.byteLength(prefix, 'utf8'))
  const actual = Buffer.byteLength(text, 'utf8')
  if (actual !== bytes) throw new Error(`textOfBytes: wanted ${bytes}, built ${actual}`)
  return text
}

/** A mid or other identifier, safe to print: the ends only, unless asked. */
export function idForLog(value: string, showIds: boolean): string {
  if (showIds) return value
  return `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`
}
