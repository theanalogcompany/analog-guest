/**
 * The once-ever Google review ask.
 *
 * One module owns all three halves of the feature's agent-side contract, so
 * they cannot drift apart:
 *
 *   WHEN to raise it   — deriveReviewAsk, the eligibility predicate. Called in
 *                        exactly one place (handle-inbound.ts, post-classify),
 *                        which is what keeps the ask off followups, declines,
 *                        the holding message and every proactive path.
 *   WHAT "sent" means  — bodyContainsReviewLink: the body that actually
 *                        reached the guest contains the venue's review URL
 *                        character for character. One definition, read by the
 *                        auto-send stamp (handle-inbound, against
 *                        deliveredBody) and the operator-approved stamp
 *                        (dispatch-operator-outbound, against the dispatched
 *                        body).
 *   ONCE EVER          — markReviewAsked, a CAS on guests.review_asked_at
 *                        (`... where review_asked_at is null`, migration 068).
 *                        The column is also the claim, the warm_close_sent_at
 *                        design one feature over. For the PRAISE ask it is
 *                        never written at queue time: a skipped card leaves
 *                        the guest re-eligible on their next praise. The timed
 *                        SIGN-OFF (TAC-575) is the exception and claims it
 *                        before sending; see releaseReviewAskClaim.
 *
 * Failure directions, chosen not inherited:
 *   - The predicate fails toward NOT asking (any unreadable input reads as
 *     ineligible). A missed ask waits for the guest's next praise; a wrong
 *     ask spends a moment that comes once.
 *   - The stamp runs post-dispatch and swallowed (a marker failure must never
 *     reject a send that already happened), but a swallowed failure logs —
 *     the guest may be asked twice, and that must be visible, not silent.
 */

import { createAdminClient } from '@/lib/db/admin'
import { findReviewLink, parseVenueLinks } from '@/lib/schemas'
import type { RuntimeContext } from './types'
import type { VisitCheckinAnswer } from './visit-checkin'

/**
 * Categories that must never carry the review ask, as a deny-list (decision
 * 0002's posture). `comp_complaint` covers the praise+complaint coalesced
 * burst — one classification per turn, and a burst that reads as a complaint
 * classifies as one. `opt_out` is the compliance turn, `manual` needs an
 * operator's eyes, and `unknown` ships a holding response.
 */
const REVIEW_ASK_DENIED_CATEGORIES = new Set([
  'comp_complaint',
  'opt_out',
  'manual',
  'unknown',
])

/**
 * Should THIS turn raise the review ask? {url, label} from the venue's
 * curated `venue_info.links` entry when every condition holds, null otherwise.
 *
 * All eight conditions, in cheap-first order:
 *   1. the classifier read genuine praise (praisedExperience)
 *   2. not a crisis turn (belt — the crisis short-circuit already returned)
 *   3. category not on the deny-list above
 *   4. the venue owes this guest no answer (same rule intentions follow)
 *   5. not the guest's first conversation (its choreography is already ruled:
 *      TAC-567/568's two questions and the warm close)
 *   5a. not inside a visit check-in (TAC-575: that guest is asked at the
 *      sign-off, by deriveSignOffReviewAsk)
 *   6. never asked before (guests.review_asked_at is null)
 *   7. the venue curated a review link (kind: 'review' in venue_info.links)
 */
export function deriveReviewAsk(
  ctx: RuntimeContext,
): { url: string; label: string } | null {
  const classification = ctx.classification
  if (classification === null) return null
  if (classification.praisedExperience !== true) return null
  if (classification.crisisSafety !== false) return null
  if (REVIEW_ASK_DENIED_CATEGORIES.has(classification.category)) return null
  if (ctx.pendingQuestion !== null) return null
  if (ctx.firstConversation !== false) return null
  // TAC-575: a guest inside a visit check-in is asked at the SIGN-OFF, not on
  // the turn they say it is good (ruled 2026-10-06). "It's great" in answer to
  // "how is it so far?" is praise, and praise is condition 1 above, so without
  // this the answer to our own question would raise the ask mid-visit and take
  // the turn from the name ask. handleInbound sets the flag; the sign-off's own
  // ask is deriveSignOffReviewAsk below.
  if (ctx.insideVisitCheckin) return null
  if (ctx.guest.reviewAskedAt !== null) return null
  const link = findReviewLink(parseVenueLinks(ctx.venue.venueInfo.links))
  if (link === null) return null
  return { url: link.url, label: link.label }
}

/**
 * Should a SIGN-OFF carry the review invitation? (TAC-575.)
 *
 * The other half of the ruling deriveReviewAsk's check-in condition serves: a
 * guest who said their order is good is invited at the sign-off, whether they
 * said goodbye or simply went quiet.
 *
 * PURE, and it takes its facts as arguments rather than a RuntimeContext,
 * because its one caller, the pause timer, has no context built yet when it
 * decides which sign-off to send.
 *
 *   the check-in reads `good`   Nothing weaker on its own. `not_yet` is a
 *                               guest who never said they liked it, and `bad`
 *                               is the next visit's follow-up.
 *   OR a followed-up complaint  The other half of the ruling: "unhappy guests
 *                               after the fix", with no happiness condition,
 *                               so the link is never offered only to guests
 *                               who say they are happy.
 *   never asked before          The once-ever marker, shared with the praise
 *                               ask: one invitation per guest, whichever path
 *                               gets there.
 *   the venue has a review link
 *
 * NOT limited to a first conversation, unlike the close it rides on (ruled
 * 2026-10-06): every guest who answers "how is it?" is eventually offered the
 * link, and a regular answers it too.
 */
export function deriveSignOffReviewAsk(input: {
  checkinAnswer: VisitCheckinAnswer | null
  /**
   * TAC-575 PR 5: this guest's earlier complaint has been followed up and they
   * are on a visit now without complaining again
   * (owesAfterComplaintReviewAsk, lib/agent/visit-checkin.ts).
   */
  afterComplaint: boolean
  reviewAskedAt: Date | null
  links: unknown
}): { url: string; label: string } | null {
  if (input.checkinAnswer !== 'good' && !input.afterComplaint) return null
  if (input.reviewAskedAt !== null) return null
  const link = findReviewLink(parseVenueLinks(input.links))
  if (link === null) return null
  return { url: link.url, label: link.label }
}

/**
 * Did the body that reached the guest carry the review link?
 *
 * A character-exact substring check against the curated URL — the same
 * string the url-detector's allowlist holds, so a composed ask that passed
 * the link check matches here by construction. Deliberately NOT a regex or a
 * normalized comparison: the allowlist is character-exact and this check
 * inherits that, so an operator who edits the link out does not stamp and
 * one who types it into any draft does.
 */
export function bodyContainsReviewLink(body: string, url: string): boolean {
  return url.trim() !== '' && body.includes(url)
}

export type MarkReviewAskedResult =
  /** This write owns the marker; the guest is now asked, forever. */
  | { ok: true; data: 'marked' }
  /** Another path already stamped it (racing coalesced runs). */
  | { ok: true; data: 'already_marked' }
  | { ok: false; error: string }

/**
 * Stamp guests.review_asked_at, once ever.
 *
 * The CAS predicate (`is null`) is the idempotency anchor; scoped on BOTH
 * venue_id and guest_id per the errors-as-values write rule, so an id from
 * anywhere surprising can never stamp another venue's guest row.
 *
 * Callers run this post-dispatch inside waitUntil and treat {ok: false} as
 * log-only: the ask already reached the guest, so the only remaining
 * question is whether the marker records it, and a failed marker is a
 * possible second ask later — visible in the log, never a broken turn.
 */
export async function markReviewAsked(args: {
  venueId: string
  guestId: string
  now: Date
}): Promise<MarkReviewAskedResult> {
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('guests')
      .update({ review_asked_at: args.now.toISOString() })
      .eq('id', args.guestId)
      .eq('venue_id', args.venueId)
      .is('review_asked_at', null)
      .select('id')
    if (error) return { ok: false, error: error.message }
    return {
      ok: true,
      data: (data ?? []).length === 1 ? 'marked' : 'already_marked',
    }
  } catch (e) {
    // supabase-js throws on some failures (unreachable host) and returns
    // {error} on others; a module whose contract is "never throws" needs both
    // handled (errors-as-values rule).
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Give back a marker that was CLAIMED for a sign-off the guest never got.
 *
 * The praise ask stamps the marker after the send, from what was delivered.
 * The timed sign-off cannot: two ticks a minute apart would both find the
 * guest unasked and both send. So that path takes the marker BEFORE generating
 * (markReviewAsked is already the compare-and-set) and gives it back here if
 * the invitation did not reach them: the send failed, or the reply went out
 * without the link.
 *
 * Scoped to the exact timestamp the claim wrote, so it can only undo its own.
 * A sign-off HELD for an operator keeps the claim, and a skipped card
 * therefore uses up the guest's one ask (accepted 2026-10-06, to avoid a claim
 * column of its own).
 */
export async function releaseReviewAskClaim(args: {
  venueId: string
  guestId: string
  claimedAt: Date
}): Promise<void> {
  try {
    const supabase = createAdminClient()
    const { error } = await supabase
      .from('guests')
      .update({ review_asked_at: null })
      .eq('id', args.guestId)
      .eq('venue_id', args.venueId)
      .eq('review_asked_at', args.claimedAt.toISOString())
    if (error) {
      console.error('[review-ask] claim release failed', {
        guestId: args.guestId,
        error: error.message,
      })
    }
  } catch (e) {
    console.error('[review-ask] claim release threw', {
      guestId: args.guestId,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}
