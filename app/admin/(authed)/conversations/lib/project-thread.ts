import type { Json } from '@/db/types'

// TAC-316: viewer-side projection from raw `messages` rows to response-grained
// thread entries. Sibling of `lib/agent/group-responses.ts` — same grouping
// identity (`generation_id ?? id`, i.e. coalesce(generation_id, id) from
// migration 032), different output shape: the prompt-facing sibling collapses
// to `RecentMessage` and discards ids/trace/review, while the viewer needs all
// of that per response plus per-bubble bodies for iMessage-faithful rendering.
//
// GROUPING IS KEYED, NOT ADJACENT. A guest can text inside the inter-bubble
// gap of a split reply, which puts an inbound row between two bubbles of one
// response; an adjacency-based merge would pass every contiguous fixture and
// mis-render in production (see group-responses.ts for the original warning).
//
// Unlike `groupIntoResponses`, this function sorts its input internally
// (created_at DESC, id tiebreak) instead of requiring pre-sorted rows. The
// sibling's DESC-input precondition exists for parity with its SQL surfaces
// and once failed SILENTLY when given ASC input (documented gotcha); at
// viewer scale (≤ a few hundred rows) the sort is cheap and removes the
// footgun entirely. Output is oldest-first, ready for the thread.
//
// The viewer's contract is SHOW EVERYTHING: no filtering on status,
// review_state, or body content happens here. `status` / `review_state` /
// `review_reason` stay opaque strings — the live DB has grown enum values the
// generated types don't narrow, and an exhaustive union here would truncate
// the list the next time that happens (the exact TAC-316 failure mode the
// ticket hypothesized). `deriveResponseState` maps the combos we know and
// falls back to literal text for everything else.

/** The `messages` columns the conversation query selects. */
export interface ConversationMessageRow {
  id: string
  body: string
  direction: string
  created_at: string
  langfuse_trace_id: string | null
  reply_to_message_id: string | null
  provider_message_id: string | null
  category: string | null
  response_review: Json | null
  status: string
  review_state: string | null
  review_reason: string | null
  generation_id: string | null
  reaction_type: string | null
  media_urls: string[]
}

/** One dispatched fragment (bubble) of a response, in its own `messages` row. */
export interface ThreadBubble {
  id: string
  body: string
  /**
   * Non-null when `body` is blank: the operator-facing stand-in text. Blank
   * bodies are legal three ways (migration 002's content constraint) —
   * reaction rows, media rows, and TAC-309 blank knowledge-gap cards — and
   * each names itself rather than rendering an empty bubble.
   */
  placeholder: string | null
  createdAt: Date
}

/**
 * One response: all rows sharing `generation_id ?? id`. Single-bubble replies,
 * inbound rows, and legacy rows (null generation_id) are one-bubble responses
 * keyed by their own id — which is why migration 032 needed no backfill.
 */
export interface ThreadResponse {
  /** First bubble's real id — the queue precedent (migration 032 recent_context). */
  id: string
  /** Oldest-first fragments. Always at least one. */
  bubbles: ThreadBubble[]
  /** Non-empty bubble bodies joined with newlines. Empty string for blank cards. */
  body: string
  direction: 'inbound' | 'outbound'
  /** The moment the response STARTED (first bubble's created_at). */
  createdAt: Date
  langfuseTraceId: string | null
  replyToMessageId: string | null
  providerMessageId: string | null
  category: string | null
  responseReview: Json | null
  status: string
  reviewState: string | null
  reviewReason: string | null
}

/**
 * Group raw rows into responses. Accepts rows in any order; output is
 * oldest-first. Bubbles straddling the query's row window merge from whatever
 * made it inside — the same boundary truncation the row cap has always
 * applied, one bubble finer.
 */
export function projectThread(rows: readonly ConversationMessageRow[]): ThreadResponse[] {
  const newestFirst = [...rows].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || a.id.localeCompare(b.id),
  )

  const groups = new Map<string, ConversationMessageRow[]>()
  for (const row of newestFirst) {
    const key = row.generation_id ?? row.id
    const existing = groups.get(key)
    if (existing) existing.push(row)
    else groups.set(key, [row])
  }

  return Array.from(groups.values())
    .map((groupRows) => {
      const ordered = [...groupRows].sort(
        (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id),
      )
      const first = ordered[0]
      return {
        id: first.id,
        bubbles: ordered.map((r) => ({
          id: r.id,
          body: r.body,
          placeholder: derivePlaceholder(r),
          createdAt: new Date(r.created_at),
        })),
        body: ordered
          .map((r) => r.body)
          .filter((b) => b.length > 0)
          .join('\n'),
        direction: (first.direction === 'outbound' ? 'outbound' : 'inbound') as
          | 'inbound'
          | 'outbound',
        createdAt: new Date(first.created_at),
        // First non-null wins — bubbles of one generation share a trace, but be
        // defensive about which row carries the pointer.
        langfuseTraceId: ordered.find((r) => r.langfuse_trace_id)?.langfuse_trace_id ?? null,
        replyToMessageId: first.reply_to_message_id,
        providerMessageId: first.provider_message_id,
        category: first.category,
        responseReview: ordered.find((r) => r.response_review !== null)?.response_review ?? null,
        status: first.status,
        reviewState: first.review_state,
        reviewReason: first.review_reason,
      }
    })
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}

// ---------------------------------------------------------------------------

/**
 * Stand-in text for a blank-body row. The `messages_has_content` constraint
 * admits blank bodies with a reaction_type or media_urls (migration 002), and
 * TAC-309 made blank knowledge-gap drafts legal outright — so "blank" is not
 * synonymous with "blank card" and each kind names itself.
 */
function derivePlaceholder(row: ConversationMessageRow): string | null {
  if (row.body.trim() !== '') return null
  if (row.reaction_type) return `reaction: ${row.reaction_type}`
  if (row.media_urls.length > 0) {
    return `media message (${row.media_urls.length} attachment${row.media_urls.length === 1 ? '' : 's'})`
  }
  return `no draft — blank card${row.review_reason ? ` (${row.review_reason})` : ''}`
}

/**
 * `normal` — dispatched happy path, renders exactly as before TAC-316.
 * `annotated` — anything else: a muted bubble plus a caption with the label.
 */
export type ThreadResponseState = { kind: 'normal' } | { kind: 'annotated'; label: string }

// Statuses that mean "this message actually traveled" — inbound rows are
// 'received'; dispatched outbound rows are 'sending' (Sendblue QUEUED, see
// the status webhook's mapping — and its out-of-order-callback TODO means a
// genuinely delivered row can sit at 'sending' indefinitely), then 'sent',
// then 'delivered'. Anything else is annotated, known or not.
const TRAVELED_STATUSES = new Set(['received', 'sending', 'sent', 'delivered'])

// Review states that coexist with a genuinely dispatched row (migration 018).
// null covers inbound rows and pre-TAC-258 history.
const DISPATCHED_REVIEW_STATES = new Set([null, 'approved', 'edited', 'auto_sent'])

/**
 * Map (status, review_state) to an operator-facing delivery-state label.
 * NEVER throws, and deliberately not an exhaustive switch: unknown values from
 * a future migration render as literal text instead of truncating the thread.
 */
export function deriveResponseState(response: {
  status: string
  reviewState: string | null
}): ThreadResponseState {
  const { status, reviewState } = response
  if (reviewState === 'skipped') return { kind: 'annotated', label: 'never sent — superseded' }
  if (reviewState === 'pending') return { kind: 'annotated', label: 'pending review' }
  if (status === 'failed') return { kind: 'annotated', label: 'failed to send' }
  // Deliberately NO `status === 'pending_review'` clause: with review_state
  // not pending/skipped, the only real occupant of that combo is the
  // documented v1 failure-recovery gap (operator approved, Sendblue dispatch
  // threw, row stranded). "pending review" would be the one thing it isn't —
  // the literal fallback below tells the operator the truth.
  if (TRAVELED_STATUSES.has(status) && DISPATCHED_REVIEW_STATES.has(reviewState)) {
    return { kind: 'normal' }
  }
  // Unknown combination — render it verbatim so the operator sees the truth
  // and the thread keeps rendering (TAC-316 contract).
  return { kind: 'annotated', label: `status=${status} · review_state=${reviewState ?? 'null'}` }
}

/**
 * True when the response actually reached (or should have reached) the guest.
 * Never-sent drafts, pending cards, and failed sends are visible in the
 * thread but excluded from response-rate stats — a guest can't reply to a
 * message they never received.
 */
export function wasDispatched(response: { status: string; reviewState: string | null }): boolean {
  return deriveResponseState(response).kind === 'normal'
}
