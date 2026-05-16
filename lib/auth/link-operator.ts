// Server-only. Resolves a Supabase auth.users.id to an operators row via
// phone OR email, populating the appropriate `auth_user_id_{phone,email}`
// column on first call and returning the same operatorId on subsequent calls.
// Idempotent.
//
// Used from three call sites — all of which have already verified the JWT or
// session that owns `authUserId`:
//   - lib/auth/verify-jwt.ts        (bearer-token path, lazy-link on miss)
//   - lib/auth/verify-analog-admin.ts (cookie-session path, lazy-link on miss)
//   - app/admin/auth/callback/route.ts (eager-link right after magic-link exchange)
//
// Uses the admin client to probe auth.users and write to operators, both of
// which would otherwise require RLS-aware grants we don't issue. This is the
// trust-extension point, not the trust boundary itself.
//
// Errors as values per the project convention (RAGResult / AIResult shape).
// Never throws. Callers translate failed results into AuthError(401) or a
// redirect with an `?error=` query param.

import { createAdminClient } from '../db/admin'
import { authUserPhoneToE164 } from './normalize-phone'

export type LinkResult =
  | {
      ok: true
      operatorId: string
      column: 'phone' | 'email'
      mode: 'newly_linked' | 'already_linked'
    }
  | {
      ok: false
      error:
        | 'auth_user_not_found'
        | 'auth_user_has_no_identity'
        | 'no_matching_operator'
        | 'multiple_matching_operators'
        | 'already_claimed_by_different_user'
        | 'db_error'
      details?: string
    }

interface OperatorsLinkRow {
  id: string
  auth_user_id_phone: string | null
  auth_user_id_email: string | null
}

export async function linkOperatorByAuthUser(
  authUserId: string,
): Promise<LinkResult> {
  const supabase = createAdminClient()

  // Step 1: pull the auth.users row to learn whether this identity is
  // phone-based or email-based.
  const { data: userResult, error: userErr } =
    await supabase.auth.admin.getUserById(authUserId)
  if (userErr) {
    return { ok: false, error: 'auth_user_not_found', details: userErr.message }
  }
  const user = userResult?.user ?? null
  if (!user) {
    return { ok: false, error: 'auth_user_not_found' }
  }
  const phoneE164 = authUserPhoneToE164(user.phone)
  const email = user.email ?? null
  if (!phoneE164 && !email) {
    return { ok: false, error: 'auth_user_has_no_identity' }
  }

  // Step 2: fast path — is this auth user already linked to an operator via
  // either column? If so, return the existing link (idempotent re-entry).
  const { data: existing, error: existingErr } = await supabase
    .from('operators')
    .select('id, auth_user_id_phone, auth_user_id_email')
    .or(
      `auth_user_id_phone.eq.${authUserId},auth_user_id_email.eq.${authUserId}`,
    )
    .maybeSingle<OperatorsLinkRow>()
  if (existingErr) {
    return {
      ok: false,
      error: 'db_error',
      details: `existing-link lookup failed: ${existingErr.message}`,
    }
  }
  if (existing) {
    const column: 'phone' | 'email' =
      existing.auth_user_id_phone === authUserId ? 'phone' : 'email'
    return {
      ok: true,
      operatorId: existing.id,
      column,
      mode: 'already_linked',
    }
  }

  // Step 3: choose the target column based on the auth identity, then look up
  // the matching operator. Phone wins if both phone and email are populated on
  // the same auth.users row (Supabase today provisions one identity per auth
  // user, but the schema doesn't forbid both — defensive).
  const targetColumn: 'auth_user_id_phone' | 'auth_user_id_email' = phoneE164
    ? 'auth_user_id_phone'
    : 'auth_user_id_email'
  const matchField: 'phone_number' | 'email' = phoneE164 ? 'phone_number' : 'email'
  // We've already returned auth_user_has_no_identity above if both are null,
  // so the non-null assertion here is safe.
  const matchValue = (phoneE164 ?? email) as string

  const { data: candidates, error: matchErr } = await supabase
    .from('operators')
    .select('id, auth_user_id_phone, auth_user_id_email')
    .eq(matchField, matchValue)
  if (matchErr) {
    return {
      ok: false,
      error: 'db_error',
      details: `operator match failed: ${matchErr.message}`,
    }
  }
  const rows = (candidates ?? []) as OperatorsLinkRow[]
  if (rows.length === 0) {
    return { ok: false, error: 'no_matching_operator' }
  }
  if (rows.length > 1) {
    return {
      ok: false,
      error: 'multiple_matching_operators',
      details: `${rows.length} operators share ${matchField}=${matchValue}`,
    }
  }

  const operator = rows[0]
  const existingAuthOnTarget =
    targetColumn === 'auth_user_id_phone'
      ? operator.auth_user_id_phone
      : operator.auth_user_id_email
  if (existingAuthOnTarget && existingAuthOnTarget !== authUserId) {
    return {
      ok: false,
      error: 'already_claimed_by_different_user',
      details: `operators.${targetColumn} already set to ${existingAuthOnTarget}`,
    }
  }

  // Step 4: idempotent UPDATE — sets the target column. Even if the column
  // already equals authUserId (Step 2 should have caught it, but UNIQUE +
  // concurrent writes could in theory race here), the UPDATE is a no-op.
  // Use a literal property name rather than a computed key so the generated
  // Update<'operators'> type narrows correctly.
  const updatePayload =
    targetColumn === 'auth_user_id_phone'
      ? { auth_user_id_phone: authUserId }
      : { auth_user_id_email: authUserId }
  const { error: updateErr } = await supabase
    .from('operators')
    .update(updatePayload)
    .eq('id', operator.id)
  if (updateErr) {
    return {
      ok: false,
      error: 'db_error',
      details: `link update failed: ${updateErr.message}`,
    }
  }

  return {
    ok: true,
    operatorId: operator.id,
    column: phoneE164 ? 'phone' : 'email',
    mode: 'newly_linked',
  }
}
