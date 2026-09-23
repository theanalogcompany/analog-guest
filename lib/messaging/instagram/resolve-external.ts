// TAC-473: a card answered from the Instagram app clears itself.
//
// Staff can reply to a guest from Instagram directly, and until now the
// operator app had no concept of a card being satisfied from outside: every
// card was resolved from inside the app. A reply typed in the Instagram app
// comes back to us as an ECHO (TAC-468), and if that guest was holding a
// pending card whose reply window had already closed, the card is now stale —
// the guest has their answer, and the card cannot be sent from the app anyway.
//
// ---------------------------------------------------------------------------
// WHY AN ECHO AFTER EXPIRY CANNOT BE ONE OF OUR OWN SENDS
// ---------------------------------------------------------------------------
// This is the structural guard the whole mechanism rests on, and it is worth
// stating here rather than only in the plan.
//
// Our own Instagram sends echo back to us too, so a naive "an echo arrived,
// clear a card" rule would let the agent's own reply, or an operator's own
// approve, resolve some OTHER card for the same guest. Nothing in the echo
// itself distinguishes the two: at the moment it is persisted, an agent send
// racing its own echo has not written its `mid` yet (TAC-469 rule 6).
//
// The window is what separates them. EVERY send we make is gated on the reply
// window being OPEN: prepareInstagramOperatorSend refuses a closed one before
// the card leaves the queue, dispatchInstagramReply gates before the first
// bubble and RE-CHECKS before every later one, and the hand-run smoke script
// (scripts/instagram-send-smoke.ts) has its own stricter pre-flight. So an echo
// arriving while the window is EXPIRED is staff typing in the Instagram app,
// which is exactly the population this exists for.
//
// BE PRECISE ABOUT THE MARGIN, because the absolute phrasing this comment first
// carried was not quite true. A send is permitted only while more than
// INSTAGRAM_WINDOW_MARGIN_MS (5 minutes) remains, and windowHasExpired below
// measures against the TRUE deadline. So the honest claim is: an echo arriving
// after expiry cannot be ours UNLESS it took more than 5 minutes to reach us
// after our own send — which a Meta retry can exceed. The direction is still
// the safe one (see windowHasExpired's own docstring: the true deadline keeps
// the expired set as small as it can be, and the margin is the buffer), but
// "cannot be ours" is a 5-minute guarantee, not an absolute one.
//
// That is why the expiry check is not a nicety and must not be relaxed into
// "resolve any card when an echo arrives". It is the only thing standing
// between this feature and the agent silently closing its own cards.
//
// One narrow hole, stated rather than papered over: prepareInstagramOperatorSend
// does NOT refuse when the window READ fails ("Meta enforces it anyway"), so a
// send could go out with the window actually closed and its echo could then
// resolve another expired card. It needs a database fault inside the send.
//
// ---------------------------------------------------------------------------
// WHICH CARD, WHEN THERE ARE SEVERAL
// ---------------------------------------------------------------------------
// TAC-397 lets a guest hold one obligation card plus one conversation card per
// unanswered inbound, so "the" card is not well defined. Rules:
//
//   * Resolve exactly ONE, the OLDEST (FIFO, the order the queue itself shows
//     them in). One send, one card. Staff sending three replies produces three
//     echoes and resolves three cards, one each.
//   * Match none, and nothing happens.
//
// The asymmetry is deliberate. Resolving too FEW leaves a stale card an
// operator can see and skip — visible and recoverable. Resolving too MANY
// silently drops a question the guest actually asked, with nothing left to
// show it was ever there. So the rule fails toward too few.
//
// Instagram cards only. A guest with both a phone number and an Instagram ID
// can hold a text card too, and a reply typed in the Instagram app does not
// answer a card queued for SMS.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'
import { RESOLVED_EXTERNALLY_REVIEW_STATE } from '@/lib/schemas/review-state'

import type { InstagramEventOutcome } from './handle-events'
import { INSTAGRAM_WINDOW_MS, loadLastGuestActionAt } from './window'

type AdminSupabaseClient = SupabaseClient<Database>


export interface ExternalResolutionTarget {
  venueId: string
  guestId: string
  /** The echo row, recorded on the card as what was actually sent. */
  echoMessageId: string
}

export type ExternalResolutionOutcome =
  /** A card was resolved. */
  | { status: 'resolved'; cardId: string; hadPendingCommitment: boolean }
  /** The window is still open, so this echo is one of our own sends. */
  | { status: 'window_open' }
  /** No saved guest action carries Meta's clock, so expiry cannot be established. */
  | { status: 'window_unknown' }
  /** Expired, but the guest holds no pending Instagram card. */
  | { status: 'no_card' }
  /** The card stopped being pending between the read and the write. */
  | { status: 'lost_race'; cardId: string }
  | { status: 'failed'; error: string }

/**
 * Pure. Which deliveries are candidates for external resolution.
 *
 * ONLY a newly persisted echo. A `duplicate` echo is one Meta redelivered, or
 * one of our own sends being reconciled by TAC-469, and in both cases the row
 * already existed so nothing new has been said to the guest. Everything else —
 * a guest message, a postback, a read receipt, a skip, a failure — is not the
 * venue saying something.
 *
 * Shaped as a selector returning null so the route can call it in its outcome
 * loop beside resolveAgentHandoff and profileRefreshTargetFor, rather than
 * branching on the outcome union in the route itself.
 */
export function externalResolutionTargetFor(
  outcome: InstagramEventOutcome,
): ExternalResolutionTarget | null {
  if (outcome.status !== 'persisted') return null
  if (outcome.kind !== 'echo') return null
  return {
    venueId: outcome.venueId,
    guestId: outcome.guestId,
    echoMessageId: outcome.messageId,
  }
}

/**
 * Whether the reply window has closed, on Meta's TRUE deadline.
 *
 * NO MARGIN. instagramWindowState closes INSTAGRAM_WINDOW_MARGIN_MS early so a
 * send never races Meta's edge; that is right for a send and wrong here.
 * Subtracting the margin would make the "expired" set LARGER, and a larger set
 * is exactly where one of our own sends could slip in — the margin window is
 * precisely when a send is refused by us but still permitted by Meta. The true
 * deadline keeps the set as small as it can be, which is the safe direction.
 */
function windowHasExpired(lastGuestActionAt: Date, now: Date): boolean {
  return now.getTime() - lastGuestActionAt.getTime() >= INSTAGRAM_WINDOW_MS
}

/**
 * Resolve the oldest pending Instagram card for this guest, if the reply
 * window has closed. Never throws.
 */
export async function resolveCardAnsweredExternally(
  supabase: AdminSupabaseClient,
  target: ExternalResolutionTarget,
  now: Date,
): Promise<ExternalResolutionOutcome> {
  try {
    const lastAction = await loadLastGuestActionAt(supabase, target.venueId, target.guestId)
    if (!lastAction.ok) return { status: 'failed', error: lastAction.error }
    // Null means no saved guest action carries Meta's clock. Expiry cannot be
    // established, so nothing is resolved: a guess here would be a guess about
    // whether this echo is our own.
    if (lastAction.value === null) return { status: 'window_unknown' }
    if (!windowHasExpired(lastAction.value, now)) return { status: 'window_open' }

    const { data: card, error: cardError } = await supabase
      .from('messages')
      // pending_commitment comes back so the caller can COUNT the case below.
      .select('id, pending_commitment')
      .eq('venue_id', target.venueId)
      .eq('guest_id', target.guestId)
      .eq('review_state', 'pending')
      .eq('channel', 'instagram')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (cardError) return { status: 'failed', error: cardError.message }
    if (!card) return { status: 'no_card' }

    // CAS on review_state, so a card an operator approved, edited or skipped in
    // the meantime is left exactly as they left it.
    const { data: updated, error: updateError } = await supabase
      .from('messages')
      .update({
        review_state: RESOLVED_EXTERNALLY_REVIEW_STATE,
        resolved_by_message_id: target.echoMessageId,
      })
      .eq('id', card.id)
      .eq('review_state', 'pending')
      .select('id')
    if (updateError) return { status: 'failed', error: updateError.message }
    if (!updated || updated.length !== 1) return { status: 'lost_race', cardId: card.id }
    return {
      status: 'resolved',
      cardId: card.id,
      // FIFO takes the oldest pending card whatever slot it is in, so it CAN be
      // an obligation card carrying a comp, hold or discount. Resolving one
      // means createCommitmentFromPending never runs and nobody sees that the
      // venue promised something. The card was unsendable anyway (the window is
      // closed), so this is a visibility loss rather than a wrong send, and
      // narrowing FIFO to the conversation slot would leave obligation cards
      // stuck for ever. Surfaced rather than decided: the telemetry carries it
      // so the case can be counted before anyone rules on it.
      hadPendingCommitment: card.pending_commitment != null,
    }
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}
