import { generateObject, NoObjectGeneratedError } from 'ai'
import { z } from 'zod'
import { getClassificationModel } from './client'
import type {
  AIResult,
  VerifyClosedVenueArrivalInput,
  VerifyClosedVenueArrivalResult,
} from './types'

// TAC-363. Its OWN version, not SYSTEM_TEMPLATE's PROMPT_VERSION — this
// verifier never touches the classify/generate contract, the same
// independence rationale VERIFY_GROUNDING_PROMPT_VERSION,
// VERIFY_MECHANIC_OFFER_PROMPT_VERSION and VERIFY_PROSE_PROMISE_PROMPT_VERSION
// each carry.
export const VERIFY_CLOSED_VENUE_ARRIVAL_PROMPT_VERSION = 'v1.0.0'

/**
 * TAC-363. 600, between verify-mechanic-offer's 300 and verify-prose-promise's
 * 1000.
 *
 * `reasoning` is unbounded and declared FIRST (see the schema for why that
 * ordering is load-bearing), but this call emits only one boolean after it —
 * no description, no enum — so the tail sits much closer to the start than
 * verify-prose-promise's. The TAC-309 / TAC-367 hazard still applies in kind:
 * the model reasons longest on the replies hardest to judge, which is exactly
 * the population a backstop exists for, so the cap is set with headroom rather
 * than trimmed to observed output.
 */
export const VERIFY_CLOSED_VENUE_ARRIVAL_MAX_OUTPUT_TOKENS = 600

/**
 * TAC-363: truncation reported as its own code so the caller can tell a verdict
 * it could not READ from a call that never landed.
 *
 * The distinction drives the retry: a transient fault is retried once, a
 * truncation is not — retrying a cap that was already hit spends a second call
 * to hit it again.
 *
 * Imported BY PATH in lib/agent/stages.ts, never via the @/lib/ai barrel:
 * stages.test.ts `vi.mock`s that barrel, and a bare constant arriving
 * `undefined` would make the no-retry branch silently unreachable in every
 * test — the same reasoning VERIFY_GROUNDING_TRUNCATED_ERROR_CODE and
 * VERIFY_PROSE_PROMISE_TRUNCATED_ERROR_CODE carry.
 */
export const VERIFY_CLOSED_VENUE_ARRIVAL_TRUNCATED_ERROR_CODE =
  'ai_verify_closed_venue_arrival_truncated'

const SYSTEM_PROMPT = `You read a reply a venue's AI assistant is ABOUT TO SEND to a guest. The venue is CLOSED right now. Your job is to decide one thing: does this reply tell the guest, or let the guest believe, that they can come to the venue now or in the next little while?

The failure you are catching is a guest walking to a locked door. Judge the reply on its own words, as the guest will read it standing outside.

Flag the reply when it confirms or welcomes an arrival happening now or very soon, whether or not it names a time. "See you soon", "see you in a bit", "come on by", "sounds good, see you shortly", "I'll have it ready for you", "perfect, we're here" all confirm an arrival. A reply that agrees with a guest who just said they are on their way is confirming it even if the reply itself only says "great" or "got it, see you".

Do not flag:
- A reply that says the venue is closed, or names when it opens, and directs the guest to that. "We're closed for the day, back at 7 tomorrow" is the correct reply, not a violation, even when it goes on to say something warm.
- A reply about arriving on a LATER day or at a named future time the guest themselves proposed. "See you at 8 tomorrow" is about tomorrow, not now.
- A reply that declines, defers, or asks a question without agreeing to an arrival. "What time were you thinking?" confirms nothing.
- A reply about anything other than the guest coming to the venue: answering a question, describing the menu, apologising, small talk.

The guest may well have said they are heading over. That is not what you are judging. You are judging only whether the assistant's reply agrees that now works.

Set confirmsArrival=true only when a guest reading this reply would set off for the venue.`

function buildUserPrompt(input: VerifyClosedVenueArrivalInput): string {
  return `Assistant's reply, about to be sent while the venue is closed: "${input.replyBody}"\n\nDoes this reply tell the guest they can come now or very soon?`
}

/**
 * TAC-363: independent post-generation check for a same-moment arrival
 * confirmation sent while the venue is closed.
 *
 * Fourth instance of the shape verify-grounding.ts, verify-mechanic-offer.ts
 * and verify-prose-promise.ts already set: generateObject, Haiku, AIResult,
 * its own prompt version, no regeneration loop, no gating of its own beyond
 * input validation.
 *
 * WHY IT EXISTS ALONGSIDE THE STRUCTURAL TRIGGER. The gate's own condition
 * fires on an `imminent` arrivalCapture emitted while closed, which catches
 * both production incidents. It cannot catch a reply that reads as a
 * confirmation while emitting NO structured field at all — "see you soon" with
 * nothing attached passes every one of the other triggers by construction and
 * auto-sends. That gap is what the 2026-09-15 ruling added a text check for.
 *
 * WHY IT IS NOT TAC-401's CHECK. verify-prose-promise is scoped to value
 * transfer and says so explicitly in its own do-not-flag list ("something the
 * guest has already paid for or already ordered"). "See you soon" transfers
 * nothing and would not flag there. Two questions, two checks.
 *
 * INPUT IS THE REPLY BODY AND NOTHING ELSE. Not the prompt, not the venue's
 * hours, not the guest's inbound. Whether the text confirms an arrival is
 * answerable from the text alone; WHETHER TO ASK is the caller's decision and
 * is made from the hours. Keeping the input to one string is what lets this be
 * measured against fixed bodies and keeps it robust to venue persona rather
 * than tuned to one venue's voice — the lesson TAC-415 paid for.
 *
 * The caller (verifyClosedVenueArrivalStage in lib/agent/stages.ts) decides
 * WHEN to call this, retries it once on a transient fault, and FAILS CLOSED on
 * everything else. This function makes no policy decision.
 */
export async function verifyClosedVenueArrival(
  input: VerifyClosedVenueArrivalInput,
): Promise<AIResult<VerifyClosedVenueArrivalResult>> {
  if (typeof input.replyBody !== 'string' || input.replyBody.trim().length === 0) {
    return { ok: false, error: 'invalid_input' }
  }

  // `reasoning` FIRST, and the order is load-bearing. Structured output
  // generates in declaration order, so a verdict declared before the analysis
  // is a verdict the model has not reasoned about yet. TAC-301 part 1.5 found
  // exactly this on verify-grounding, where the model emitted a flag and then
  // reasoned its way to the opposite conclusion inside the same object.
  const schema = z.object({
    reasoning: z.string(),
    confirmsArrival: z.boolean(),
  })

  try {
    const { object } = await generateObject({
      model: getClassificationModel(),
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(input),
      schema,
      // Analytical task — keep determinism high, same as all three siblings.
      temperature: 0.2,
      maxOutputTokens: VERIFY_CLOSED_VENUE_ARRIVAL_MAX_OUTPUT_TOKENS,
    })

    return {
      ok: true,
      data: {
        confirmsArrival: object.confirmsArrival,
        promptVersion: VERIFY_CLOSED_VENUE_ARRIVAL_PROMPT_VERSION,
      },
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // Truncation separated from every other failure, read off the SDK's own
    // error rather than inferred from provider-formatted message text. Both
    // still return ok:false — this function makes no policy decision — but the
    // caller retries one of these and not the other.
    if (NoObjectGeneratedError.isInstance(e) && e.finishReason === 'length') {
      return {
        ok: false,
        error: message,
        errorCode: VERIFY_CLOSED_VENUE_ARRIVAL_TRUNCATED_ERROR_CODE,
      }
    }
    return { ok: false, error: message, errorCode: 'ai_verify_closed_venue_arrival_failed' }
  }
}
