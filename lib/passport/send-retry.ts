// TAC-586: one image's send, with the retries that are safe and none that
// are not. Pure apart from what it is handed, so passport-check can drive it
// with fake sends and a fake clock (scripts/harness/passport/).
//
// RETRIED, up to 2 more times with 2 s then 6 s between (ruled 2026-10-14; in
// the run only): a failure Meta has told us it did NOT deliver and that may
// not happen again - a rate limit, a Graph 4xx.
//
// NOT RETRIED, because it will fail the same way again: a closed window, a
// rejected token, a guest who blocked the account, a link Meta would refuse.
//
// NEVER SENT AGAIN: a failure where Meta may have delivered anyway - a
// timeout, a network failure, a 200 we could not read, a Meta 5xx. A resend
// risks the guest seeing the image twice, and the first copy's echo would
// match nothing of ours and be read as staff having replied. Instead, wait
// for Meta's echo (2 s, then 6 s more) and adopt it if it arrives. If it does
// not, stop: possibly delivered, never confirmed. Lifted out of
// dispatch-instagram-stamp.ts, whose header has the full reasoning.

import {
  sendOutcomeUnknown,
  type InstagramImageSendFailureKind,
  type InstagramImageSendResult,
} from '@/lib/messaging/instagram/send'

/** Waits before the 2nd and 3rd attempts (ruled: up to 2 more, with backoff). */
export const PASSPORT_SEND_BACKOFF_MS = [2_000, 6_000] as const
/** After an ambiguous failure: when to look for Meta's echo instead of resending. */
export const PASSPORT_ECHO_WAITS_MS = [2_000, 6_000] as const

const NOT_RETRYABLE: ReadonlySet<InstagramImageSendFailureKind> = new Set([
  'window_closed',
  'token_rejected',
  'recipient_unavailable',
  'invalid_url',
])

export type SendWithRetryResult =
  | { ok: true; mid: string; via: 'send' | 'echo' }
  | { ok: false; kind: InstagramImageSendFailureKind | null }

export async function sendWithRetry(input: {
  send: () => Promise<InstagramImageSendResult>
  /** The mid of Meta's echo of an image sent since `since`, or null. */
  findEchoSince: (since: Date) => Promise<string | null>
  sleep: (ms: number) => Promise<void>
  now: () => Date
  onAttempt: () => void
}): Promise<SendWithRetryResult> {
  let lastFailure: InstagramImageSendFailureKind | null = null
  for (let attempt = 0; attempt <= PASSPORT_SEND_BACKOFF_MS.length; attempt++) {
    if (attempt > 0) await input.sleep(PASSPORT_SEND_BACKOFF_MS[attempt - 1]!)
    const startedAt = input.now()
    input.onAttempt()
    const sent = await input.send()
    if (sent.ok) return { ok: true, mid: sent.mid, via: 'send' }
    lastFailure = sent.kind
    if (NOT_RETRYABLE.has(sent.kind)) break
    const httpStatus =
      sent.failure?.reason === 'graph_error' ? sent.failure.httpStatus : null
    if (sendOutcomeUnknown(sent.kind, httpStatus)) {
      for (const wait of PASSPORT_ECHO_WAITS_MS) {
        await input.sleep(wait)
        const echoed = await input.findEchoSince(startedAt)
        if (echoed !== null) return { ok: true, mid: echoed, via: 'echo' }
      }
      break
    }
  }
  return { ok: false, kind: lastFailure }
}
