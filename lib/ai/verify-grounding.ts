import { generateObject } from 'ai'
import { z } from 'zod'
import { getClassificationModel } from './client'
import { knowledgeChunksToProse, venueInfoToProse } from './prompts/serializers'
import type { AIResult, VerifyGroundingInput, VerifyGroundingResult } from './types'

// TAC-350. Deliberately its OWN version, not SYSTEM_TEMPLATE's PROMPT_VERSION
// — this verifier never touches the classify/generate contract, same
// independence rationale as EXTRACT_REPORTED_ORDER_PROMPT_VERSION and
// CLASSIFY_INTENTION_PROMPTS_PROMPT_VERSION.
export const VERIFY_GROUNDING_PROMPT_VERSION = 'v1.0.0'

const SYSTEM_PROMPT = `You read a reply a venue's AI assistant is ABOUT TO SEND to a guest, plus the source material the assistant had access to — the venue's facts, menu, and any retrieved venue knowledge. Your job is to catch specific factual claims in the reply that are NOT supported by that source material, even when the reply states them confidently.

A specific factual claim is a concrete detail someone actually working at the venue would need to know: a name, an ingredient, a price, a policy, a network password, a location, a supplier, a quantity, a schedule detail, or similar. General pleasantries, opinions, and replies that state no specific venue fact are never flagged.

Flag a claim as ungrounded when ALL of:
1. The reply states it as if it were true.
2. It is a specific, checkable fact about this venue — not small talk, not a hedge, not an opinion.
3. The provided source material does not state it. A source that mentions the general topic without stating the specific detail does NOT count as support. For example: source material saying a drink "has four variations" does not support a reply that names all four; source material describing a different menu item's ingredients does not support a claim about this item's ingredients; source material confirming cards are accepted generally does not support a claim that one specific card brand or payment method is accepted.

Do not flag:
- A reply that already admits uncertainty ("not sure," "no idea," "let me check").
- A reply that draws only on what the source material actually states, even if phrased differently.
- General conversation with no specific venue fact in it.

Set hasUngroundedClaim=true only when you found at least one claim you would flag; list each such claim in ungroundedClaims, quoting or closely paraphrasing the ungrounded part of the reply. Otherwise hasUngroundedClaim=false and ungroundedClaims is empty.`

function buildSourceMaterial(input: VerifyGroundingInput): string {
  const sections = [venueInfoToProse(input.venueInfo)]
  // knowledgeChunksToProse renders the explicit "no specific venue knowledge
  // matched" framing on an empty array (TAC-242) — including that framing
  // here, rather than omitting the section, tells the verifier the assistant
  // had nothing beyond venue facts/menu to draw on for this turn.
  sections.push(knowledgeChunksToProse(input.knowledgeChunks ?? []))
  return sections.join('\n\n')
}

function buildUserPrompt(input: VerifyGroundingInput): string {
  return `Guest's message: "${input.inboundBody}"\n\nAssistant's reply, about to be sent: "${input.replyBody}"\n\nSource material the assistant had access to:\n\n${buildSourceMaterial(input)}\n\nDoes the reply state any specific factual claim not supported by the source material above?`
}

/**
 * Independent grounding backstop for a reply the model has already claimed
 * is fine (`GenerateMessageResult.knowledgeGap === false`). Mirrors
 * extractReportedOrder.ts / classifyIntentionPrompts.ts exactly
 * (generateObject, Haiku, AIResult, no regeneration loop) — this is the same
 * architectural move CLAUDE.md documents for `comp_regex_backstop`: self-
 * report proved unreliable, so a second, independent check runs against the
 * same underlying risk (see TAC-350's audit — 8/8 observed fabrications had
 * knowledgeGap=false).
 *
 * The caller (verifyGroundingStage in lib/agent/stages.ts) is responsible for
 * deciding WHEN to call this — inbound-only, non-demo, and only when the
 * model's own self-report is false. This function itself has no gating
 * beyond input validation; it always runs the check it's asked to run.
 *
 * Source material is built from the SAME serializers compose-prompt.ts uses
 * for generation (`venueInfoToProse`, `knowledgeChunksToProse`) rather than a
 * separately hand-rolled summary, so "what the verifier checks against" can
 * never drift from "what the generator actually saw." Voice corpus
 * (ragChunks) is deliberately excluded — it's how the venue talks, not what
 * is true about it (see SYSTEM_TEMPLATE's "# Voice vs knowledge").
 */
export async function verifyGrounding(
  input: VerifyGroundingInput,
): Promise<AIResult<VerifyGroundingResult>> {
  if (typeof input.replyBody !== 'string' || input.replyBody.length === 0) {
    return { ok: false, error: 'invalid_input' }
  }

  const schema = z.object({
    hasUngroundedClaim: z.boolean(),
    // No .max() — THE-157 / TAC-347: Anthropic's structured-output validator
    // rejects maxItems on array fields. Unbounded is fine here; a reply with
    // more than a handful of distinct ungrounded claims is not a realistic
    // shape to defend against with a cap.
    ungroundedClaims: z.array(z.string()),
    reasoning: z.string(),
  })

  try {
    const { object } = await generateObject({
      model: getClassificationModel(),
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(input),
      schema,
      // Analytical task — keep determinism high, same as classify-message.ts.
      temperature: 0.2,
      maxOutputTokens: 500,
    })

    // Defensive: nothing structurally stops the model from returning
    // hasUngroundedClaim=true with an empty ungroundedClaims array. The
    // SAFETY behavior (queue, blank the body, arm the clock) is keyed on
    // hasUngroundedClaim alone downstream and must stay that way — treating
    // a malformed-but-still-flagged response as "nothing found" would defeat
    // the backstop on exactly the response shape most likely to come from a
    // model that's genuinely unsure. The only real gap is DISPLAY: an
    // operator-facing Slack message or queue card with an empty claim list
    // reads as broken. Substitute a fallback string rather than either
    // silently clearing the flag or hard-failing the whole call (a
    // `.refine()` that throws here would make this exact edge case fail
    // OPEN — the one shape a backstop against fabrication cannot afford to
    // let through unflagged).
    const ungroundedClaims =
      object.hasUngroundedClaim && object.ungroundedClaims.length === 0
        ? ['(model flagged an ungrounded claim but did not specify which one)']
        : object.ungroundedClaims

    return {
      ok: true,
      data: {
        hasUngroundedClaim: object.hasUngroundedClaim,
        ungroundedClaims,
        promptVersion: VERIFY_GROUNDING_PROMPT_VERSION,
      },
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message, errorCode: 'ai_verify_grounding_failed' }
  }
}
