// GET /api/operator/queue — list pending drafts AND pending_ack commitments
// (TAC-258 + TAC-297) for the authenticated operator's allowed venues. FIFO
// ordered (oldest first) on both surfaces.
//
// Response shape (additive — backward compatible with the TAC-258 client):
//   { drafts: QueueDraft[], commitments: HeadsUpCommitment[] }
//
// HeadsUpCommitment is locked at the cross-repo Contract level
// (TAC-297 ↔ TAC-298): `{ id, type, guest: {name}, description, code,
// expected_arrival, created_at }`.
//
// Auth: bearer-token via withOperatorAuth (lib/auth/operator-auth.ts). The
// HOF resolves to AuthenticatedOperator { operatorId, allowedVenueIds }
// and shapes AuthError as 401/403 JSON. The acknowledge endpoint
// (`/api/operator/commitments/[id]/acknowledge`) uses the inline Contract-
// bound auth pattern — but this queue route predates that and stays on the
// HOF; clients tolerate the existing 401 body shape from withOperatorAuth.
//
// Empty allowedVenueIds returns 200 with `{ drafts: [], commitments: [] }` —
// an operator with no venue grants isn't an error, they just see nothing.
// Both queue lookups run in parallel to avoid serial DB latency.

import { NextResponse } from 'next/server'

import { withOperatorAuth } from '@/lib/auth'
import { listHeadsUpQueue, listPendingQueue } from '@/lib/operator'

export const dynamic = 'force-dynamic'

export const GET = withOperatorAuth(async (_request, { operator }) => {
  const [draftsResult, commitmentsResult] = await Promise.all([
    listPendingQueue(operator.allowedVenueIds),
    listHeadsUpQueue(operator.allowedVenueIds),
  ])
  if (!draftsResult.ok) {
    return NextResponse.json(
      { error: 'queue lookup failed', detail: draftsResult.error },
      { status: 500 },
    )
  }
  if (!commitmentsResult.ok) {
    return NextResponse.json(
      { error: 'queue lookup failed', detail: commitmentsResult.error },
      { status: 500 },
    )
  }
  return NextResponse.json({
    drafts: draftsResult.drafts,
    commitments: commitmentsResult.commitments,
  })
})
