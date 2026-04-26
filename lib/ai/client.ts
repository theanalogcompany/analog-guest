import { anthropic } from '@ai-sdk/anthropic'

// Model identifiers. Re-check on Anthropic model releases.
const GENERATION_MODEL_ID = 'claude-sonnet-4-6'
const CLASSIFICATION_MODEL_ID = 'claude-haiku-4-5-20251001'

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