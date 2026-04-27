import { generateObject } from 'ai'
import { z } from 'zod'
import { getGenerationModel } from './client'
import { composePrompt } from './compose-prompt'
import { PROMPT_VERSION } from './prompts/system-template'
import type { AIResult, GenerateMessageInput, GenerateMessageResult } from './types'

const MIN_VOICE_FIDELITY = 0.7
const MAX_ATTEMPTS = 3

const GeneratedMessageSchema = z.object({
  body: z.string().min(1),
  voiceFidelity: z.number().min(0).max(1),
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

  try {
    let lastResult: { body: string; voiceFidelity: number; reasoning: string } | null = null
    let attempts = 0
    const attemptScores: number[] = []

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      attempts++
      const { object } = await generateObject({
        model: getGenerationModel(),
        system: systemPrompt,
        prompt: userPrompt,
        schema: GeneratedMessageSchema,
        maxOutputTokens: 500,
      })
      lastResult = object
      attemptScores.push(object.voiceFidelity)
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
        promptVersion: PROMPT_VERSION,
      },
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message, errorCode: 'ai_generation_failed' }
  }
}