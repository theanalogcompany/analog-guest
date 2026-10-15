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
 * keeps a comp from being promised twice. The details are barred because
 * the model does not have them: this greeting is generated without the
 * earlier conversation (below).
 *
 * "TODAY" in "what they got today" is deliberate: without it the question
 * reads as being about the order that went wrong.
 *
 * THIS GREETING IS GENERATED WITHOUT THE EARLIER CONVERSATION
 * (messagesFromThisVisit, lib/agent/visit-checkin.ts), and that is what makes
 * it work, not these words. With the thread in front of it the model answered
 * the old complaint instead of greeting: eight of ten in the pre-registered
 * run (2026-10-06, scripts/measurement/complaint-followup.ts), and still two
 * of ten after this text was rewritten to say the earlier conversation was
 * over. The history reaches the model as chat turns with no dates on them, so
 * a thread ending in a complaint and an apology reads as a complaint made a
 * moment ago. The two greetings that passed every run were the two with no
 * history loaded. So the wording went back to the draft and the history went.
 *
 * THE ORDINARY RETURNING GREETING HAD THE SAME WEAKNESS AND NOW HAS THE SAME
 * FIX (ruled 2026-10-06). On those threads, with its history, it answered the
 * old complaint in five of ten; that is what any returning guest got whose
 * thread ended on a complaint and who was not owed a follow-up. Its wording
 * is a ruling's, verbatim, and is unchanged. Only the thread is withheld.
 *
 * WHAT A GREETING GIVES UP BY NOT SEEING THE THREAD, so nobody restores it
 * without knowing the trade:
 *
 *   - It could not see its own earlier greetings, and ten in a row came out
 *     as one sentence. FIXED SEPARATELY: the greeting is now handed its last
 *     three greetings to this guest as lines not to repeat
 *     (PRIOR_GREETING_LIMIT, lib/agent/scan-arrival.ts). Those lines only.
 *   - It cannot pick up anything the guest said that was never stored as a
 *     fact: a joke, a plan mentioned in passing, what they were unsure about
 *     last time.
 *   - It cannot match the register the thread had settled into.
 *   - It cannot see a message from earlier the same day that is more than half
 *     an hour old. "On my way, any almond croissants left?" forty minutes
 *     before the scan is gone from the greeting's view.
 *
 * What it KEEPS, because none of it travels in the thread: the guest's name
 * and stored notes, their visit history, open commitments, and the two facts
 * in `## Guest just arrived`. Anything the guest wrote in the half hour before
 * scanning is this visit and stays.
 */
export const GUEST_ARRIVED_INSTRUCTIONS_AFTER_COMPLAINT = `The guest just scanned the code at the counter, so they are in the shop right now. The last time they were in, they told you something was wrong with what they got. Greet them the way you would someone walking up, say you are glad they came back, and ask what they got today. Do not apologise again, do not repeat what went wrong, and do not offer anything. One or two short lines. You have talked before, so don't introduce yourself.`

// ---------------------------------------------------------------------------
// TAC-588: a scan of a RECEIPT code
// ---------------------------------------------------------------------------
//
// The scan has already told us what they ordered, so asking "what did you get?"
// says we weren't paying attention. The hello compliments the order instead,
// and asks NOTHING: the question about the item comes about twenty minutes
// after the order, on its own (lib/agent/scan-item-question.ts).
//
// THE THREE COMPLIMENT VARIANTS ARE JAIPAL'S WORDING, approved verbatim
// (ruled 2026-10-14), with three additions ruled after the first measurement
// (2026-10-15): "Always open with a short hello" (eight of ten nameless new
// guests got none), no "enjoy" and nothing about the stage of their visit
// ("hope you enjoyed the espresso"), and no claim about popularity, rank or
// who made it unless the facts say so ("the most underrated"). The first two
// are in the hello-only variants too. The order reaches the model as facts in
// `## Guest just arrived` (formatScanOrder, serializers.ts); this text names no
// item and quotes no example, so nothing here is a line every guest receives.
//
// "MAY STILL BE IN THE SHOP OR MAY ALREADY HAVE LEFT". A receipt code binds for
// twenty-four hours, and a slip is scanned on the walk out, at home, or the next
// morning, so the present tense the counter wordings above assert is not ours
// to assert here.
//
// "ASK NOTHING AT ALL" IS ALSO ENFORCED IN CODE (withoutQuestions,
// lib/agent/scan-arrival.ts), because a prompt's "don't" is a request
// (decision 0007's lesson).
//
// THE HELLO-ONLY VARIANTS, for a receipt code past its day (ruled 2026-10-14,
// question 3: "a hello only, with no compliment and no question") and for one
// already used by an earlier scan (ruled in the PR #392 review: "only the
// counter sign asks 'what did you get?', because only the counter sign means
// they're in the shop now"). Each is
// its compliment variant with the compliment sentence REMOVED and nothing
// else changed: no new wording was written for them, so none needed its own
// approval beyond the ruling that says what they leave out.

/** A new guest, with a bound order. Approved verbatim. */
export const GUEST_ARRIVED_ORDER_INSTRUCTIONS_NEW = `The guest just scanned the code on their receipt and has not written anything. They may still be in the shop or may already have left, so say nothing that depends on which. Never say "enjoy", "enjoyed" or "enjoying", and say nothing about the start, middle or end of their visit. Always open with a short hello, using their name if you know it; if you don't, leave the name out and don't ask for it. Then compliment what they ordered, named under "Guest just arrived", using what the facts say about it: how it tastes, what it goes with. Never a generic line like "great choice", and never a detail the facts don't give you. Say only what the facts say about it: nothing about how popular it is, how it ranks, whether it sells best, or who made or created it, unless the facts say so. Ask nothing at all. Don't mention a passport or a stamp. One or two short lines. Say only what the facts below say about past visits.`

/** A returning guest, with a bound order. Approved verbatim. */
export const GUEST_ARRIVED_ORDER_INSTRUCTIONS_RETURNING = `The guest just scanned the code on their receipt and has not written anything. They may still be in the shop or may already have left, so say nothing that depends on which. Never say "enjoy", "enjoyed" or "enjoying", and say nothing about the start, middle or end of their visit. You have talked before, so don't introduce yourself. Always open with a short hello and say it's good to see them, using their name if you know it; if you don't, leave the name out and don't ask for it. Then compliment what they ordered, named under "Guest just arrived", using what the facts say about it: how it tastes, what it goes with. Never a generic line like "great choice", and never a detail the facts don't give you. Say only what the facts say about it: nothing about how popular it is, how it ranks, whether it sells best, or who made or created it, unless the facts say so. Ask nothing at all. Don't mention a passport or a stamp. One or two short lines. Say only what the facts below say about past visits.`

/**
 * After a complaint, with a bound order. Approved verbatim. Bars the apology,
 * the details and an offer, for GUEST_ARRIVED_INSTRUCTIONS_AFTER_COMPLAINT's
 * reasons.
 */
export const GUEST_ARRIVED_ORDER_INSTRUCTIONS_AFTER_COMPLAINT = `The guest just scanned the code on their receipt and has not written anything. They may still be in the shop or may already have left, so say nothing that depends on which. Never say "enjoy", "enjoyed" or "enjoying", and say nothing about the start, middle or end of their visit. The last time they were in, they told you something was wrong with what they got. Always open with a short hello and say you are glad they came back, using their name if you know it; if you don't, leave the name out and don't ask for it. Then compliment what they ordered today, named under "Guest just arrived", using what the facts say about it. Say only what the facts say about it: nothing about how popular it is, how it ranks, whether it sells best, or who made or created it, unless the facts say so. Do not apologise again, do not repeat what went wrong, do not offer anything, and ask nothing at all. Don't mention a passport or a stamp. One or two short lines. You have talked before, so don't introduce yourself.`

/** A new guest whose receipt code was past its day: the compliment sentence removed. */
export const GUEST_ARRIVED_HELLO_ONLY_INSTRUCTIONS_NEW = `The guest just scanned the code on their receipt and has not written anything. They may still be in the shop or may already have left, so say nothing that depends on which. Never say "enjoy", "enjoyed" or "enjoying", and say nothing about the start, middle or end of their visit. Always open with a short hello, using their name if you know it; if you don't, leave the name out and don't ask for it. Ask nothing at all. Don't mention a passport or a stamp. One or two short lines. Say only what the facts below say about past visits.`

/** A returning guest whose receipt code was past its day: the compliment sentence removed. */
export const GUEST_ARRIVED_HELLO_ONLY_INSTRUCTIONS_RETURNING = `The guest just scanned the code on their receipt and has not written anything. They may still be in the shop or may already have left, so say nothing that depends on which. Never say "enjoy", "enjoyed" or "enjoying", and say nothing about the start, middle or end of their visit. You have talked before, so don't introduce yourself. Always open with a short hello and say it's good to see them, using their name if you know it; if you don't, leave the name out and don't ask for it. Ask nothing at all. Don't mention a passport or a stamp. One or two short lines. Say only what the facts below say about past visits.`

/**
 * After a complaint, receipt code past its day: the compliment clause removed,
 * and "ask nothing at all" kept with the three bars it was listed with.
 */
export const GUEST_ARRIVED_HELLO_ONLY_INSTRUCTIONS_AFTER_COMPLAINT = `The guest just scanned the code on their receipt and has not written anything. They may still be in the shop or may already have left, so say nothing that depends on which. Never say "enjoy", "enjoyed" or "enjoying", and say nothing about the start, middle or end of their visit. The last time they were in, they told you something was wrong with what they got. Always open with a short hello and say you are glad they came back, using their name if you know it; if you don't, leave the name out and don't ask for it. Do not apologise again, do not repeat what went wrong, do not offer anything, and ask nothing at all. Don't mention a passport or a stamp. One or two short lines. You have talked before, so don't introduce yourself.`

/**
 * Pick the variant.
 *
 * TWO AXES. Who the guest is (new, returning, after a complaint) and what the
 * scan says about the order (TAC-588):
 *
 *   an order is bound      the compliment wording, which asks nothing
 *   the code was expired   the hello-only wording, which asks nothing
 *     or already used
 *   neither                today's counter wording, which asks what they got
 *                          (the counter sign, a payment not yet ingested)
 *
 * `afterComplaint` wins over the other two guest axes: it is only ever set for
 * a guest with a check-in on file, who has by definition talked with us before.
 *
 * `null` means the runtime context did not carry a scan-arrival fact on a
 * `guest_arrived` turn, which is a wiring bug rather than a reachable state.
 * It falls back to the NEW-guest counter variant on purpose: an introduction a
 * guest did not need is odd, and telling a stranger "you have talked before"
 * is false. Falling toward the false one would be the worse failure.
 */
export function guestArrivedInstructionsFor(
  scanArrival: {
    hadPriorConversation: boolean
    afterComplaint?: boolean
    order?: unknown
    helloOnly?: boolean
  } | null,
): string {
  const variants =
    scanArrival?.order !== null && scanArrival?.order !== undefined
      ? ORDER_VARIANTS
      : scanArrival?.helloOnly === true
        ? HELLO_ONLY_VARIANTS
        : COUNTER_VARIANTS
  if (scanArrival?.afterComplaint === true) return variants.afterComplaint
  return scanArrival?.hadPriorConversation === true
    ? variants.returning
    : variants.new
}

type GreetingVariants = {
  new: string
  returning: string
  afterComplaint: string
}

const COUNTER_VARIANTS: GreetingVariants = {
  new: GUEST_ARRIVED_INSTRUCTIONS_NEW,
  returning: GUEST_ARRIVED_INSTRUCTIONS_RETURNING,
  afterComplaint: GUEST_ARRIVED_INSTRUCTIONS_AFTER_COMPLAINT,
}

const ORDER_VARIANTS: GreetingVariants = {
  new: GUEST_ARRIVED_ORDER_INSTRUCTIONS_NEW,
  returning: GUEST_ARRIVED_ORDER_INSTRUCTIONS_RETURNING,
  afterComplaint: GUEST_ARRIVED_ORDER_INSTRUCTIONS_AFTER_COMPLAINT,
}

const HELLO_ONLY_VARIANTS: GreetingVariants = {
  new: GUEST_ARRIVED_HELLO_ONLY_INSTRUCTIONS_NEW,
  returning: GUEST_ARRIVED_HELLO_ONLY_INSTRUCTIONS_RETURNING,
  afterComplaint: GUEST_ARRIVED_HELLO_ONLY_INSTRUCTIONS_AFTER_COMPLAINT,
}
