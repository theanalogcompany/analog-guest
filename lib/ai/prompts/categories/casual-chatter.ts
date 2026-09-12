// TAC-327: the two deleted PURSUIT lines ("don't pivot to perks, events, or a
// service offer" / "don't try to read a service intent into a friendly
// remark") duplicated, absolutely, what the first-touch intentions block
// already states conditionally ("only raise one if the conversation opens a
// natural door"). Category instructions govern REGISTER, not PURSUIT — see
// CLAUDE.md "Category instruction layer carries NO pursuit authority
// (TAC-327)". Do not re-add pivot/service-intent restraint language here;
// that restraint belongs to lib/agent/intentions/, which already states it
// correctly and conditionally.
//
// TAC-356: this is the category a guest's bare greeting ("hey", "hi") with
// no question actually classifies to (welcome is outbound-only, TAC-238/
// migration 016 — it can never be the guest's own inbound greeting). The
// live incident that motivated universal R31 ("hey" answered with "come try
// Indian coffee sometime") fell through exactly here, because "stay in
// voice" says nothing about not naming a product. R31 covers it at the
// universal layer now; nothing needed to change in this file's own text.
export const CASUAL_CHATTER_INSTRUCTIONS = `The guest is making small talk or an unprompted casual comment that doesn't ask a question or invoke a service. Stay in voice.`
