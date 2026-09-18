import { generateObject } from 'ai'
import { z } from 'zod'
import { getClassificationModel } from './client'
import type {
  AIResult,
  ExtractReportedOrderInput,
  ExtractReportedOrderResult,
} from './types'

// TAC-323. Deliberately its OWN version, not SYSTEM_TEMPLATE's PROMPT_VERSION
// — this extractor never touches the classify/generate contract, so bumping
// one must not force a bump of the other.
export const EXTRACT_REPORTED_ORDER_PROMPT_VERSION = 'v1.4.0'

const SYSTEM_PROMPT = `You read a text message a guest sent to a cafe, bakery, or restaurant, and decide whether they are reporting a COMPLETED PAST ORDER — something they already received or are currently holding, not something they're asking about, planning, or imagining.

You are given the venue's menu item names as a closed list — the "name" field can only be one of those exact values, enforced by your output schema, so you cannot invent or reformat a name. Your job is to map the guest's own words (which may include a modifier, size, or slight variation, and often just a fragment of a longer menu name) onto the correct entry in that list. Real menu names are frequently multi-word or slash-separated (e.g. "House Blend / Cortado") — a guest saying "i got an oat cortado" is reporting "House Blend / Cortado" if that's the closest menu match; "oat" is a modifier that doesn't need its own menu entry.

Only return an item when the guest's own words name a specific menu item or an unambiguous synonym/modifier of one ("oat cortado" -> the cortado; "a latte" -> the latte). A generic category word alone ("a pastry", "a drink", "something to eat", or "coffee" when the venue has more than one coffee drink) is NOT a specific item — return nothing for it, even if only one menu item on the list would plausibly fit. WRONG: guest says "a cortado and a pastry", venue has one croissant on the menu, you return Cortado AND Almond Croissant — the guest never named a croissant. RIGHT: guest says "a cortado and a pastry", you return Cortado only, and the pastry is dropped because it was never specifically named. If nothing on the list is a confident, specifically-named match for what the guest said, omit that item entirely rather than picking the closest-sounding or only-plausible option.

Return an item ONLY when the message reports that the guest already got it. Return NOTHING (an empty items array) for:
- a question about the menu or availability ("do you have oat cortados?", "is the croissant vegan?")
- a future intention ("i'll get a cortado tomorrow", "thinking about grabbing a croissant later")
- a hypothetical or opinion ("is the cortado any good?", "i bet the croissant is great")
- any message that doesn't name a menu item at all

A guest can report more than one item in one message ("oat cortado and a croissant"). Include a quantity for each (default 1 if not stated; "two cortados" -> quantity 2).

Separately, report the TIMING of the message — whether the guest is describing the order as happening right now, on one identifiable earlier day, or at some vaguer point in the past.

- "present" — they are there now or just were, and the message is the moment. "just grabbed a cortado", "in line waiting on my latte", "sitting here with a croissant", "picking up my order".
- "specific_past_day" — the message places the order on ONE calendar day you can identify, even if that day is today. This covers a named day ("came in Tuesday", "got a cortado yesterday"), "earlier today" or "this morning", AND a message with NO timing cue at all ("a cortado and a croissant") — absent any signal otherwise, an ordinary report like that describes something from today.
- "vague_past" — the message itself signals a stretch of time too imprecise to pin to one day: "had one of your croissants last week", "stopped by a while back", "a few days ago", "the other day".

When you answer "specific_past_day", also resolve the actual calendar date (see occurredOnDate below) using today's date, which is given to you in the user message. For a named weekday, always resolve to the most recent PAST occurrence of that day — never today, never a future date, even if today happens to be that weekday ("I came in Saturday" said on a Saturday means the Saturday before this one). For "yesterday", use the day before today. For "earlier today", "this morning", or no timing cue at all, use today's date itself. If today's date was not given to you, you have no anchor to resolve a day against — answer "vague_past" instead of guessing.

Report timing (and, when applicable, occurredOnDate) even when you return an empty items array.

Finally, report whether this message continues the SAME visit as anything recent, or describes a separate trip: set continuesRecentVisit to false ONLY when the message itself signals a distinct, separate visit from a recent one — "came back later", "stopped by again", "another trip today". Otherwise, default it to true.

This is a high-precision task: a false positive here writes a permanent, unrecoverable record of an order the guest never placed. When genuinely unsure whether a message is a completed-order report versus a question, future intent, or hypothetical, return an empty items array — recall is far less important than precision here.`

function buildUserPrompt(input: ExtractReportedOrderInput): string {
  const todayLine = input.todayInVenueTimezone
    ? `Today's date, at the venue: ${input.todayInVenueTimezone}.`
    : `Today's date at the venue is not available — do not resolve a relative day to a date; answer "vague_past" for any past-tense reference to a specific day instead.`
  return `Venue menu items: ${input.menuItemNames.join(', ')}\n\n${todayLine}\n\nGuest message: "${input.inboundBody}"\n\nDoes this message report a completed past order? Extract any reported items, or return an empty items array. Report the timing either way.`
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
    // No model call was made, so there is no timing read. 'vague_past' is
    // the conservative filler: the caller writes nothing for it, and with
    // zero items the caller never reaches the precision decision anyway.
    return {
      ok: true,
      data: {
        items: [],
        reportTiming: 'vague_past',
        occurredOnDate: '',
        continuesRecentVisit: true,
        promptVersion: EXTRACT_REPORTED_ORDER_PROMPT_VERSION,
      },
    }
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
    // TAC-377, widened to three states by TAC-325. Required, not optional —
    // a missing timing would have to default to something, and every default
    // is wrong in some common case. Declared AFTER items so the model
    // commits to the extraction before reading the timing off it.
    reportTiming: z.enum(['present', 'specific_past_day', 'vague_past']),
    // TAC-325. A bare `z.string()`, not `.regex()` or `.nullable()` — the
    // empty-string "not applicable" sentinel must stay a valid value for
    // every reportTiming other than 'specific_past_day', and Anthropic's
    // structured-output validator is the one this repo trusts least with an
    // unproven constraint (THE-157's own lesson). The caller validates the
    // shape post-LLM. Declared after reportTiming so the model resolves the
    // date only once it has already committed to needing one.
    occurredOnDate: z.string(),
    // TAC-325. Required boolean — no missing-value case to default away.
    continuesRecentVisit: z.boolean(),
  })

  try {
    const { object } = await generateObject({
      model: getClassificationModel(),
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(input),
      schema,
      // Analytical task — keep determinism high, same as classify-message.ts.
      temperature: 0.2,
      // TAC-377 raised this from 300. 300 was sized for `items` alone, and
      // adding an output field against a static cap is the exact shape of
      // the TAC-309 / TAC-367 truncation bugs — there, an enlarged emission
      // silently blew a cap nobody revisited and the whole object failed to
      // parse. Headroom is cheap; a truncated extraction is a silent loss.
      maxOutputTokens: 600,
    })

    return {
      ok: true,
      data: {
        items: object.items,
        reportTiming: object.reportTiming,
        occurredOnDate: object.occurredOnDate,
        continuesRecentVisit: object.continuesRecentVisit,
        promptVersion: EXTRACT_REPORTED_ORDER_PROMPT_VERSION,
      },
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message, errorCode: 'ai_extract_reported_order_failed' }
  }
}
