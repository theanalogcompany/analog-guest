import { generateObject } from 'ai'
import { z } from 'zod'
import { getClassificationModel } from './client'
import { PROMPT_VERSION } from './prompts/system-template'
import { formatTimeDelta, personaToProse, venueInfoToProse } from './prompts/serializers'
import type { AIResult, ClassifyMessageInput, ClassifyMessageResult, RecentMessage } from './types'

// Cap inbound length sent to the classifier. Generation still gets the full body.
// Exported so the tunables manifest (TAC-183) can surface the cap to operators.
export const MAX_CLASSIFIER_INPUT_CHARS = 1000

// TAC-348: the crisisSafety determination must not be silently defeated by the
// cap above. That cap exists for cost/latency on an analytical task where the
// category rarely depends on anything past the first ~1000 chars — but a
// guest genuinely in crisis may write a long, escalating message where the
// actual self-harm or emergency statement lands past that cutoff, and a
// truncated view would give the classifier no chance to see it. When the body
// exceeds MAX_CLASSIFIER_INPUT_CHARS, a second, more generous cap is applied
// and the fuller text is appended as its OWN block, explicitly scoped to the
// crisisSafety check only — category classification still works primarily off
// the truncated view, unchanged from before. Bounded (not unbounded) so a
// pathological input can't inflate classifier cost/latency unpredictably;
// 4x the classification cap is well beyond any plausible real guest message.
export const MAX_CRISIS_CHECK_INPUT_CHARS = 4000

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
  // TAC-348: independent of category — set true alongside whatever category
  // fits best. Never `.optional()`, matching the repo's explicit-presence
  // convention for structured-output fields (THE-157 / TAC-212 precedent).
  crisisSafety: z.boolean(),
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

The categories welcome, follow_up, perk_unlock, and event_invite are venue-initiated outbound triggers and are intentionally absent from this list. Never select them when classifying an inbound. If a guest's first contact looks like an opening pleasantry, route to casual_chatter or new_question depending on what they're saying. If a guest's message looks like a response to an event invite or perk offer, route to reply (or event_question / perk_inquiry if they're asking ABOUT an event or perk).

Separately from category, set crisisSafety to true when the message expresses either of these, regardless of what category you picked:
  - Self-harm or suicidal ideation: the guest indicates they may hurt themselves, wants to die, doesn't see the point of continuing, or similar. ("I don't really see the point of anything anymore", "I want to end it", "I don't want to be here anymore" used in a self-harm sense.)
  - An immediate medical emergency or physical danger: a severe allergic reaction, difficulty breathing, chest pain, choking, an injury in progress, or a similar statement that someone needs help right now.
Set crisisSafety to false for everything else, including hyperbole and idiom that merely uses this language ("this coffee is to die for", "dying to try this place", "I'm dying laughing", "this latte is a matter of life and death"). When genuinely ambiguous between hyperbole and a real signal, prefer true — a false positive here costs one unnecessary safety message; a false negative costs missing a guest who needs help.

Return your classification with a confidence score (DECIMAL between 0.0 and 1.0, NOT a 1-10 score) and a one-sentence reasoning. Be conservative with confidence. If the message is genuinely ambiguous, score lower so the operator can review it.

  0.0 = no idea, pure guess
  0.5 = ambiguous, multiple plausible categories
  0.7 = clear category, minor uncertainty
  0.9 = high confidence, distinctive signal in the message
  1.0 = certain`

// Reuses formatTimeDelta from generation so phrasing stays consistent. Header
// is plain (not `##`-prefixed) since the classifier user prompt isn't markdown.
function formatClassifierRecentConversation(messages: readonly RecentMessage[]): string {
  const now = new Date()
  const lines = messages.map((m) => {
    const speaker = m.direction === 'inbound' ? 'guest' : 'venue'
    const delta = formatTimeDelta(m.createdAt, now)
    return `[${speaker}, ${delta}] ${m.body}`
  })
  return `Recent conversation (most recent at the bottom):\n${lines.join('\n')}`
}

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

  const inboundForClassifier =
    input.inboundBody.length > MAX_CLASSIFIER_INPUT_CHARS
      ? input.inboundBody.slice(0, MAX_CLASSIFIER_INPUT_CHARS) + ' [...truncated]'
      : input.inboundBody

  const contextSections: string[] = []
  if (input.persona) contextSections.push(personaToProse(input.persona))
  if (input.venueInfo) contextSections.push(venueInfoToProse(input.venueInfo))

  const userPromptParts: string[] = []
  if (contextSections.length > 0) {
    userPromptParts.push(`Context about the venue:\n\n${contextSections.join('\n\n')}`)
  }
  if (input.recentMessages && input.recentMessages.length > 0) {
    userPromptParts.push(formatClassifierRecentConversation(input.recentMessages))
  }
  if (input.guestState) {
    userPromptParts.push(`Guest relationship: ${input.guestState}`)
  }
  userPromptParts.push(`Inbound message from guest:\n"${inboundForClassifier}"`)
  // TAC-348: see MAX_CRISIS_CHECK_INPUT_CHARS above. Only appended when the
  // body was actually truncated for the block above, so a normal-length
  // message (the common case) sees no prompt change at all.
  if (input.inboundBody.length > MAX_CLASSIFIER_INPUT_CHARS) {
    const crisisCheckBody =
      input.inboundBody.length > MAX_CRISIS_CHECK_INPUT_CHARS
        ? input.inboundBody.slice(0, MAX_CRISIS_CHECK_INPUT_CHARS) + ' [...truncated]'
        : input.inboundBody
    userPromptParts.push(
      `Full message, untruncated (for the crisisSafety determination ONLY — the shortened version above is what informs category):\n"${crisisCheckBody}"`,
    )
  }
  userPromptParts.push('Classify this message.')
  const userPrompt = userPromptParts.join('\n\n')

  try {
    const { object } = await generateObject({
      model: getClassificationModel(),
      system: CLASSIFY_SYSTEM_PROMPT,
      prompt: userPrompt,
      schema: ClassifiedMessageSchema,
      // Analytical task — keep determinism high. Default of 1.0 lets the same
      // message flip categories run-to-run.
      temperature: 0.2,
      maxOutputTokens: 200,
    })

    return {
      ok: true,
      data: {
        category: object.category,
        classifierConfidence: object.classifierConfidence,
        reasoning: object.reasoning,
        promptVersion: PROMPT_VERSION,
        crisisSafety: object.crisisSafety,
      },
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message, errorCode: 'ai_classification_failed' }
  }
}