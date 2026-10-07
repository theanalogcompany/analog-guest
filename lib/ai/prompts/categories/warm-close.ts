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
// No em dash.
//
// THE LAST TWO SENTENCES WERE REWRITTEN ON A RULING (2026-10-06). The first
// version said the close "does not ask them to come in". Read against twenty
// generated closes that was both too strict and too loose: "hope to see you
// soon" is a normal thing to say and was being forbidden, while one close
// invited a guest in "for that Blossom Tonic", a drink they had never
// mentioned, which is the thing actually worth forbidding. So a soft hope to
// see them is allowed, and an invitation for something specific, or naming
// an item the guest did not bring up, is not.
export const WARM_CLOSE_INSTRUCTIONS = `The guest has gone quiet after a conversation with you. This message closes it. It is not a reply to anything they said. A soft hope to see them again is fine. Do not invite them in for anything specific, and do not name any item they did not mention themselves.`
