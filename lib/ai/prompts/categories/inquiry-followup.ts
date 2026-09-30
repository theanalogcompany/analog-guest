// TAC-386: the category instructions for the inquiry follow-up.
//
// REPLACES the `follow_up` instructions on this turn rather than layering over
// them, and that is the whole reason this file exists. The row stores
// `category: 'follow_up'` (no new messages.category value, so no migration
// against a high-stakes table), but that category's text is written for a
// message DAYS AFTER A VISIT and tells the model to check in on it. Ruling 11
// forbids exactly that: this message knows what the guest asked and what we
// said, and nothing at all about whether they came in.
//
// Handing the model a false premise as fact is the TAC-484 / TAC-502 failure
// class, so the instruction is swapped rather than argued with. The mechanism is
// TAC-536's and TAC-560's: `categoryInstructionsFor` already carries two
// per-turn exceptions for this reason, and this is the third.
//
// IT NAMES NO TOPIC AND NO EXAMPLE PHRASE. What the guest asked and what we told
// them arrive as DATA in the `## Following up on what they asked` block
// (lib/ai/prompts/serializers.ts), because they are different on every send. A
// quoted example here would be copied verbatim (Jaipal's standing rule), and a
// worked example of one venue's answer would ship that venue's product decision
// into every venue's prompt, which is TAC-560's reason for naming no topics.
//
// TIMING-NEUTRAL WORDING, ruled 2026-09-30. An earlier draft opened "Earlier
// today", which is false on every send that rolled to the next open period, and
// that is most of them: a question asked after Le Mil's 3pm close is answered
// the following morning.
//
// No em dash: R3 bans them in output and the prompt should not model one.
export const INQUIRY_FOLLOWUP_INSTRUCTIONS = `This message follows up on something the guest asked us recently, which we answered. It checks that what we helped them with worked out. It is not a message about a past visit, and it does not ask them to come in.`
