import { generateObject } from 'ai'
import { z } from 'zod'
import { getClassificationModel } from './client'
import type { AIResult, ExtractReportedOrderInput, ExtractReportedOrderResult } from './types'

// TAC-323. Deliberately its OWN version, not SYSTEM_TEMPLATE's PROMPT_VERSION
// — this extractor never touches the classify/generate contract, so bumping
// one must not force a bump of the other.
export const EXTRACT_REPORTED_ORDER_PROMPT_VERSION = 'v1.2.0'

const SYSTEM_PROMPT = `You read a text message a guest sent to a cafe, bakery, or restaurant, and decide whether they are reporting a COMPLETED PAST ORDER — something they already received or are currently holding, not something they're asking about, planning, or imagining.

You are given the venue's menu item names as a closed list — the "name" field can only be one of those exact values, enforced by your output schema, so you cannot invent or reformat a name. Your job is to map the guest's own words (which may include a modifier, size, or slight variation, and often just a fragment of a longer menu name) onto the correct entry in that list. Real menu names are frequently multi-word or slash-separated (e.g. "House Blend / Cortado") — a guest saying "i got an oat cortado" is reporting "House Blend / Cortado" if that's the closest menu match; "oat" is a modifier that doesn't need its own menu entry. If nothing on the list is a confident match for what the guest said, omit that item entirely rather than picking the closest-sounding option.

Return an item ONLY when the message reports that the guest already got it. Return NOTHING (an empty items array) for:
- a question about the menu or availability ("do you have oat cortados?", "is the croissant vegan?")
- a future intention ("i'll get a cortado tomorrow", "thinking about grabbing a croissant later")
- a hypothetical or opinion ("is the cortado any good?", "i bet the croissant is great")
- any message that doesn't name a menu item at all

A guest can report more than one item in one message ("oat cortado and a croissant"). Include a quantity for each (default 1 if not stated; "two cortados" -> quantity 2).

This is a high-precision task: a false positive here writes a permanent, unrecoverable record of an order the guest never placed. When genuinely unsure whether a message is a completed-order report versus a question, future intent, or hypothetical, return an empty items array — recall is far less important than precision here.`

function buildUserPrompt(input: ExtractReportedOrderInput): string {
  return `Venue menu items: ${input.menuItemNames.join(', ')}\n\nGuest message: "${input.inboundBody}"\n\nDoes this message report a completed past order? Extract any reported items, or return an empty items array.`
}

/**
 * Extract menu items a guest is reporting they already ordered, from a
 * single inbound message. Single model call, no regeneration loop — mirrors
 * classify-message.ts exactly (generateObject, Haiku, AIResult).
 *
 * The output schema's `name` field is a `z.enum` built from
 * `input.menuItemNames` PER CALL, not a bare `z.string()` — this makes a
 * hallucinated or reformatted (extra whitespace, different slash spacing,
 * curly-vs-straight apostrophe) menu name structurally impossible rather
 * than relying on the prompt being obeyed. A code-reviewer finding on the
 * first version of this file (which used `z.string()` + a prompt
 * instruction to "return it exactly") called this out directly: a prompt
 * instruction is not a substitute for a structural constraint, and the
 * venue's menu is already known at request time, so there's no reason not
 * to enforce it. Deduped via `Set` — a venue can have duplicate menu names
 * (TAC-323's own size-variant case), and repeating a value in the enum list
 * is harmless but wasteful.
 *
 * Duplicates the empty-menu short-circuit that `bodyMentionsMenuItem`
 * (lib/agent/extract-reported-order.ts) already applies before ever calling
 * this function — `z.enum` requires a non-empty tuple, and this function
 * guards its own contract independent of caller discipline.
 *
 * Returns `{items: []}` on questions, future intent, hypotheticals, or a
 * message naming no menu item — the caller treats an empty result as
 * "nothing to write," never as an error.
 */
export async function extractReportedOrder(
  input: ExtractReportedOrderInput,
): Promise<AIResult<ExtractReportedOrderResult>> {
  if (typeof input.inboundBody !== 'string' || input.inboundBody.length === 0) {
    return { ok: false, error: 'invalid_input' }
  }
  if (input.menuItemNames.length === 0) {
    return { ok: true, data: { items: [], promptVersion: EXTRACT_REPORTED_ORDER_PROMPT_VERSION } }
  }

  const menuItemNames = [...new Set(input.menuItemNames)] as [string, ...string[]]
  const schema = z.object({
    items: z.array(
      z.object({
        name: z.enum(menuItemNames),
        // No .min(1) — THE-157: Anthropic's structured-output validator
        // rejects min/max on number fields. A non-positive or fractional
        // quantity is normalized defensively by the caller
        // (lib/agent/extract-reported-order.ts), not here.
        quantity: z.number(),
      }),
    ),
  })

  try {
    const { object } = await generateObject({
      model: getClassificationModel(),
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(input),
      schema,
      // Analytical task — keep determinism high, same as classify-message.ts.
      temperature: 0.2,
      maxOutputTokens: 300,
    })

    return {
      ok: true,
      data: {
        items: object.items,
        promptVersion: EXTRACT_REPORTED_ORDER_PROMPT_VERSION,
      },
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message, errorCode: 'ai_extract_reported_order_failed' }
  }
}
