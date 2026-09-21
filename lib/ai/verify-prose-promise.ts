import { generateObject, NoObjectGeneratedError } from 'ai'
import { z } from 'zod'
import { getClassificationModel } from './client'
import type { AIResult, VerifyProsePromiseInput, VerifyProsePromiseResult } from './types'

// TAC-401. Deliberately its OWN version, not SYSTEM_TEMPLATE's PROMPT_VERSION
// — this verifier never touches the classify/generate contract, same
// independence rationale as VERIFY_GROUNDING_PROMPT_VERSION and
// VERIFY_MECHANIC_OFFER_PROMPT_VERSION.
export const VERIFY_PROSE_PROMISE_PROMPT_VERSION = 'v1.0.0'

/**
 * TAC-401. 1000, not verify-mechanic-offer's 300.
 *
 * `reasoning` is unbounded and declared FIRST (see the schema below for why
 * that ordering is load-bearing), and this call also emits a description, so
 * the tail of the object sits further from the start than either sibling's.
 * That is exactly the TAC-309 / TAC-367 hazard: the model reasons longest on
 * the replies hardest to judge, so a tight cap truncates preferentially on
 * the population the check exists for.
 *
 * The replay harness (scripts/measurement/prose-promise-catch-rate.ts)
 * reports the observed output-token distribution against this cap, so the
 * headroom is measured rather than asserted.
 */
export const VERIFY_PROSE_PROMISE_MAX_OUTPUT_TOKENS = 1000

/**
 * TAC-401: truncation reported as its own code, so the caller can tell a
 * verdict it could not READ from a call that never landed.
 *
 * The distinction drives the retry (ruled 2026-09-21): a transient fault is
 * retried once, a truncation is not — retrying a cap that was already hit
 * spends a second call to hit it again. Same reasoning TAC-367 gives for
 * treating truncation as a verdict the model produced rather than as an
 * absence of one.
 *
 * Imported BY PATH in lib/agent/stages.ts, never via the @/lib/ai barrel:
 * stages.test.ts `vi.mock`s that barrel, and a bare constant arriving
 * `undefined` would make the no-retry branch silently unreachable in every
 * test — the same reasoning VERIFY_GROUNDING_TRUNCATED_ERROR_CODE carries.
 */
export const VERIFY_PROSE_PROMISE_TRUNCATED_ERROR_CODE = 'ai_verify_prose_promise_truncated'

const SYSTEM_PROMPT = `You read a reply a venue's AI assistant is ABOUT TO SEND to a guest. Your job is to decide one thing: does this reply commit the venue to giving this guest something of value that the guest has not paid for?

Judge the reply on its own words. You are not checking whether the venue can afford it, whether the guest deserves it, or whether it was wise to offer. Only whether it was offered.

Something of value means the guest ends up with product, service, or money they did not pay for, because of this reply. A replacement drink, a remake, a free item, an item set aside for them, money off a future purchase, "on us", "the next one's on me", "I'll make it right" about a drink that was wrong. The wording does not matter and the reply does not have to name a price, an item, or a mechanism. "We'll sort you out next time" is a promise; so is "I'll make sure your next one is right".

Do not flag:
- A promise of INFORMATION or effort only. "Let me find out and get back to you", "I'll look into it", "I'll ask the team". Nothing changes hands.
- A refusal or a deferral. "I can't do that over text", "that's something the owner handles". Mentioning a thing in order to decline it is not offering it.
- An apology that gives nothing. "We'll do better next time", "that one's on us to get right", "sorry that happened". "On us" in an apology about responsibility is not "on us" as in free.
- A reply that only describes the regular menu, hours, prices, or policies, including what something costs.
- Something the guest has already paid for or already ordered: confirming an existing order, or saying a drink they bought will be ready.

Set promisesSomething=true only when a venue owner reading the reply would agree the venue now owes this guest something.

When promisesSomething is true, also say WHAT is owed:
- commitmentType: "comp" for something free or replaced at no charge, "hold" for an item set aside for them to collect, "discount" for money off a future purchase, "none" if it clearly promises something but you cannot tell which of those three it is.
- commitmentDescription: a short noun phrase naming what the venue owes, from the guest's side. "a replacement cortado", "a free pastry on their next visit". Not a sentence, not a quote of the reply, and never first person. Leave it empty only if the reply is too vague to name anything.

When promisesSomething is false, set commitmentType to "none" and commitmentDescription to an empty string.`

function buildUserPrompt(input: VerifyProsePromiseInput): string {
  return `Assistant's reply, about to be sent: "${input.replyBody}"\n\nDoes this reply commit the venue to giving this guest something of value?`
}

/**
 * TAC-401: independent post-generation check for a promise made in PROSE with
 * no structured commitment behind it.
 *
 * Third instance of the shape verify-grounding.ts and verify-mechanic-offer.ts
 * already set: generateObject, Haiku, AIResult, its own prompt version, no
 * regeneration loop, no gating of its own beyond input validation.
 *
 * WHY IT EXISTS. The controls that were supposed to cover this both measured
 * near zero. Across 220 replies at Le Mil's the model's own
 * `requiresOperatorApproval` self-flag fired 0 times and caught 0 of the 4
 * genuine uncarried promises; the comp regex fired 5 times and caught 0 of
 * them, flagging 3 apology idioms and 1 fabricated comp instead. The promises
 * that were held were held by the grounding check and the mechanic-offer
 * check — neither of them a commitment control, both firing for unrelated
 * reasons. Ruled 2026-09-15: an independent check becomes the primary
 * control and nothing may depend on the self-flag.
 *
 * INPUT IS THE REPLY BODY AND NOTHING ELSE. Not the prompt, not the retrieved
 * knowledge, not the mechanics list. "Does this text commit the venue to
 * giving this guest something" is answerable from the text alone, and keeping
 * the input to one string is what lets the replay harness measure this check
 * against fixed bodies, and what keeps it robust to venue persona rather than
 * tuned to one venue's voice (see TAC-415 — the same code and prompt produced
 * 27/60 on a synthetic persona reading "quick to make things right" and 4/220
 * at a venue whose persona says the opposite).
 *
 * The caller (verifyProsePromiseStage in lib/agent/stages.ts) decides WHEN to
 * call this, retries it once on a transient fault, and FAILS CLOSED on
 * everything else. This function makes no policy decision.
 */
export async function verifyProsePromise(
  input: VerifyProsePromiseInput,
): Promise<AIResult<VerifyProsePromiseResult>> {
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
    promisesSomething: z.boolean(),
    commitmentType: z.enum(['comp', 'hold', 'discount', 'none']),
    commitmentDescription: z.string(),
  })

  try {
    const { object } = await generateObject({
      model: getClassificationModel(),
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(input),
      schema,
      // Analytical task — keep determinism high, same as both siblings.
      temperature: 0.2,
      maxOutputTokens: VERIFY_PROSE_PROMISE_MAX_OUTPUT_TOKENS,
    })

    if (!object.promisesSomething) {
      return {
        ok: true,
        data: {
          promisesSomething: false,
          commitmentType: null,
          commitmentDescription: null,
          promptVersion: VERIFY_PROSE_PROMISE_PROMPT_VERSION,
        },
      }
    }

    // Defensive resolution, mirroring verify-mechanic-offer.ts's handling of
    // the analogous ambiguous shape. Nothing structurally stops the model
    // returning promisesSomething=true alongside type "none" or a blank
    // description — the schema does not cross-validate the fields.
    //
    // The SAFETY-relevant boolean survives untouched. Only the carrier is
    // dropped. Downgrading to promisesSomething=false here would be the exact
    // false negative a fail-closed backstop cannot afford, and fabricating a
    // description instead would be worse than dropping it: that string lands
    // in guest_commitments.description on operator approval and renders in
    // "## Active commitments" on every later turn, so an invented one becomes
    // a fact about the venue that nobody wrote.
    const namedType = object.commitmentType === 'none' ? null : object.commitmentType
    const description = object.commitmentDescription.trim()
    const usable = namedType !== null && description.length > 0

    return {
      ok: true,
      data: {
        promisesSomething: true,
        commitmentType: usable ? namedType : null,
        commitmentDescription: usable ? description : null,
        promptVersion: VERIFY_PROSE_PROMISE_PROMPT_VERSION,
      },
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // Truncation separated from every other failure, exactly as
    // verify-grounding.ts does it, and read off the SDK's own error rather
    // than inferred from provider-formatted message text. Both still return
    // ok:false — this function makes no policy decision — but the caller
    // retries one of these and not the other.
    if (NoObjectGeneratedError.isInstance(e) && e.finishReason === 'length') {
      return {
        ok: false,
        error: message,
        errorCode: VERIFY_PROSE_PROMISE_TRUNCATED_ERROR_CODE,
      }
    }
    return { ok: false, error: message, errorCode: 'ai_verify_prose_promise_failed' }
  }
}
