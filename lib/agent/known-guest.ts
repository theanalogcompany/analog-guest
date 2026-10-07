// Phone test 2026-10-07: is the guest writing now someone we already know?
//
// The history reaches the model as chat turns with no times on them, so it
// cannot tell ten minutes from ten days, and anything older than the history
// window is not in the prompt at all. A guest who came back an hour later, or
// whose only messages are months old (an imported Instagram thread, TAC-515),
// was greeted as a first-time contact. This decides, from two facts, which of
// the two `## You know this guest` blocks the prompt carries, if either.
//
// Pure, like warm-close.ts: the boundaries decide something guest-facing and
// should be drivable without a database.
//
// WHAT COUNTS AS KNOWING THEM (ruled 2026-10-07): the guest has WRITTEN to us
// before. A guest we only ever wrote to, such as one greeted after a scan who
// never replied, stays new for this block; whether they have visited is
// recognition's job, not this one's.
//
// WHY NOT `guests.created_via = 'instagram_backfill'`. The import writes
// ordinary message rows at Meta's timestamps and makes no guest for a thread
// where only the venue wrote, so every imported guest has an inbound row and
// needs no special case. The marker would also miss a guest the webhook
// created whose older messages were imported later.
//
// WHY NOT `recognition.state`. That band scores visits. This is about
// messages: a guest can have messaged for a year and never been in.

import { reachedGuest } from './retrieval-context'
import type { RecentMessage } from '@/lib/ai/types'

/** `earlier`: back after a pause in a recent conversation. `known`: older history. */
export type KnownGuest = 'earlier' | 'known'

/**
 * How long after the last message a return still reads as picking the same
 * conversation back up.
 *
 * TWELVE HOURS, ruled 2026-10-07, and deliberately NOT the venue's
 * `recent_conversation_hours` (48 by default): the block this selects asks
 * whether there is anything else we can help with, which is odd two days on.
 */
export const CONTINUITY_MAX_GAP_MS = 12 * 60 * 60 * 1000

export interface KnownGuestInput {
  /** The loaded history, oldest first, as build-runtime-context groups it. */
  recentMessages: readonly RecentMessage[]
  /** When the message being answered arrived. */
  receivedAt: Date
  /** The venue's own definition of a pause: `warm_close_pause_minutes`. */
  pauseMs: number
  /** Did this guest write to us before the loaded history begins? */
  wroteBeforeHistoryWindow: boolean
}

/**
 * Which block, if any.
 *
 * THE MESSAGES THIS TURN IS ANSWERING ARE NOT HISTORY. A burst is one turn
 * (decision 0005), so a guest's "hey" and "are you open" seconds apart are
 * both in the table by the time this runs, and the first would otherwise make
 * a brand-new guest "known". Everything the guest has sent since our last
 * message that reached them is treated as this turn. The cost is a guest whose
 * earlier message we never answered: they stay new, which is the safe side.
 */
export function deriveKnownGuest(input: KnownGuestInput): KnownGuest | null {
  const reached = input.recentMessages.filter(reachedGuest)
  let end = reached.length
  while (end > 0 && reached[end - 1]?.direction === 'inbound') end -= 1
  const before = reached.slice(0, end)
  const turnStartedAt = reached[end]?.createdAt ?? input.receivedAt

  const wroteInWindow = before.some((m) => m.direction === 'inbound')
  if (!wroteInWindow && !input.wroteBeforeHistoryWindow) return null

  const last = before.at(-1)
  if (last === undefined) return 'known'

  const gapMs = turnStartedAt.getTime() - last.createdAt.getTime()
  if (!Number.isFinite(gapMs)) return null
  // Still mid-conversation: no greeting is at stake.
  if (gapMs < input.pauseMs) return null
  if (wroteInWindow && gapMs < CONTINUITY_MAX_GAP_MS) return 'earlier'
  return 'known'
}
