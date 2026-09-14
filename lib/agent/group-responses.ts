// TAC-313: the READ half of message splitting.
//
// `split-message.ts` turns one generated body into bubbles at the send
// boundary. This module does the inverse at the read boundary: it folds the
// rows of one response back into a single history entry, so everything
// downstream counts and renders RESPONSES rather than rows.
//
// This is the single site that fixes both prompt serializers. `formatRecent
// Conversation` (lib/ai/prompts/serializers.ts) and
// `formatClassifierRecentConversation` (lib/ai/classify-message.ts) are two
// independent one-line-per-element renderers, and both consume the same
// `ctx.recentMessages` array. Merging here fixes both; fixing either renderer
// alone would leave the classifier reading rows.
//
// Why that matters beyond tidiness: a three-bubble reply rendered as three
// `[venue, 2m ago]` lines reads to the model as three separate turns, and the
// model infers from its own history that short single-beat bubbles are the
// house rhythm — a quiet feedback loop toward over-splitting.
//
// TAC-394: this is also where each response learns whether the guest ever
// received it. Same single-site argument: both serializers read the field, so
// deriving it here is what stops the classifier and the generator disagreeing
// about what the guest has seen.
//
// Pure. The only import is type-only and therefore erased at runtime, so this
// module can be unit-tested without any SDK init.

import type { MessageDelivery, RecentMessage } from '@/lib/ai'

/** The `messages` columns the history query selects. */
export interface HistoryRow {
  id: string
  direction: string
  body: string
  created_at: string
  generation_id: string | null
  // TAC-394: what deriveDelivery reads.
  status: string
  review_state: string | null
}

/**
 * TAC-394: outbound statuses that mean the message left for the guest.
 *
 * Includes 'sending', which `count_outbound_responses` (migration 032) does
 * not. The Sendblue status webhook maps QUEUED to 'sending', and its callbacks
 * can arrive out of order, so a message the guest really received can sit at
 * 'sending' indefinitely (the Command Center viewer's TRAVELED_STATUSES makes
 * the same call). For the recognition count, leaving it out under-counts a
 * reply rate. For the prompt, marking it NEVER SENT would tell the model the
 * guest never saw something they did, and invite it to say it again. Those
 * are different costs, so the two sets differ on purpose.
 */
export const DELIVERED_OUTBOUND_STATUSES: ReadonlySet<string> = new Set([
  'sending',
  'sent',
  'delivered',
])

/**
 * TAC-394: did the guest receive this row, and if not, why not?
 *
 * Order matters. `review_state = 'pending'` is checked BEFORE status, so a
 * pending draft can never read as sent whatever its status column says. Before
 * this existed every row rendered as sent, and on 2026-09-14 a model
 * regenerating a pending comp draft read the comp as already offered and
 * replied only to the guest's next question, which then overwrote the comp.
 *
 * A delivered status is checked BEFORE `skipped`. An operator can only skip a
 * pending draft, so a skipped row never went out; but if one ever carried a
 * delivered status, the guest read it, and that fact wins.
 *
 * `skipped` is its own value because the marker says why a line never arrived:
 * a draft the venue decided against and a send that failed both went unread,
 * but only the first was a decision, and a bare "never sent" beside "they have
 * not read them" can nudge the model to raise what an operator rejected.
 *
 * Anything else outbound is never_sent: failed, rejected, draft, and the v1
 * dispatch gap (approved, Sendblue threw, row stranded at pending_review).
 * That catch-all is the safe direction: a new status nobody mapped reads as
 * unsent, which costs at most a repeated sentence, rather than as sent, which
 * is the defect.
 */
export function deriveDelivery(
  row: Pick<HistoryRow, 'direction' | 'status' | 'review_state'>,
): MessageDelivery {
  if (row.direction === 'inbound') return 'delivered'
  if (row.review_state === 'pending') return 'awaiting_review'
  if (DELIVERED_OUTBOUND_STATUSES.has(row.status)) return 'delivered'
  if (row.review_state === 'skipped') return 'skipped_by_operator'
  return 'never_sent'
}

/**
 * Fold bubble rows into one entry per response, newest-`maxResponses` kept,
 * returned oldest-first for the prompt.
 *
 * `rowsNewestFirst` must be ordered `created_at DESC` — the same order the
 * history query returns.
 *
 * GROUPING IS KEYED, NOT ADJACENT. `coalesce(generation_id, id)` is the same
 * identity the two SQL surfaces in migration 032 use, so all three agree by
 * construction. Adjacency would be wrong: a guest can text between two bubbles
 * of a split reply, which puts an inbound row in the middle of a response, and
 * an adjacency-based merge would look correct in every fixture and silently
 * mis-render in production.
 *
 * A row with a null `generation_id` groups by its own id, so legacy rows,
 * inbound rows and single-bubble replies are each their own response. That is
 * why migration 032 needed no backfill.
 *
 * Window-edge caveat: if a response's bubbles straddle the query's row limit,
 * the merged body holds only the bubbles that made it inside. That is the same
 * truncation the row cap has always applied at the boundary, one bubble finer.
 *
 * TAC-394: a response is delivered if ANY of its bubbles was. Bubbles of one
 * response only disagree when a status callback marks one failed after
 * another arrived, and the guest has then read part of it. Calling the whole
 * response NEVER SENT would invite the model to repeat what they read. A
 * pending draft is always a single row (migration 020), so this never blurs
 * a pending draft into a sent one.
 */
export function groupIntoResponses(
  rowsNewestFirst: readonly HistoryRow[],
  maxResponses: number,
): RecentMessage[] {
  const groups = new Map<string, HistoryRow[]>()
  for (const row of rowsNewestFirst) {
    const key = row.generation_id ?? row.id
    const existing = groups.get(key)
    if (existing) existing.push(row)
    else groups.set(key, [row])
  }

  // Map iteration is insertion-ordered, and insertion followed the DESC row
  // order, so groups arrive newest-first and the first N are the N most
  // recent responses.
  return Array.from(groups.values())
    .slice(0, maxResponses)
    .map((rows) => {
      const ordered = [...rows].sort(
        (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
      )
      const first = ordered[0]!
      const deliveries = ordered.map((r) => deriveDelivery(r))
      return {
        // All rows in a group are bubbles of one outbound response and share a
        // direction; the first is representative.
        direction: first.direction as RecentMessage['direction'],
        // Joined with a space to reconstruct the turn as one thing said, which
        // is what the model needs to see it as.
        body: ordered
          .map((r) => r.body)
          .filter((b) => b.length > 0)
          .join(' '),
        // The moment the venue STARTED replying. The time delta the prompt
        // renders should describe the response, not its last fragment.
        createdAt: new Date(first.created_at),
        delivery: deliveries.includes('delivered') ? 'delivered' : deliveries[0]!,
      }
    })
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}
