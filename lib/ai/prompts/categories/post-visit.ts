// TAC-578: the category instructions for the two messages that follow a visit.
//
// Both are stored as `category: 'follow_up'` (no new messages.category value,
// so no migration against a high-stakes table), and that category's own text
// is wrong for each in a different way: it describes a message "some days
// after" a visit and tells the model to check in. The thank-you is hours after
// and checks on nothing; the check-in is explicitly not a thank-you. Handing
// the model a false premise as fact is the TAC-484 / TAC-502 failure class, so
// the instruction is swapped, by the mechanism the scan greeting, the inquiry
// follow-up and the check-back use (`categoryInstructionsFor`).
//
// Wording approved verbatim 2026-10-07. `when` is "earlier today" or
// "yesterday", from the slot the message goes out in.
//
// ABOUT, NOT SHAPE (lib/ai/prompts/CLAUDE.md): what each message says lives in
// its user-prompt block, and the one-message guarantee is made in code.
//
// No em dash, and no item named.

export function firstVisitThanksInstructions(): string {
  return 'The guest visited for the first time and that visit is over. This message thanks them for coming in. It is not a reply to anything they said, and it does not check on anything.'
}

export function visitCheckinInstructions(when: string): string {
  return `The guest has been in before and came in again ${when}. This message is not a thank-you and not a reply. It is one compliment from someone who knows them, about what they ordered.`
}
