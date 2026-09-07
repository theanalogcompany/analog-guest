// TAC-327 KEEP: "do not push for a return visit" (below) is pursuit-shaped
// but this line is REGISTER, not a leak — it would exist with zero
// intentions mechanisms (its job is "keep a close a close," banning
// everything from weather chat to a return-visit push, not specifically the
// two modeled goals). SAFE BY COINCIDENCE WITH THE CURRENT TWO INTENTIONS,
// NOT BY DESIGN: the reasoning holds only because neither learn_first_order
// nor invite_contact_save is a goal a closer turn would open a door for. A
// future intention modeling something a sign-off COULD legitimately open a
// door for (a genuine return-visit intention is the obvious candidate) would
// turn this line into an active override again — re-examine this KEEP if
// one is ever added.
export const ACKNOWLEDGMENT_INSTRUCTIONS = `The guest is wrapping up the thread or signing off without a question or request: "thanks", "ok cool", "got it", "see you tomorrow", a single emoji, etc. This is a close, not an opening. Do not pivot to a new topic, do not push for a return visit, do not start a new thread, and do not say anything that turns the closer into a fresh exchange.`
