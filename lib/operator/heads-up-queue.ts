// Powers GET /api/operator/queue's new `commitments` field (TAC-297). Returns
// pending_ack commitments FIFO-ordered across the operator's allowed venues.
// Cross-repo Contract-locked payload (TAC-297 + TAC-298 + TAC-299): each entry
// is `{ id, type, guest: {name}, description, code, expected_arrival,
// created_at, recognitionState, sourceMessageId }`.
//
// Mirrors the lib/operator/queue.ts shape (RAGResult-style, app-layer venue
// scoping via the `in()` filter on allowedVenueIds). Joins the guest name
// in a single round trip via PostgREST's embedded relations rather than an
// N+1 lookup per commitment.
//
// TAC-299 adds two fields:
//   - sourceMessageId — projected directly from the guest_commitments row's
//     source_message_id column. One extra column in the same SELECT, no extra
//     round trip.
//   - recognitionState — pulled via a SECOND batched query against guest_states
//     keyed on the set of guest_ids returned by the first query. We avoid
//     PostgREST's embedded relations for the recognition lookup because
//     "latest row per parent" via embedded ORDER BY + LIMIT is unreliable
//     (PostgREST applies LIMIT to the OUTER set, not per-relation). Two
//     queries gives deterministic semantics under O(2) round trips total
//     regardless of result count, and keeps both queries indexed.

import { createAdminClient } from '@/lib/db/admin'
import { GUEST_STATES, type GuestState } from '@/lib/recognition/types'
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

const RECOGNITION_STATE_VALUES: ReadonlySet<string> = new Set(GUEST_STATES)

function normalizeRecognitionState(s: string | null): GuestState | null {
  if (s === null) return null
  return RECOGNITION_STATE_VALUES.has(s) ? (s as GuestState) : null
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
      'id, type, description, code, expected_arrival, created_at, source_message_id, guest_id, guest:guests!inner(first_name)',
    )
    .eq('status', 'pending_ack')
    .in('venue_id', allowedVenueIds)
    .order('created_at', { ascending: true })
    .limit(200)

  if (error) {
    return { ok: false, error: error.message }
  }

  // Second batched query for recognition state. Skipped entirely when there
  // are zero rows to enrich — avoids a wasted `.in('guest_id', [])` round
  // trip and matches the empty-allowlist short-circuit above.
  //
  // We read the CURRENT state row (`exited_at IS NULL`) per guest. Each
  // state transition INSERTs a new row + UPDATEs the prior row's exited_at;
  // the open-ended row is the live one. Cleaner than ORDER BY entered_at +
  // pick-first because the data model already marks the live row.
  const guestIds = Array.from(new Set((data ?? []).map((row) => row.guest_id)))
  const recognitionByGuestId = new Map<string, GuestState>()
  if (guestIds.length > 0) {
    // Compound (guest_id, venue_id) filter hits the partial index
    // `idx_guest_states_current ON (guest_id, venue_id) WHERE exited_at
    // IS NULL` (migration 001). Functionally redundant — guest_id is
    // already venue-scoped via guests.venue_id — but encodes the cross-
    // venue scoping intent on the query surface for any future reader.
    const { data: stateRows, error: stateError } = await supabase
      .from('guest_states')
      .select('guest_id, state, entered_at')
      .in('guest_id', guestIds)
      .in('venue_id', allowedVenueIds)
      .is('exited_at', null)
      .order('entered_at', { ascending: false })
    if (stateError) {
      // Recognition is a UI nicety, not load-bearing. Degrade gracefully:
      // log + leave the map empty so every commitment projects with
      // recognitionState=null. The heads-up card still renders; just
      // without the recognition pill.
      console.warn(
        `[lib/operator/heads-up-queue] guest_states lookup degraded: ${stateError.message}`,
      )
    } else {
      for (const row of stateRows ?? []) {
        // Multiple "current" rows for one guest shouldn't happen (insert +
        // exit-prior is the only legal transition), but the ORDER BY +
        // hasKey-check makes the projection deterministic if it ever does.
        if (!recognitionByGuestId.has(row.guest_id)) {
          const normalized = normalizeRecognitionState(row.state)
          if (normalized !== null) {
            recognitionByGuestId.set(row.guest_id, normalized)
          }
        }
      }
    }
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
      recognitionState: recognitionByGuestId.get(row.guest_id) ?? null,
      sourceMessageId: row.source_message_id,
    }
  })

  return { ok: true, commitments }
}
