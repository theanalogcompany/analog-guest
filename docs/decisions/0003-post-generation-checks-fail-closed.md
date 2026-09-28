# 0003 - All five post-generation checks fail closed

**Date:** 2026-09-21
**Status:** accepted

## Decision

Every post-generation check holds the draft when it cannot produce a verdict: one immediate
retry on a transient fault, then queue. Truncation is **never** retried.

The five: `verify_grounding`, `verify_mechanic_offer`, `verify_prose_promise`,
`verify_cancellation_claim`, `verify_closed_venue_arrival`.

**Treat a proposal to loosen any one of them as a change to all five.**

## Why

They used to differ. Grounding failed **open** on a transient fault, on the reasoning that it
runs on every inbound and queuing every provider hiccup would flood the queue, and that it
degrades to a defensible prior - the model's own `knowledgeGap` self-report.

Both halves stopped being true:

- **The prior is worthless.** Measured over 220 replies, the model's own
  `requiresOperatorApproval` fired **0 times** and caught **0 of the 4** genuine uncarried
  promises. The comp regex fired 5 times and caught **0 of them**. What actually held those
  promises was the grounding and mechanic-offer checks, firing for unrelated reasons.
- **The flood argument was already void.** The prose-promise check runs concurrently on nearly
  every generation and already failed closed, so during an outage the reply was held anyway.
  Failing open bought no availability and left the one path where an invented fact reaches a
  guest unchecked.

**The retry is what makes the closed posture affordable.** It narrows the flood case from a
single Haiku blip to a fault surviving two immediate attempts, which is an outage rather than a
hiccup - and at that point queue volume is what makes it legible as an outage while it is
happening.

Truncation is excluded from the retry because retrying a cap that was already hit spends a
second call to hit it again. The fix is the cap.

## What breaks if reversed

A check that fails open is indistinguishable, in the row it leaves behind, from a check that
ran and found nothing. `messages.ungrounded_claims` exists precisely to tell those apart, and
for a period a transient fault recorded as `[]` - byte-identical to a genuine pass. Rows from
before that was fixed cannot be trusted to mean "checked and clean".

A caveat that is still true: one path has no queue slot to carry the record, so a degraded
grounding check there leaves no row-level trace at all, only the PostHog event and the
fallback's alert.

## Where it lives

`lib/agent/stages.ts` - the five `verify*Stage` functions and `checkDidNotComplete`.
`lib/ai/verify-*.ts` - the calls. The `*_TRUNCATED_ERROR_CODE` constants are imported **by
path** in `stages.ts`, never through the `lib/ai` barrel, because `stages.test.ts` mocks that
barrel and a constant arriving `undefined` makes the fail-closed branch silently unreachable.

`checkDidNotComplete` is a **separate expression** from `isGapTurn`. A new check must be added
to both, or a guest already holding a card gets silence.
