# 0003 - The five post-generation checks: fail closed pre-send, run post-send on inbound

**Date:** 2026-09-21, rewritten 2026-09-29 (owner ruling)
**Status:** accepted

## Decision

The five checks: `verify_grounding`, `verify_mechanic_offer`, `verify_prose_promise`,
`verify_cancellation_claim`, `verify_closed_venue_arrival`.

**On the inbound path they run AFTER dispatch**, off the guest's critical path, in
`lib/agent/post-send-checks.ts` inside the webhook's `waitUntil` window.
A finding is a Slack forward for an upstream fix (`disposition: 'sent'` threads through every
capture so the alert says the reply already went out), never a hold and never a recall.
A queued, dropped or silenced turn runs no checks at all - the queued draft is already in
front of an operator, and the others sent nothing.

**On the operator-initiated paths they keep the 2026-09-21 posture unchanged**: followups and
the holding message run them pre-send, hold the draft when a check cannot produce a verdict,
one immediate retry on a transient fault, truncation never retried.
No guest is waiting on those turns, so the latency the checks cost there buys real
prevention.

**Every deterministic protection stays pre-send on every path**: fidelity floors, the model's
own self-flag, the comp regex, commitment-type gating, the pure cancellation resolution
(triggers 13/16 still hold a draft whose emission cancels or dangles), the structural
closed-venue emission, unverified URLs, pending-slot rules, per-category policy,
`hold_all_outbound`.
Only the five second-opinion LLM calls defer.

**Treat a proposal to change the posture of any one of them as a change to all five.**
That rule survives the rewrite; this rewrite itself changed all five together.

## Why the 2026-09-29 rewrite

The verifier batch was the measured ~2-3s p50 of every auto-send inbound reply - the largest
serial cost after generation itself, and the tail was unbounded (retries).
With classification moved to Jev (~150ms) and the settle window at zero, the batch became the
dominant non-generation latency.

The owner ruled: the active channels cannot recall a sent message anyway, so on a live
conversation the check's only actionable output is "fix the prompt/corpus upstream" - which a
Slack forward delivers just as well after the send as a hold delivers it before.
The venue-protecting holds that must remain holds (comps, commitments, cancellations, policy)
are all carried by the deterministic triggers, which never left the gate.

## Why the 2026-09-21 half (pre-send paths fail closed) still stands

They used to differ. Grounding failed **open** on a transient fault, on the reasoning that it
runs on every inbound and queuing every provider hiccup would flood the queue, and that it
degrades to a defensible prior - the model's own `knowledgeGap` self-report.

Both halves stopped being true:

- **The prior is worthless.** Measured over 220 replies, the model's own
  `requiresOperatorApproval` fired **0 times** and caught **0 of the 4** genuine uncarried
  promises. The comp regex fired 5 times and caught **0 of them**.
- **The flood argument was already void.** The prose-promise check ran concurrently on nearly
  every generation and already failed closed, so during an outage the reply was held anyway.

**The retry is what makes the closed posture affordable** on the paths that keep it: it
narrows the flood case from a single Haiku blip to a fault surviving two immediate attempts.
Truncation is excluded from the retry because retrying a cap that was already hit spends a
second call to hit it again. The fix is the cap.

## What breaks if reversed

Reverting inbound to pre-send checks restores ~2-3s p50 to every reply; that is a latency
decision, not a correctness one, and it is one line of orchestration plus this file.

The subtler invariant to protect in either direction: a check that fails open is
indistinguishable, in the row it leaves behind, from a check that ran and found nothing.
`messages.ungrounded_claims` exists precisely to tell those apart.
Post-send, the analogous claim is the event's `disposition` field - an alert that says "held"
about a reply a guest already read is the same defect in a different medium, which is why the
field is required on every check event rather than defaulted.

## Where it lives

`lib/agent/post-send-checks.ts` - the inbound post-send batch (never throws, fails open by
construction; it can lose an alert, never a reply).
`lib/agent/handle-inbound.ts` - passes the documented neutral values to the gate and hands
the batch to `waitUntil` on the sent path only.
`lib/agent/stages.ts` - the five `verify*Stage` functions (now taking
`disposition: 'held' | 'sent' = 'held'`) and `checkDidNotComplete`.
`lib/analytics/posthog.ts` - `CheckDisposition` and the disposition-aware headlines.
`lib/ai/verify-*.ts` - the calls. The `*_TRUNCATED_ERROR_CODE` constants are imported **by
path** in `stages.ts`, never through the `lib/ai` barrel, because `stages.test.ts` mocks that
barrel and a constant arriving `undefined` makes the fail-closed branch silently unreachable.

`checkDidNotComplete` is a **separate expression** from `isGapTurn`. A new check must be added
to both, or a guest already holding a card gets silence. Both now matter only on the pre-send
paths.
