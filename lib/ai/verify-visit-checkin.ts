import { generateObject, NoObjectGeneratedError } from 'ai'
import { z } from 'zod'
import { getClassificationModel } from './client'
import type { AIResult } from './types'

// TAC-578. Its OWN version, not SYSTEM_TEMPLATE's PROMPT_VERSION: this judge
// never touches the classify/generate contract, the independence the four
// verify-* siblings each carry.
//
// v1.2.0 (2026-10-07): WHAT A REPEAT IS, by ruling. v1.0.0 asked whether the
//   draft "makes the same observation as any earlier message" and, on the
//   first pre-registered run, caught 5 of 5 hand-written repeats and passed 0
//   of 5 fresh drafts: a compliment on a NEW item was "a repeat" of an
//   earlier one about a different new item, because both were the guest
//   leaving their usual. With any history nothing could be sent. Ruled that
//   day: "A repeat is the same angle about the same item, or a near-copy of
//   an earlier line. 'You tried something new' about a different item on a
//   different day is fresh."
//
//   So the judge no longer returns one verdict on repeating. It returns the
//   two facts the ruling names (`sameAngleAndItem`, `nearCopy`) and is asked
//   to lay out each earlier message's angle and item before the draft's.
//   `repeatsEarlier` is their OR, computed here. The "when in doubt" tilt now
//   applies to specificity only.
//
//   (A v1.1.0 that restated the definition inside the old single question was
//   tried the same day, moved nothing, and was never shipped.)
//
// v1.3.0 (2026-10-07): one clause, by ruling. v1.2.0 caught 4 of 5 repeats: it
//   let "you never pick the sweet one, the pour over is the grown-up choice"
//   past an earlier "you always go for the one with the least sugar in it",
//   because the earlier line names no item and the draft names one, so "same
//   item" was false. Ruled: "the same observation about the guest's taste or
//   habit counts as a repeat even when no item is named."
export const VERIFY_VISIT_CHECKIN_PROMPT_VERSION = 'v1.3.0'

/**
 * 1200 since v1.2.0, which asks the reasoning to lay out every earlier
 * message's angle before the draft's (up to ten of them). `reasoning` is
 * unbounded and declared first, and five short fields follow it, so the tail sits between verify-closed-venue-arrival's (one
 * boolean, 600) and verify-prose-promise's (1000). Set with headroom: the
 * drafts hardest to judge are the ones this exists for (TAC-309, TAC-367).
 */
export const VERIFY_VISIT_CHECKIN_MAX_OUTPUT_TOKENS = 1200

/** Truncation, reported apart from a call that never landed. */
export const VERIFY_VISIT_CHECKIN_TRUNCATED_ERROR_CODE =
  'ai_verify_visit_checkin_truncated'

/**
 * The angles, as the judge is asked to name them. Kept in step with
 * CHECKIN_ANGLE_KINDS (lib/agent/visit-messages.ts) by the assignment in
 * judgeCheckin (lib/agent/post-visit-timeout.ts), which fails tsc if the two
 * lists differ; declared here as the schema's own enum because lib/ai does
 * not import from lib/agent.
 */
const ANGLE_KINDS = [
  'the_choice',
  'the_usual',
  'a_departure',
  'the_pairing',
  'the_timing',
  'their_taste',
] as const

export type VisitCheckinAngleKind = (typeof ANGLE_KINDS)[number]

export interface VerifyVisitCheckinInput {
  /** The drafted check-in. */
  draft: string
  /** What the guest got on this visit. */
  order: string
  /** One line per earlier visit, newest first: what they got. */
  earlierOrders: readonly string[]
  /** The check-ins already sent to this guest, newest first. */
  earlierCheckins: readonly string[]
}

export interface VerifyVisitCheckinResult {
  angleKind: VisitCheckinAngleKind
  /** The menu item the compliment is about, lowercased; '' when none. */
  angleItem: string
  specificToGuest: boolean
  repeatsEarlier: boolean
  promptVersion: string
}

const SYSTEM_PROMPT = `You read a short message a cafe is ABOUT TO SEND to a returning guest after their visit. It is meant to be a compliment on what they ordered that shows the cafe knows them. You decide whether it is worth sending. A weak message is worse than no message, so when in doubt about whether it is specific, say it is not.

You are given the draft, what the guest ordered this time, what they ordered on earlier visits, and the messages of this kind the cafe has already sent them.

In your reasoning, first write down, for each earlier message, the angle it takes and the menu item it is about (or "no item"). Then write the same two things for the draft. Only then answer.

The angles:
- the_choice: it compliments the thing they picked this time, on its own merits.
- the_usual: it is about them ordering the same thing they usually order.
- a_departure: it is about them trying something different from what they usually order.
- the_pairing: it is about two things they ordered together.
- the_timing: it is about when or how often they come in.
- their_taste: it is about what their orders say about what they like in general.

Decide five things.

1. angleKind: the one angle the draft takes. Pick the closest one. If the draft is not a compliment at all, still pick the closest.

2. angleItem: the one menu item the draft is mostly about, in lowercase, exactly as it appears in the orders you were given. Empty string if it is not about a particular item.

3. specificToGuest: true only when the draft says something that depends on THIS guest's history or THIS order, and that could not be sent unchanged to a different guest who ordered something else. A generic line ("hope you enjoyed it", "great choice") is not specific. A draft that mentions an item the guest did not order, on this visit or earlier, is not specific. A draft that is not a compliment (it asks a question, thanks them for visiting, invites them back for something) is not specific.

4. sameAngleAndItem: true only when some earlier message takes the SAME angle as the draft AND is about the SAME item (or both are about no item). Both must match. The same angle about a different item is false: an earlier message about them trying one new thing does not match a draft about them trying a different new thing. The same item under a different angle is false too. One exception: when the draft and an earlier message make the same observation about the guest's taste or habit (what they like in general, or when and how often they come), that is true even if one names an item and the other names none. If there are no earlier messages, false.

5. nearCopy: true only when the draft is nearly the same sentence as an earlier message, with a few words changed. Sharing a subject or an item is not enough. If there are no earlier messages, false.`

function buildUserPrompt(input: VerifyVisitCheckinInput): string {
  const list = (lines: readonly string[]) =>
    lines.length === 0 ? '(none)' : lines.map((l) => `- ${l}`).join('\n')
  return [
    `Draft, about to be sent: "${input.draft}"`,
    '',
    `What they ordered this time: ${input.order}`,
    '',
    'What they ordered on earlier visits, newest first:',
    list(input.earlierOrders),
    '',
    'Messages of this kind already sent to them, newest first:',
    list(input.earlierCheckins.map((c) => `"${c}"`)),
  ].join('\n')
}

/**
 * TAC-578: is a drafted later-visit check-in specific to this guest and new?
 *
 * Ruled 2026-10-07: "If we can't say something fresh that doesn't repeat what
 * we've sent this guest before, send nothing that day. Skipping is better than
 * a weak or repeated line." The generation is told that; this is the
 * independent reading, in the shape the four verify-* siblings set:
 * generateObject, the classification model, AIResult, its own prompt version,
 * no regeneration loop.
 *
 * IT ALSO NAMES THE ANGLE, which nothing else can. The safety floor (never the
 * same angle twice running) is arithmetic in lib/agent/visit-messages.ts over
 * what this returns, so the floor does not rest on this judge's own
 * `repeatsEarlier`.
 *
 * NOT ONE OF THE FOUR POST-GENERATION CHECKS of decision 0003, and it adds no
 * approval trigger. Those decide whether a human should look at a draft. This
 * decides whether to send anything at all, and its failure direction is
 * simpler: the caller sends nothing on any failure.
 */
export async function verifyVisitCheckin(
  input: VerifyVisitCheckinInput,
): Promise<AIResult<VerifyVisitCheckinResult>> {
  if (typeof input.draft !== 'string' || input.draft.trim().length === 0) {
    return { ok: false, error: 'invalid_input' }
  }

  // `reasoning` FIRST; the order is load-bearing (TAC-301 part 1.5).
  const schema = z.object({
    reasoning: z.string(),
    angleKind: z.enum(ANGLE_KINDS),
    angleItem: z.string(),
    specificToGuest: z.boolean(),
    sameAngleAndItem: z.boolean(),
    nearCopy: z.boolean(),
  })

  try {
    const { object } = await generateObject({
      model: getClassificationModel(),
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(input),
      schema,
      temperature: 0.2,
      maxOutputTokens: VERIFY_VISIT_CHECKIN_MAX_OUTPUT_TOKENS,
    })
    return {
      ok: true,
      data: {
        angleKind: object.angleKind,
        angleItem: object.angleItem.trim().toLowerCase(),
        specificToGuest: object.specificToGuest,
        // The ruling's definition, as arithmetic over the two facts.
        repeatsEarlier: object.sameAngleAndItem || object.nearCopy,
        promptVersion: VERIFY_VISIT_CHECKIN_PROMPT_VERSION,
      },
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (NoObjectGeneratedError.isInstance(e) && e.finishReason === 'length') {
      return {
        ok: false,
        error: message,
        errorCode: VERIFY_VISIT_CHECKIN_TRUNCATED_ERROR_CODE,
      }
    }
    return {
      ok: false,
      error: message,
      errorCode: 'ai_verify_visit_checkin_failed',
    }
  }
}
