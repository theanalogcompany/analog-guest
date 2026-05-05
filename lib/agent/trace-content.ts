import type { GenerateMessageResult } from '@/lib/ai'
import type { CorpusMatch, KnowledgeMatch, RecognitionSnapshot } from './types'

// Pure helpers that pack agent stage outputs into the structured `content`
// payloads consumed by Langfuse spans (THE-216). Centralized so handle-inbound
// and handle-followup share the same shape and the wrapper-side stripping
// logic (when LANGFUSE_CAPTURE_CONTENT=false) sees a consistent schema.
//
// All helpers are pure and read-only — they MUST NOT throw. The wrapper itself
// swallows errors, but content building runs before the wrapper sees the
// payload, so an exception here would crash the agent run. If a future field
// requires expensive computation, gate the call site on `trace.captureContent`
// to skip the work entirely when the content would be dropped.

export type RecognitionSignalContent = {
  signal: keyof NonNullable<RecognitionSnapshot['weights']>
  normalized: number
  weight: number
  contribution: number
}

export type RecognitionContent = {
  signals: RecognitionSignalContent[]
  multipliers: RecognitionSnapshot['signals']['appliedMultipliers']
}

const SIGNAL_KEYS = [
  'recency',
  'visitFrequency',
  'engagementEvents',
  'moneySpent',
  'responseRate',
  'percentMenuExplored',
  'referrals',
] as const

/**
 * Pack recognition snapshot into a structured per-signal breakdown for the
 * `context_build` span content. weights and contributions are optional on the
 * snapshot (so the test-scenarios script doesn't have to populate them) — we
 * fall back to zeros when missing rather than crashing. The fallback is a
 * trace-only placeholder; nothing else in the agent path consumes it.
 */
export function buildRecognitionContent(snapshot: RecognitionSnapshot): RecognitionContent {
  const weights = snapshot.weights
  const contributions = snapshot.contributions
  return {
    signals: SIGNAL_KEYS.map((signal) => ({
      signal,
      normalized: snapshot.signals[signal],
      weight: weights ? weights[signal] : 0,
      contribution: contributions ? contributions[signal] : 0,
    })),
    multipliers: snapshot.signals.appliedMultipliers,
  }
}

export type CorpusContent = {
  chunks: Array<{
    id: string
    voiceCorpusId: string
    text: string
    sourceType: string
    confidence: number
    similarity: number
  }>
}

/**
 * Pack the full retrieved chunks (text + metadata) for the `retrieve` span
 * content. Operators looking at a trace need to see what voice corpus the
 * agent actually pulled, not just counts. THE-201 (admin renderer) will
 * project this back into a readable list view.
 */
export function buildCorpusContent(corpus: CorpusMatch[]): CorpusContent {
  return {
    chunks: corpus.map((c) => ({
      id: c.id,
      voiceCorpusId: c.voiceCorpusId,
      text: c.text,
      sourceType: c.sourceType,
      confidence: c.confidence,
      similarity: c.similarity,
    })),
  }
}

export type KnowledgeCorpusContent = {
  chunks: Array<{
    id: string
    knowledgeCorpusId: string
    text: string
    sourceType: string
    confidence: number
    similarity: number
    tags: string[]
  }>
}

/**
 * Pack retrieved knowledge_corpus chunks for the conditional
 * `retrieve_knowledge` span. Same content-gated capture pattern as
 * buildCorpusContent — only built when trace.captureContent is true so the
 * heavy text payload is dropped at the call site when capture is off.
 */
export function buildKnowledgeCorpusContent(
  knowledge: KnowledgeMatch[],
): KnowledgeCorpusContent {
  return {
    chunks: knowledge.map((c) => ({
      id: c.id,
      knowledgeCorpusId: c.knowledgeCorpusId,
      text: c.text,
      sourceType: c.sourceType,
      confidence: c.confidence,
      similarity: c.similarity,
      tags: c.tags,
    })),
  }
}

export type GenerateParentContent = {
  systemPrompt: string
  userPrompt: string
  model: string
}

const GENERATION_MODEL_LABEL = 'claude-sonnet-4-6'

/**
 * Pack the prompts sent to the model on the `generate` parent span content.
 * Same prompt is sent on every attempt today (the regen loop varies only via
 * model randomness), so capturing once on the parent suffices.
 *
 * Model label is hardcoded to match `getGenerationModel()` in lib/ai/client.ts.
 * If we add a runtime-selected model, surface it from generateMessage's
 * result and pass through here.
 */
export function buildGenerateContent(result: GenerateMessageResult): GenerateParentContent {
  return {
    systemPrompt: result.systemPrompt,
    userPrompt: result.userPrompt,
    model: GENERATION_MODEL_LABEL,
  }
}

export type GenerateAttemptContent = {
  body: string
  voiceFidelity: number
  reasoning: string
  // Present only when the regen loop appended explicit feedback to the parent
  // user prompt for this attempt (THE-225 dash-rewrite directive). Operators
  // reviewing a regen run see exactly what Sonnet was asked to fix.
  userPromptOverride?: string
}

/**
 * Pack a single attempt's output for a `generate.attempt_N` span. Sourced
 * from GenerateMessageResult.attemptHistory, indexed in attempt order.
 */
export function buildGenerateAttemptContent(
  attempt: GenerateMessageResult['attemptHistory'][number],
): GenerateAttemptContent {
  return {
    body: attempt.body,
    voiceFidelity: attempt.voiceFidelity,
    reasoning: attempt.reasoning,
    ...(attempt.userPromptOverride !== undefined
      ? { userPromptOverride: attempt.userPromptOverride }
      : {}),
  }
}
