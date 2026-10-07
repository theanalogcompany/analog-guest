// TAC-536: what to say to a guest who scanned the counter code and said
// nothing for the greeting delay (SCAN_GREETING_DELAY_MS, twenty seconds).
//
// TWO VARIANTS, chosen by whether the guest has any message on our record.
// They are not a stylistic pair: one introduces the venue and one is told not
// to, so picking the wrong one either greets a regular as a stranger or skips
// an introduction for someone who has never heard from us.
//
// Both were approved by Jaipal, the first verbatim as written in the ruling of
// 2026-09-25, the second as proposed in the amended plan and approved in the
// same ruling. Neither carries an em dash: R3 bans them in output and the
// regen loop pays for every one that survives, so the prompt should not model
// one.
//
// WHY THE NEW-GUEST VARIANT IS NOT TAC-423'S OPENER VERBATIM, which is what a
// first reading of the ruling asks for. Two reasons, both structural, and both
// recorded because the difference is deliberate rather than drift:
//
//   1. That string opens "This is the guest's first message, sent right after
//      they scanned the sign at your pickup counter", and continues "If their
//      message doesn't name a person". On a bare scan there is no guest
//      message. Rendering it unchanged tells the model one exists and invites
//      it to answer something nobody said.
//   2. It could not render here anyway. The opener lives inside the
//      `## What you're hoping to get to` block, gated by
//      computeFirstTouchAfterQrScan, whose first condition is
//      `ctx.currentMessage !== null`; and buildRuntimeContext derives
//      intentions at all only when there is a current message. A greeting turn
//      has none, and giving handleFollowup one is what its TAC-244
//      inbound-XOR-outbound invariant throws on.
//
// So the variant below says the same things the opener says in the opener's own
// words, with the clauses the absent message made false rewritten and nothing
// else changed.
//
// TAC-567 (ruled 2026-09-30) DELETED "and say who they have reached" from both
// this variant and the opener it mirrors. A guest who just scanned this venue's
// code does not need telling whose code it was, and on device the instruction
// beat a persona rule saying not to. The two strings were changed together
// because the ticket named this one explicitly; keeping them in step is the
// whole reason this header records the relationship. Do not restore it here
// either.
//
// REGISTER ONLY, per TAC-314 and TAC-327. Neither variant prescribes length
// beyond the one short line the ruling specified, and neither says what goals
// to pursue.

/**
 * The guest has messages on our record. Jaipal's wording, verbatim from the
 * ruling of 2026-09-25.
 */
export const GUEST_ARRIVED_INSTRUCTIONS_RETURNING = `The guest just scanned the code at the counter, so they are in the shop right now. Greet them the way you would someone walking up, and ask what they got. One short line. You have talked before, so don't introduce yourself. Say only what the facts below say about past visits.`

/**
 * No messages on our record. See the header for why this is not TAC-423's
 * opener character for character.
 */
export const GUEST_ARRIVED_INSTRUCTIONS_NEW = `The guest just scanned the sign at your pickup counter and has not written anything yet, so they are in the shop right now. They have just ordered and collected it. Say hello. Ask what they just got. One short line. Say only what the facts below say about past visits.`

/**
 * TAC-575: the guest is back after a visit that ended in a complaint, and this
 * greeting is the follow-up (ruled 2026-10-06: "on the guest's next detected
 * visit, the agent follows up"). The returning-guest variant with the one fact
 * added and three things barred.
 *
 * WHY IT BARS AN APOLOGY, THE DETAILS AND AN OFFER. The apology and anything
 * offered were the complaint path's job on the day, and went through an
 * operator. Repeating them here would re-open a complaint at the counter in an
 * unprompted message nobody approved, and "do not offer anything" is what
 * keeps a comp from being promised twice. The details are barred because the
 * model may not have them: the conversation is in its history for fourteen
 * days and this renders for thirty.
 *
 * "TODAY" in "what they got today" is deliberate: without it the question
 * reads as being about the order that went wrong.
 */
export const GUEST_ARRIVED_INSTRUCTIONS_AFTER_COMPLAINT = `The guest just scanned the code at the counter, so they are in the shop right now. The last time they were in, they told you something was wrong with what they got. Greet them the way you would someone walking up, say you are glad they came back, and ask what they got today. Do not apologise again, do not repeat what went wrong, and do not offer anything. One or two short lines. You have talked before, so don't introduce yourself.`

/**
 * Pick the variant.
 *
 * `afterComplaint` wins over the other two: it is only ever set for a guest
 * with a check-in on file, who has by definition talked with us before.
 *
 * `null` means the runtime context did not carry a scan-arrival fact on a
 * `guest_arrived` turn, which is a wiring bug rather than a reachable state.
 * It falls back to the NEW-guest variant on purpose: an introduction a guest
 * did not need is odd, and telling a stranger "you have talked before" is
 * false. Falling toward the false one would be the worse failure.
 */
export function guestArrivedInstructionsFor(
  scanArrival: {
    hadPriorConversation: boolean
    afterComplaint?: boolean
  } | null,
): string {
  if (scanArrival?.afterComplaint === true) {
    return GUEST_ARRIVED_INSTRUCTIONS_AFTER_COMPLAINT
  }
  return scanArrival?.hadPriorConversation === true
    ? GUEST_ARRIVED_INSTRUCTIONS_RETURNING
    : GUEST_ARRIVED_INSTRUCTIONS_NEW
}
