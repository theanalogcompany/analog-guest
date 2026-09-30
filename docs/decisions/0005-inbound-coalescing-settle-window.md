# 0005 - The settle window is zero; the claim and the extension carry coalescing

**Date:** 2026-09-23, revised 2026-09-26, settle set to zero 2026-09-29
**Status:** accepted; the number is still open to evidence, and now has some

## Decision

An inbound claims its turn immediately: `COALESCE_SETTLE_MS` is **0** (the constant and its
`> 0` guard remain as the rollback lever). Exactly one run per `(venue_id, guest_id)` may
produce a reply, enforced by a primary key on `inbound_turn_claims`. The winner adopts any
already-inserted sibling right after claiming, re-checks immediately before dispatch, and
adopts anything that arrived while it generated, bounded by `MAX_TURN_EXTENSIONS` (2). The
pipeline itself is the fold window: every moment spent on classify/retrieve/generate is time
in which the pre-dispatch check will still adopt a late fragment.

## Why

Both webhooks call `waitUntil(runInboundAgent(id))` **once per inbound row**, so two messages
seconds apart start two runs in two serverless invocations that share no memory. Observed
live: 7 seconds between a guest's two messages, 5 between the two replies, and the guest was
asked their name twice.

**The ticket's premise was half wrong, and the wrong half decides the design.** Both runs
could see the other's *message* - context assembly excludes only the current message. Neither
could see the other's *reply*, because it did not exist yet. So the fix is "only one run may
produce a reply", not "let the reply see both messages" - which is why no prompt file is
touched and `PROMPT_VERSION` is not bumped.

The claim INSERT has **no `ON CONFLICT`**: a race must surface as 23505 so exactly one run
wins. An upsert would hand both runs a success.

### On the number

8 s was the original proposal, against an observed 7 s gap. It was cut to 3 s on a latency
argument: the settle sits in front of **every** turn, bursty or not, and Instagram first-bubble
p50 moved from ~16-18 s to ~23-25 s when it landed.

Shortening it moves a burst from the cheap path (caught by the settle) to the more expensive
one (caught by the extension, one generated-and-verified draft spent and discarded). **It
cannot let a second reply out** - that is the claim's job, not the window's.

The 3 s cut was moved on an argument; the cut to zero was moved on a run.
`scripts/measurement/coalesce-window.ts` (read-only against production, replaying candidate
windows over real gaps) measured 30 days in 2026-09: 251 inbound, **4** bursts a 3 s settle
would have folded, all Instagram, at one venue. The earlier "22% burst rate" figure from the
incident window did not describe steady state. So the settle was paying 3 s on every turn to
save roughly four discarded generation sets a month - and same-delivery Instagram siblings
never needed it at all, because the webhook awaits the whole delivery's inserts before
invoking any run and the winner's post-claim adoption folds them at zero cost.

**If burst behaviour shifts, the lever is the one constant.** Extension-caught bursts are
visible without re-running the harness: losers record `coalesced_into_turn` in
`inbound_turn_outcomes`, and extension re-runs appear in Langfuse. A sustained rate of
roughly one per day is the tripwire to re-run `coalesce-window.ts` and reconsider.

## What breaks if reversed

Removing the claim restores duplicate replies. Removing the **handoff** in
`closeCoalescedTurn` is subtler and worse: before the claim existed, two runs were the bug
*and* the redundancy - if one died the other still replied. With the claim and no handoff, the
loser has already stood down, so a failed winner means the guest gets silence. That handoff is
dead code on the happy path; do not delete it as unreachable.

## Where it lives

`lib/agent/coalesce-turn.ts` (the four constants, the claim, the lease CAS, `pickNewer`) ·
migration 057 · `lib/agent/testing/turn-claims-fake.ts`, which **yields before it checks** so
two concurrent claims really interleave - without that the runtime serialises them by luck and
the concurrency test passes against a claim with no atomicity in it.
