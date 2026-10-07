import { anthropic } from '@ai-sdk/anthropic'

// Model identifiers. Re-check on Anthropic model releases.
const GENERATION_MODEL_ID = 'claude-sonnet-4-6'
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
