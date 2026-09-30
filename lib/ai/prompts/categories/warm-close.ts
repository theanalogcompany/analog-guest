// TAC-560: the category instructions for the pause-triggered warm close.
//
// REPLACES ACKNOWLEDGMENT_INSTRUCTIONS on this turn rather than layering over it,
// and that is the whole reason this file exists. The row stores
// `category: 'acknowledgment'` (no new messages.category value, so no migration
// against a high-stakes table), but that category's own text is FALSE here:
//
//   "The guest is wrapping up the thread or signing off"      the guest sent nothing
//   "do not turn the closer into a fresh exchange"            this close names topics
//
// Handing the model a false premise as fact is the TAC-484 / TAC-502 failure
// class, so the instruction is swapped rather than argued with. The mechanism is
// TAC-536's: `categoryInstructionsFor` already carries one per-turn exception for
// exactly this reason, and its header states it — one category is what the
// storage layer, the approval-policy UI and the operator queue all want.
//
// IT NAMES NO TOPICS, deliberately. The three things a guest can message about
// (coffee and beans; the menu, specials and recommendations; events) are LE MIL'S
// choice, carried in that venue's own voice rules. Restating them here would ship
// one venue's product decision into every venue's prompt. This file supplies the
// situation; the venue's rules supply the content.
//
// No em dash: R3 bans them in output and the prompt should not model one.
export const WARM_CLOSE_INSTRUCTIONS = `This message closes the guest's first conversation with the venue. It is a warm sign-off that leaves the line open, not a new exchange and not a check-in about a past visit.`
