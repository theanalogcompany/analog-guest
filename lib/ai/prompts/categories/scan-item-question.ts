// TAC-588: the category instruction for a receipt scan's item question, about
// twenty minutes after the order (lib/agent/scan-item-question.ts).
//
// It REPLACES the check-back for a scan visit and rides its trigger, so the
// send is stored as `follow_up` like the check-back, and this swaps that
// category's text the way VISIT_CHECKBACK_INSTRUCTIONS does.
//
// THE WORDING IS JAIPAL'S, approved verbatim (ruled 2026-10-14), with the item
// filled in. Unlike the check-back, it NAMES THE ITEM: the check-back's guest
// named their own order in the thread, and this guest never did, because the
// scan told us. The name is Square's line item, the one the hello
// complimented, flattened to one line so it cannot break the instruction.
//
// "WHETHER THEY ARE STILL FINISHING IT OR HAVE ALREADY LEFT", because a receipt
// code binds for twenty-four hours: this can reach a guest at the counter or at
// home the next morning. "how is it" and "how was it" each guess which. The
// preferred form, from the ruling, is "how'd you like the {item}?", and it is
// deliberately not quoted here: a quoted line is the one every guest gets.
//
// No em dash: R3 bans them in output and the prompt should not model one.

/** The approved instruction, for this item. */
export function scanItemQuestionInstructions(item: string): string {
  const name = item.replace(/\s+/g, ' ').trim()
  return `You complimented what this guest ordered a little while ago, and they haven't written back. Ask them how they liked the ${name}, in words that work whether they are still finishing it or have already left. Don't say "how is it" or "how was it". This message is only that question.`
}
