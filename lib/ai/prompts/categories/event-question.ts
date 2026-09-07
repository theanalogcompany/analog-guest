// TAC-327 KEEP: "Do not pivot to suggesting they come anyway" is pursuit-
// shaped but NOT a duplicate of anything the first-touch intentions block
// states — no current intention (learn_first_order, invite_contact_save)
// models generic return-visit nudging. Deleting this would open a real gap,
// not remove a leak. A future sweep should re-examine this together with
// follow-up.ts's "Do not push a return visit explicitly" (same restraint,
// same gap) rather than deleting one and missing the other.
export const EVENT_QUESTION_INSTRUCTIONS = `The guest is asking about events, when they are, or what is coming up. This is the inbound side of events, distinct from event_invite (venue-initiated outbound). Pull from the venue's documented events in the venue facts and current context. Answer factually. If you have details (date, time, what to expect), share them naturally. Do not pivot to suggesting they come anyway.`
