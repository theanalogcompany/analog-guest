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
import { linkOperatorByAuthUser } from './link-operator'
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
 * the matching operators row by either auth_user_id_phone or
 * auth_user_id_email (TAC-272), then asserts is_analog_admin. Returns the
 * same shape as verifyAnalogAdminRequest so callers can share downstream
 * code.
 *
 * Lazy-links on miss — the admin callback at app/admin/auth/callback eagerly
 * links on first sign-in, but a session cookie that pre-dates that wiring
 * (or that lands here without going through the callback) self-heals here.
 */
export async function verifyAnalogAdminAccess(
  authUserId: string,
): Promise<AnalogAdminOperator> {
  const supabase = createAdminClient()

  // OR-match on either auth method's column. authUserId is a UUID just
  // resolved by Supabase auth, so the filter string is safe.
  const { data: operator, error: opErr } = await supabase
    .from('operators')
    .select('id, is_analog_admin')
    .or(
      `auth_user_id_phone.eq.${authUserId},auth_user_id_email.eq.${authUserId}`,
    )
    .maybeSingle()
  if (opErr) {
    throw new AuthError(401, `operator lookup failed: ${opErr.message}`)
  }

  let operatorId: string
  let isAnalogAdmin: boolean
  if (operator) {
    operatorId = operator.id
    isAnalogAdmin = operator.is_analog_admin
  } else {
    // Lazy-link path. After linking we re-fetch the operator's
    // is_analog_admin flag — assertAnalogAdmin handles that lookup so we
    // share its error shape, but it lives below; instead, inline a small
    // fetch here to keep the cookie-session path's error surface unchanged.
    const linked = await linkOperatorByAuthUser(authUserId)
    if (!linked.ok) {
      throw new AuthError(
        401,
        `authenticated user is not an operator: ${linked.error}`,
      )
    }
    operatorId = linked.operatorId
    const { data: linkedRow, error: linkedErr } = await supabase
      .from('operators')
      .select('is_analog_admin')
      .eq('id', operatorId)
      .single()
    if (linkedErr) {
      throw new AuthError(
        401,
        `admin flag lookup failed: ${linkedErr.message}`,
      )
    }
    isAnalogAdmin = linkedRow.is_analog_admin
  }

  if (!isAnalogAdmin) {
    throw new AuthError(403, 'not an analog admin')
  }

  const { data: venueRows, error: vErr } = await supabase
    .from('operator_venues')
    .select('venue_id')
    .eq('operator_id', operatorId)
  if (vErr) {
    throw new AuthError(401, `venue allowlist lookup failed: ${vErr.message}`)
  }

  return {
    operatorId,
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
