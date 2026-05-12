// GET /api/operator/queue — list pending drafts for the authenticated
// operator's allowed venues (TAC-258). FIFO ordered (oldest first), capped
// at 200 by the underlying RPC, with recent context + recognition state
// pre-joined in a single round trip.
//
// Auth: bearer-token via withOperatorAuth (lib/auth/operator-auth.ts). The
// HOF resolves to AuthenticatedOperator { operatorId, allowedVenueIds }
// and shapes AuthError as 401/403 JSON.
//
// Empty allowedVenueIds returns 200 with `{ drafts: [] }` — an operator with
// no venue grants isn't an error, they just see nothing. Matches the pattern
// from the cc-review/follow-up routes where empty allowlist is treated as
// "analog admin sees all" — except operators are NOT admins, so empty means
// no access.

import { NextResponse } from 'next/server'

import { withOperatorAuth } from '@/lib/auth'
import { listPendingQueue } from '@/lib/operator'

export const dynamic = 'force-dynamic'

export const GET = withOperatorAuth(async (_request, { operator }) => {
  const result = await listPendingQueue(operator.allowedVenueIds)
  if (!result.ok) {
    return NextResponse.json(
      { error: 'queue lookup failed', detail: result.error },
      { status: 500 },
    )
  }
  return NextResponse.json({ drafts: result.drafts })
})
