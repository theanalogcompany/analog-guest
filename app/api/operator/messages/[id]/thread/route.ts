// GET /api/operator/messages/[id]/thread — returns the full conversation
// thread (guest-at-venue) for the operator-app edit screen (TAC-277, cross-
// repo sibling TAC-290).
//
// Contract conformance (NOT using withOperatorAuth):
//
// The Contract specifies fixed-string error bodies — `{"error":"unauthorized"}`
// at 401, `{"error":"not_found"}` at 404, `{"error":"internal_error"}` at 500.
// The shared `withOperatorAuth` HOF forwards `AuthError.message` verbatim
// (e.g. "missing Authorization header", "invalid or expired token: ..."),
// which is fine for the legacy operator routes that predate cross-repo
// Contracts but breaks the sibling client's `error === 'unauthorized'`
// matching. So this route verifies auth inline via verifyOperatorRequest +
// try/catch, discarding `err.message`. Same auth primitive, sanitized body.
//
// ACL: both "message does not exist" and "message exists at a venue outside
// the operator's allowlist" return 404 with `{"error":"not_found"}` —
// uniform, indistinguishable to the client. The helper distinguishes the
// two internally for logging/observability; the route flattens. Matches
// CLAUDE.md → Auth boundary ("don't leak existence") and the rest of
// `app/api/operator/*`.
//
// Invalid UUID returns 404 (not 400). The Contract doesn't enumerate 400,
// and a non-UUID `messageId` "doesn't exist" by definition — collapsing
// keeps the wire surface flat.

import { NextResponse } from 'next/server'

import { AuthError, verifyOperatorRequest } from '@/lib/auth'
import { loadGuestThread } from '@/lib/operator'

// Canonical UUID regex: app/api/operator/messages/[id]/approve/route.ts:19.
// Inlined rather than imported to avoid coupling route handlers; extract
// to lib/operator/uuid.ts if a third caller appears.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const dynamic = 'force-dynamic'

export async function GET(
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
  if (!UUID_RE.test(messageId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // ---- load ----
  const result = await loadGuestThread({
    messageId,
    allowedVenueIds: operator.allowedVenueIds,
  })

  if (!result.ok) {
    switch (result.errorCode) {
      case 'message_not_found':
      case 'out_of_allowlist':
        return NextResponse.json({ error: 'not_found' }, { status: 404 })
      case 'db_error':
      default:
        // 500 body is the literal 'internal_error' per Contract; surface the
        // underlying message to Vercel logs so a transient DB error leaves a
        // breadcrumb instead of going silent.
        console.warn(
          `[/api/operator/messages/:id/thread] loadGuestThread failed errorCode=${result.errorCode} error=${result.error ?? '<no detail>'}`,
        )
        return NextResponse.json({ error: 'internal_error' }, { status: 500 })
    }
  }

  return NextResponse.json({ messages: result.messages })
}
