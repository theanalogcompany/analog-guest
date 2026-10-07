// TAC-572: the only writer of `guests.opted_out_at`.
//
// Every suppression check in the repo reads that column (scan greeting, warm
// close, both follow-up engines, the holding message, operator dispatch), and
// until this file nothing wrote it, so no opt-out had ever taken effect on
// either channel. The Oct 6 phone test caught it: "stop messaging me" got
// "got it, we'll stop" and the next message got a welcome and a name ask.
//
// Three things live here: the read, the two CAS writes, and the pure decision
// the inbound turn acts on. The decision is pure so the rules below are one
// table rather than branches spread through handle-inbound.ts.
//
// THE RULES (ruled 2026-10-06, both rounds, on the ticket):
//   - A turn classified `opt_out` records the opt-out and still sends its
//     confirmation.
//   - Instagram: an opted-out guest who writes again is opted back in, UNLESS
//     the message is an `acknowledgment` (silence: "thanks" after the
//     confirmation must not undo it) or another `opt_out` (confirmed again).
//   - SMS: only START opts back in, and it is the keyword that decides, never
//     the category: a bare "START" can classify as an acknowledgment. Anything
//     else from an opted-out SMS guest gets silence.
//   - One exception to that silence: the retry of an `opt_out` turn that
//     failed after recording. The guest is opted out by then and did not say
//     START, but the confirmation is still owed.
//   - TAC-574, NOT in decideOptOutTurn: a message with media and no text is
//     never classified, so its two rules live with its card
//     (persistMediaOnlyCard in lib/agent/handle-inbound.ts). SMS: silence.
//     Instagram: opted back in, with the open gaps that docstring lists.
//
// START ONLY, NOT UNSTOP. Sendblue suppresses its own outbound to a number
// that replied STOP and resumes only on START (its support docs), so clearing
// our flag on a word Sendblue ignores would leave us believing we can send to
// someone every send is dropped for.

import { createAdminClient } from '@/lib/db/admin'
import type { RAGResult } from '@/lib/rag/types'
import type { MessageChannel } from '@/lib/schemas/message-channel'

/** Which kind of re-opt-in a turn is. Picks the prompt line it renders. */
export type ReOptIn = 'instagram' | 'sms_start'

export type OptOutTurnDecision =
  /** Not an opt-out turn and the guest is not opted out. The ordinary turn. */
  | { action: 'none' }
  /** Record the opt-out (a no-op when already set), then confirm as usual. */
  | { action: 'record' }
  /** The guest stays opted out and hears nothing on this turn. */
  | { action: 'silence' }
  /** Clear the opt-out and run the turn, marked so the prompt can say so. */
  | { action: 'clear'; reOptIn: ReOptIn }

const SMS_OPT_IN_KEYWORD = 'start'

/** Is the whole message, trimmed and case-folded, the SMS opt-in keyword? */
export function isSmsOptInKeyword(body: string): boolean {
  return body.trim().toLowerCase() === SMS_OPT_IN_KEYWORD
}

/**
 * What an inbound turn does about the guest's opt-out. Pure.
 *
 * `channel` null (unresolved) is treated as SMS, the stricter of the two: an
 * unknown channel must not opt anyone back in on an ordinary message. The
 * inbound turn refuses to run on a null channel anyway, so this is a default
 * for a case that should not arrive rather than a rule about it.
 */
export function decideOptOutTurn(input: {
  channel: MessageChannel | null
  optedOut: boolean
  category: string
  body: string
  /**
   * This run is the one retry of a turn that failed (`turn.retryDepth > 0`).
   * A failed `opt_out` turn has already recorded the opt-out, so on SMS its
   * retry would otherwise read an opted-out guest who did not say START and
   * go silent, and the confirmation the first attempt failed to send would
   * never go out.
   */
  isRetry: boolean
}): OptOutTurnDecision {
  const { channel, optedOut, category, body, isRetry } = input

  if (!optedOut) {
    return category === 'opt_out' ? { action: 'record' } : { action: 'none' }
  }

  if (channel !== 'instagram') {
    if (isSmsOptInKeyword(body))
      return { action: 'clear', reOptIn: 'sms_start' }
    return isRetry && category === 'opt_out'
      ? { action: 'record' }
      : { action: 'silence' }
  }

  if (category === 'opt_out') return { action: 'record' }
  if (category === 'acknowledgment') return { action: 'silence' }
  return { action: 'clear', reOptIn: 'instagram' }
}

/** Is `guests.opted_out_at` set? Venue-scoped, like every guest write here. */
export async function readOptedOut(input: {
  venueId: string
  guestId: string
}): Promise<RAGResult<boolean>> {
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('guests')
      .select('opted_out_at')
      .eq('id', input.guestId)
      .eq('venue_id', input.venueId)
      .maybeSingle()
    if (error) return { ok: false, error: error.message }
    return { ok: true, data: data?.opted_out_at != null }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Set `opted_out_at` to now, only where it is null, so the first opt-out's
 * time survives a guest who says it twice. `data` is whether THIS call set it.
 */
export async function recordOptOut(input: {
  venueId: string
  guestId: string
}): Promise<RAGResult<{ changed: boolean }>> {
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('guests')
      .update({ opted_out_at: new Date().toISOString() })
      .eq('id', input.guestId)
      .eq('venue_id', input.venueId)
      .is('opted_out_at', null)
      .select('id')
    if (error) return { ok: false, error: error.message }
    return { ok: true, data: { changed: (data?.length ?? 0) > 0 } }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Clear `opted_out_at`. `data` is whether THIS call cleared it. */
export async function clearOptOut(input: {
  venueId: string
  guestId: string
}): Promise<RAGResult<{ changed: boolean }>> {
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('guests')
      .update({ opted_out_at: null })
      .eq('id', input.guestId)
      .eq('venue_id', input.venueId)
      .not('opted_out_at', 'is', null)
      .select('id')
    if (error) return { ok: false, error: error.message }
    return { ok: true, data: { changed: (data?.length ?? 0) > 0 } }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
