// TAC-330 (case 2) narrowed this file's no-pivot ban after a bare one-word
// reply classified as `acknowledgment` instead of `reply` and the absolute
// "do not pivot / do not start a new thread" silently vetoed an open
// intention on the one turn it was free to fire. The fix added a
// jurisdictional carve-out sentence: this category's register guidance has
// no authority over whether the model acts on a goal it's already
// carrying. TAC-314 (second round) promoted that sentence to the universal
// layer as R22 (`system-template.ts`) — it's a general prompt-authority
// rule, not category-specific content, and leaving it here would mean
// re-deriving it for every future category that bans a pivot. Removed from
// here as a paired move, not a deletion. The ban below is untouched and
// stays local: what a close is, and isn't, is genuinely this category's
// content. Full incident history (TAC-327's original "safe by coincidence"
// classification, the case-2 failure, the self-contradicting first draft)
// lives in CLAUDE.md under "Category instruction layer carries NO pursuit
// authority (TAC-327)" and the "First-touch intentions (TAC-324)" section.
export const ACKNOWLEDGMENT_INSTRUCTIONS = `The guest is wrapping up the thread or signing off without a question or request: "thanks", "ok cool", "got it", "see you tomorrow", a single emoji, etc. This is a close, not an opening. Do not pivot to a new topic, do not push for a return visit, and do not turn the closer into a fresh exchange.`
