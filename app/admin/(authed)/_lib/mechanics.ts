// TAC-343 Stage C: mechanics write helpers for the venue admin surface.
// Same read-modify-write-validate-write shape as venue-info's PATCH route
// and persona's — a partial edit is merged onto the current row, the WHOLE
// result is re-validated against MechanicFullSchema (including the
// redemption-policy/window pairing constraint migration 009 enforces at the
// DB level), and only then written back. `redemption` is never read, never
// written, never exposed — not part of the corrected §2 editable set.
//
// `trigger` is the one column that needs care on write: it's a jsonb blob
// today shaped `{ type: '...' }` on every live mechanic, but this helper
// treats that as an assumption to defend, not a guarantee to rely on — a
// write here merges the new `type` onto whatever the raw trigger jsonb
// currently holds, rather than blindly replacing the whole object, in case
// a future mechanic (or a hand-edited one) carries other keys there.

import { createAdminClient } from '@/lib/db/admin'
import {
  type MechanicCreate,
  MechanicFullSchema,
  type MechanicPatch,
} from '@/lib/schemas'
import { parseMechanicTriggerType } from '../venues/_lib/mechanic-fields'

export type AddMechanicResult =
  | { ok: true; mechanicId: string }
  | { ok: false; error: string; errorCode: 'db_error' }

export async function addMechanic(input: {
  venueId: string
  mechanic: MechanicCreate
}): Promise<AddMechanicResult> {
  const supabase = createAdminClient()
  const m = input.mechanic

  const { data: inserted, error: insertErr } = await supabase
    .from('mechanics')
    .insert({
      venue_id: input.venueId,
      type: m.type,
      name: m.name,
      description: m.description,
      qualification: m.qualification,
      reward_description: m.rewardDescription,
      min_state: m.minState,
      redemption_policy: m.redemptionPolicy,
      redemption_window_days: m.redemptionWindowDays,
      requires_operator_approval: m.requiresOperatorApproval,
      trigger: { type: m.triggerType },
      expiration_rule: m.expirationRule,
    })
    .select('id')
    .single()
  if (insertErr || !inserted) {
    return {
      ok: false,
      error: `insert failed: ${insertErr?.message ?? 'no row'}`,
      errorCode: 'db_error',
    }
  }

  return { ok: true, mechanicId: inserted.id }
}

export type EditMechanicResult =
  | { ok: true; mechanicId: string }
  | { ok: false; error: string; errorCode: 'db_error' | 'not_found' | 'invalid_after_merge' | 'no_op' }

export async function editMechanic(input: {
  mechanicId: string
  patch: MechanicPatch
}): Promise<EditMechanicResult> {
  if (Object.keys(input.patch).length === 0) {
    return { ok: false, error: 'no_op: pass at least one field to change', errorCode: 'no_op' }
  }

  const supabase = createAdminClient()

  const { data: row, error: fetchErr } = await supabase
    .from('mechanics')
    .select(
      'type, name, description, qualification, reward_description, min_state, redemption_policy, redemption_window_days, requires_operator_approval, trigger, expiration_rule',
    )
    .eq('id', input.mechanicId)
    .single()
  if (fetchErr || !row) {
    return {
      ok: false,
      error: `mechanic not found: ${fetchErr?.message ?? 'no row'}`,
      errorCode: 'not_found',
    }
  }

  const current = {
    type: row.type,
    name: row.name,
    description: row.description,
    qualification: row.qualification,
    rewardDescription: row.reward_description,
    minState: row.min_state,
    redemptionPolicy: row.redemption_policy,
    redemptionWindowDays: row.redemption_window_days,
    requiresOperatorApproval: row.requires_operator_approval,
    triggerType: parseMechanicTriggerType(row.trigger),
    expirationRule: row.expiration_rule,
  }

  const merged = { ...current, ...input.patch }
  const validated = MechanicFullSchema.safeParse(merged)
  if (!validated.success) {
    return {
      ok: false,
      error: `mechanic invalid after merge: ${validated.error.message}`,
      errorCode: 'invalid_after_merge',
    }
  }
  const m = validated.data

  // Merge the new trigger type onto the raw jsonb rather than replacing it
  // wholesale — see the module comment.
  const currentRawTrigger =
    typeof row.trigger === 'object' && row.trigger !== null && !Array.isArray(row.trigger)
      ? (row.trigger as Record<string, unknown>)
      : {}
  const newTrigger = { ...currentRawTrigger, type: m.triggerType }

  const { error: updateErr } = await supabase
    .from('mechanics')
    .update({
      type: m.type,
      name: m.name,
      description: m.description,
      qualification: m.qualification,
      reward_description: m.rewardDescription,
      min_state: m.minState,
      redemption_policy: m.redemptionPolicy,
      redemption_window_days: m.redemptionWindowDays,
      requires_operator_approval: m.requiresOperatorApproval,
      trigger: newTrigger,
      expiration_rule: m.expirationRule,
    })
    .eq('id', input.mechanicId)
  if (updateErr) {
    return { ok: false, error: `update failed: ${updateErr.message}`, errorCode: 'db_error' }
  }

  return { ok: true, mechanicId: input.mechanicId }
}

export type DeactivateMechanicResult =
  | { ok: true; mechanicId: string }
  | { ok: false; error: string; errorCode: 'db_error' | 'not_found' }

/**
 * "Delete" a mechanic means deactivate, never a hard DELETE —
 * `engagement_events.mechanic_id` FK-references mechanic rows (redemption
 * history), so removing the row would orphan or cascade-destroy real guest
 * history. Idempotent: deactivating an already-inactive mechanic succeeds
 * without erroring.
 */
export async function deactivateMechanic(
  mechanicId: string,
): Promise<DeactivateMechanicResult> {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('mechanics')
    .update({ is_active: false, deactivated_at: new Date().toISOString() })
    .eq('id', mechanicId)
    .select('id')
    .maybeSingle()
  if (error) {
    return { ok: false, error: error.message, errorCode: 'db_error' }
  }
  if (!data) {
    return { ok: false, error: `mechanic not found: ${mechanicId}`, errorCode: 'not_found' }
  }
  return { ok: true, mechanicId }
}
