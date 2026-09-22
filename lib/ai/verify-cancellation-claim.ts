import { generateObject, NoObjectGeneratedError } from 'ai'
import { z } from 'zod'
import { getClassificationModel } from './client'
import type {
  AIResult,
  VerifyCancellationClaimInput,
  VerifyCancellationClaimResult,
} from './types'

// TAC-513. Its OWN version, not SYSTEM_TEMPLATE's PROMPT_VERSION and not
// VERIFY_PROSE_PROMISE_PROMPT_VERSION — this verifier never touches the
// classify/generate contract, same independence rationale as every sibling.
export const VERIFY_CANCELLATION_CLAIM_PROMPT_VERSION = 'v1.0.0'

/**
 * TAC-513. 600, between verify-mechanic-offer's 300 and verify-prose-promise's
 * 1000.
 *
 * `reasoning` is unbounded and declared FIRST (see the schema for why that
 * ordering is load-bearing), which is the TAC-309 / TAC-367 hazard: the model
 * reasons longest on the replies hardest to judge, so a tight cap truncates
 * preferentially on the population the check exists for. But this object has
 * ONE boolean after the reasoning where prose-promise has three fields
 * including a description, so its tail sits closer to the start.
 *
 * Not a measured number. It is headroom against a judged output shape, and the
 * fail-closed handling below is what actually covers a truncation.
 */
export const VERIFY_CANCELLATION_CLAIM_MAX_OUTPUT_TOKENS = 600

/**
 * TAC-513: truncation reported as its own code so the caller can tell a verdict
 * it could not READ from a call that never landed.
 *
 * Drives the retry, exactly as TAC-401 ruled for its sibling: a transient fault
 * is retried once, a truncation is not, because retrying a cap that was already
 * hit spends a second call to hit it again.
 *
 * Imported BY PATH in lib/agent/stages.ts, never via the @/lib/ai barrel:
 * stages.test.ts `vi.mock`s that barrel, and a bare constant arriving
 * `undefined` would make the no-retry branch silently unreachable in every
 * test. Same reasoning VERIFY_GROUNDING_TRUNCATED_ERROR_CODE and
 * VERIFY_PROSE_PROMISE_TRUNCATED_ERROR_CODE both carry.
 */
export const VERIFY_CANCELLATION_CLAIM_TRUNCATED_ERROR_CODE =
  'ai_verify_cancellation_claim_truncated'

const SYSTEM_PROMPT = `You read a reply a venue's AI assistant is ABOUT TO SEND to a guest. Your job is to decide one thing: does this reply tell the guest that something the venue already promised them is no longer happening?

Judge the reply on its own words. You are not deciding whether the venue was right to withdraw it, whether the guest will mind, or whether the promise existed in the first place. Only whether this reply says it is off.

Set claimsCancellation=true when the reply tells the guest that a previously promised thing is cancelled, called off, withdrawn, dropped, scrapped, no longer standing, no longer needed, or words to that effect. The wording does not matter and the reply does not have to use the word "cancel". "Scratch the comp on the tonic", "forget the replacement then", "we'll take that one off", "no need for the free one after all", "that one's off the table now" are all yes. So is a reply that agrees to a guest's own request to drop something: "sure, we'll leave it then".

Do not flag:
- A reply that makes a NEW promise, or declines to make one. Refusing to give something is not withdrawing something already given. "I can't do a refund over text" is not a cancellation.
- A reply that says something is unavailable, sold out, or off the menu today. That is about stock, not about a promise to this guest.
- A reply that changes the DETAIL of a promise while keeping it: a different pickup time, a different size, a different day. Swapping one promised item for another counts as a cancellation ONLY if the reply says the first one is off.
- A reply that merely mentions or confirms an existing promise, including reassuring the guest it still stands. "The cortado comp still stands" is the opposite of a cancellation.
- A reply about the venue's own operations: an event being cancelled, a closure, a delivery not arriving. Those are not promises of something to this guest.
- Hypothetical or conditional language that withdraws nothing now. "If you'd rather skip it, just say" is an offer, not a cancellation.

Set claimsCancellation to true only when a venue owner reading the reply would agree the guest has just been told they are no longer getting something the venue had promised them.`

function buildUserPrompt(input: VerifyCancellationClaimInput): string {
  return `Assistant's reply, about to be sent: "${input.replyBody}"\n\nDoes this reply tell the guest that something the venue already promised is no longer happening?`
}

/**
 * TAC-513: independent post-generation check for a cancellation CLAIMED in
 * prose with no structured carrier behind it.
 *
 * Fourth instance of the shape verify-grounding.ts, verify-mechanic-offer.ts
 * and verify-prose-promise.ts already set: generateObject, Haiku, AIResult, its
 * own prompt version, no regeneration loop, no gating of its own beyond input
 * validation.
 *
 * WHY THIS IS NOT A SECOND QUESTION ON verify-prose-promise.ts, which reads the
 * same string and is the obvious place to put it. Four reasons, and the first
 * is mechanical rather than a matter of taste:
 *
 *   1. THE SKIP CONDITIONS DIFFER, so one call cannot serve both.
 *      verifyProsePromiseStage skips on isCommitmentTypeGated, a draft carrying
 *      an obligation. This one skips on a RESOLVED cancellation carrier, a
 *      different state, and it must RUN on a carried-obligation draft: a reply
 *      can offer one thing and falsely claim to cancel another. Folding them
 *      means running one question in a state where its answer is unwanted, in
 *      both directions.
 *   2. THE VERDICTS COMPOSE OPPOSITELY, and this is the safety argument.
 *      TAC-401's check PRODUCES a carrier: it names a type and description that
 *      land on messages.pending_commitment and become a real guest_commitments
 *      row on approval. This check must never produce one. Minting an
 *      obligation from a second reading of prose is protective, because the
 *      venue ends up owing what it said it owed. Minting a CANCELLATION from a
 *      second reading is destructive: it takes away something a guest was
 *      promised, on a model's guess about which one. So this returns a boolean
 *      and nothing actionable, and a carrier only ever comes from the model's
 *      own id emission resolved against the guest's live list.
 *   3. It would reset TAC-401's measured baseline. That check has a catch rate
 *      measured over 220 replies at its v1.0.0 with a replay harness. A second
 *      question in the same prompt makes the two rates inseparable afterwards,
 *      so a regression in promise-catching would be indistinguishable from one
 *      in cancellation-catching.
 *   4. Schema growth against a cap whose own docstring names the truncation
 *      hazard.
 *
 * INPUT IS THE REPLY BODY AND NOTHING ELSE, matching TAC-401's contract, so it
 * stays replayable against fixed bodies and robust to venue persona. It is NOT
 * given the active commitments on purpose: "does this text say a promise is
 * off" is answerable from the text, and handing it the list would tempt it to
 * answer the different question of whether the cancellation is correct, which
 * is the gate's job and not a model's.
 *
 * The caller (verifyCancellationClaimStage in lib/agent/stages.ts) decides WHEN
 * to call this, retries it once on a transient fault, and FAILS CLOSED on
 * everything else. This function makes no policy decision.
 */
export async function verifyCancellationClaim(
  input: VerifyCancellationClaimInput,
): Promise<AIResult<VerifyCancellationClaimResult>> {
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
    claimsCancellation: z.boolean(),
  })

  try {
    const { object } = await generateObject({
      model: getClassificationModel(),
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(input),
      schema,
      // Analytical task. Same as all three siblings.
      temperature: 0.2,
      maxOutputTokens: VERIFY_CANCELLATION_CLAIM_MAX_OUTPUT_TOKENS,
    })

    return {
      ok: true,
      data: {
        claimsCancellation: object.claimsCancellation,
        promptVersion: VERIFY_CANCELLATION_CLAIM_PROMPT_VERSION,
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
        errorCode: VERIFY_CANCELLATION_CLAIM_TRUNCATED_ERROR_CODE,
      }
    }
    return { ok: false, error: message, errorCode: 'ai_verify_cancellation_claim_failed' }
  }
}
