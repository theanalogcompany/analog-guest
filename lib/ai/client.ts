import { anthropic } from '@ai-sdk/anthropic'

// Model identifiers. Re-check on Anthropic model releases.
/**
 * Exported so a trace can LABEL the generation with the model that produced
 * it. Read it rather than reaching for `ASSESSOR_MODEL_ID`, which happens to
 * hold the same string today and would mislabel every generation span the day
 * the assessor moves.
 */
export const GENERATION_MODEL_ID = 'claude-sonnet-4-6'
const CLASSIFICATION_MODEL_ID = 'claude-haiku-4-5-20251001'

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
   * The same stale branch reports `maxOutputTokens: 4096`, so
   * `V2_GENERATE_MAX_OUTPUT_TOKENS` cannot be raised past that on such a model
   * until the provider is upgraded (3.0.129 is the current ai-v6 line).
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
    sendsTemperature: true,
    forcesOutputFormat: false,
  },
  'sonnet-5-5': {
    id: 'claude-sonnet-5-5',
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
    sendsTemperature: false,
    forcesOutputFormat: true,
  },
} satisfies Record<string, V2ModelProfile>

export type V2ModelKey = keyof typeof V2_MODEL_PROFILES

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

/**
 * Takes the profile rather than resolving its own, so a caller that also reads
 * `sendsTemperature` or `forcesOutputFormat` cannot end up sending one model's
 * parameters to another model's id across two separate reads of the switch.
 */
export function anthropicV2Model(profile: V2ModelProfile) {
  ensureApiKey()
  return anthropic(profile.id)
}

export function getV2GenerationModel() {
  return anthropicV2Model(resolveV2ModelProfile())
}

/**
 * The LLM-as-judge model, owner-ruled 2026-10-06 to be a different family
 * from generation. Until this change `judgeResponse` ran on
 * GENERATION_MODEL_ID, so the same model wrote a reply and scored it - the
 * judge has no independence that way, and "arrange for something to disagree"
 * is precisely what an evaluator is for. Kimi is OpenAI-compatible and
 * supports strict json_schema, which the six-axis judge schema requires
 * (verified 2026-10-06 against /v1/chat/completions).
 */
export const JUDGE_MODEL_ID = 'kimi-k3'

/**
 * The post-turn assessor, owner-ruled 2026-10-08 back onto Anthropic.
 *
 * It rode along with the judge onto Kimi in assessor-v1.3.0 on the
 * independence argument, but that argument is the JUDGE's: a judge that scores
 * what its own family wrote has nothing to disagree with. The assessor does
 * not score anything - it reads the exchange and writes records - so it bought
 * no independence and paid Kimi's two costs, a shared account outage and a
 * provider that allows only temperature 1 on a call that wants to be
 * idempotent. The outage is what forced the ruling: the Kimi org is suspended
 * for balance, every assessor call 429s after 5 attempts, and a playground
 * chat silently carries an EMPTY profile and memory from turn to turn as a
 * result.
 *
 * Sonnet rather than Haiku because the assessor DECIDES: state transitions,
 * profile writes and the move tags the regression gate's pursuit bar reads.
 */
export const ASSESSOR_MODEL_ID = GENERATION_MODEL_ID

export function getAssessorModel() {
  ensureApiKey()
  return anthropic(ASSESSOR_MODEL_ID)
}

// TODO: revisit temperature settings after pilot data — may want temp=0.2 for classification, default for generation

// TODO: when we want to support model overrides per venue, accept venueConfig
// and read venue_configs.ai_overrides.generation_model

function ensureApiKey(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Missing env var: ANTHROPIC_API_KEY')
  }
}

export function getGenerationModel() {
  ensureApiKey()
  return anthropic(GENERATION_MODEL_ID)
}

export function getClassificationModel() {
  ensureApiKey()
  return anthropic(CLASSIFICATION_MODEL_ID)
}

// The judge call itself goes through lib/ai/kimi-client.ts (plain fetch, the
// Jev pattern) rather than an AI SDK provider - see that module's header for
// why the SDK route is closed. Credential enforcement is FIRST-CALL there, not
// module-load: CI sets no KIMI_* vars, so a module-init throw would break
// `tsc` and `next build`.
