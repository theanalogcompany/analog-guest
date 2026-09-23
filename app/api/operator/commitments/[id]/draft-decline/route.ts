// POST /api/operator/commitments/[id]/draft-decline — operator swipes left
// on a pending_ack heads-up card. Generates an agent decline draft and
// persists it as a pending review row (NO Sendblue dispatch). Marks the
// underlying commitment cancelled. The operator-app routes the returned
// messageId into the existing edit screen for final review + send.
//
// TAC-364: the response also carries the persisted `body`, so that edit screen
// renders the apology on first paint instead of "That draft is no longer
// pending". See the read-back comment below for why it comes off the row.
//
// TAC-299 (cross-repo sibling TAC-298).
//
// Contract conformance (NOT using withOperatorAuth):
//
// The Contract specifies fixed-string error bodies — `{"error":"unauthorized"}`
// at 401, `{"error":"not_found"}` at 404, `{"error":"invalid_state"}` at 409,
// `{"error":"refused"}` at 422, `{"error":"internal_error"}` at 502/500 (502 also
// covers a decline draft dropped before any write, TAC-394). The
// shared withOperatorAuth HOF forwards AuthError.message verbatim — fine for
// the TAC-258 legacy routes that predate cross-repo Contracts but breaks the
// sibling client's `error === 'unauthorized'` matching. Same posture as
// /acknowledge (TAC-297) and /thread (TAC-277).
//
// ACL: both "commitment does not exist" and "commitment exists at a venue
// outside the operator's allowlist" return 404 — uniform, indistinguishable
// to the client. The existence-leak prevention rule is consistent across
// every Contract-bound operator route.
//
// State machine: only status='pending_ack' commitments can be declined. Any
// other state (open, cancelled, acknowledged, expired, redeemed) → 409
// invalid_state. We discriminate this from 404 because we DID find the row —
// just in the wrong state — and the operator-app surfaces a different toast
// ("already handled") vs "couldn't find it."
//
// Cancellation timing (TAC-299 Decision 1): we mark cancelled on trigger
// (here), NOT on send of the decline. The operator's swipe-left intent is
// the load-bearing signal — even if they abandon the edit screen the venue
// still can't honor the commitment. editAndSend is commitment-agnostic;
// routing cancellation through send would require new wiring. Failure mode
// is acceptable: if the operator declines and then closes the edit screen
// without sending, the commitment is cancelled but no apology lands. That's
// a deliberate operator action.
//
// Single-pending-draft edge (TAC-299 Decision 2): if a prior pending draft
// exists for the (venue, guest), persistOrRegenQueuedDraft UPDATEs in place
// — the decline clobbers it. The operator's "we can't fulfill" outranks an
// auto-generated reply still awaiting review. captureDraftRegenerated
// PostHog event observes the trigger transition.

import { NextResponse } from 'next/server'

import { handleOperatorDecline } from '@/lib/agent'
import {
  captureOperatorDraftDeclineInitiated,
} from '@/lib/analytics/posthog'
import { AuthError, verifyOperatorRequest } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import { markCancelled } from '@/lib/guests/commitments'
import { venueFilterIds } from '@/lib/auth/venue-scope'

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
  const { id: commitmentId } = await ctx.params
  if (!UUID_RE.test(commitmentId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // TAC-530: a bearer principal with zero grants, and a fleet-wide scope
  // (which the operator API never legitimately receives), both deny. 404
  // uniformly with not-found / out-of-allowlist; skip the round trip.
  const venueIds = venueFilterIds(operator.venueScope)
  if (venueIds === null || venueIds.length === 0) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // ---- load + venue-allowlist + state check ----
  const supabase = createAdminClient()
  const { data: row, error: loadError } = await supabase
    .from('guest_commitments')
    .select('id, venue_id, guest_id, status, description, type, created_at')
    .eq('id', commitmentId)
    .in('venue_id', venueIds)
    .maybeSingle()

  if (loadError) {
    console.warn(
      `[/api/operator/commitments/:id/draft-decline] commitment load failed: ${loadError.message}`,
    )
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
  if (!row) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (row.status !== 'pending_ack') {
    return NextResponse.json({ error: 'invalid_state' }, { status: 409 })
  }
  if (typeof row.description !== 'string' || row.description.trim().length === 0) {
    // Defensive: a commitment row with an empty description shouldn't exist
    // (the DB column is NOT NULL and the agent's pendingFromEmission guards
    // empty description before materialization), but if one slipped in we
    // refuse to invoke generation on a hint with an unbounded interpolation.
    console.warn(
      `[/api/operator/commitments/:id/draft-decline] commitment ${commitmentId} has empty description`,
    )
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }

  // ---- generate + persist pending (NO send) ----
  const result = await handleOperatorDecline({
    venueId: row.venue_id,
    guestId: row.guest_id,
    commitmentId: row.id,
    commitmentDescription: row.description,
  })

  if (result.status === 'failed') {
    console.warn(
      `[/api/operator/commitments/:id/draft-decline] pipeline failed stage=${result.stage} error=${result.error}`,
    )
    return NextResponse.json({ error: 'internal_error' }, { status: 502 })
  }
  if (result.status === 'refused') {
    return NextResponse.json({ error: 'refused' }, { status: 422 })
  }
  if (result.status !== 'queued') {
    // 'dropped' (TAC-394): the decline draft carried a different obligation
    // than the guest's pending obligation card, so nothing was written. The
    // commitment is NOT cancelled, because cancellation below runs only after a
    // queued draft, and the existing internal_error keeps the Contract as it is.
    // 'sent' / 'skipped_duplicate' would be a structural regression. Either
    // way: 502 with a logline rather than a silent 200.
    console.warn(
      `[/api/operator/commitments/:id/draft-decline] unexpected pipeline status=${result.status}`,
    )
    return NextResponse.json({ error: 'internal_error' }, { status: 502 })
  }

  const messageId = result.outboundMessageId

  // ---- read the persisted body back for the response (TAC-364) ----
  //
  // The Contract returns `{ messageId, body }` rather than `{ messageId }`
  // alone, so the operator app can render /queue/edit on FIRST PAINT.
  // Without it that screen resolves the draft out of `queue.drafts`, a client
  // cache that cannot contain a row created server-side milliseconds ago, and
  // renders "That draft is no longer pending" — not a rare race but the
  // guaranteed first frame of every decline. TAC-298 worked around it with a
  // blocking full-queue refetch before navigating, which TAC-304 then filed as
  // a 5-10s lag; returning the body removes both the wrong first paint and the
  // extra round trip.
  //
  // Read back from the ROW rather than threaded out of the generation. The
  // persist layer strips stray bubble delimiters via collapseToSingleMessage
  // before writing, so the generated string and the stored string are not
  // guaranteed identical — and it is the stored one the operator will send.
  // Prefilling anything else would show them text that is not on the row.
  //
  // Degrades to '' rather than failing the request. The draft is already
  // persisted and the commitment is about to be cancelled; a 5xx here would
  // leave the operator unable to reach a draft that exists, and a retry would
  // hit 409 invalid_state on the already-cancelled commitment. An empty
  // composer that fills in on the next realtime tick is a far smaller cost,
  // and still strictly better than the wrong-state screen this replaces.
  let body = ''
  const { data: draftRow, error: draftError } = await supabase
    .from('messages')
    .select('body')
    .eq('id', messageId)
    .maybeSingle()
  if (draftError) {
    console.warn(
      `[/api/operator/commitments/:id/draft-decline] decline body read degraded for message=${messageId}: ${draftError.message}`,
    )
  } else {
    body = draftRow?.body ?? ''
  }

  // ---- transition commitment → cancelled (CAS-gated, race-safe) ----
  // Per Decision 1: this happens AFTER persist succeeds. If markCancelled
  // lost the CAS race (concurrent acknowledge from another operator), the
  // commitment is not at status='cancelled' — that's fine. The decline
  // draft is still persisted; the operator can decide whether to send it.
  // captureOperatorDraftDeclineInitiated carries the CAS-lost flag for
  // observability.
  const now = new Date()
  const cancelResult = await markCancelled({
    commitmentId: row.id,
    operatorId: operator.operatorId,
    venueScope: operator.venueScope,
    now,
  })
  let cancellationRaceLost = false
  if (!cancelResult.ok) {
    // DB error during cancellation. The draft is persisted; this is the
    // recovery-secondary side effect failing. Log + accept (don't 500
    // because we'd have to UNDO the persist to keep the API contract
    // honest, and we'd rather have the draft + a stale-status commitment
    // than nothing).
    console.warn(
      `[/api/operator/commitments/:id/draft-decline] markCancelled failed (continuing) errorCode=${cancelResult.errorCode ?? '<none>'} error=${cancelResult.error}`,
    )
    cancellationRaceLost = true
  } else if (!cancelResult.data.transitioned) {
    // CAS lost — another operator acknowledged (or cancelled) the row
    // between our load + our markCancelled. Same posture: log + accept.
    console.warn(
      `[/api/operator/commitments/:id/draft-decline] markCancelled CAS lost for commitment=${row.id}`,
    )
    cancellationRaceLost = true
  }

  await captureOperatorDraftDeclineInitiated({
    venueId: row.venue_id,
    guestId: row.guest_id,
    commitmentId: row.id,
    messageId,
    operatorId: operator.operatorId,
    type: row.type,
    timeToActionMs: Math.max(0, now.getTime() - new Date(row.created_at).getTime()),
    commitmentCancellationRaceLost: cancellationRaceLost,
  })

  return NextResponse.json({ messageId, body })
}
