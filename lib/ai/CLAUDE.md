# lib/ai - model calls, schemas, and the verifier family

Loads only when you work in this directory. Prompt **copy** rules live in
`lib/ai/prompts/CLAUDE.md`; this file is about the calls and their schemas.

## Call shape

`generateObject` from the Vercel AI SDK with a Zod schema. Production model
`claude-sonnet-4-6`. Temperature 0.7 for generation (phrasing variety), 0.2-0.3 for
anything analytical or idempotent.

Every module here returns `AIResult<T>` (`{ok: true, data} | {ok: false, error}`). Throw
only at an outer boundary.

## Two schema rules that are not negotiable

**No `.min()` or `.max()` on a number field in an LLM-output schema.** Anthropic's
structured output rejects them. Use `.refine()` or validate after the call. The same
rejection applies to `.max()` on a `z.array()` (`maxItems` unsupported); `.min()` on an
array is fine. Cap array length with `.slice(0, N)` after the call.

**The optional-field budget is 22, against Anthropic's hard cap of 24.** The cap counts
optional parameters across the whole nested tree, so an optional nested object costs one
slot for the object plus one per optional leaf inside it. Exceeding it takes generation
down outright - it has happened. `schema-budget.test.ts` pins the count exactly, not just
bounded, so a new field is a deliberate decision rather than silent drift. A **required**
boolean or string is free.

## Prompt versions are independent by design

`PROMPT_VERSION` (`prompts/system-template.ts`, currently v1.71.0) covers the
classify/generate contract. Every other module here carries its own, and they are
deliberately not linked:

`VERIFY_GROUNDING_PROMPT_VERSION` · `VERIFY_PROSE_PROMISE_PROMPT_VERSION` ·
`VERIFY_MECHANIC_OFFER_PROMPT_VERSION` · `VERIFY_CANCELLATION_CLAIM_PROMPT_VERSION` ·
`VERIFY_CLOSED_VENUE_ARRIVAL_PROMPT_VERSION` · `EXTRACT_REPORTED_ORDER_PROMPT_VERSION` ·
`CLASSIFY_INTENTION_PROMPTS_PROMPT_VERSION`

A change to one of those never touches the classify/generate contract, so bumping
`PROMPT_VERSION` alongside it would be a false signal.

**Bumping `PROMPT_VERSION` is a repo-wide sweep.** See `.claude/rules/prompt-versioning.md` -
it loads automatically when you touch a prompt or a test.

## The verifier family

Five independent second-opinion checks, all the same shape: a cheap `generateObject` call,
its own prompt version, narrow inputs, `AIResult`.

| module | asks |
| --- | --- |
| `verify-grounding.ts` | does the reply state a fact the source material does not support |
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
   whole prompt - except `verify-grounding`, which gets `generation.userPrompt` **verbatim**
   and must never be handed a curated subset. A maintained subset fell behind four times.
3. **Their callers fail CLOSED.** That policy lives in `lib/agent/stages.ts`, not here.

A per-call `z.enum` built from the caller's actual valid set, never a bare `z.string()`,
wherever the model must return one of a known list. `verify-mechanic-offer`,
`extract-reported-order` and `classify-intention-prompts` all do this.

## Truncation is a distinct failure

`MAX_OUTPUT_TOKENS` is 1500 for generation; each verifier has its own
(`VERIFY_GROUNDING_MAX_OUTPUT_TOKENS` 2000, prose-promise 1000, the rest 600). An
unbounded `reasoning` field declared early burns budget before the verdict, so a cap that
was fine when written stops being fine when a field moves.

Detect it off the SDK's own error (`NoObjectGeneratedError.isInstance(e) && e.finishReason
=== 'length'`), never by pattern-matching provider message text, and report it as a
distinct `errorCode`. The `*_TRUNCATED_ERROR_CODE` constants are imported **by path** in
`lib/agent/stages.ts`, never through the `lib/ai` barrel, because `stages.test.ts` mocks
that barrel and a constant arriving `undefined` makes the fail-closed branch silently
unreachable.

**When you move an unbounded field earlier in a schema, re-measure the output-token
distribution in the same change.**

## Barrel exclusions

`emoji-cadence.ts` and `self-talk-detector.ts` are deliberately **not** exported from
`index.ts`. They are pure functions that tests need for real, and `stages.test.ts` mocks
the barrel. Import them by path.

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

Nothing mutates the body after generation. There is no strip, no rewrite: a persistent
violation ships and fires an observation event. Do not read the dash loop as precedent for
adding a mutation.

Known limit: the loop returns the **last** attempt, not the best one.

---

Root `CLAUDE.md` is the index for the whole repo, `docs/decisions/README.md` holds the
cross-cutting decisions, and `README.md` is the navigable map of both.
