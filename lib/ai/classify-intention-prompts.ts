import { generateObject } from 'ai'
import { z } from 'zod'
import { getClassificationModel } from './client'
import type { AIResult, ClassifyIntentionPromptsInput, ClassifyIntentionPromptsResult } from './types'

// TAC-324. Deliberately its OWN version, not SYSTEM_TEMPLATE's PROMPT_VERSION
// — this classifier never touches the classify/generate contract, mirroring
// EXTRACT_REPORTED_ORDER_PROMPT_VERSION's precedent (lib/ai/extract-reported-order.ts).
export const CLASSIFY_INTENTION_PROMPTS_PROMPT_VERSION = 'v1.0.0'

function buildSystemPrompt(openIntentions: readonly { key: string; description: string }[]): string {
  const lines = openIntentions.map((o) => `- ${o.key}: ${o.description}`)
  return `You read a text message a cafe, bakery, or restaurant sent to a guest, and decide which of a small set of conversational goals that message actually raised.

The goals under consideration for this message:
${lines.join('\n')}

Return a goal ONLY when the message's own words actually do that thing — not when it's merely plausible the guest might reply in a way that satisfies it. A goal that isn't raised in this specific message should be omitted. Return an empty array if the message raises none of them.

This is a precision task: a false positive here permanently caps how many times we can ever ask about that goal for this guest. When genuinely unsure whether the message raises a given goal, leave it out.`
}

function buildUserPrompt(input: ClassifyIntentionPromptsInput): string {
  return `Message sent to the guest: "${input.sentBody}"\n\nWhich of the listed goals does this message raise?`
}

/**
 * Post-send classification of which first-touch intentions a sent message
 * raised. Single model call, no regeneration loop — mirrors
 * extractReportedOrder.ts exactly (generateObject, Haiku, AIResult).
 *
 * `raisedKeys` is constrained via a `z.enum` built from `input.openIntentions`'
 * keys PER CALL, not a bare `z.string()` — same structural-constraint
 * reasoning TAC-323's code review forced onto extract-reported-order.ts: the
 * valid set is already known at request time, so a hallucinated or malformed
 * key is made structurally impossible rather than merely discouraged by the
 * prompt.
 *
 * Returns `{raisedKeys: []}` when openIntentions is empty (nothing to ask
 * about) or on a message that raises nothing — the caller treats an empty
 * result as "nothing to write," never as an error.
 */
export async function classifyIntentionPrompts(
  input: ClassifyIntentionPromptsInput,
): Promise<AIResult<ClassifyIntentionPromptsResult>> {
  if (typeof input.sentBody !== 'string' || input.sentBody.length === 0) {
    return { ok: false, error: 'invalid_input' }
  }
  if (input.openIntentions.length === 0) {
    return {
      ok: true,
      data: { raisedKeys: [], promptVersion: CLASSIFY_INTENTION_PROMPTS_PROMPT_VERSION },
    }
  }

  // Dedup by key (a caller shouldn't send duplicates, but z.enum requires a
  // set of distinct values and repeating one is otherwise harmless-but-wasteful).
  const dedupedByKey = [...new Map(input.openIntentions.map((o) => [o.key, o])).values()]
  const openIntentionKeys = dedupedByKey.map((o) => o.key) as [string, ...string[]]
  const schema = z.object({
    raisedKeys: z.array(z.enum(openIntentionKeys)),
  })

  try {
    const { object } = await generateObject({
      model: getClassificationModel(),
      system: buildSystemPrompt(dedupedByKey),
      prompt: buildUserPrompt(input),
      schema,
      // Analytical task — keep determinism high, same as classify-message.ts.
      temperature: 0.2,
      maxOutputTokens: 200,
    })

    return {
      ok: true,
      data: {
        raisedKeys: object.raisedKeys,
        promptVersion: CLASSIFY_INTENTION_PROMPTS_PROMPT_VERSION,
      },
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message, errorCode: 'ai_classify_intention_prompts_failed' }
  }
}
