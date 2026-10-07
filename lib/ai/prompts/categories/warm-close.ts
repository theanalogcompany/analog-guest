// TAC-575: the category instruction for the pause timer's sign-off.
//
// The send is stored as `category: 'acknowledgment'` (no new messages.category
// value, so no migration against a high-stakes table). That category's own
// text opens "The guest is wrapping up the thread or signing off", which is
// FALSE on this turn: the guest sent nothing, which is the whole reason a
// timer is doing this. Handing the model a false premise as fact is the
// TAC-484 / TAC-502 failure class, so the instruction is swapped, by the
// mechanism the scan greeting, the inquiry follow-up and the check-back use.
//
// THIS FILE EXISTED BEFORE, under TAC-560, and TAC-568 deleted it when the
// close became a fixed string nobody generated. TAC-575 makes the close
// generated again (ruled 2026-10-06: "the model writes each ... sign-off
// fresh"), so the instruction is back. It is shorter than the original on
// purpose: what the close SAYS now lives in the user-prompt block (`## Sign
// off` or `## Closing this conversation`), and a category instruction governs
// only what the turn is about.
//
// A goodbye turn does NOT use this. There the guest did sign off, and the
// acknowledgment text is true.
//
// Wording approved verbatim, 2026-10-06. No em dash.
export const WARM_CLOSE_INSTRUCTIONS = `The guest has gone quiet after a conversation with you. This message closes it. It is not a reply to anything they said, and it does not ask them to come in.`
