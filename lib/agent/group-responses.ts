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
// Pure. The only import is type-only and therefore erased at runtime, so this
// module can be unit-tested without any SDK init.

import type { RecentMessage } from '@/lib/ai'

/** The `messages` columns the history query selects. */
export interface HistoryRow {
  id: string
  direction: string
  body: string
  created_at: string
  generation_id: string | null
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
      }
    })
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}
