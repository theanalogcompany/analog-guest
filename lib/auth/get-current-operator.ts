// Route-handler-friendly wrapper around verifyOperatorRequest. Returns a
// 401/403 Response on AuthError, the AuthenticatedOperator on success.
//
// Use this in routes that don't need custom error handling. Routes that want
// to log auth failures, shape the 401 body differently, or branch on
// err.status should call verifyOperatorRequest directly and catch AuthError.
//
// Non-AuthError throws (e.g. a missing env var bubbling up from
// createAdminClient) re-throw — those are 500-class infra failures, not auth
// failures, and Next's default error boundary should handle them.

import { type AuthenticatedOperator, AuthError } from './types'
import { verifyOperatorRequest } from './verify-jwt'

export async function getCurrentOperator(
  request: Request,
): Promise<AuthenticatedOperator | Response> {
  try {
    return await verifyOperatorRequest(request)
  } catch (err) {
    if (err instanceof AuthError) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: err.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw err
  }
}
