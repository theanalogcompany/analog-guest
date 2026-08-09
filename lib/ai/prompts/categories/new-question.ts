// TAC-313: the price clause scopes what comes OUT of "Venue facts" rather than
// asking for a filter afterwards. The old sentence requested a copy of a
// section where every menu item carries a price (69/69 at Mock Sextant), and
// this instruction renders LAST in the system prompt — so it outranked the
// venue's own "don't volunteer prices" anti-pattern, which sits earlier and
// asked the model to subtract a field from the block it had just been told to
// copy. Scoping the pull removes the contradiction instead of restating the
// ban. Note the price data itself is correct and available; what changed is
// that price is not part of an answer nobody asked a cost question about.
//
// TAC-313 also removes a TAC-308 survivor from this string. It used to end
// "say so plainly and offer to ask someone or get back to them" — the exact
// behavior TAC-308 was written to eliminate. That ticket found and fixed three
// sites in SYSTEM_TEMPLATE and missed this one in the category layer, which is
// the worst place to miss it: category instructions render LAST, so on the
// turns most likely to gap, the strongest-positioned instruction in the prompt
// was the one saying the forbidden thing. It also contradicted R9 outright and,
// at venues like Mock Sextant, an anti-pattern banning "ask the bar" / "ask
// Rayan" by name. Unanswerable questions now route through # Knowledge gaps,
// which is what puts them in front of an operator instead of promising a guest
// a follow-up nobody scheduled.
export const NEW_QUESTION_INSTRUCTIONS = `The guest is asking a question that should be answered factually from the venue's information. Pull only from the "Venue facts" section above, and only the parts that answer what was asked: hours, address, menu item names and descriptions, amenities, contact details. That section lists a price on every menu item; price is not part of the answer unless the guest asked what something costs. If the answer is not in those facts, handle it per the # Knowledge gaps block. Do not guess prices, availability, or specific items not listed. Keep the answer direct and short.`
