import { generateObject } from 'ai'
import { z } from 'zod'
import { getClassificationModel } from './client'
import { PROMPT_VERSION } from './prompts/system-template'
import { personaToProse, venueInfoToProse } from './prompts/serializers'
import type { AIResult, ClassifyMessageInput, ClassifyMessageResult } from './types'

const ClassifiedMessageSchema = z.object({
  category: z.enum([
    'welcome',
    'follow_up',
    'reply',
    'new_question',
    'opt_out',
    'perk_unlock',
    'event_invite',
    'manual',
    'acknowledgment',
  ]),
  // .refine() instead of .min(0).max(1) — Anthropic's structured-output
  // validator rejects `minimum`/`maximum` constraints on JSON Schema number
  // types. Refine runs as a post-parse predicate and isn't serialized into
  // the schema sent to the model. See THE-157.
  classifierConfidence: z
    .number()
    .refine((n) => n >= 0 && n <= 1, { message: 'must be between 0 and 1' }),
  reasoning: z.string(),
})

const CLASSIFY_SYSTEM_PROMPT = `You classify inbound text messages from guests of a hospitality venue (cafe, bakery, restaurant) into one of these categories:

- welcome: an opening pleasantry where the guest is reaching out for the first time
- follow_up: the guest is following up on a previous interaction
- reply: a conversational reply to something the venue sent
- new_question: the guest is asking the venue a factual question (hours, menu, location, etc.)
- opt_out: the guest is asking to stop receiving messages
- perk_unlock: the guest is responding to a perk or recognition offering
- event_invite: the guest is responding to or asking about an event
- manual: best for cases that do not fit any other category cleanly, or that need an operator's attention

Return your classification with a confidence score between 0 and 1 and a one-sentence reasoning. Be conservative with confidence — if the message is genuinely ambiguous, score lower so the operator can review it.`

/**
 * Classify an inbound message from a guest into one of the eight categories.
 *
 * Single model call — no regeneration loop. Returns the classifier's
 * confidence score so callers can route low-confidence messages to operator
 * review. Optional persona/venueInfo provide context but the classifier does
 * not consume the RAG corpus.
 */
export async function classifyMessage(
  input: ClassifyMessageInput,
): Promise<AIResult<ClassifyMessageResult>> {
  if (typeof input.inboundBody !== 'string' || input.inboundBody.length === 0) {
    return { ok: false, error: 'invalid_input' }
  }

  const contextSections: string[] = []
  if (input.persona) contextSections.push(personaToProse(input.persona))
  if (input.venueInfo) contextSections.push(venueInfoToProse(input.venueInfo))

  const userPromptParts: string[] = []
  if (contextSections.length > 0) {
    userPromptParts.push(`Context about the venue:\n\n${contextSections.join('\n\n')}`)
  }
  userPromptParts.push(`Inbound message from guest:\n"${input.inboundBody}"`)
  userPromptParts.push('Classify this message.')
  const userPrompt = userPromptParts.join('\n\n')

  try {
    const { object } = await generateObject({
      model: getClassificationModel(),
      system: CLASSIFY_SYSTEM_PROMPT,
      prompt: userPrompt,
      schema: ClassifiedMessageSchema,
      maxOutputTokens: 200,
    })

    return {
      ok: true,
      data: {
        category: object.category,
        classifierConfidence: object.classifierConfidence,
        reasoning: object.reasoning,
        promptVersion: PROMPT_VERSION,
      },
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message, errorCode: 'ai_classification_failed' }
  }
}