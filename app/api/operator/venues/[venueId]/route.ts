// GET /api/operator/venues/[venueId] — TAC-516, sibling TAC-517.
//
// Venue-level state for the operator app. Today that is only the `instagram`
// block; the shape has room to grow.
//
// THIS ENDPOINT DID NOT EXIST BEFORE THIS TICKET. The Contract originally
// said the block would appear "wherever the app reads venue state", and the
// audit found that nothing in this repo returns a venue-level payload at all
// — so the sibling ticket had nothing concrete to build against. The Contract
// was amended during plan review to name this path, per the divergence rule
// that the ticket is updated first.
//
// Contract-bound inline auth and bearerAllowsVenue, exactly as the connect
// endpoint beside it. Same reasons: the HOF would forward AuthError.message
// where the Contract wants fixed strings, and the `ids.length > 0` idiom is
// the TAC-530 fleet grant on a bearer path.

import { NextResponse } from 'next/server'

import { AuthError, verifyOperatorRequest } from '@/lib/auth'
import { bearerAllowsVenue, venueScopeDeniesAll } from '@/lib/auth/venue-scope'
import { createAdminClient } from '@/lib/db/admin'
import { loadVenueConnectionState } from '@/lib/operator/venue-connection'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  ctx: { params: Promise<{ venueId: string }> },
): Promise<Response> {
  let operator
  try {
    operator = await verifyOperatorRequest(request)
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    throw err
  }

  const { venueId } = await ctx.params
  if (!UUID_RE.test(venueId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  // Denied before any query: an operator with zero grants may act on nothing.
  if (venueScopeDeniesAll(operator.venueScope)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (!bearerAllowsVenue(operator.venueScope, venueId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const result = await loadVenueConnectionState(createAdminClient(), venueId)
  if (!result.ok) {
    console.error('[operator] could not load venue connection state', {
      event: 'venue_connection_load_failed',
      venueId,
      error: result.error,
    })
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }

  return NextResponse.json(result.state)
}
