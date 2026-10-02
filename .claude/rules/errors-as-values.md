---
paths:
  - "lib/**/*.ts"
  - "app/api/**/*.ts"
---

# Errors are values; failure direction is a decision

## The shape

Internal functions return `{ok: true, data} | {ok: false, error}`. Throw only at an outer
boundary - a route handler or a script entry point.

Use the domain aliases rather than inlining the union: `RAGResult<T>` (`lib/rag/types.ts`),
`AIResult<T>` (`lib/ai/types.ts`), `RequireAdminResult<T>` (`lib/auth/`). A new helper reuses
one or defines a parallel alias.

No `any`. Use `unknown` and narrow.

**Distinguish failure modes even when the caller flattens them.** `message_not_found |
out_of_allowlist | db_error` collapses to one 404 at the route today and is what lets logging
tell them apart tomorrow.

## Every failure path picks a direction, and the choice is the design

Write down which one and why, at the function. "Fails open" and "fails closed" are not
stylistic.

| pattern | direction | why |
| --- | --- | --- |
| voice pack load (inbound) | **closed** | voice failure breaks the thing we sell; followups proceed with what loaded |
| knowledge retrieval | **open** (degrade to `[]`) | a less specific reply still ships |
| the four post-generation checks | **closed** after one retry | no prior to degrade to |
| coalescing claim table | **open** | a guest silenced by a claim-table hiccup is a worse, newly-introduced failure |
| config/JSONB parse at a **live** boundary | **open** to defaults | a typo must not take down every agent run for that venue |
| the same parse at an **offline** boundary | **closed**, loudly | a seed-time crash is catchable |
| intention-prompt reads | **closed** | a missed nudge is cheap; a re-ask is the failure being prevented |
| venue hours unreadable | **open** (process) | a push nobody needed costs less than a guest arriving unannounced |
| venue status unreadable | **open** (process) | but **mark-seen** on the same column fails closed, because there the only cost is a missing tick |
| inbound-since / opt-out reads before a proactive send | **closed** | |

Two rules that follow:

**A comment claiming a direction is not the direction.** One docstring said "FAILS OPEN"
above a function handling only `{ error }` - a **thrown** read propagated to the orchestrator
and produced a red alert with no reply, the exact outcome the docstring called the worse
failure. Check the direction by reading both a thrown and an errored read.

**supabase-js is inconsistent here.** It returns most failures as `{ error }` and **throws**
on some (unreachable host, malformed client). A module whose contract is "never throws" needs
a `try/catch`, and a type cannot express that claim.

## A three-state result is often the honest one

`unreadable` is not `none`. Collapsing them is how a transient read failure silenced a folded
message permanently: the caller's fail-open default was right for one call site and exactly
backwards for the other.

Same shape elsewhere: a check verdict is `skipped | clean | flagged | degraded`, not a
boolean, because "the check did not complete" must be distinguishable from "it found
nothing"; a venue's opening state is `open | closed | unknown`, because guessing past a
stated closure discards the only fact you had; a null precision means "nobody recorded one",
which is honestly different from either value.

Before widening a two-state return, ask which caller would read the new state wrongly.

## Writes

**A check-then-act needs a storage-layer backstop.** The app check is the enforcement; the partial
unique index catches the TOCTOU window. Handle `23505` as an outcome, not an error.

**A CAS write's `rowcount === 1` is the idempotency anchor.** Gate the side effect on it.
Scope the predicate on `venue_id` and `guest_id`, not on `id` alone - an id that came from a
model can name another guest's row and return what looks like a clean win.

**An idempotency marker must be written before the thing it marks is believed to have
happened**, and a failed marker write must `return`, not fall through to a state change that
removes the row from the scan's own filter.

**Never write a claim you cannot honour.** If you cannot compute a value honestly, write
nothing rather than a plausible default - a vague date resolved to the message's own
timestamp is a fabricated fact with a column behind it.

## Analytics and observability never change control flow

PostHog and Slack emission is wrapped and swallowed. A failure there must not crash the path.

But **a silent degrade needs an event**, or it is invisible by construction. A `console.warn`
and a null return meant a fabrication check that had stopped running left no trace in PostHog,
Slack or Langfuse. Any new call site that swallows its own failure ships with the event, not
after.

Distinguish the causes in the event rather than folding them: "the check was truncated" and
"the check faulted twice" have different fixes, and one event with an `outcome` discriminator
beats two vague ones.
