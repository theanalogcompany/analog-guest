import { createAdminClient } from '@/lib/db/admin'
import type { RAGResult } from '@/lib/rag/types'
import {
  type ArrivalSignal,
  type GuestCommitmentRow,
  GuestCommitmentRowSchema,
  type PendingCommitment,
} from '@/lib/schemas/guest-commitment'

// TAC-297. Mirrors the shape of lib/guests/context.ts: RAGResult-typed, never
// throws, fail-CLOSED on DB errors, fail-OPEN on malformed payloads. All
// status transitions are CAS-gated (conditional UPDATE on the prior status)
// so concurrent callers can't double-process the same row — the rowcount
// gate is what anchors push idempotency (design call #4 in the TAC-297
// plan-review thread).

// ===== Create =====

/**
 * Materialize a guest_commitments row from a draft's pending_commitment jsonb
 * carrier. Called from two sites:
 *   - lib/operator/dispatch-operator-outbound.ts after the operator's
 *     approve/edit dispatch succeeds on a gated draft (comp/hold/discount).
 *   - lib/agent/schedule-and-send.ts inline after the rec's auto-send
 *     dispatch succeeds (ungated path — no queue gap to bridge).
 *
 * Both call sites await this synchronously so the materialization happens
 * before the route returns to the operator (or before the agent run completes
 * for the rec path). On failure we log + return error without rolling back
 * the already-sent message — the dispatch is canonical, the row write is
 * recovery-secondary (reconciliation via a follow-up ticket if pilot data
 * shows the failure mode).
 */
export async function createCommitmentFromPending(opts: {
  guestId: string
  venueId: string
  pendingCommitment: PendingCommitment
  sourceMessageId: string
  now: Date
}): Promise<RAGResult<GuestCommitmentRow>> {
  const { guestId, venueId, pendingCommitment, sourceMessageId, now } = opts
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('guest_commitments')
      .insert({
        guest_id: guestId,
        venue_id: venueId,
        type: pendingCommitment.type,
        description: pendingCommitment.description,
        code: pendingCommitment.code,
        status: 'open',
        created_by: 'agent',
        expires_at: pendingCommitment.expiresAt,
        source_message_id: sourceMessageId,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .select()
      .single()
    if (error) {
      return { ok: false, error: error.message, errorCode: 'db_write_failed' }
    }
    const parsed = GuestCommitmentRowSchema.safeParse(data)
    if (!parsed.success) {
      return {
        ok: false,
        error: `invalid commitment row shape: ${parsed.error.message}`,
        errorCode: 'db_write_invalid_shape',
      }
    }
    return { ok: true, data: parsed.data }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg, errorCode: 'db_write_threw' }
  }
}

// ===== Transitions (CAS-gated) =====

export type TransitionResult = {
  transitioned: boolean
  row: GuestCommitmentRow | null
}

/**
 * Move a commitment from 'open' to 'pending_ack'. CAS-gated on status='open'
 * so concurrent callers (imminent inbound + cron firing on the same row)
 * produce exactly one transition.
 *
 * Returns `{ transitioned: true, row }` only when this caller actually
 * flipped the row. Caller MUST gate push-fire on this flag — firing on
 * transitioned=false would double-push when the loser CAS returns first.
 * Anchors design call #4 in the TAC-297 plan-review.
 *
 * Why we also write expectedArrival + arrivalSignal here: the imminent path
 * captures both at transition time (signal is 'imminent', expectedArrival is
 * now). The scheduled path uses scheduleArrival earlier to set them, then
 * the cron picks up the row and calls this with the prior values.
 */
export async function transitionToPendingAck(opts: {
  commitmentId: string
  expectedArrival: Date
  arrivalSignal: ArrivalSignal
  now: Date
}): Promise<RAGResult<TransitionResult>> {
  const { commitmentId, expectedArrival, arrivalSignal, now } = opts
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('guest_commitments')
      .update({
        status: 'pending_ack',
        expected_arrival: expectedArrival.toISOString(),
        arrival_signal: arrivalSignal,
        updated_at: now.toISOString(),
      })
      .eq('id', commitmentId)
      .eq('status', 'open')
      .select()
    if (error) {
      return { ok: false, error: error.message, errorCode: 'db_write_failed' }
    }
    if (!data || data.length === 0) {
      return { ok: true, data: { transitioned: false, row: null } }
    }
    const parsed = GuestCommitmentRowSchema.safeParse(data[0])
    if (!parsed.success) {
      return {
        ok: false,
        error: `invalid commitment row shape: ${parsed.error.message}`,
        errorCode: 'db_write_invalid_shape',
      }
    }
    return { ok: true, data: { transitioned: true, row: parsed.data } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg, errorCode: 'db_write_threw' }
  }
}

/**
 * Record a scheduled arrival on an 'open' commitment. Status stays 'open';
 * the hourly cron (/api/cron/commitments-due) picks up the row when
 * expected_arrival is due and calls transitionToPendingAck.
 *
 * CAS-gated on status='open' so we don't accidentally overwrite arrival
 * info on an already-acknowledged or cancelled row.
 */
export async function scheduleArrival(opts: {
  commitmentId: string
  expectedArrival: Date
  arrivalSignal: ArrivalSignal
  now: Date
}): Promise<RAGResult<TransitionResult>> {
  const { commitmentId, expectedArrival, arrivalSignal, now } = opts
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('guest_commitments')
      .update({
        expected_arrival: expectedArrival.toISOString(),
        arrival_signal: arrivalSignal,
        updated_at: now.toISOString(),
      })
      .eq('id', commitmentId)
      .eq('status', 'open')
      .select()
    if (error) {
      return { ok: false, error: error.message, errorCode: 'db_write_failed' }
    }
    if (!data || data.length === 0) {
      return { ok: true, data: { transitioned: false, row: null } }
    }
    const parsed = GuestCommitmentRowSchema.safeParse(data[0])
    if (!parsed.success) {
      return {
        ok: false,
        error: `invalid commitment row shape: ${parsed.error.message}`,
        errorCode: 'db_write_invalid_shape',
      }
    }
    return { ok: true, data: { transitioned: true, row: parsed.data } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg, errorCode: 'db_write_threw' }
  }
}

/**
 * Acknowledge a pending_ack commitment. CAS-gated on status='pending_ack'
 * AND venue_id IN allowedVenueIds — combines the state-machine gate with
 * the per-operator allowlist enforcement in a single conditional UPDATE
 * (one round trip, no read-then-write race).
 *
 * transitioned=false here means one of:
 *   - the row is already acknowledged / cancelled / never-pending,
 *   - or the commitment exists but is in a venue outside the operator's
 *     allowlist (handled the same as not-found, per the existence-leak
 *     prevention rule in CLAUDE.md).
 * The route handler maps this to 404 or 409 — the caller can't disambiguate
 * those at the DB layer without leaking existence, which is intentional.
 */
export async function markAcknowledged(opts: {
  commitmentId: string
  operatorId: string
  allowedVenueIds: string[]
  now: Date
}): Promise<RAGResult<TransitionResult>> {
  const { commitmentId, operatorId, allowedVenueIds, now } = opts
  if (allowedVenueIds.length === 0) {
    // Empty allowlist → no row matches by definition. Skip the round trip.
    return { ok: true, data: { transitioned: false, row: null } }
  }
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('guest_commitments')
      .update({
        status: 'acknowledged',
        acknowledged_at: now.toISOString(),
        acknowledged_by: operatorId,
        updated_at: now.toISOString(),
      })
      .eq('id', commitmentId)
      .eq('status', 'pending_ack')
      .in('venue_id', allowedVenueIds)
      .select()
    if (error) {
      return { ok: false, error: error.message, errorCode: 'db_write_failed' }
    }
    if (!data || data.length === 0) {
      return { ok: true, data: { transitioned: false, row: null } }
    }
    const parsed = GuestCommitmentRowSchema.safeParse(data[0])
    if (!parsed.success) {
      return {
        ok: false,
        error: `invalid commitment row shape: ${parsed.error.message}`,
        errorCode: 'db_write_invalid_shape',
      }
    }
    return { ok: true, data: { transitioned: true, row: parsed.data } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg, errorCode: 'db_write_threw' }
  }
}

// ===== Reads =====

/**
 * Load active commitments (open + pending_ack) for a single guest at a
 * single venue. Used by lib/agent/build-runtime-context.ts to populate the
 * ## Active commitments user-prompt block.
 *
 * Indexed by idx_guest_commitments_active_for_guest (migration 026).
 */
export async function findActiveCommitmentsForGuest(opts: {
  venueId: string
  guestId: string
}): Promise<RAGResult<GuestCommitmentRow[]>> {
  const { venueId, guestId } = opts
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('guest_commitments')
      .select('*')
      .eq('venue_id', venueId)
      .eq('guest_id', guestId)
      .in('status', ['open', 'pending_ack'])
      .order('created_at', { ascending: true })
    if (error) {
      return { ok: false, error: error.message, errorCode: 'db_read_failed' }
    }
    const rows: GuestCommitmentRow[] = []
    for (const row of data ?? []) {
      const parsed = GuestCommitmentRowSchema.safeParse(row)
      if (parsed.success) rows.push(parsed.data)
      // Fail-OPEN on a single malformed row — drop it, keep the rest. The
      // agent path treats absence as empty (block omitted), so a malformed
      // row degrades gracefully rather than killing the agent run.
    }
    return { ok: true, data: rows }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg, errorCode: 'db_read_threw' }
  }
}

/**
 * Find open commitments with arrival_signal='scheduled' and expected_arrival
 * populated. The morning-of model (TAC-297 follow-up): time-of-day filtering
 * lives in the processor, not the query — the processor knows each venue's
 * timezone and can decide per-row whether "now" falls in that venue's morning
 * hour. The SQL just provides the candidate set.
 *
 * imminent-signal rows are deliberately excluded — they fire off the inbound
 * (handle-inbound.ts), never from the cron. Including them here would let a
 * pathological cron tick (one that races a pending dispatchArrivalCapture
 * before its CAS lands) potentially transition the row.
 *
 * Indexed by idx_guest_commitments_due (migration 026) for the
 * `status='open' AND expected_arrival IS NOT NULL` half of the filter.
 */
export async function findScheduledOpenCommitments(): Promise<
  RAGResult<GuestCommitmentRow[]>
> {
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('guest_commitments')
      .select('*')
      .eq('status', 'open')
      .eq('arrival_signal', 'scheduled')
      .not('expected_arrival', 'is', null)
      .order('expected_arrival', { ascending: true })
    if (error) {
      return { ok: false, error: error.message, errorCode: 'db_read_failed' }
    }
    const rows: GuestCommitmentRow[] = []
    for (const row of data ?? []) {
      const parsed = GuestCommitmentRowSchema.safeParse(row)
      if (parsed.success) rows.push(parsed.data)
    }
    return { ok: true, data: rows }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg, errorCode: 'db_read_threw' }
  }
}
