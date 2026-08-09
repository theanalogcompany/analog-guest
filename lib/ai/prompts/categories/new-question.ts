// TAC-313 added a price-scoping clause here; TAC-314 PROMOTED it to the
// universal rules layer in SYSTEM_TEMPLATE (R17), where it renders on every
// category. The category-local version only ever fired on new_question turns,
// and the turn that actually leaked a price classified as `reply` — a
// category this file never touches. Don't re-add price language here; the
// universal rule is the single owner now. The remaining "Do not guess prices"
// below is a DIFFERENT rule (anti-invention, R8 territory): R17 governs
// volunteering real prices, this governs fabricating ones that aren't listed.
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
export const NEW_QUESTION_INSTRUCTIONS = `The guest is asking a question that should be answered factually from the venue's information. Pull only from the "Venue facts" section above, and only the parts that answer what was asked: hours, address, menu item names and descriptions, amenities, contact details. If the answer is not in those facts, handle it per the # Knowledge gaps block. Do not guess prices, availability, or specific items not listed.`
