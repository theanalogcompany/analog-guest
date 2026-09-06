// GET /api/operator/conversations — lists every guest conversation across
// the operator's allowed venues (cross-repo sibling: analog-operator
// Conversations tab). Contract-conformance auth pattern matches
// app/api/operator/messages/[id]/thread/route.ts: inline
// verifyOperatorRequest, sanitized error bodies, not withOperatorAuth.

import { NextResponse } from 'next/server'

import { AuthError, verifyOperatorRequest } from '@/lib/auth'
import { listOperatorConversations } from '@/lib/operator'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  let operator
  try {
    operator = await verifyOperatorRequest(request)
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    throw err
  }

  const result = await listOperatorConversations(operator.allowedVenueIds)
  if (!result.ok) {
    console.warn(
      `[/api/operator/conversations] listOperatorConversations failed error=${result.error}`,
    )
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }

  return NextResponse.json({ conversations: result.conversations })
}
