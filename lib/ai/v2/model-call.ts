// What a v2 generation call may be MADE WITH: the model profiles, the effort
// levels, and the token and temperature constants - and nothing that touches a
// provider SDK.
//
// SPLIT OUT OF lib/ai/client.ts FOR THE BROWSER. The playground's inspector
// offers a per-turn model and effort picker, so it needs the profile table and
// the levels each model accepts; importing them from `client.ts` would pull
// `@ai-sdk/anthropic` into the client bundle for three string arrays. Keep this
// module free of imports that are not pure data - `client.ts` owns the one
// function that constructs a provider model.
//
// The same split is why the Zod boundaries (the playground run route,
// lib/schemas/playground.ts) import the ceiling from here: a schema module
// should not drag a model SDK in behind it.

/**
 * Anthropic's thinking-effort levels, in the provider's own order.
 *
 * MEASURED 2026-10-12, and the honest summary is that the LEVEL sets a ceiling
 * while the PROMPT decides how much of it gets used:
 *
 * | model | level | thinking tokens |
 * | --- | --- | --- |
 * | claude-haiku-5-5 | max | 1,276 / 5,091 / 2,971 across three turns |
 * | claude-haiku-5-5 | high | 0 on a one-line probe, 213 on a full v2 turn |
 * | claude-haiku-5-5 | xhigh, medium, low | 0 on a one-line probe |
 * | claude-sonnet-4-6 | every level | no breakdown reported at all |
 *
 * AN EARLIER VERSION OF THIS COMMENT SAID "ONLY max ACTUALLY THINKS", and it
 * was wrong - it generalised from one short probe where `high` happened to
 * spend nothing. The same level on a real 23k-char turn spent 213. Do not read
 * a single zero as a property of the level.
 *
 * Two things follow for anyone reading a number off this. A `high` turn's
 * thinking is charged against `maxOutputTokens` like any other output, so the
 * production budget has to hold both; 213 of 1,000 is what was observed, and
 * `max` blows straight through it. And claude-sonnet-4-6 reporting no
 * breakdown is not a claim that it did not think - it is the provider not
 * saying.
 */
export const V2_EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
export type V2Effort = (typeof V2_EFFORT_LEVELS)[number]

/**
 * The effort every v2 generation sends unless a caller says otherwise
 * (owner-ruled 2026-10-12, "default to high thinking").
 *
 * IT DOES SOMETHING, measured on the real prompt: a Le Mil's turn at `high`
 * on claude-haiku-5-5 spent 213 thinking tokens against the 1,000-token output
 * budget, where the same turn at `'none'` spent 0. On claude-sonnet-4-6 - the
 * default profile - the provider reports no breakdown either way, so there the
 * change is in the request and not visibly in the model.
 *
 * THE BUDGET IS THE THING TO WATCH. Thinking is charged against
 * `V2_GENERATE_MAX_OUTPUT_TOKENS`, so this default quietly spends part of the
 * reply's budget on every turn. 213 of 1,000 is the one number measured; a
 * turn that thinks harder and then truncates surfaces as
 * `NoObjectGeneratedError` with `finishReason: 'length'`, which is what `max`
 * at 1,000 does every time. If truncation starts appearing in v2, raise the
 * budget or lower this - do not read it as the model failing.
 *
 * EVERY MEASURED LESSON IN `lib/ai/v2/template.ts` PREDATES IT and was taken
 * with no effort sent at all - same caveat the model switch carries. That is
 * reproducible: `effort: 'none'` on a turn override sends nothing.
 *
 * All three profiles accept `high`, so this never hits the per-profile
 * refusal. If one ever does not, `generateV2Reply` DEGRADES the default to no
 * effort rather than refusing - an explicit effort a model rejects is a failed
 * experiment and must be reported, but a default that fails would take v2
 * generation down everywhere.
 */
export const V2_DEFAULT_EFFORT: V2Effort = 'high'

/**
 * A per-call effort, where `'none'` means SEND NOTHING - which is not the same
 * as leaving it unset, because unset now means `V2_DEFAULT_EFFORT`.
 *
 * Three states, each load-bearing: undefined reproduces production, `'none'`
 * reproduces every measurement taken before the default existed, and a level
 * is the experiment.
 */
export type V2EffortRequest = V2Effort | 'none'

export const V2_EFFORT_REQUESTS = [...V2_EFFORT_LEVELS, 'none'] as const

/**
 * The effort a call will actually SEND, or null for none.
 *
 * ONE DEFINITION, because two readers need the same answer and they are in
 * different modules: `generateV2Reply` makes the call, and `runTurn` records
 * what was asked for on a trace that must still be right when generation
 * FAILS - so it cannot wait for the generator to tell it. Two copies of
 * `?? V2_DEFAULT_EFFORT` plus a profile check is exactly how a trace comes to
 * name an effort the call did not carry.
 *
 * Refusing an explicit-but-rejected level is the CALLER's job, not this
 * function's: it has to answer for a trace too, and a trace needs a value.
 */
export function resolveV2Effort(
  profile: V2ModelProfile,
  requested: V2EffortRequest | undefined,
): V2Effort | null {
  const effort = requested ?? V2_DEFAULT_EFFORT
  if (effort === 'none') return null
  return profile.allowedEfforts.includes(effort) ? effort : null
}

/**
 * v2 generation is a SWITCH, not a constant (owner-ruled 2026-10-12: "v2
 * only", then "leave it as a switch for now"). `V2_GENERATION_MODEL` selects
 * a profile; unset means 4.6, which is the behaviour every measured lesson in
 * `lib/ai/v2/template.ts` was measured on.
 *
 * WHY A PROFILE AND NOT A MODEL ID. The two models disagree on how the call
 * must be MADE, so a bare string switch would send 5.5 parameters it rejects
 * and generation would fail outright, 3/3 (measured 2026-10-12). Both fields
 * below are that measurement, not preference.
 *
 * WHY v2 IS SPLIT from `GENERATION_MODEL_ID` at all: that constant has five
 * other readers and one of them is v1's live `generateMessage` at the pilot
 * venue - `describeAttachment`, `lib/voices/find-pattern-cluster.ts`,
 * `lib/voices/classify-critique.ts` and `ASSESSOR_MODEL_ID` are the rest.
 * Switching the shared constant would move the model under production v1 as a
 * side effect of a v2 experiment.
 *
 * RESOLVE IT, NEVER HARDCODE IT, WHEREVER A V2 CALL IS LABELLED. This is
 * exactly the trap the `ASSESSOR_MODEL_ID` note above describes, now with a
 * value that changes per environment: `run-turn.ts` labels the `v2.generate`
 * Langfuse observation, and Langfuse PRICES a generation from its model id, so
 * a hardcoded label there bills and reports every v2 turn as the wrong model
 * while the other one runs.
 *
 * 5.5 IS NOT SHIPPABLE ON THE CURRENT PROMPT, and the switch exists to keep
 * trying it rather than to turn it on. Measured 2026-10-12, the same 10
 * regression scenarios at n=6: 4.6 passed 9/10 with 0 ceiling breaches, 5.5
 * passed 6/10 with 4 - `call-you` three times and `two-questions` once.
 * Those are register drift and question stacking, which are the two failure
 * modes `V2_GENERATE_TEMPERATURE` was ruled in to suppress on 2026-10-05, and
 * 5.5 rejects `temperature` outright. Removing the knob brought back what the
 * knob was for. Shipping 5.5 needs prompt copy doing that work instead.
 */
export interface V2ModelProfile {
  id: string
  /**
   * Which effort levels this model accepts. Per-model because they DISAGREE:
   * claude-sonnet-4-6 refuses `xhigh` outright ("This model does not support
   * effort level 'xhigh'. Supported levels: high, low, max, medium.") while
   * both 5.5 models take all five. A UI offering a level the model rejects
   * turns an experiment into a failed generation.
   */
  allowedEfforts: readonly V2Effort[]
  /**
   * False for a model that REJECTS the parameter. 5.5 answers
   * "`temperature` is deprecated for this model" and the call fails.
   */
  sendsTemperature: boolean
  /**
   * True for a model @ai-sdk/anthropic does not know yet. Its
   * `getModelCapabilities` table tests `claude-sonnet-4-6`, `claude-sonnet-4-5`
   * and a `claude-sonnet-4-` prefix, so 5.5 lands on the unknown-model default
   * with `supportsStructuredOutput: false`; the provider then synthesises a
   * forced tool call and 5.5 rejects `tool_choice` of type "tool" or "any".
   * Forcing `outputFormat` goes straight to Anthropic's native structured
   * output and bypasses the stale table. `'auto'` consults the same table, so
   * it is not a substitute.
   *
   * THE 4096 IN THAT BRANCH DOES NOT BIND, which an earlier version of this
   * comment got wrong. It is the default for a call that omits
   * `maxOutputTokens`, and the clamp that would enforce it
   * (@ai-sdk/anthropic index.js:3239) is gated on `isKnownModel` - false for
   * exactly these models. Verified: 20,000 passes through with no warning and
   * no truncation. Upgrading the provider (3.0.129 is the current ai-v6 line)
   * would make the table correct AND start clamping, so re-check this then.
   */
  forcesOutputFormat: boolean
}

export const V2_DEFAULT_MODEL_KEY = 'sonnet-4-6'

/**
 * `satisfies` rather than a bare record, so the keys are a closed set the
 * compiler checks - a `readonly string[]` would not be exhaustiveness-checked.
 */
export const V2_MODEL_PROFILES = {
  'sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    // No `xhigh`: this model names it as unsupported and lists the rest.
    allowedEfforts: ['low', 'medium', 'high', 'max'],
    sendsTemperature: true,
    forcesOutputFormat: false,
  },
  'sonnet-5-5': {
    id: 'claude-sonnet-5-5',
    allowedEfforts: V2_EFFORT_LEVELS,
    sendsTemperature: false,
    forcesOutputFormat: true,
  },
  // Haiku 5.5 is the reason these two flags are SEPARATE rather than one
  // "is a 5.x model" boolean. Probed 2026-10-12 over all four combinations:
  // it rejects `temperature` exactly as Sonnet 5.5 does, but it ACCEPTS the
  // forced tool call Sonnet 5.5 refuses, so it generates fine either way.
  // `forcesOutputFormat` is still true by choice, not by necessity - native
  // structured output is schema-enforced, where the synthetic json tool is the
  // SDK's legacy fallback, and keeping every non-default profile on one path
  // means a difference between them is about the model and not the plumbing.
  'haiku-5-5': {
    id: 'claude-haiku-5-5',
    allowedEfforts: V2_EFFORT_LEVELS,
    sendsTemperature: false,
    forcesOutputFormat: true,
  },
} satisfies Record<string, V2ModelProfile>

export type V2ModelKey = keyof typeof V2_MODEL_PROFILES

/**
 * Every profile key, DERIVED so there is no second list to drift from the
 * first. A new profile is offered by the playground's model picker and
 * accepted by its route's Zod enum the moment it is added above - a
 * hand-maintained tuple is how a model ends up selectable but rejected at the
 * boundary, or the reverse.
 *
 * The cast is the one thing `Object.keys` cannot express: the object is a
 * non-empty literal, so the array is non-empty, which is what `z.enum` needs.
 */
export const V2_MODEL_KEYS = Object.keys(V2_MODEL_PROFILES) as [
  V2ModelKey,
  ...V2ModelKey[],
]

/**
 * The key whose profile carries this model id, or null.
 *
 * For a UI that has a TRACE (which records the id that ran) and needs to
 * preselect a picker (which is keyed). Returns null rather than falling back
 * to the default, because a trace naming a model no profile claims is a real
 * state - a profile removed after that turn ran - and preselecting some other
 * model would misreport which one wrote the reply.
 */
export function v2ModelKeyOf(id: string): V2ModelKey | null {
  return V2_MODEL_KEYS.find((key) => V2_MODEL_PROFILES[key].id === id) ?? null
}

function isV2ModelKey(value: string): value is V2ModelKey {
  return value in V2_MODEL_PROFILES
}

/**
 * FAILS OPEN to the default on an unrecognised value, loudly.
 *
 * Direction is a decision (`.claude/rules/errors-as-values.md`): a typo in an
 * environment variable must not take every v2 turn down, and v2 is heading for
 * a production caller. The cost of failing open is a silent wrong model, so the
 * resolved id is what labels the trace and what the harnesses print - that is
 * the thing which disagrees if the switch did not take, rather than a comment
 * claiming it did.
 */
export function resolveV2ModelProfile(): V2ModelProfile {
  const raw = process.env.V2_GENERATION_MODEL?.trim()
  if (raw === undefined || raw === '')
    return V2_MODEL_PROFILES[V2_DEFAULT_MODEL_KEY]
  if (!isV2ModelKey(raw)) {
    console.warn(
      `V2_GENERATION_MODEL="${raw}" is not a known profile (${Object.keys(V2_MODEL_PROFILES).join(', ')}); falling back to ${V2_DEFAULT_MODEL_KEY}`,
    )
    return V2_MODEL_PROFILES[V2_DEFAULT_MODEL_KEY]
  }
  return V2_MODEL_PROFILES[raw]
}

export const V2_GENERATE_MAX_OUTPUT_TOKENS = 1_000

/**
 * The playground's ceiling on a per-turn `maxOutputTokens` override, 20x
 * production's default (owner-ruled 2026-10-12, "extend it to 20k for now").
 *
 * A CEILING AND NOT A NEW DEFAULT. Production still sends 1,000, which is what
 * every measured lesson in `lib/ai/v2/template.ts` was measured under; raising
 * the default would change latency and cost on every live turn as a side
 * effect of making an experiment possible.
 *
 * It exists because `effort: 'max'` STARVES at 1,000: thinking is charged
 * against the same budget, so a max-effort turn spent all 1,000 tokens
 * thinking, returned no reply at all, and surfaced as
 * `NoObjectGeneratedError` with `finishReason: 'length'` (measured
 * 2026-10-12). A model picker with an effort control and no token headroom
 * would present that as the model failing.
 *
 * Bounded at all because the field reaches a provider from a browser: an
 * unbounded number is a request anyone with the admin cookie can make
 * expensive. 20,000 does pass through unclamped on the 5.x profiles - see
 * `forcesOutputFormat` in client.ts for why the SDK's 4096 does not bind.
 */
export const V2_PLAYGROUND_MAX_OUTPUT_TOKENS = 20_000

/**
 * NOT SENT ANY MORE, and kept as the record of what was lost.
 *
 * Lowest (owner call, 2026-10-05). Unset, the provider default (1.0) applied
 * and regression runs showed the tail of that distribution: register drift
 * and question stacking. 0 picks the head of the distribution every time;
 * per-guest variety comes from the situation brief differing, not sampling.
 *
 * claude-sonnet-5-5 REJECTS the parameter - "`temperature` is deprecated for
 * this model", 3/3 generations failed with it attached - so the v2 call below
 * no longer passes a temperature at all. There is no setting that restores
 * the 2026-10-05 ruling on this model; the knob is gone, not retuned.
 *
 * READ THIS BEFORE TRUSTING AN n=3 RUN. `.claude/rules/v2-template-regression.md`
 * fixes the default at n=3 on the stated grounds that "generation is at
 * temperature 0, so a single-turn reply barely moves", and that premise is
 * now false. Determinism is measured rather than assumed - see the
 * model-boundary note in template.ts for the number.
 */
export const V2_GENERATE_TEMPERATURE = 0
