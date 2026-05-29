// POST /api/operator/commitments/[id]/acknowledge — operator swipes right on
// a pending_ack heads-up card and transitions the commitment to acknowledged
// (TAC-297, cross-repo sibling TAC-298).
//
// Contract conformance (NOT using withOperatorAuth):
//
// The Contract specifies fixed-string error bodies — `{"error":"unauthorized"}`
// at 401, `{"error":"not_found"}` at 404, `{"error":"already_acknowledged"}`
// at 409, `{"error":"internal_error"}` at 500. The shared `withOperatorAuth`
// HOF forwards `AuthError.message` verbatim — which is fine for the TAC-258
// legacy routes that predate cross-repo Contracts but breaks the sibling
// client's `error === 'unauthorized'` matching. So this route verifies auth
// inline via verifyOperatorRequest + try/catch, discarding `err.message`.
// Same pattern as `/api/operator/messages/[id]/thread` (TAC-277).
//
// ACL: both "commitment does not exist" and "commitment exists at a venue
// outside the operator's allowlist" return 404 with `{"error":"not_found"}` —
// uniform, indistinguishable to the client. markAcknowledged's CAS gates on
// BOTH `status='pending_ack'` AND `venue_id IN (allowedVenueIds)`, so a
// transitioned=false response could mean any of:
//   - row doesn't exist
//   - row is in a venue outside the allowlist
//   - row is already acknowledged / cancelled / never reached pending_ack
// We can't disambiguate without leaking existence. The route maps the first
// two implicit cases to 404 (consistent with the rest of `/api/operator/*`)
// and the third to 409 — but the route can't tell them apart from the CAS
// result alone, so we follow the gate's own discrimination: a second SELECT
// AFTER the CAS lookup distinguishes "ack landed" from "row never existed
// (or out-of-allowlist)" from "row is now in a non-pending_ack state."

import { NextResponse } from 'next/server'

import {
  captureOperatorCommitmentAcknowledged,
} from '@/lib/analytics/posthog'
import { AuthError, verifyOperatorRequest } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import { markAcknowledged } from '@/lib/guests/commitments'

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

  // ---- transition ----
  const now = new Date()
  const result = await markAcknowledged({
    commitmentId,
    operatorId: operator.operatorId,
    allowedVenueIds: operator.allowedVenueIds,
    now,
  })

  if (!result.ok) {
    console.warn(
      `[/api/operator/commitments/:id/acknowledge] markAcknowledged failed errorCode=${result.errorCode ?? '<none>'} error=${result.error}`,
    )
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }

  if (result.data.transitioned && result.data.row !== null) {
    const row = result.data.row
    await captureOperatorCommitmentAcknowledged({
      venueId: row.venue_id,
      guestId: row.guest_id,
      commitmentId: row.id,
      operatorId: operator.operatorId,
      timeToActionMs: Math.max(0, now.getTime() - new Date(row.created_at).getTime()),
      type: row.type,
    })
    return NextResponse.json({ ok: true })
  }

  // CAS lost — disambiguate "doesn't exist or out-of-allowlist" (404) from
  // "exists but is no longer pending_ack" (409) via a defensive second SELECT.
  // The query mirrors markAcknowledged's allowlist scoping so an out-of-
  // allowlist row reads as "not found" — preserving the existence-leak
  // invariant.
  const supabase = createAdminClient()
  const probe = await supabase
    .from('guest_commitments')
    .select('id')
    .eq('id', commitmentId)
    .in(
      'venue_id',
      operator.allowedVenueIds.length === 0 ? [''] : operator.allowedVenueIds,
    )
    .maybeSingle()
  if (probe.error || !probe.data) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  return NextResponse.json({ error: 'already_acknowledged' }, { status: 409 })
}
