// GET /api/operator/guests/:guestId/thread — full thread for one guest,
// keyed directly by guestId (unlike the sibling
// /api/operator/messages/[id]/thread, most guests here have no pending
// draft to key off). Same Contract shape and same 200-most-recent,
// oldest→newest windowing.

import { NextResponse } from 'next/server'

import { AuthError, verifyOperatorRequest } from '@/lib/auth'
import { loadGuestThreadByGuestId } from '@/lib/operator'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  ctx: { params: Promise<{ guestId: string }> },
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

  const { guestId } = await ctx.params
  if (!UUID_RE.test(guestId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const result = await loadGuestThreadByGuestId({
    guestId,
    allowedVenueIds: operator.allowedVenueIds,
  })

  if (!result.ok) {
    switch (result.errorCode) {
      case 'guest_not_found':
      case 'out_of_allowlist':
        return NextResponse.json({ error: 'not_found' }, { status: 404 })
      case 'db_error':
      default:
        console.warn(
          `[/api/operator/guests/:guestId/thread] loadGuestThreadByGuestId failed errorCode=${result.errorCode} error=${result.error ?? '<no detail>'}`,
        )
        return NextResponse.json({ error: 'internal_error' }, { status: 500 })
    }
  }

  return NextResponse.json({ messages: result.messages })
}
