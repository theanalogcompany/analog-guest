# 0007 - A getting-to-know-you question is its own last message, guaranteed in code

**Date:** 2026-09-29
**Status:** accepted

## Decision

A question raised from the `## What you're hoping to get to` block - name, local, rhythm,
any of the seven - **goes out as its own message, after the answer, whenever it goes out at
all**.

> **Amended by TAC-567 (2026-09-30).** This said "always goes out as its own message". That
> is still true of every question that is SENT, which is what this decision is about, but a
> second gate now decides whether one is sent: on a turn whose reply already asks something,
> `composeReplyWithIntention` drops the question so the guest never gets two in one turn. See
> the amendment note below the next paragraph.

The model emits it in `intentionQuestion`, a required string on
`GeneratedMessageSchema`, separate from the reply. `composeReplyWithIntention` then **joins
the two**, so `GenerateMessageResult.body` is still the complete reply and the field rides
alongside as its exact tail. `resolveDispatchBubbles(body, rng, tail)` peels it off as the
final bubble. `intentionTailFor(question, renderedCount)` is the one gate, and both dispatch
arms call it.

Whether to ask was untouched by THIS decision: it stayed entirely the intentions block's
call.

> **Amended by TAC-567.** No longer true as an absolute. `composeReplyWithIntention` now drops
> the question when the reply already asks one ("never two questions in one turn", ruled
> 2026-09-30), so there are TWO gates in sequence: the intentions block decides whether to
> raise, and the compose seam can still veto it for that turn. The veto writes nothing and
> closes nothing, so the intention comes back open on the next turn. It is reported through
> `intentionQuestionDroppedForBodyQuestion`, and `intentionTailFor` remains the one gate on
> the DISPATCH side, which is what the paragraph above is about.

## Why

Jaipal ruled it after a persona rule saying exactly this failed twice on device on the day it
was applied. **Prompt wording cannot reach bubble structure**, and the two failures show it
from both sides:

- *"nice! what variation did you go with? and by the way, what's your name?"* is three
  sentences, so it rode `SPLIT_PROBABILITY`'s fair coin and lost.
- *"Foncii, nice to meet you 🙂 do you live or work around Polk Street?"* has no `.?!` before
  "do", so `splitIntoSentences` finds ONE sentence. It could not have split at any coin value.

This is the second time the same lesson has been paid for here. TAC-319 already moved the
split decision out of the prompt after two prompt-side rounds failed identically.

### Why compose the two halves back together

The tidy-looking alternative is to keep them apart and send two messages. It is wrong, and
this is the part someone will reach for.

Every post-generation check reads `body`: the dash substitution, self-talk, unverified links,
the grounding verifier, the prose-promise and cancellation checks, the comp regex. A question
kept out of `body` **bypasses all of them** - a fabricated link or a reasoning slip inside the
question would ship unchecked. Keeping `body` whole also means the queue row an operator
approves verbatim is still one complete reply, and `recordIntentionPrompts` still sees the
question, so the intention still closes.

Composing in our own code is also what makes the tail a real suffix. Asking the model to
reproduce a substring of its own reply would make the boundary depend on its copying; joining
two strings makes it true by construction.

### Why it cannot split mid-sentence or emit an empty bubble

The boundary is never found in text - it is the join between two separately generated
strings, so the answer and the question were never one sentence. Five guards cover emptiness:
`''` on a non-asking turn makes the mechanism inert; a tail that trims empty or carries no
letter or digit is dropped (reachable - `replaceDashes` refuses a substitution that would
empty a non-empty string, so a field of only an em dash survives as `"—"`); an empty answer
sends the question alone; `collapseToSingleMessage` trims both sides; and (TAC-567) a reply
that already asks a question drops the tail, which is the one condition that normalizes a
NON-empty field to `''`. The empty-answer branch runs first, so a question-only reply is still
sent as the question rather than as nothing.

## What breaks if reversed

Reverting the field returns to a 50/50 coin on 2-3 sentence replies and no possibility at all
outside that range - which is most replies.

Three narrower reversals each break something specific:

- **Dropping the gate** (`intentionTailFor`) lets a question bubble on a turn where the
  intentions block never rendered - `opt_out`, `comp_complaint`, a pending question.
- **Dropping the tail from `fitBubblesToInstagramCap`** silently undoes the whole thing on
  Instagram, but only when a bubble is over 1000 bytes, because that repack throws the bubble
  structure away and re-packs the whole reply greedily.
- **Restoring the answer's old cap** produces four bubbles, which is what
  `MAX_BUBBLES_PER_RESPONSE` exists to prevent.

## Where it lives

`lib/ai/generate-message.ts` (the schema field, `composeReplyWithIntention`,
`stripTrailingDuplicate`) · `lib/agent/sentence-split.ts` (`intentionTailFor`, the tail
parameter, the narrowed answer cap) · `lib/agent/schedule-and-send.ts` and
`lib/agent/dispatch-instagram-reply.ts` (the two arms, plus the cap fitter) ·
`# Getting-to-know-you questions` in `lib/ai/prompts/system-template.ts`.

**Not** the queue path. An operator-approved card still sends as one message
(`dispatchOperatorOutbound` is single-block), so a queued intention turn does not split.
Known limitation, ruled 2026-09-29: changing it would change what "approve sends exactly what
I read" means.

The duplicate guard is the one place model text is removed. It only ever strips a question the
model repeated at the end of the answer, and it reports itself on
`intentionQuestionDuplicateStripped` because a guard that edits guest-facing text has to be
countable.
