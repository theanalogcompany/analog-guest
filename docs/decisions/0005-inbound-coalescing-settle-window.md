# 0005 - A guest's burst settles for 3 s before one run claims it

**Date:** 2026-09-23, revised 2026-09-26
**Status:** accepted; the number is still open to evidence

## Decision

An inbound waits `COALESCE_SETTLE_MS` (**3 s**) before claiming its turn. Exactly one run per
`(venue_id, guest_id)` may produce a reply, enforced by a primary key on
`inbound_turn_claims`. The winner re-checks immediately before dispatch and adopts anything
that arrived while it generated, bounded by `MAX_TURN_EXTENSIONS` (2).

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

Shortening it moves a burst between 3 and 8 seconds from the cheap path (caught by the settle)
to the more expensive one (caught by the extension, one generation spent and discarded). **It
cannot let a second reply out** - that is the claim's job, not the window's.

The trade, costed at the measured 22% burst rate: no settle at all is ~5 s better in
expectation, ~7 s worse per burst, and spends one wasted generation set per burst. So the
window buys worst-case latency and model cost with expected latency.

**The number was moved on an argument, not on a run.** `scripts/measurement/coalesce-window.ts`
is read-only against production and replays candidate windows over real gaps; it is what should
settle this properly.

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
