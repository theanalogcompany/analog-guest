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
