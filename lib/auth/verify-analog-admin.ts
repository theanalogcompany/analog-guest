// Server-only. Sibling to verify-jwt.ts that adds a second trust check on
// top of operator verification: the operator's `is_analog_admin` flag must be
// true. Throws AuthError(403) when the operator is verified but not flagged.
//
// Two entry points for two trust paths:
//   - verifyAnalogAdminRequest(request) — bearer token (API routes)
//   - verifyAnalogAdminAccess(authUserId) — cookie session (admin layout)
//
// Both produce the same AnalogAdminOperator shape. They are deliberately
// separate (not a single helper that infers source from input) so the two
// trust paths stay legible and the failure modes don't conflate.
//
// Same security note as verify-jwt.ts: thrown AuthError messages may contain
// upstream Supabase / Postgres error text. Don't forward raw to untrusted
// consumers without sanitization.

import { createAdminClient } from '../db/admin'
import { type AuthenticatedOperator, AuthError } from './types'
import { verifyOperatorRequest } from './verify-jwt'

export interface AnalogAdminOperator extends AuthenticatedOperator {
  isAnalogAdmin: true
}

/**
 * Bearer-token entry point. Verifies the JWT via verifyOperatorRequest,
 * then asserts is_analog_admin=true. Throws AuthError(401) for any
 * operator-identification failure (bubbled from verifyOperatorRequest);
 * AuthError(403) when the operator is identified but not an analog admin.
 */
export async function verifyAnalogAdminRequest(
  request: Request,
): Promise<AnalogAdminOperator> {
  const operator = await verifyOperatorRequest(request)
  await assertAnalogAdmin(operator.operatorId)
  return { ...operator, isAnalogAdmin: true }
}

/**
 * Cookie-session entry point. Use from server components / layouts that
 * have already resolved a Supabase auth user via session cookies. Looks up
 * the matching operators row by auth_user_id and asserts is_analog_admin.
 * Returns the same shape as verifyAnalogAdminRequest so callers can share
 * downstream code.
 */
export async function verifyAnalogAdminAccess(
  authUserId: string,
): Promise<AnalogAdminOperator> {
  const supabase = createAdminClient()

  const { data: operator, error: opErr } = await supabase
    .from('operators')
    .select('id, is_analog_admin')
    .eq('auth_user_id', authUserId)
    .maybeSingle()
  if (opErr) {
    throw new AuthError(401, `operator lookup failed: ${opErr.message}`)
  }
  if (!operator) {
    throw new AuthError(401, 'authenticated user is not an operator')
  }
  if (!operator.is_analog_admin) {
    throw new AuthError(403, 'not an analog admin')
  }

  const { data: venueRows, error: vErr } = await supabase
    .from('operator_venues')
    .select('venue_id')
    .eq('operator_id', operator.id)
  if (vErr) {
    throw new AuthError(401, `venue allowlist lookup failed: ${vErr.message}`)
  }

  return {
    operatorId: operator.id,
    allowedVenueIds: (venueRows ?? []).map((r) => r.venue_id),
    isAnalogAdmin: true,
  }
}

// Private. Asserts the admin flag on an already-identified operator.
async function assertAnalogAdmin(operatorId: string): Promise<void> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('operators')
    .select('is_analog_admin')
    .eq('id', operatorId)
    .single()
  if (error) {
    throw new AuthError(401, `admin flag lookup failed: ${error.message}`)
  }
  if (!data.is_analog_admin) {
    throw new AuthError(403, 'not an analog admin')
  }
}
