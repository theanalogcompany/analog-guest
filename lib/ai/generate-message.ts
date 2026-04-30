import { generateObject, NoObjectGeneratedError } from 'ai'
import { z } from 'zod'
import { getGenerationModel } from './client'
import { composePrompt } from './compose-prompt'
import { PROMPT_VERSION } from './prompts/system-template'
import type {
  AIResult,
  GenerateMessageAttempt,
  GenerateMessageInput,
  GenerateMessageResult,
} from './types'

const MIN_VOICE_FIDELITY = 0.7
const MAX_ATTEMPTS = 3

// THE-160: pin the voiceFidelity scale unambiguously in the prompt. The Zod
// schema uses .refine() (per THE-157) so .min/.max don't get serialized into
// JSON Schema; without this instruction Sonnet defaults to a 1–10 confidence
// scale and returns e.g. 9 instead of 0.9, which then fails the [0,1] refine
// check and rejects the entire structured-output response.
const VOICE_FIDELITY_INSTRUCTION = `# Voice fidelity self-assessment (output field)
voiceFidelity: a DECIMAL number between 0.0 and 1.0 (NOT a 1-10 score).
  0.0 = does not match the venue's voice at all
  0.5 = generic but acceptable, lacks distinctive voice markers
  0.7 = good match, voice is recognizable
  0.9 = excellent match, captures distinctive phrases and tone
  1.0 = indistinguishable from how the operator would write`

const GeneratedMessageSchema = z.object({
  body: z.string().min(1),
  // .refine() instead of .min(0).max(1) — Anthropic's structured-output
  // validator rejects `minimum`/`maximum` constraints on JSON Schema number
  // types. Refine runs as a post-parse predicate and isn't serialized into
  // the schema sent to the model. See THE-157.
  voiceFidelity: z
    .number()
    .refine((n) => n >= 0 && n <= 1, { message: 'must be between 0 and 1' }),
  reasoning: z.string(),
})

/**
 * Generate an outbound message in the venue's voice with a self-assessed
 * voice-fidelity score.
 *
 * Calls the model up to MAX_ATTEMPTS (3) times, returning the first attempt
 * that scores >= MIN_VOICE_FIDELITY (0.7). If no attempt clears the threshold,
 * returns the final attempt regardless. Callers should still consult
 * voiceFidelity on the result, since the loop may terminate without crossing
 * threshold and the caller may want to flag the message for operator review.
 *
 * Pure transformer. No DB writes. The caller is responsible for persisting
 * the message.
 */
export async function generateMessage(
  input: GenerateMessageInput,
): Promise<AIResult<GenerateMessageResult>> {
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof input.persona !== 'object' ||
    input.persona === null ||
    typeof input.venueInfo !== 'object' ||
    input.venueInfo === null ||
    !Array.isArray(input.ragChunks) ||
    typeof input.runtime !== 'object' ||
    input.runtime === null
  ) {
    return { ok: false, error: 'invalid_input' }
  }

  const { systemPrompt, userPrompt } = composePrompt(input)
  const augmentedSystemPrompt = `${systemPrompt}\n\n${VOICE_FIDELITY_INSTRUCTION}`

  // Hoisted out of the try so the catch's diagnostic log can include which
  // attempt was in-flight when generateObject threw.
  let attempts = 0

  try {
    let lastResult: { body: string; voiceFidelity: number; reasoning: string } | null = null
    const attemptScores: number[] = []
    const attemptHistory: GenerateMessageAttempt[] = []

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      attempts++
      const { object } = await generateObject({
        model: getGenerationModel(),
        system: augmentedSystemPrompt,
        prompt: userPrompt,
        schema: GeneratedMessageSchema,
        maxOutputTokens: 500,
      })
      lastResult = object
      attemptScores.push(object.voiceFidelity)
      attemptHistory.push({
        body: object.body,
        voiceFidelity: object.voiceFidelity,
        reasoning: object.reasoning,
      })
      if (object.voiceFidelity >= MIN_VOICE_FIDELITY) break
    }

    if (lastResult === null) {
      return { ok: false, error: 'no_result_returned', errorCode: 'ai_generation_failed' }
    }

    return {
      ok: true,
      data: {
        body: lastResult.body,
        voiceFidelity: lastResult.voiceFidelity,
        reasoning: lastResult.reasoning,
        attempts,
        attemptScores,
        attemptHistory,
        // System prompt sent to the model is the augmented one — what THE-160's
        // voice-fidelity instruction tacks on is part of what the model saw,
        // so the trace should match.
        systemPrompt: augmentedSystemPrompt,
        userPrompt,
        promptVersion: PROMPT_VERSION,
      },
    }
  } catch (e) {
    // Diagnostic logging for THE-159 (will be replaced by structured alerts).
    // When generateObject can't parse Sonnet's response into the schema, the
    // top-level error message ("No object generated: response did not match
    // schema") drops everything useful — raw text, cause, Zod issue paths.
    // Walk the error to surface them so the next failure is debuggable from
    // Vercel logs alone. Logs ARE in addition to the existing alert: we still
    // return the failure result below, which the orchestrator turns into an
    // AgentResult.failed and fires fireRedAlert.
    if (NoObjectGeneratedError.isInstance(e)) {
      const cause = e.cause
      const causeName = cause instanceof Error ? cause.name : null
      const causeMessage = cause instanceof Error ? cause.message : null
      const innerCause =
        cause instanceof Error ? (cause as Error & { cause?: unknown }).cause : undefined
      const issues =
        innerCause && typeof innerCause === 'object' && innerCause !== null && 'issues' in innerCause
          ? (innerCause as { issues: unknown }).issues
          : undefined
      console.log('[agent] generation diagnostic', {
        attempts,
        text: e.text ? e.text.slice(0, 1000) : null,
        finishReason: e.finishReason,
        usage: e.usage,
        message: e.message,
        causeName,
        causeMessage,
        zodIssues: issues ?? null,
      })
    }
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message, errorCode: 'ai_generation_failed' }
  }
}