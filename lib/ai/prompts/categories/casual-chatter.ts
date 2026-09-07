// TAC-327: the two deleted PURSUIT lines ("don't pivot to perks, events, or a
// service offer" / "don't try to read a service intent into a friendly
// remark") duplicated, absolutely, what the first-touch intentions block
// already states conditionally ("only raise one if the conversation opens a
// natural door"). Category instructions govern REGISTER, not PURSUIT — see
// CLAUDE.md "Category instruction layer carries NO pursuit authority
// (TAC-327)". Do not re-add pivot/service-intent restraint language here;
// that restraint belongs to lib/agent/intentions/, which already states it
// correctly and conditionally.
export const CASUAL_CHATTER_INSTRUCTIONS = `The guest is making small talk or an unprompted casual comment that doesn't ask a question or invoke a service. Stay in voice.`
