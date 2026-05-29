// Powers GET /api/operator/queue's new `commitments` field (TAC-297). Returns
// pending_ack commitments FIFO-ordered across the operator's allowed venues.
// Cross-repo Contract-locked payload (TAC-297 + TAC-298): each entry is
// `{ id, type, guest: {name}, description, code, expected_arrival, created_at }`.
//
// Mirrors the lib/operator/queue.ts shape (RAGResult-style, app-layer venue
// scoping via the `in()` filter on allowedVenueIds). Joins the guest name
// in a single round trip via PostgREST's embedded relations rather than an
// N+1 lookup per commitment.

import { createAdminClient } from '@/lib/db/admin'
import type {
  CommitmentType,
  HeadsUpCommitment,
} from '@/lib/schemas/guest-commitment'

export type ListHeadsUpQueueResult =
  | { ok: true; commitments: HeadsUpCommitment[] }
  | { ok: false; error: string }

interface JoinedGuestShape {
  first_name: string | null
}

/**
 * Read all status='pending_ack' commitments for the operator's allowed
 * venues, oldest-first (FIFO — matches list_operator_queue convention).
 * Cap matches the draft queue's underlying RPC cap of 200; commitments
 * volume is much lower than drafts in practice, so an explicit `.limit(200)`
 * is more of a safety belt than a hot-path constraint.
 *
 * Empty allowlist → empty array, no DB round trip (mirrors listPendingQueue).
 */
export async function listHeadsUpQueue(
  allowedVenueIds: string[],
): Promise<ListHeadsUpQueueResult> {
  if (allowedVenueIds.length === 0) {
    return { ok: true, commitments: [] }
  }

  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('guest_commitments')
    .select(
      'id, type, description, code, expected_arrival, created_at, guest:guests!inner(first_name)',
    )
    .eq('status', 'pending_ack')
    .in('venue_id', allowedVenueIds)
    .order('created_at', { ascending: true })
    .limit(200)

  if (error) {
    return { ok: false, error: error.message }
  }

  const commitments: HeadsUpCommitment[] = (data ?? []).map((row) => {
    // PostgREST may return the embedded relation as either an object (1:1
    // FK) or an array; normalize to object-or-null.
    const guestRaw = row.guest as JoinedGuestShape | JoinedGuestShape[] | null
    const guest = Array.isArray(guestRaw) ? guestRaw[0] ?? null : guestRaw
    return {
      id: row.id,
      type: row.type as CommitmentType,
      guest: { name: guest?.first_name ?? '' },
      description: row.description,
      code: row.code,
      expected_arrival: row.expected_arrival,
      created_at: row.created_at,
    }
  })

  return { ok: true, commitments }
}
