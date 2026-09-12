import { generateObject } from 'ai'
import { z } from 'zod'
import { getClassificationModel } from './client'
import type { AIResult, VerifyMechanicOfferInput, VerifyMechanicOfferResult } from './types'

// TAC-355. Deliberately its OWN version, not SYSTEM_TEMPLATE's PROMPT_VERSION
// — this verifier never touches the classify/generate contract, same
// independence rationale as VERIFY_GROUNDING_PROMPT_VERSION and
// EXTRACT_REPORTED_ORDER_PROMPT_VERSION.
export const VERIFY_MECHANIC_OFFER_PROMPT_VERSION = 'v1.0.0'

const SYSTEM_PROMPT = `You read a reply a venue's AI assistant is ABOUT TO SEND to a guest, plus a list of special perks or offers this specific guest currently qualifies for but that require the venue owner's approval before being promised. Your job is to catch a reply that promises, offers, or grants one of those listed perks — in any wording, not just the perk's exact name — even when the reply never uses the perk's own name.

A reply "offers" a listed perk when it tells the guest they are getting, will get, or have been given something matching that perk's description — a complimentary item, a held item, a special invite, a discount, a custom addition, or similar — regardless of how the reply phrases it. The reply does not need to name the perk, mention approval, or use the word "perk." Paraphrase, vague teasers ("something special is coming your way"), and indirect framing ("since you brought a friend by...") all count if they match a listed perk's qualification and reward.

Do not flag:
- A reply that only describes the venue's regular menu, hours, or policies.
- A reply that answers a question without promising anything additional.
- A reply that mentions a perk only to say it is NOT available, or defers a decision to someone else ("let me check with the team").

Set offersGatedMechanic=true only when the reply promises a listed perk with enough confidence that an owner reviewing it would recognize it as that specific perk. Set mechanicId to that perk's id. Otherwise set offersGatedMechanic=false and mechanicId="none".`

function buildMechanicsBlock(mechanics: VerifyMechanicOfferInput['eligibleGatedMechanics']): string {
  return mechanics
    .map((m) => {
      const reward = m.rewardDescription ? ` — ${m.rewardDescription}` : ''
      const qual = m.qualification ? ` (qualifies when: ${m.qualification})` : ''
      return `- id="${m.id}": ${m.name}${reward}${qual}`
    })
    .join('\n')
}

function buildUserPrompt(input: VerifyMechanicOfferInput): string {
  return `Assistant's reply, about to be sent: "${input.replyBody}"\n\nPerks this guest currently qualifies for that require approval before being promised:\n${buildMechanicsBlock(input.eligibleGatedMechanics)}\n\nDoes the reply promise, offer, or grant any of the listed perks?`
}

/**
 * Independent verification backstop for the mechanic-approval gate. Mirrors
 * verify-grounding.ts's shape exactly (generateObject, Haiku, AIResult, no
 * regeneration loop) — the same architectural move this repo already made
 * for comp_regex_backstop and TAC-350's grounding backstop: self-report
 * (requiresOperatorApproval / commitment.type) proved unreliable, so a
 * second, independent check runs against the same underlying risk.
 *
 * The caller (verifyMechanicOfferStage in lib/agent/stages.ts) decides WHEN
 * to call this (skips when there's nothing gated eligible this turn, when
 * the model already self-flagged via either existing signal, or for a demo
 * guest) and how to treat a failure (FAILS CLOSED there — a deliberate
 * divergence from the grounding backstop). This function itself has no
 * gating beyond input validation.
 *
 * mechanicId is constrained via a z.enum built PER CALL from the actual
 * eligible-gated-mechanic id set (plus 'none') — never a bare z.string().
 * This is the same structural-constraint fix code review has forced onto
 * extract-reported-order.ts and classify-intention-prompts.ts in this repo;
 * applied from the start here.
 */
export async function verifyMechanicOffer(
  input: VerifyMechanicOfferInput,
): Promise<AIResult<VerifyMechanicOfferResult>> {
  if (typeof input.replyBody !== 'string' || input.replyBody.length === 0) {
    return { ok: false, error: 'invalid_input' }
  }
  if (!Array.isArray(input.eligibleGatedMechanics) || input.eligibleGatedMechanics.length === 0) {
    return { ok: false, error: 'no_eligible_gated_mechanics' }
  }

  const ids = input.eligibleGatedMechanics.map((m) => m.id)
  // `[...ids, 'none']` is a plain `string[]`, and TS's `as` rejects the direct
  // cast to the tuple shape z.enum requires ("neither type sufficiently
  // overlaps") — bridge through `unknown` per the compiler's own suggested
  // fix for this exact situation.
  const mechanicIdEnum = z.enum([...ids, 'none'] as unknown as [string, ...string[]])

  const schema = z.object({
    offersGatedMechanic: z.boolean(),
    mechanicId: mechanicIdEnum,
    reasoning: z.string(),
  })

  try {
    const { object } = await generateObject({
      model: getClassificationModel(),
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(input),
      schema,
      // Analytical task — keep determinism high, same as verify-grounding.ts.
      temperature: 0.2,
      maxOutputTokens: 300,
    })

    // Defensive: nothing structurally stops the model from returning
    // offersGatedMechanic=true with mechanicId="none" — the schema doesn't
    // cross-validate the two fields. Mirrors verify-grounding.ts's identical
    // defensive substitution for the analogous ambiguous shape
    // (hasUngroundedClaim=true + an empty claims array): the SAFETY-relevant
    // boolean must survive untouched, only the identifying detail is
    // patched. Silently downgrading to "clean" here would be exactly the
    // false negative this backstop exists to prevent — trust
    // offersGatedMechanic, not the enum, when the two disagree.
    const mechanicId =
      object.offersGatedMechanic && object.mechanicId === 'none'
        ? '(model flagged an offer but did not specify which mechanic)'
        : object.mechanicId

    return {
      ok: true,
      data: {
        offersGatedMechanic: object.offersGatedMechanic,
        mechanicId,
        promptVersion: VERIFY_MECHANIC_OFFER_PROMPT_VERSION,
      },
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message, errorCode: 'ai_verify_mechanic_offer_failed' }
  }
}
