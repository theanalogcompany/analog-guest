// Powers GET /api/operator/queue (TAC-258). Returns pending drafts FIFO-
// ordered across the operator's allowed venues, with the latest guest_state
// and last-3 conversation context joined in via the Postgres lateral RPC
// `list_operator_queue` (migration 018) — one round trip, not N+1.
//
// The RPC handles row-level scoping (venue_ids passed in); this helper
// projects the row shape into QueueDraft (camelCase, normalized
// recent_context jsonb → array, pending_since_ms computed from created_at)
// and surfaces it as RAGResult-shaped output for consistency with other
// fail-as-value helpers in the codebase.

import { createAdminClient } from '@/lib/db/admin'
import type { Json } from '@/db/types'
import type { ApprovalTrigger } from '@/lib/agent/stages'
import type { ThreadMessage } from '@/lib/schemas'

export type GuestRecognitionState =
  | 'new'
  | 'returning'
  | 'regular'
  | 'raving_fan'

// Recent-context entry shape on the queue (last 3 messages joined by
// `list_operator_queue`). Aliased to the canonical `ThreadMessage` so the
// queue payload and the full-thread fetch (`/api/operator/messages/:id/thread`,
// TAC-277) share a single shape. Adding fields here means adding them in
// `lib/schemas/thread-message.ts` so both surfaces stay in lockstep.
export type QueueRecentContextEntry = ThreadMessage

export interface QueueDraft {
  messageId: string
  venueId: string
  venueSlug: string
  guestId: string
  guestDisplayName: string | null
  guestPhoneFallback: string
  draftBody: string
  category: string | null
  voiceFidelity: number | null
  reviewReason: string | null
  recognitionState: GuestRecognitionState | null
  pendingSinceMs: number
  recentContext: QueueRecentContextEntry[]
  langfuseTraceId: string | null
}

export type ListPendingQueueResult =
  | { ok: true; drafts: QueueDraft[] }
  | { ok: false; error: string }

const RECOGNITION_STATE_VALUES: ReadonlySet<string> = new Set([
  'new',
  'returning',
  'regular',
  'raving_fan',
])

function normalizeRecognitionState(s: string | null): GuestRecognitionState | null {
  if (s === null) return null
  return RECOGNITION_STATE_VALUES.has(s) ? (s as GuestRecognitionState) : null
}

// Operator-facing labels for `messages.review_reason`. The wire field stays
// `string | null` — only the value changes from raw classifier code to
// human-readable text. Typed as Record<ApprovalTrigger, ...> so adding a
// new trigger in lib/agent/stages.ts without a label here fails tsc.
const REVIEW_REASON_LABELS: Record<ApprovalTrigger, string> = {
  comp_regex_backstop: 'Compensation language detected',
  model_flagged: 'Model flagged for approval',
  fidelity_below_auto_send_floor: 'Voice match below auto-send threshold',
  previous_pending_held: 'Earlier draft still pending',
  // TAC-297: structural commitment-type gate. Surfaces as the most-severe
  // signal in PRIMARY_TRIGGER_PRIORITY (lib/agent/stages.ts), so most queued
  // drafts carrying a comp/hold/discount will land with this label rather
  // than the comp_regex_backstop fallback.
  commitment_type_gated: 'Commitment requires approval',
}

const REVIEW_REASON_FALLBACK = 'Needs review'

function normalizeReviewReason(raw: string | null): string | null {
  if (raw === null) return null
  return (REVIEW_REASON_LABELS as Record<string, string>)[raw] ?? REVIEW_REASON_FALLBACK
}

function normalizeRecentContext(raw: Json | null): QueueRecentContextEntry[] {
  if (raw === null) return []
  if (!Array.isArray(raw)) return []
  const out: QueueRecentContextEntry[] = []
  for (const entry of raw) {
    if (
      entry !== null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      typeof (entry as Record<string, unknown>).id === 'string' &&
      typeof (entry as Record<string, unknown>).direction === 'string' &&
      typeof (entry as Record<string, unknown>).body === 'string' &&
      typeof (entry as Record<string, unknown>).createdAt === 'string'
    ) {
      const e = entry as Record<string, string>
      if (e.direction === 'inbound' || e.direction === 'outbound') {
        out.push({
          id: e.id,
          direction: e.direction,
          body: e.body,
          createdAt: e.createdAt,
        })
      }
    }
  }
  return out
}

export async function listPendingQueue(
  allowedVenueIds: string[],
  /** Optional override for testing. Defaults to Date.now(). */
  nowMs: number = Date.now(),
): Promise<ListPendingQueueResult> {
  // Empty allowlist → empty queue; an operator with no venue grants isn't
  // an error, they just see nothing.
  if (allowedVenueIds.length === 0) {
    return { ok: true, drafts: [] }
  }

  const supabase = createAdminClient()
  const { data, error } = await supabase.rpc('list_operator_queue', {
    venue_ids: allowedVenueIds,
  })

  if (error) {
    return { ok: false, error: error.message }
  }

  const drafts: QueueDraft[] = (data ?? []).map((row) => {
    const createdAt = new Date(row.created_at).getTime()
    return {
      messageId: row.draft_id,
      venueId: row.venue_id,
      venueSlug: row.venue_slug,
      guestId: row.guest_id,
      guestDisplayName: row.guest_display_name,
      guestPhoneFallback: row.guest_phone,
      draftBody: row.draft_body,
      category: row.category,
      voiceFidelity: row.voice_fidelity,
      reviewReason: normalizeReviewReason(row.review_reason),
      recognitionState: normalizeRecognitionState(row.recognition_state),
      pendingSinceMs: Math.max(0, nowMs - createdAt),
      recentContext: normalizeRecentContext(row.recent_context),
      langfuseTraceId: row.langfuse_trace_id,
    }
  })

  return { ok: true, drafts }
}
