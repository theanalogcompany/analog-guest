import { generateObject, NoObjectGeneratedError } from 'ai'
import { z } from 'zod'
import { getClassificationModel } from './client'
import { knowledgeChunksToProse, venueInfoToProse } from './prompts/serializers'
import type { AIResult, VerifyGroundingInput, VerifyGroundingResult } from './types'

// TAC-350. Deliberately its OWN version, not SYSTEM_TEMPLATE's PROMPT_VERSION
// — this verifier never touches the classify/generate contract, same
// independence rationale as EXTRACT_REPORTED_ORDER_PROMPT_VERSION and
// CLASSIFY_INTENTION_PROMPTS_PROMPT_VERSION.
// v1.1.0 (TAC-301 part 1.5): source material now also carries the generator's
// composed user prompt (see VerifyGroundingInput.runtimeContext), plus the
// system-prompt rule below about the assistant's own prior messages.
// v1.2.0 (TAC-358): `knowledgeChunksToProse` is shared with the generator, so
// its reframed "## Venue knowledge" header now renders inside this prompt's
// source material too. That header carries assistant-directed wording ("use
// only what actually answers the guest", "handle it per # Knowledge gaps"),
// which this prompt's scoping paragraph must exempt by name or the verifier
// can read it as a rule the reply broke. Bumped because the rendered prompt
// materially changed — without it the two generations are indistinguishable
// in analytics.
// v1.3.0 (TAC-367): maxOutputTokens 500 -> VERIFY_GROUNDING_MAX_OUTPUT_TOKENS
// (2000), and truncation is now reported as its OWN errorCode so the caller
// can fail CLOSED on it. The rendered prompt is byte-identical to v1.2.0;
// the version moves because the generation ENVELOPE changed and the two
// populations must be separable in analytics — at 500 an unknown fraction of
// v1.2.0 verdicts were never produced at all.
// v1.4.0 (TAC-409): two bullets added to "Do not flag:".
//   1. Abridgement. A reply that omits detail the source contains, while
//      contradicting nothing in it, is grounded. The bullet names its own
//      DIRECTION against point 3 deliberately: point 3's three worked examples
//      are all a reply asserting MORE than the source, and this is the reverse
//      case. The two never conflicted logically, and the model conflated them
//      anyway — twice, three days apart, drawing a different line each time
//      (`a1345d56` was flagged only for "in tonic" though it named the cold
//      foam; `c7a01385` was flagged for both). Stating "omission is fine" with
//      nothing distinguishing it from point 3 would have produced a third
//      arbitrary line rather than a rule.
//   2. Identity. Who the assistant is — the name it speaks under, and that it
//      works here — is configured, not asserted. Deliberately NOT "the role it
//      claims": nothing configures a role. `speakerFramingProse`'s
//      named_person branch renders only "staff at the venue", and
//      `venue_info.staff` is `z.array(z.string())` of free-form lines, so a
//      reply claiming a specific job title is an ordinary unsupported claim
//      and stays checked. Scoped to identity ONLY so it cannot be read
//      against the assistant's-own-text rule below, which must survive intact.
// Both were false positives on real drafts at Le Mil's: the verifier held
// correct replies against source material it already had. The name it objected
// to was in `venue_info.staff` (which it receives) and, on `1b221692`, in the
// guest's own inbound.
// v1.5.0 (TAC-376): the check now also runs on turns with no guest message —
// followups and the knowledge-gap holding message. The base SYSTEM_PROMPT
// text above is UNCHANGED; a proactive-only addendum is appended by
// buildSystemPrompt when isProactive is true, and buildUserPrompt swaps the
// literal "Guest's message" line for proactive framing. An inbound call's
// rendered prompt is byte-for-byte what v1.4.0 produced — the version moves
// because the function can now render a prompt it never could before, and the
// two populations must stay distinguishable in analytics.
export const VERIFY_GROUNDING_PROMPT_VERSION = 'v1.5.0'

/**
 * TAC-367. Was 500, which this verifier had quietly outgrown: measured
 * against Le Mil's live config the successful calls emit 373-496 output
 * tokens, so the best run cleared the cap by FOUR tokens and ~8% (1 of 12 on
 * a paced sample) ran past it, truncated mid-JSON, and threw. Every one of
 * those failed OPEN — no queue, no PostHog, no Slack — so the only
 * fabrication check that actually fires under real traffic was silently not
 * running on a slice of inbound turns.
 *
 * This is the same MAX_OUTPUT_TOKENS schema-growth hazard CLAUDE.md already
 * documents for TAC-309 (generate-message, 500 -> 1500), arriving here by a
 * different route: TAC-301 part 1.5 moved `reasoning` — the one unbounded
 * field — ahead of the verdict, which is load-bearing for CORRECTNESS and
 * must stay, but it put the long field first against a cap that never moved.
 *
 * 2000 is ~4x the observed ceiling. It is headroom, not a bound: `reasoning`
 * is still unbounded, so any ceiling can be hit. The fail-CLOSED handling of
 * `finishReason: 'length'` in verifyGroundingStage is what actually closes
 * the hole; this constant only makes hitting it rare.
 */
export const VERIFY_GROUNDING_MAX_OUTPUT_TOKENS = 2000

/**
 * TAC-367. `errorCode` on a failed verifyGrounding call, when the failure was
 * specifically output truncation (`finishReason: 'length'`) rather than a
 * transient fault. The caller keys its fail-CLOSED branch on this exact
 * string; see verifyGroundingStage in lib/agent/stages.ts.
 */
export const VERIFY_GROUNDING_TRUNCATED_ERROR_CODE = 'ai_verify_grounding_truncated'

const SYSTEM_PROMPT = `You read a reply a venue's AI assistant is ABOUT TO SEND to a guest, plus the source material the assistant had access to — the venue's facts, menu, and any retrieved venue knowledge. Your job is to catch specific factual claims in the reply that are NOT supported by that source material, even when the reply states them confidently.

A specific factual claim is a concrete detail someone actually working at the venue would need to know: a name, an ingredient, a price, a policy, a network password, a location, a supplier, a quantity, a schedule detail, or similar. General pleasantries, opinions, and replies that state no specific venue fact are never flagged.

Flag a claim as ungrounded when ALL of:
1. The reply states it as if it were true.
2. It is a specific, checkable fact about this venue — not small talk, not a hedge, not an opinion.
3. The provided source material does not state it. A source that mentions the general topic without stating the specific detail does NOT count as support. For example: source material saying a drink "has four variations" does not support a reply that names all four; source material describing a different menu item's ingredients does not support a claim about this item's ingredients; source material confirming cards are accepted generally does not support a claim that one specific card brand or payment method is accepted.

Do not flag:
- A reply that already admits uncertainty ("not sure," "no idea," "let me check").
- A reply that draws only on what the source material actually states, even if phrased differently.
- A reply that says LESS than the source does. Leaving out detail the source contains is not an unsupported claim: if every fact the reply states is supported, the reply is grounded no matter how much it omits. Note the direction, because it is the opposite of point 3 above — point 3 is about a reply asserting MORE than the source states, which you check; a shorter, partial, or selective description asserts less, and is fine so long as it contradicts nothing the source states. A reply naming three of a drink's five ingredients has stated nothing unsupported.
- Who the assistant is. The name the assistant speaks under, and that it works at this venue, are configured, not claimed — never flag a reply for saying who is speaking, including when the guest asked. This exempts identity only, never the facts inside it: a specific job title, shift, or responsibility the assistant claims for itself is checked exactly like any other claim, as is anything else it says about itself or the venue.
- General conversation with no specific venue fact in it.
- A reply that draws on the runtime context for this turn, when that section is present. It states what the assistant legitimately knew about this guest and this moment: the current date and time, whether the venue is open right now, what this guest can be offered, what has already been promised to them, what they have ordered before, what is known about them, and what was said earlier in the conversation. A claim supported there is grounded, exactly as much as one supported by the venue facts. Two specifics, because they are the ones most often got wrong:
  - The status line in the runtime context is the authority on whether the venue is open AT THIS MOMENT and when it next opens. A reply that says the venue is closed right now, or that names the next opening day and time from that line, is grounded. Do not flag it for lacking support elsewhere; the weekly hours table is not the source for a claim about right now, that line is.
  - Everything under "## What this guest can access" is a real, existing offering this guest is eligible for right now. Naming one, describing it in the venue's own words, offering it, or asking whether the guest wants it is GROUNDED — that block is the support. Do not flag such an offer merely because the item is absent from the menu or the venue facts; perks are not menu items and will not appear there. What is NOT grounded: an item absent from that block entirely, or a claim that something has already been arranged, reserved, or set aside for the guest when nothing says it has.
- The DECISION to make an offer, an invitation, or a suggestion. Whether the venue should be offering something is not yours to judge; you are not a policy check. But this exempts the decision only, never the facts inside it: a specific date, time, item, price, or availability stated as part of an offer is checked exactly like any other claim. "Want a pastry on us?" is a decision. "We'll have the new single-origin in on Friday" contains a schedule claim and is checked.

The runtime context section, the venue facts' "what this venue does and doesn't offer" block, and the "## Venue knowledge" header, also contain instructions written FOR the assistant about how to write its reply — style guidance, things to avoid mentioning, when to raise a topic. Those are not your concern and they are not grounding rules. You check one thing only: whether a stated fact is supported. A reply that does something the runtime context discouraged, but that states nothing unsupported, is NOT flagged. For example, guidance not to recite visit history back to the guest does not make a correct statement about what the guest ordered ungrounded — the visit history is right there, so the fact is supported, and whether mentioning it was stylistically wise is someone else's judgement, not yours.

One exception inside that section: ANYTHING THE ASSISTANT ITSELF WROTE is not evidence that it was correct. It is only what the assistant said. Two places this appears, and both matter:
  - Under "## Recent conversation", lines marked [venue, ...] are the assistant's own earlier replies. Lines marked [guest, ...] are the guest's own words, and those ARE legitimate grounding.
  - Under "## Guest context", the "Observations:" entries were written by the assistant about the guest, not quoted from the guest, despite that block's intro.
Do not treat a fact about the venue as grounded solely because it appears in one of those. A password, a price, or an ingredient the assistant asserted last week is exactly as unsupported today as it was then.

Stay inside your remit. You are checking factual support and nothing else. In particular:
- Do NOT judge whether the guest QUALIFIES for something. If an item appears under what this guest can access, eligibility has already been decided before you saw it; the qualification text is background, not a test for you to re-apply.
- Do NOT judge how confidently something is phrased. Hedging like "if I remember right" about a fact that IS in the source material is still grounded. Tone, confidence and word choice are not yours to flag.
- Do NOT judge whether saying it was a good idea. Only whether it is supported.

Work through the evidence first, then decide. If your reasoning concludes a claim is supported, hasUngroundedClaim must be false — do not flag a claim you have just talked yourself into accepting.

Set hasUngroundedClaim=true only when you found at least one claim you would flag; list each such claim in ungroundedClaims, quoting or closely paraphrasing the ungrounded part of the reply. Otherwise hasUngroundedClaim=false and ungroundedClaims is empty.`

/**
 * TAC-376. Appended to SYSTEM_PROMPT only when isProactive is true — never
 * woven into the base prompt, so an inbound call's system prompt stays
 * byte-for-byte what it was before this ticket.
 *
 * One rule, per the 2026-09-17 ruling (question 5): the single point where a
 * proactive check must diverge from an inbound one. On an inbound turn, a
 * reply restating something the guest just said about themselves ("so glad
 * you brought your friend!" right after the guest said as much) is licensed
 * by the guest's own message — nobody wrote that rule down because the guest
 * message itself is the license. On a proactive message there is no guest
 * message to license it: the ASSISTANT is the one asserting what the guest
 * did, unprompted, and that assertion is exactly the kind of specific,
 * checkable claim the base prompt already governs. The addendum exists so it
 * is not mistaken for warm conversational filler ("Do not flag: General
 * conversation with no specific venue fact in it") — thanking a guest for a
 * referral reads exactly like that unless the rule is explicit that it isn't.
 */
const PROACTIVE_ADDENDUM = `This reply was NOT written in response to anything the guest said. It is a proactive message the venue is sending on its own initiative — a scheduled or operator-triggered follow-up, or a placeholder note sent while a question is still being checked. There is no guest message this turn; ignore any instruction elsewhere about a "Guest's message" section, because none is present.

One rule applies only here: a claim about something the GUEST did — that they visited, ordered something, brought a friend in, referred someone, or similar — is a specific, checkable fact and must be checked exactly like any other, never waved through as friendly conversational warmth. On an inbound reply, the guest's own message is what licenses a line like that; here there is none, so the assistant is the one asserting it, and it must be supported by the source material (a recorded visit, order, or referral) or flagged. "So glad you brought a friend in" with nothing in the source material recording a referral is exactly the claim this rule exists to catch.`

function buildSystemPrompt(isProactive: boolean): string {
  return isProactive ? `${SYSTEM_PROMPT}\n\n${PROACTIVE_ADDENDUM}` : SYSTEM_PROMPT
}

function buildSourceMaterial(input: VerifyGroundingInput): string {
  const sections = [venueInfoToProse(input.venueInfo)]
  // knowledgeChunksToProse renders the explicit "no specific venue knowledge
  // matched" framing on an empty array (TAC-242) — including that framing
  // here, rather than omitting the section, tells the verifier the assistant
  // had nothing beyond venue facts/menu to draw on for this turn.
  sections.push(knowledgeChunksToProse(input.knowledgeChunks ?? []))
  // TAC-301 part 1.5: appended VERBATIM, never summarized, sliced, or
  // re-serialized. The whole point is that this string is the one the
  // generating model actually received, so "what the verifier checks
  // against" cannot drift from "what the generator saw" — the same principle
  // the venueInfoToProse/knowledgeChunksToProse reuse above is chosen for,
  // taken to its limit. A curated subset would have to be maintained by hand
  // and would fall behind the next runtime block, which is precisely how the
  // six known divergences arrived (TAC-296, TAC-297, TAC-308, TAC-324 each
  // appended one).
  if (input.runtimeContext !== undefined && input.runtimeContext.trim().length > 0) {
    sections.push(`## Runtime context for this turn\n${input.runtimeContext}`)
  }
  return sections.join('\n\n')
}

function buildUserPrompt(input: VerifyGroundingInput): string {
  // TAC-376: unchanged for isProactive=false — the literal line every inbound
  // call has always sent. A proactive turn has no guest message to quote, so
  // it gets explicit framing instead of an empty pair of quotes.
  const guestLine = input.isProactive
    ? "This message is proactive — the venue is sending it on its own initiative, not in reply to anything the guest said this turn."
    : `Guest's message: "${input.inboundBody}"`
  return `${guestLine}\n\nAssistant's reply, about to be sent: "${input.replyBody}"\n\nSource material the assistant had access to:\n\n${buildSourceMaterial(input)}\n\nDoes the reply state any specific factual claim not supported by the source material above?`
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
 * Source material has three parts, and none of them is a hand-rolled summary:
 * the same `venueInfoToProse` / `knowledgeChunksToProse` output compose-prompt.ts
 * builds for generation, plus (TAC-301 part 1.5) the generator's composed USER
 * prompt verbatim. So "what the verifier checks against" cannot drift from
 * "what the generator actually saw." Voice corpus (ragChunks) stays excluded —
 * it's how the venue talks, not what is true about it (see SYSTEM_TEMPLATE's
 * "# Voice vs knowledge") — and it lives in the SYSTEM prompt, so passing the
 * user prompt doesn't smuggle it back in.
 */
export async function verifyGrounding(
  input: VerifyGroundingInput,
): Promise<AIResult<VerifyGroundingResult>> {
  if (typeof input.replyBody !== 'string' || input.replyBody.length === 0) {
    return { ok: false, error: 'invalid_input' }
  }

  // FIELD ORDER IS LOAD-BEARING (TAC-301 part 1.5). Structured-output fields
  // are generated in declaration order, so `reasoning` last meant the model
  // committed to a verdict and then rationalized it. Observed directly: on a
  // reply naming what a guest ordered last time — a fact sitting in the
  // visit-history block — the reasoning worked through the evidence, reversed
  // itself mid-paragraph, and ended "This IS supported by the source material
  // provided. The claim is grounded." The emitted hasUngroundedClaim was
  // still true, because the boolean had already been written. Reasoning first
  // lets the conclusion follow the analysis instead of preceding it.
  const schema = z.object({
    reasoning: z.string(),
    hasUngroundedClaim: z.boolean(),
    // No .max() — THE-157 / TAC-347: Anthropic's structured-output validator
    // rejects maxItems on array fields. Unbounded is fine here; a reply with
    // more than a handful of distinct ungrounded claims is not a realistic
    // shape to defend against with a cap.
    ungroundedClaims: z.array(z.string()),
  })

  try {
    const { object } = await generateObject({
      model: getClassificationModel(),
      system: buildSystemPrompt(input.isProactive),
      prompt: buildUserPrompt(input),
      schema,
      // Analytical task — keep determinism high, same as classify-message.ts.
      temperature: 0.2,
      maxOutputTokens: VERIFY_GROUNDING_MAX_OUTPUT_TOKENS,
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
    // TAC-367: separate truncation from every other failure. Both still
    // return ok:false — this function makes no policy decision — but only
    // truncation is a verdict the model PRODUCED and we failed to read.
    // That distinction is what lets the caller fail closed on this one case
    // while leaving transient faults fail-open (see verifyGroundingStage).
    //
    // finishReason is read off the SDK's own error rather than inferred from
    // the message text, which is provider-formatted and not a contract.
    if (NoObjectGeneratedError.isInstance(e) && e.finishReason === 'length') {
      return {
        ok: false,
        error: message,
        errorCode: VERIFY_GROUNDING_TRUNCATED_ERROR_CODE,
      }
    }
    return { ok: false, error: message, errorCode: 'ai_verify_grounding_failed' }
  }
}
