// POST /api/operator/messages/[id]/resolve-external — the operator says this
// card was answered outside the app (TAC-473, cross-repo sibling TAC-486).
//
// WHY IT EXISTS. TAC-473's echo resolution clears a card automatically when a
// reply typed in the Instagram app echoes back to us. That echo can be slow,
// and it can be missed. TAC-486 item 5 therefore asks the operator on return
// to the app: "Sent" / "Not yet". "Sent" lands here.
//
// The two alternatives were both FALSE RECORDS, which is why this endpoint was
// added rather than reusing one:
//   - approve would try to send a message the guest already has, and on an
//     expired window Meta would refuse it anyway.
//   - skip records "the operator chose to send nothing", when in fact they
//     sent something. It would also corrupt the skip rate.
//
// Contract conformance (NOT using withOperatorAuth): the Contract specifies
// fixed-string error bodies, and the shared HOF forwards AuthError.message
// verbatim. Same reasoning and same shape as the TAC-277 thread route beside
// it — auth verified inline, err.message discarded.
//
// IDEMPOTENT BY DESIGN. A second call returns 200 with alreadyResolved, not an
// error: the operator may double-tap, and the echo may land between their tap
// and this request. Either way the card is resolved and saying so twice is the
// honest answer. It is also what stops the echo path and this path
// duplicating: whichever arrives second finds the card no longer pending.
//
// NOT RESTRICTED to expired cards or to Instagram cards. The operator is
// asserting a fact about the world — they sent it — and the server has no
// better information than they do. The echo path is the one that must be
// conservative, because it is inferring.

import { NextResponse } from 'next/server'

import { captureOperatorMessageResolvedExternally } from '@/lib/analytics/posthog'
import { AuthError, verifyOperatorRequest } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
// From lib/schemas, not the Instagram folder: this route is deliberately not
// Instagram-specific, and the value is shared by three callers that must not
// import each other.
import { RESOLVED_EXTERNALLY_REVIEW_STATE } from '@/lib/schemas/review-state'
import { venueFilterIds } from '@/lib/auth/venue-scope'

// Canonical UUID regex, as app/api/operator/messages/[id]/thread/route.ts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  // ---- auth (inline, Contract-shaped body) ----
  let operator
  try {
    operator = await verifyOperatorRequest(request)
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    throw err
  }

  // ---- params ----
  const { id: messageId } = await ctx.params
  // A non-UUID id does not exist by definition. 404, not 400, so the wire
  // surface stays flat and existence is never leaked.
  if (!UUID_RE.test(messageId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // An EMPTY allowlist means NO venue access on this path, and it is a deny.
  //
  // `verifyOperatorRequest` builds the venue scope from the operator's literal
  // `operator_venues` rows (lib/auth/verify-jwt.ts), so empty means they are
  // allowlisted for nothing. The `if (length > 0)` idiom belongs to the COOKIE
  // path (lib/auth/require-admin.ts), where empty deliberately means
  // analog-admin scope and therefore every venue. Two auth paths, one field
  // name, opposite meanings.
  //
  // Guarded here, before the database, exactly as listPendingQueue,
  // listOperatorConversations, listHeadsUpQueue, loadGuestThread and the two
  // commitment helpers all do. 404 rather than 403, per the existence-leak rule
  // the rest of app/api/operator/* follows.
  const venueIds = venueFilterIds(operator.venueScope)
  if (venueIds === null || venueIds.length === 0) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const supabase = createAdminClient()
  const now = new Date().toISOString()

  // CAS on review_state, so a card an operator approved, edited or skipped in
  // the meantime is left exactly as they left it.
  //
  // resolved_by_message_id is deliberately NOT set. It records which ECHO
  // answered a card, and an operator asserting they sent something is a weaker
  // record than an echo proving it. Leaving it NULL is what keeps the two
  // distinguishable in SQL afterwards.
  //
  // previous_review_state is deliberately NOT set either. Note what actually
  // stops /undo reaching this row: NOT the operator stamps below, which this
  // route does set, so within the 3-second window /undo finds it. It is that
  // /undo's state switch has no branch for this value and falls through to its
  // 409 "nothing to undo". If an undo is ever wanted here, that is a decision,
  // not an oversight to be corrected in passing.
  const claimQuery = supabase
    .from('messages')
    .update({
      review_state: RESOLVED_EXTERNALLY_REVIEW_STATE,
      last_operator_action_at: now,
      last_operator_id: operator.operatorId,
    })
    .eq('id', messageId)
    .eq('review_state', 'pending')
    .eq('direction', 'outbound')
    .in('venue_id', venueIds)

  const { data: claimed, error: claimErr } = await claimQuery.select(
    'id, venue_id, guest_id, channel, created_at',
  )

  if (claimErr) {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }

  if (!claimed || claimed.length === 0) {
    // Rowcount 0 — either not found / not allowed, or already acted on. Look
    // up the current state to tell them apart.
    // The allowlist is applied HERE TOO, and it is load-bearing rather than
    // belt-and-braces: without it this lookup reports `review_state` for any
    // message in the fleet by id, which is the existence leak the uniform 404
    // below exists to prevent.
    const { data: current, error: lookupErr } = await supabase
      .from('messages')
      .select('id, review_state, direction')
      .eq('id', messageId)
      .in('venue_id', venueIds)
      .maybeSingle()
    if (lookupErr) {
      return NextResponse.json({ error: 'internal_error' }, { status: 500 })
    }
    // Out of the allowlist is indistinguishable from absent, per the
    // existence-leak rule the rest of app/api/operator/* follows.
    if (!current || current.direction !== 'outbound') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    return NextResponse.json({
      ok: true,
      reviewState: current.review_state,
      alreadyResolved: true,
    })
  }

  const row = claimed[0]!

  await captureOperatorMessageResolvedExternally({
    venueId: row.venue_id,
    guestId: row.guest_id,
    messageId: row.id,
    operatorId: operator.operatorId,
    channel: row.channel,
    timeToActionMs: Math.max(0, Date.now() - new Date(row.created_at).getTime()),
  })

  return NextResponse.json({
    ok: true,
    reviewState: RESOLVED_EXTERNALLY_REVIEW_STATE,
  })
}
