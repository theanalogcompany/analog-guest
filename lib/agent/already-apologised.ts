// Phone test 2026-10-07: consecutive replies in a complaint thread each opened
// with an apology.
//
// WHY CODE DECIDES THIS AND NOT A RULE. A universal rule saying "apologise for
// a thing once" was measured and missed: 13 of 16 replies opened with an
// apology before it and 7 of 16 after, with "that's on us" taking the
// opener's place. No single removal cleared it either (the category's "say
// sorry", the persona's complaint line, the rule on repeated lines). The same
// instruction as a block at the end of the user prompt went 0 of 16. A block
// needs something to decide when it renders, and that is this.
//
// SIMPLE ON PURPOSE (ruled 2026-10-07). It reads our own outbound, where the
// copy says sorry in so many words; the same reasoning as the bare `?` test in
// composeReplyWithIntention. It does not try to tell WHAT was apologised for:
// the block's own last sentence leaves room for a different problem.

import { reachedGuest } from './retrieval-context'
import type { RecentMessage } from '@/lib/ai/types'

const APOLOGY = /\b(sorry|apolog(?:y|ies|ise|ize|ised|ized|ising|izing))\b/i

/**
 * Have we already said sorry to this guest in the current conversation?
 *
 * Only messages that REACHED the guest count: an apology in a held draft is one
 * they never read. "Current conversation" is the caller's window, the one
 * definition build-runtime-context hoists.
 */
export function alreadyApologised(
  recentMessages: readonly RecentMessage[],
  now: Date,
  conversationWindowMs: number,
): boolean {
  return recentMessages.some(
    (m) =>
      m.direction === 'outbound' &&
      reachedGuest(m) &&
      now.getTime() - m.createdAt.getTime() <= conversationWindowMs &&
      APOLOGY.test(m.body),
  )
}
