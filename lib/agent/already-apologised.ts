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
// composeReplyWithIntention. It does not try to tell WHAT was apologised for,
// and "sorry, we're closed sundays" counts. That is why the block it switches
// on asks the model whether this is the same thing, rather than saying so: a
// wording that asserted it cost a first complaint its apology 6 times in 10.

import { reachedGuest } from './retrieval-context'
import type { RecentMessage } from '@/lib/ai/types'

const APOLOGY = /\b(sorry|apolog(?:y|ies|ise|ize|ised|ized|ising|izing))\b/i

/**
 * Have we already said sorry to this guest in the current conversation?
 *
 * Only messages that REACHED the guest count: an apology in a held draft is one
 * they never read. "Current conversation" is the caller's window, the one
 * definition build-runtime-context hoists, measured back from `asOf`: when the
 * guest's message arrived, so a replayed turn is judged as of its own moment.
 */
export function alreadyApologised(
  recentMessages: readonly RecentMessage[],
  asOf: Date,
  conversationWindowMs: number,
): boolean {
  return recentMessages.some(
    (m) =>
      m.direction === 'outbound' &&
      reachedGuest(m) &&
      asOf.getTime() - m.createdAt.getTime() <= conversationWindowMs &&
      APOLOGY.test(m.body),
  )
}
