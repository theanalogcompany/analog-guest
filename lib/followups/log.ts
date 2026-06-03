// TAC-123 followup_log claim/finalize/release helpers.
//
// Backs the engine's "claim before side-effect" idempotency model. The
// migration 029 UNIQUE index on (venue_id, guest_id, dedup_key) is the
// load-bearing constraint: a CLAIM that conflicts means another run
// already owns this (guest, reason) slot; that run will dispatch or
// release, and we skip cleanly.
//
// Flow per engine run (per guest):
//   1. Build the claim rows from detected reasons + their dedup_keys.
//   2. claimFollowupLogRows() → all-or-nothing INSERT.
//      - success: returns inserted ids, engine proceeds to dispatch.
//      - conflict (23505): returns {conflict: true}, engine skips.
//      - db_error: returns RAGResult error, engine logs + skips.
//   3. Dispatch via handleFollowup.
//   4. On AgentResult.sent / .queued → finalizeFollowupLogClaim() UPDATEs
//      message_id on each claimed row.
//   5. On .refused / .failed → releaseFollowupLogClaim() DELETEs the
//      claim rows so dedup isn't burned and a same-day retry on the
//      next tick can re-attempt.
//
// All helpers are RAGResult-shaped — never throw into the engine loop.

import { createAdminClient } from '@/lib/db/admin'
import type { RAGResult } from '@/lib/rag/types'
import type { EngineFollowupReason } from '@/lib/schemas'

/**
 * Engine-side view of a single guest's followup_log signals, populated by
 * loadFollowupSnapshotsForVenue and consumed by canSendFollowup +
 * detectPerkUnlockReason.
 */
export interface FollowupGuestSignals {
  weeklyCount: number
  lastByReason: Partial<Record<EngineFollowupReason, Date>>
  announcedMechanicIds: Set<string>
}

/** Empty snapshot for guests with no log history. */
export function emptyFollowupGuestSignals(): FollowupGuestSignals {
  return { weeklyCount: 0, lastByReason: {}, announcedMechanicIds: new Set() }
}

/**
 * Per-guest claim instruction. Multi-reason runs pass one row per reason;
 * the engine builds the array from the detector output.
 *
 * For perk_unlock the caller should set dedup_key via
 * dedupKeyForReason('perk_unlock', {mechanicId}). For post_visit /
 * cold_lapsed the caller uses lastVisitAt. Centralizing key construction
 * in `detectors.dedupKeyForReason` keeps the convention single-source.
 */
export interface FollowupClaimRow {
  venueId: string
  guestId: string
  reason: EngineFollowupReason
  dedupKey: string
}

export interface FollowupClaim {
  id: string
  reason: EngineFollowupReason
  dedupKey: string
}

export type FollowupClaimResult =
  | { ok: true; claimed: FollowupClaim[] }
  | { ok: true; conflict: true }
  | { ok: false; error: string; errorCode?: string }

/**
 * Atomic CLAIM. INSERT all rows in a single multi-row statement; on
 * UNIQUE violation (23505) Postgres aborts the WHOLE statement atomically
 * — nothing is committed, no partial-state cleanup needed. Returns
 * {conflict: true} so the engine skips the run.
 *
 * INVARIANT: this helper does NOT use `.onConflict('do_nothing')` or any
 * upsert variant. The migration header (`029_create_followup_log.sql`)
 * relies on the atomic-rollback semantic. A future maintainer who
 * "simplifies" this to `onConflict: 'do_nothing'` silently switches the
 * conflict path from "engine skips entire guest" to "engine partial-
 * claims and dispatches anyway" — the load-bearing dedup guarantee
 * breaks. If you need partial-claim semantics, ADD count comparison +
 * a release-of-the-inserted-rows branch, and update the migration header.
 *
 * On db_error returns the standard RAGResult error shape. Empty `rows`
 * is a no-op that returns ok with an empty claimed array — the engine
 * never calls with empty rows (no reasons = no run), but the helper is
 * defensive.
 */
export async function claimFollowupLogRows(
  rows: readonly FollowupClaimRow[],
): Promise<FollowupClaimResult> {
  if (rows.length === 0) return { ok: true, claimed: [] }
  const supabase = createAdminClient()
  const insertRows = rows.map((r) => ({
    venue_id: r.venueId,
    guest_id: r.guestId,
    reason: r.reason,
    dedup_key: r.dedupKey,
    // message_id stays NULL on claim; finalizeFollowupLogClaim sets it
    // post-dispatch.
  }))
  // NB: NO `.onConflict('...')` here — see header. Multi-row INSERT
  // semantics: any UNIQUE violation aborts the whole statement; Supabase
  // surfaces it as `error.code === '23505'`.
  const { data, error } = await supabase
    .from('followup_log')
    .insert(insertRows)
    .select('id, reason, dedup_key')
  if (error) {
    if (error.code === '23505') {
      // UNIQUE violation on (venue_id, guest_id, dedup_key) — another run
      // already owns at least one of these rows. Whole INSERT rolled back,
      // nothing to clean up.
      return { ok: true, conflict: true }
    }
    return {
      ok: false,
      error: `claimFollowupLogRows: ${error.message}`,
      errorCode: error.code ?? undefined,
    }
  }
  if (!data) {
    return {
      ok: false,
      error: 'claimFollowupLogRows: no data returned from insert',
      errorCode: 'no_data',
    }
  }
  const claimed: FollowupClaim[] = data.map((row) => ({
    id: row.id,
    reason: row.reason as EngineFollowupReason,
    dedupKey: row.dedup_key,
  }))
  return { ok: true, claimed }
}

/**
 * Stamp message_id onto previously-claimed rows. Called from the engine
 * after handleFollowup returns AgentResult.sent / .queued; multi-reason
 * runs share one message_id (the run correlator).
 */
export async function finalizeFollowupLogClaim(
  claimIds: readonly string[],
  messageId: string,
): Promise<RAGResult<{ updatedCount: number }>> {
  if (claimIds.length === 0) return { ok: true, data: { updatedCount: 0 } }
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('followup_log')
    .update({ message_id: messageId })
    .in('id', claimIds)
    .select('id')
  if (error) {
    return {
      ok: false,
      error: `finalizeFollowupLogClaim: ${error.message}`,
      errorCode: error.code ?? undefined,
    }
  }
  return { ok: true, data: { updatedCount: data?.length ?? 0 } }
}

/**
 * Delete the just-claimed rows so dedup isn't burned. Called from the
 * engine on AgentResult.refused / .failed; preserves the "same-day
 * retry on next tick" semantics.
 */
export async function releaseFollowupLogClaim(
  claimIds: readonly string[],
): Promise<RAGResult<{ deletedCount: number }>> {
  if (claimIds.length === 0) return { ok: true, data: { deletedCount: 0 } }
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('followup_log')
    .delete()
    .in('id', claimIds)
    .select('id')
  if (error) {
    return {
      ok: false,
      error: `releaseFollowupLogClaim: ${error.message}`,
      errorCode: error.code ?? undefined,
    }
  }
  return { ok: true, data: { deletedCount: data?.length ?? 0 } }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Pre-load followup_log signals for every guest in `guestIds` (one venue).
 * Returns a Map keyed on guest_id. Guests with no rows are absent from
 * the map; the engine uses `emptyFollowupGuestSignals()` as the default.
 *
 * Two queries per venue (rolling-7d count + per-reason history) for
 * defensible single-round-trip-per-purpose semantics. At pilot scale
 * (single-digit guests per venue per tick) this is trivially fast.
 *
 * `announcedMechanicIds` is parsed in JS from any dedup_key matching the
 * `perk:` prefix on the per-reason history rows; the detector consumes
 * this Set to filter "newly eligible AND not announced."
 */
export async function loadFollowupSnapshotsForVenue(
  venueId: string,
  guestIds: readonly string[],
  now: Date,
): Promise<RAGResult<Map<string, FollowupGuestSignals>>> {
  const out = new Map<string, FollowupGuestSignals>()
  if (guestIds.length === 0) return { ok: true, data: out }
  const supabase = createAdminClient()
  const sevenDaysAgoIso = new Date(now.getTime() - 7 * MS_PER_DAY).toISOString()

  // Query 1: rolling-7d row count per guest.
  const weeklyResult = await supabase
    .from('followup_log')
    .select('guest_id, created_at')
    .eq('venue_id', venueId)
    .in('guest_id', guestIds)
    .gte('created_at', sevenDaysAgoIso)
  if (weeklyResult.error) {
    return {
      ok: false,
      error: `loadFollowupSnapshotsForVenue (weekly): ${weeklyResult.error.message}`,
      errorCode: weeklyResult.error.code ?? undefined,
    }
  }

  // Query 2: every row this venue has for these guests — we need the
  // per-reason MAX(created_at) AND the perk dedup_keys for the
  // announcedMechanicIds set. Cheap at pilot scale; revisit with a
  // SQL-side aggregation if the row count climbs.
  const historyResult = await supabase
    .from('followup_log')
    .select('guest_id, reason, dedup_key, created_at')
    .eq('venue_id', venueId)
    .in('guest_id', guestIds)
    .order('created_at', { ascending: false })
  if (historyResult.error) {
    return {
      ok: false,
      error: `loadFollowupSnapshotsForVenue (history): ${historyResult.error.message}`,
      errorCode: historyResult.error.code ?? undefined,
    }
  }

  const ensure = (guestId: string): FollowupGuestSignals => {
    let snap = out.get(guestId)
    if (!snap) {
      snap = emptyFollowupGuestSignals()
      out.set(guestId, snap)
    }
    return snap
  }

  for (const row of weeklyResult.data ?? []) {
    ensure(row.guest_id).weeklyCount += 1
  }

  for (const row of historyResult.data ?? []) {
    const snap = ensure(row.guest_id)
    const reason = row.reason as EngineFollowupReason
    const at = new Date(row.created_at)
    const existing = snap.lastByReason[reason]
    if (!existing || at.getTime() > existing.getTime()) {
      snap.lastByReason[reason] = at
    }
    // Parse perk dedup_keys into the announced-mechanics set. Defensive
    // prefix check — non-perk dedup_keys don't pollute the set.
    if (row.dedup_key.startsWith('perk:')) {
      const mechanicId = row.dedup_key.slice('perk:'.length)
      if (mechanicId.length > 0) snap.announcedMechanicIds.add(mechanicId)
    }
  }

  return { ok: true, data: out }
}
