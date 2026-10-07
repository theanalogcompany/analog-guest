# lib/ai - model calls, schemas, and the verifier family

Loads only when you work in this directory. Prompt **copy** rules live in
`lib/ai/prompts/CLAUDE.md`; this file is about the calls and their schemas.

## Call shape

`generateObject` from the Vercel AI SDK with a Zod schema. Production model
`claude-sonnet-4-6`. Generation sets no temperature (the provider default applies), 0.2-0.3 for
anything analytical or idempotent.

Every module here returns `AIResult<T>` (`{ok: true, data} | {ok: false, error}`). Throw
only at an outer boundary.

## Two schema rules that are not negotiable

**No `.min()` or `.max()` on a number field in an LLM-output schema.** Anthropic's
structured output rejects them. Use `.refine()` or validate after the call. The same
rejection applies to `.max()` on a `z.array()` (`maxItems` unsupported); `.min()` on an
array is fine. Cap array length with `.slice(0, N)` after the call. **`.int()` counts
too**: Zod 4 renders it as `integer` plus safe-integer `minimum`/`maximum` bounds, which
Anthropic rejects identically (caught live in the v2 judge, 2026-10-04) - use a bare
`z.number()` and round after the call.

**The optional-field budget is 22, against Anthropic's hard cap of 24.** The cap counts
optional parameters across the whole nested tree, so an optional nested object costs one
slot for the object plus one per optional leaf inside it. Exceeding it takes generation
down outright - it has happened. Count exactly when adding a field, so it is a deliberate
decision rather than silent drift. A **required** boolean or string is free.

## Prompt versions are independent by design

**`classifyMessage` carries four independent booleans**: `crisisSafety`,
`correctsPendingReply`, `followUpWorthy`, `praisedExperience`. None is `.optional()`, which
is what makes the compiler name every site synthesizing a `Classification`.

`PROMPT_VERSION` (`prompts/system-template.ts`, currently v1.96.0) covers the
classify/generate contract. Every other module here carries its own, and they are
deliberately not linked:

`VERIFY_PROSE_PROMISE_PROMPT_VERSION` · `VERIFY_MECHANIC_OFFER_PROMPT_VERSION` · `VERIFY_CANCELLATION_CLAIM_PROMPT_VERSION` ·
`VERIFY_CLOSED_VENUE_ARRIVAL_PROMPT_VERSION` · `EXTRACT_REPORTED_ORDER_PROMPT_VERSION` ·
`CLASSIFY_INTENTION_PROMPTS_PROMPT_VERSION`

A change to one of those never touches the classify/generate contract, so bumping
`PROMPT_VERSION` alongside it would be a false signal.

**Bumping `PROMPT_VERSION` is a repo-wide sweep.** See `.claude/rules/prompt-versioning.md` -
it loads automatically when you touch a prompt.

## The verifier family

Four independent second-opinion checks, all the same shape: a cheap `generateObject` call,
its own prompt version, narrow inputs, `AIResult`.

| module | asks |
| --- | --- |
| `verify-prose-promise.ts` | does it promise something with no structured carrier behind it |
| `verify-mechanic-offer.ts` | does it offer an approval-gated mechanic |
| `verify-cancellation-claim.ts` | does it claim a cancellation with no carrier |
| `verify-closed-venue-arrival.ts` | does it confirm a same-moment arrival while shut |

Three properties they share, each load-bearing:

1. **`reasoning` is declared FIRST in the schema.** Structured output generates fields in
   declaration order, so a verdict declared before the analysis is produced before the
   analysis. This was a live defect: reasoning that reversed itself and ended "the claim is
   grounded" while the boolean stayed `true`.
2. **Narrow inputs.** They get the drafted body and the minimum context needed, not the
   whole prompt.
3. **Their callers fail CLOSED.** That policy lives in `lib/agent/stages.ts`, not here.

A per-call `z.enum` built from the caller's actual valid set, never a bare `z.string()`,
wherever the model must return one of a known list. `verify-mechanic-offer`,
`extract-reported-order` and `classify-intention-prompts` all do this.

## Truncation is a distinct failure

`MAX_OUTPUT_TOKENS` is 1500 for generation; each verifier has its own
(prose-promise 1000, the rest 600). An
unbounded `reasoning` field declared early burns budget before the verdict, so a cap that
was fine when written stops being fine when a field moves.

Detect it off the SDK's own error (`NoObjectGeneratedError.isInstance(e) && e.finishReason
=== 'length'`), never by pattern-matching provider message text, and report it as a
distinct `errorCode`. The `*_TRUNCATED_ERROR_CODE` constants are imported **by path** in
`lib/agent/stages.ts`, never through the `lib/ai` barrel.

**When you move an unbounded field earlier in a schema, re-measure the output-token
distribution in the same change.**

## Barrel exclusions

`emoji-cadence.ts` and `self-talk-detector.ts` are deliberately **not** exported from
`index.ts`. They are pure functions. Import them by path.

## Classifier

`classify-message.ts` returns a category plus `crisisSafety` as an **independent boolean** -
a self-harm message classifies as whatever category fits and the flag is separate. Anything
gating on sensitive content must read the flag, not the category. This has already reached
a push notification through a category-only gate.

`MAX_CLASSIFIER_INPUT_CHARS` is 1000 for category work, but crisis detection gets its own
more generous `MAX_CRISIS_CHECK_INPUT_CHARS` (4000) appended as a second block, because a
guest in crisis may write a long message whose actual statement lands past the cutoff.

Confidence routing: above 0.7 keep the pick; 0.3 to 0.7 keep it and fire an event; below
0.3 rewrite the category to `unknown` so the agent ships a holding response.

## Generation loop

`generateMessage` retries within `MAX_ATTEMPTS` (3) on a dash violation, self-talk, or an
unverified link. **Constraints are sticky for the whole call** and worded as standing
instructions, not as reports on the previous attempt - a sticky directive phrased as
feedback becomes false the moment it outlives the attempt it describes.

**No check result mutates the body.** A persistent dash, self-talk or unverified link ships
and fires an observation event; there is no strip and no rewrite to make a check pass. Do
not read the dash loop as precedent for adding one.

Two transformations DO run at the `replaceDashes` seam, and both are normalizations rather
than check outcomes:

- `replaceDashes` substitutes dashes for the punctuation the constraint text asks for
  anyway. It REFUSES a substitution that would empty a non-empty body.
- `composeReplyWithIntention` (TAC-554) joins `body` and `intentionQuestion` into the one
  complete reply, and strips a question the model duplicated at the end of the answer. That
  strip is the only place model text is REMOVED; it only ever removes a trailing duplicate,
  and it reports itself on `intentionQuestionDuplicateStripped` because a guard editing
  guest-facing text has to be countable.

`intentionQuestion` is a bare REQUIRED string, which costs zero against Anthropic's
24-optional cap. `body` remains the complete reply, so every backstop still reads the
question; the field rides along as its exact tail for dispatch to peel off. See
`lib/agent/CLAUDE.md` and `docs/decisions/0007-intention-question-is-its-own-bubble.md`.

The generation schema is `{body, intentionQuestion, ...flags}` and nothing else for prose:
`reasoning` and `voiceFidelity` left in v1.80.0. Output tokens dominate latency (decode is
about 40 tok/s), and the self-scored fidelity never gated anything (110 production scores,
minimum 0.72, floors 0.4 and 0.6). `messages.voice_fidelity` stays as a nullable column that
new writes leave empty. Do not add a self-assessment field back without a gate that has
fired at least once.

Known limit: the loop returns the **last** attempt, not the best one.

---

Root `CLAUDE.md` is the index for the whole repo, `docs/decisions/README.md` holds the
cross-cutting decisions, and `README.md` is the navigable map of both.
