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
 *                        design one feature over. Never written at queue time:
 *                        a skipped card leaves the guest re-eligible on their
 *                        next praise.
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
 * All seven conditions, in cheap-first order:
 *   1. the classifier read genuine praise (praisedExperience)
 *   2. not a crisis turn (belt — the crisis short-circuit already returned)
 *   3. category not on the deny-list above
 *   4. the venue owes this guest no answer (same rule intentions follow)
 *   5. not the guest's first conversation (its choreography is already ruled:
 *      TAC-567/568's two questions and the warm close)
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
  // TAC-575, INTERIM UNTIL PR 4 OF THAT TICKET (ruled 2026-10-06). A guest who
  // answers "how is it so far?" with praise is, by the ruling, asked for a
  // review at the SIGN-OFF, not here. The sign-off does not exist until PR 4,
  // so until then this predicate is left exactly as it was and that praise
  // raises the ask on this turn, as any praise does.
  //
  // PR 4 removes this fallback by adding ONE condition at this line:
  //   if (isInsideVisitCheckin(ctx)) return null
  // where "inside" is a check-in row for the visit still within
  // CHECKIN_ANSWER_WINDOW_MS (lib/agent/visit-checkin.ts), or this turn's
  // orderTurnVerdict being 'good'. Nothing else here needs to change, and
  // nothing in this PR depends on the ask being raised.
  if (ctx.guest.reviewAskedAt !== null) return null
  const link = findReviewLink(parseVenueLinks(ctx.venue.venueInfo.links))
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
