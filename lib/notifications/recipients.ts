// Shared APNs recipient, badge and token-invalidation helpers.
//
// WHY THIS MODULE EXISTS. `loadRecipients`, `nullOperatorToken` and the badge
// count were copied from send.ts (TAC-207) into send-commitment-push.ts
// (TAC-297), and CLAUDE.md has carried "extraction to a shared
// lib/notifications/recipients.ts is a deliberate follow-up" ever since.
// TAC-473 adds a third push surface, and three copies is where duplication
// stops being a tidiness question: the next person fixing a bug in the
// recipient query would have had to find all three.
//
// This is a PURE EXTRACTION. Every query, every guard and every log line is
// byte-identical to what the two callers had, which is why their existing
// tests are unchanged and are the evidence the move is behaviour-preserving.
// The log prefixes differed between the two copies ('[apns] loadRecipients'
// vs '[apns] commitment loadRecipients'), so the prefix is a parameter rather
// than something unified here — unifying it would be a behaviour change
// smuggled into a refactor.
//
// ---------------------------------------------------------------------------
// THE TWO BADGE COUNTS DISAGREE, AND THIS MODULE DOES NOT FIX THAT
// ---------------------------------------------------------------------------
// `countPendingDraftsForOperator` counts pending drafts only. `countOperatorBadge`
// counts pending drafts PLUS pending_ack commitments. The draft-flagged push
// (send.ts) uses the first; the commitment-arrival push
// (send-commitment-push.ts) uses the second, and its own docstring called
// itself "single source of truth for the operator app's badge across BOTH push
// surfaces" — which was not true, and was not true before this extraction
// either. The same operator's badge is therefore one number when a draft
// queues and a different number when a commitment arrives.
//
// Both are kept here, with their existing callers unchanged, because making
// them agree changes what an operator sees and is a product decision rather
// than a refactor. What the extraction does buy is that the disagreement is
// now visible in one file instead of being two functions in two files that
// nobody reads side by side. Filed as a finding on TAC-473.
//
// New surfaces should use `countOperatorBadge`: a badge that ignores
// commitments under-counts what is actually waiting.

import { createAdminClient } from '@/lib/db/admin'

export interface OperatorRecipient {
  id: string
  apnsDeviceToken: string
}

/**
 * Every operator allowlisted for this venue who has a device token.
 *
 * `logPrefix` keeps each caller's existing log line intact — see the header.
 * `verbose` is send.ts's extra diagnostic line, which the commitment surface
 * never had.
 */
export async function loadPushRecipients(
  venueId: string,
  options: { logPrefix: string; verbose?: boolean },
): Promise<OperatorRecipient[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('operator_venues')
    .select('operator:operators!inner(id, apns_device_token)')
    .eq('venue_id', venueId)
    .not('operator.apns_device_token', 'is', null)
  if (error || !data) {
    console.error(`${options.logPrefix} query failed`, {
      venueId,
      error: error?.message,
    })
    return []
  }
  const seen = new Set<string>()
  const out: OperatorRecipient[] = []
  for (const row of data) {
    const op = row.operator
    if (!op) continue
    if (!op.apns_device_token) continue
    if (seen.has(op.id)) continue
    seen.add(op.id)
    out.push({ id: op.id, apnsDeviceToken: op.apns_device_token })
  }
  if (options.verbose) {
    // Diagnostic delta: rawRowCount > 0 with recipientCount === 0 means the
    // operator_venues rows exist but the embedded apns_device_token filter
    // dropped them all (or row.operator was unexpectedly null/array-shaped).
    // recipientCount === 0 with rawRowCount === 0 means no operator is
    // allowlisted for this venue.
    console.log(options.logPrefix, {
      venueId,
      rawRowCount: data.length,
      recipientCount: out.length,
    })
  }
  return out
}

/** The operator's allowed venue ids, or [] when they have none or the read failed. */
async function allowedVenueIds(operatorId: string): Promise<string[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('operator_venues')
    .select('venue_id')
    .eq('operator_id', operatorId)
  if (error || !data || data.length === 0) return []
  return data.map((v) => v.venue_id)
}

/**
 * Pending-draft count for the operator's queue. Same predicate as
 * list_operator_queue (db/migrations/018_operator_review_state.sql:218-219)
 * scoped to the operator's allowed venues:
 *   review_state = 'pending' AND venue_id IN (operator's allowedVenueIds)
 *
 * Going through a subquery on operator_venues keeps the predicate the
 * literal same one the queue uses; if the queue's filter ever changes, this
 * needs to change alongside it.
 *
 * DRAFTS ONLY — see the header. `countOperatorBadge` is the one that also
 * counts commitments, and the two genuinely disagree.
 */
export async function countPendingDraftsForOperator(operatorId: string): Promise<number> {
  const supabase = createAdminClient()
  const venueIds = await allowedVenueIds(operatorId)
  if (venueIds.length === 0) return 0
  const { count, error } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('review_state', 'pending')
    .in('venue_id', venueIds)
  if (error) {
    console.error('apns: countPendingForOperator failed', {
      operatorId,
      error: error.message,
    })
    return 0
  }
  return count ?? 0
}

/**
 * Operator-scoped badge count combining pending drafts (review_state='pending')
 * and pending_ack commitments.
 *
 * Preferred for any NEW push surface: a badge that counts only drafts
 * under-reports what is actually waiting for the operator.
 */
export async function countOperatorBadge(operatorId: string): Promise<number> {
  const supabase = createAdminClient()
  const venueIds = await allowedVenueIds(operatorId)
  if (venueIds.length === 0) return 0
  const [draftsResult, commitmentsResult] = await Promise.all([
    supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('review_state', 'pending')
      .in('venue_id', venueIds),
    supabase
      .from('guest_commitments')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending_ack')
      .in('venue_id', venueIds),
  ])
  if (draftsResult.error) {
    console.error('[apns] commitment countBadgeForOperator drafts failed', {
      operatorId,
      error: draftsResult.error.message,
    })
  }
  if (commitmentsResult.error) {
    console.error('[apns] commitment countBadgeForOperator commitments failed', {
      operatorId,
      error: commitmentsResult.error.message,
    })
  }
  return (draftsResult.count ?? 0) + (commitmentsResult.count ?? 0)
}

/**
 * Clear a device token APNs rejected as gone or malformed (410 / 400
 * BadDeviceToken). Never throws: the push has already failed, and failing the
 * cleanup on top of it would tell nobody anything.
 */
export async function clearOperatorPushToken(
  operatorId: string,
  options: { logPrefix: string },
): Promise<void> {
  const supabase = createAdminClient()
  const { error } = await supabase
    .from('operators')
    .update({ apns_device_token: null, apns_token_updated_at: null })
    .eq('id', operatorId)
  if (error) {
    console.error(options.logPrefix, {
      operatorId,
      error: error.message,
    })
  }
}
