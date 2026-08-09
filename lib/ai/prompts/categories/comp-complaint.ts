// v1.24.0 — rewritten from prohibition to register.
//
// HISTORY, because this file has now caused two production failures in
// opposite directions and the next editor should know both.
//
// f177885 (2026-05-02) through b5c415f (2026-08-06) said "Do not promise a
// specific remedy ... UNLESS the additional context or eligible mechanics
// support it." The model read that conditional as standing permission and
// auto-sent an unauthorized comp on 2026-08-07 ("Come by and I'll have
// another made for you," on a refund request, no operator in the loop).
//
// b5c415f closed the loophole by making the instruction prohibition-first and
// adding "Acknowledging the problem and asking a real question IS a complete
// response." Forty minutes later the agent replied to a guest complaining
// about a bad matcha with "Sour matcha's usually a sign something was off
// with the prep. Noted." Diagnostic, cold, no acknowledgment that anyone had
// a bad time. The stopping license was obeyed literally.
//
// The diagnosis that produced this rewrite: warmth on complaints was NEVER
// instructed here. Not in any version. What existed was "Do not perform
// sympathy or pile on apologies" (an anti-warmth rule, live for 96 days) plus
// a loophole the model exploited to be generous. The generosity and the bug
// were the same behavior, so closing one removed the other.
//
// So this is authored, not restored. Two things changed structurally:
//   1. The prohibitions are gone. Not narrowed into smaller prohibitions —
//      GONE. Prohibition is what produced the cold turn. The approval gate
//      (CATEGORY_REQUIRES_APPROVAL) is the brake now; the prompt does not
//      need to be one, because on a routed category a human reads this draft
//      before the guest does.
//   2. The instruction's SHAPE mirrors the gate's. understand -> apologize ->
//      make it up maps onto complaintIntent 'clarifying' -> 'resolving',
//      which is what decides auto-send vs queue. The prompt and the routing
//      tell the same story, so the model isn't optimizing against itself.
//
// "once, and mean it" carries the whole anti-stacking intent of the deleted
// sympathy rule. Do not add a separate line forbidding apology-stacking; that
// is how this file drifts back to a list of things not to do.
//
// The comp is an invitation to return, not compensation. "Come back for
// another on us" is the default remedy shape — not a refund, not settling a
// score. That framing is the product thesis, not a stylistic preference.
//
// No em or en dashes: THE-225 prose hygiene is asserted over this string in
// lib/ai/prompts/categories/index.test.ts.
//
// TAC-314 KEEP: "ask one real question and send only that" / "A question is a
// complete turn on its own" read as structural prescriptions and a future
// form-sweep will be tempted to strip them. Do not. They are load-bearing for
// complaintIntent 'clarifying' vs 'resolving', which decides auto-send vs
// queue at the approval gate. Stripping them changes gate behavior, not prose.
// (TAC-314 did remove this file's "Keep it short" tail — that one was a pure
// length directive; the question-shape lines are routing.)

export const COMP_COMPLAINT_INSTRUCTIONS = `The guest is telling you something went wrong.

First, understand what actually happened. If you do not have enough to go on, ask one real question and send only that. A question is a complete turn on its own; you are not expected to solve anything in the same breath as asking.

Once you understand it, say sorry for it, once, and mean it. Then find a way to make it up to them. Most of the time that means asking them to come back and have another one on us. Word it as an invitation rather than a payout: you are not settling a score, you want to see them again.

You are not defending the venue, and you are not explaining what went wrong in the prep. A guest who left unhappy is someone you are trying to win back, and a bad visit put right well is how a regular gets made.

The "What this guest can access" block tells you what is actually yours to offer on this turn. Follow it.

Name the specific thing they raised so they know it landed.`
