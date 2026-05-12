// Higher-order route wrapper for bearer-token operator endpoints (TAC-258).
// Lives under lib/auth/ next to verify-jwt.ts / verify-analog-admin.ts because
// the HOF is an auth-surface concern, not operator business logic. Future
// auth surfaces (guest auth, etc.) follow the same pattern under lib/auth/.
//
// Use this in routes under app/api/operator/* that just need "validated
// operator + their venue allowlist, AuthError → JSON response." Routes that
// want custom error shaping or need to log auth failures should call
// verifyOperatorRequest directly and catch AuthError.
//
// Non-AuthError throws (e.g. createAdminClient missing env vars) bubble. Those
// are 500-class infra failures and Next's error boundary should handle them.

import { NextResponse } from 'next/server'

import { type AuthenticatedOperator, AuthError } from './types'
import { verifyOperatorRequest } from './verify-jwt'

/**
 * Inner-handler shape. The HOF resolves Next's params Promise + runs auth
 * before invoking this, so the handler sees a plain `params` object alongside
 * the authenticated operator.
 */
export type OperatorRouteHandler<TParams> = (
  request: Request,
  ctx: { operator: AuthenticatedOperator; params: TParams },
) => Promise<Response> | Response

/**
 * Next.js App Router dynamic-route signature for the wrapped handler. Mirrors
 * the shape Next passes to a `route.ts` export (params resolved via Promise).
 */
export type NextRouteContext<TParams> = { params: Promise<TParams> }

export function withOperatorAuth<TParams = Record<string, never>>(
  handler: OperatorRouteHandler<TParams>,
): (request: Request, ctx: NextRouteContext<TParams>) => Promise<Response> {
  return async (request, ctx) => {
    let operator: AuthenticatedOperator
    try {
      operator = await verifyOperatorRequest(request)
    } catch (err) {
      if (err instanceof AuthError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }
    const params = await ctx.params
    return handler(request, { operator, params })
  }
}
