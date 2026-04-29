// Server-only. Verifies a Supabase auth JWT and resolves it to our internal
// operator + their venue allowlist. Uses the admin client so the post-verify
// DB lookup bypasses RLS — this is server-trusted code that has just verified
// the bearer token, so it's the trust boundary itself. A user-context client
// here would be circular (need to authenticate to look up whether you're
// authenticated).
//
// Security note for callers: thrown AuthError messages may contain upstream
// error text from Supabase auth (e.g. "JWT expired") or Postgres (e.g. a
// query failure). Those are useful for our own logs and dashboard UI, but
// must NOT be forwarded raw to untrusted consumers without sanitization.
// The getCurrentOperator wrapper writes err.message into a JSON response
// body, which is fine for v1 because the only consumer is our own operator
// dashboard. If a future endpoint exposes auth errors to a less-trusted
// surface, sanitize before forwarding.
//
// Throws AuthError(401) on any failure to identify the operator. Never throws
// 403 — that's reserved for the route handler's own venue-mismatch check
// against the returned allowedVenueIds.

import { createAdminClient } from '../db/admin'
import { type AuthenticatedOperator, AuthError } from './types'

export async function verifyOperatorRequest(
  request: Request,
): Promise<AuthenticatedOperator> {
  const header = request.headers.get('authorization')
  if (!header) {
    throw new AuthError(401, 'missing Authorization header')
  }
  if (!/^Bearer\s+\S+/i.test(header)) {
    throw new AuthError(401, 'malformed Authorization header — expected "Bearer <jwt>"')
  }
  const jwt = header.replace(/^Bearer\s+/i, '').trim()
  if (jwt.length === 0) {
    throw new AuthError(401, 'empty bearer token')
  }

  const supabase = createAdminClient()
  const { data: userData, error: userError } = await supabase.auth.getUser(jwt)
  if (userError || !userData?.user) {
    throw new AuthError(
      401,
      `invalid or expired token: ${userError?.message ?? 'no user'}`,
    )
  }
  const authUserId = userData.user.id

  const { data: operatorRow, error: operatorError } = await supabase
    .from('operators')
    .select('id')
    .eq('auth_user_id', authUserId)
    .maybeSingle()
  if (operatorError) {
    throw new AuthError(401, `operator lookup failed: ${operatorError.message}`)
  }
  if (!operatorRow) {
    throw new AuthError(401, 'authenticated user is not an operator')
  }
  const operatorId = operatorRow.id

  const { data: venueRows, error: venuesError } = await supabase
    .from('operator_venues')
    .select('venue_id')
    .eq('operator_id', operatorId)
  if (venuesError) {
    throw new AuthError(401, `venue allowlist lookup failed: ${venuesError.message}`)
  }
  const allowedVenueIds = (venueRows ?? []).map((r) => r.venue_id)

  return { operatorId, allowedVenueIds }
}
