// TAC-575: the category instruction for the timed check-back.
//
// The send is stored as `category: 'follow_up'` (no new messages.category
// value, so no migration against a high-stakes table), but that category's
// text is written for a message DAYS AFTER A VISIT and tells the model to
// check in on it. This guest is still in the shop with the drink in their
// hand. Handing the model a false premise as fact is the TAC-484 / TAC-502
// failure class, so the instruction is swapped, by the mechanism the scan
// greeting and the inquiry follow-up already use (`categoryInstructionsFor`).
//
// IT NAMES NO ITEM AND QUOTES NO QUESTION. What the guest got is in the
// thread, in their own message. The ruling's example ("how's the SoFi treating
// you?") is deliberately not here: a quoted line is the one every guest would
// receive, and a venue's product name must not ship in a prompt every venue
// reads.
//
// "A LITTLE WHILE AGO" is timing-neutral on purpose (the inquiry follow-up's
// lesson). The timer fires ten to thirty minutes after the order, and a
// number in the copy would be false on most sends.
//
// IT SAYS THIS IS A RETURN TO THE SUBJECT. The model can see its own earlier
// "how is it?" in the thread and R41 tells it never to reuse a line, so it
// needs to know that asking again here is the point, in different words.
//
// No em dash: R3 bans them in output and the prompt should not model one.
//
// ABOUT, NOT SHAPE. An earlier draft said "send one short line" and "add
// nothing else". lib/ai/prompts/CLAUDE.md reserves length and structure for
// the universal layer (a category instruction governs what the turn is ABOUT),
// and the one-message guarantee is made in code anyway (NEVER_SPLIT_RNG at the
// send). That draft also said "how it is treating them", which is the ruling's
// own example with the pronoun changed.
export const VISIT_CHECKBACK_INSTRUCTIONS = `The guest told you what they got a little while ago, and they have not said how it is: they had not tried it yet, or they went quiet. You are checking back on that once, and that is all this message is about: ask how it is now, naming what they got, in different words from anything you have already sent them. It is not a message about a past visit.`
