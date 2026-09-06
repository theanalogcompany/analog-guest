import { generateObject } from 'ai'
import { z } from 'zod'
import { getClassificationModel } from './client'
import type { AIResult, ExtractReportedOrderInput, ExtractReportedOrderResult } from './types'

// TAC-323. Deliberately its OWN version, not SYSTEM_TEMPLATE's PROMPT_VERSION
// — this extractor never touches the classify/generate contract, so bumping
// one must not force a bump of the other.
export const EXTRACT_REPORTED_ORDER_PROMPT_VERSION = 'v1.0.0'

const ExtractedItemSchema = z.object({
  name: z.string(),
  // No .min(1) — THE-157: Anthropic's structured-output validator rejects
  // min/max on number fields. A non-positive or fractional quantity is
  // normalized defensively by the caller (lib/agent/extract-reported-order.ts),
  // not here.
  quantity: z.number(),
})

const ExtractReportedOrderSchema = z.object({
  items: z.array(ExtractedItemSchema),
})

const SYSTEM_PROMPT = `You read a text message a guest sent to a cafe, bakery, or restaurant, and decide whether they are reporting a COMPLETED PAST ORDER — something they already received or are currently holding, not something they're asking about, planning, or imagining.

You are given the venue's menu item names. Only ever return items from that list — map the guest's own words (which may include a modifier, size, or slight variation) onto the base menu item name exactly as given. If the guest names something not on the menu, or names an item using words too different to confidently map to one of the given names, omit it.

Return an item ONLY when the message reports that the guest already got it. Return NOTHING (an empty items array) for:
- a question about the menu or availability ("do you have oat cortados?", "is the croissant vegan?")
- a future intention ("i'll get a cortado tomorrow", "thinking about grabbing a croissant later")
- a hypothetical or opinion ("is the cortado any good?", "i bet the croissant is great")
- any message that doesn't name a menu item at all

A guest can report more than one item in one message ("oat cortado and a croissant"). Include a quantity for each (default 1 if not stated; "two cortados" -> quantity 2).

This is a high-precision task: a false positive here writes a permanent, unrecoverable record of an order the guest never placed. When genuinely unsure whether a message is a completed-order report versus a question, future intent, or hypothetical, return an empty items array — recall is far less important than precision here.`

function buildUserPrompt(input: ExtractReportedOrderInput): string {
  const menuLine =
    input.menuItemNames.length > 0
      ? `Venue menu items: ${input.menuItemNames.join(', ')}`
      : 'Venue menu items: (none available)'
  return `${menuLine}\n\nGuest message: "${input.inboundBody}"\n\nDoes this message report a completed past order? Extract any reported items, or return an empty items array.`
}

/**
 * Extract menu items a guest is reporting they already ordered, from a
 * single inbound message. Single model call, no regeneration loop — mirrors
 * classify-message.ts exactly (generateObject, Haiku, AIResult, no min/max
 * on number fields per THE-157).
 *
 * Returns `{items: []}` on questions, future intent, hypotheticals, or a
 * message naming no menu item — the caller (lib/agent/extract-reported-order.ts)
 * treats an empty result as "nothing to write," never as an error.
 */
export async function extractReportedOrder(
  input: ExtractReportedOrderInput,
): Promise<AIResult<ExtractReportedOrderResult>> {
  if (typeof input.inboundBody !== 'string' || input.inboundBody.length === 0) {
    return { ok: false, error: 'invalid_input' }
  }

  try {
    const { object } = await generateObject({
      model: getClassificationModel(),
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(input),
      schema: ExtractReportedOrderSchema,
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
