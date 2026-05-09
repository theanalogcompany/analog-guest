import { generateObject } from 'ai'
import { z } from 'zod'
import { getClassificationModel } from './client'
import { PROMPT_VERSION } from './prompts/system-template'
import { personaToProse, venueInfoToProse } from './prompts/serializers'
import type { AIResult, ClassifyMessageInput, ClassifyMessageResult } from './types'

const ClassifiedMessageSchema = z.object({
  category: z.enum([
    'reply',
    'new_question',
    'opt_out',
    'manual',
    'acknowledgment',
    'comp_complaint',
    'mechanic_request',
    'recommendation_request',
    'casual_chatter',
    'personal_history_question',
    'perk_inquiry',
    'event_question',
    'unknown',
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

- reply: a conversational reply to something the venue sent, without a specific question, complaint, request, or other intent below
- new_question: the guest is asking the venue a factual question (hours, menu, location, etc.)
- opt_out: the guest is asking to stop receiving messages
- acknowledgment: the guest is acknowledging, signing off, or otherwise closing a thread without a question or request (e.g., "thanks", "ok cool", "got it", "see you tomorrow")
- comp_complaint: the guest is reporting a quality issue or unsatisfactory experience with something they received from the venue (e.g., "muffin was stale", "had a bad experience today", "waited 20 minutes")
- mechanic_request: the guest is asking about, invoking, or requesting a perk, hold, event slot, or other venue mechanic (e.g., "can you hold the couch", "is the tea on the house", "can i get on the open mic list")
- recommendation_request: the guest is asking the venue for a recommendation on what to order, try, or pair (e.g., "what's good here", "what do you pair with the latte", "anything worth trying"). Distinct from new_question, which is factual.
- casual_chatter: the guest is making small talk or an unprompted casual comment without asking a question or invoking a service (e.g., "this neighborhood is wild", "love this couch", "hope you have a good day"). Distinct from reply, which is in conversational response to something the venue sent.
- personal_history_question: the guest is asking about their own past interactions with the venue: what they ordered, when they visited, whether they've been here before, or anything about their own history (e.g., "what did I get last time", "do you remember me", "have I been here before", "what was that thing I tried")
- perk_inquiry: the guest is asking about perks, recognition tiers, what they unlock at higher levels, or whether they qualify for something (e.g., "do I get any free drinks?", "what's my tier?", "do I unlock anything if I keep coming?"). Distinct from mechanic_request, which is invoking or requesting a specific mechanic; perk_inquiry is asking ABOUT the system.
- event_question: the guest is asking about the venue's events, when they are, or what is coming up (e.g., "when's the next open mic?", "what's happening this weekend?", "do you have anything Friday?")
- manual: the guest's message contains content that genuinely needs an operator's eyes before a real reply can be written (sensitive complaints, complex situations, custom requests that can't be answered from documented venue facts)
- unknown: the message does not fit any other category cleanly and the agent does not have confident grounding to respond

When a message could fit multiple categories, prefer the more specific one: a complaint about service is comp_complaint even if phrased as a reply; a question that is opinion-shaped ("what's good") is recommendation_request rather than new_question; an unprompted casual remark is casual_chatter rather than reply. Personal-history questions ("what did I get last time", "do you remember me") route to personal_history_question, NOT to manual or new_question. Use unknown only when the message genuinely doesn't fit any other category and the agent has no clear path to respond. Use manual only when the message contains content that genuinely needs an operator's eyes, not as a fallback for ambiguous classification.

Return your classification with a confidence score (DECIMAL between 0.0 and 1.0, NOT a 1-10 score) and a one-sentence reasoning. Be conservative with confidence. If the message is genuinely ambiguous, score lower so the operator can review it.

  0.0 = no idea, pure guess
  0.5 = ambiguous, multiple plausible categories
  0.7 = clear category, minor uncertainty
  0.9 = high confidence, distinctive signal in the message
  1.0 = certain`

/**
 * Classify an inbound message from a guest into one of the supported
 * categories defined in CLASSIFY_SYSTEM_PROMPT.
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