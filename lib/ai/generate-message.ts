import { generateObject, NoObjectGeneratedError } from 'ai'
import { z } from 'zod'
import {
  ArrivalCaptureEmissionSchema,
  CommitmentEmissionSchema,
} from '@/lib/schemas/guest-commitment'
import { GuestContextPatchSchema } from '@/lib/schemas/guest-context'
import { isMessageChannel } from '@/lib/schemas/message-channel'
import { parseVenueLinks } from '@/lib/schemas/venue-info'
import { captureGenerationTruncated } from '@/lib/analytics/posthog'
import { getGenerationModel } from './client'
import { composePrompt } from './compose-prompt'
import { containsEmoji } from './emoji-cadence'
import { PROMPT_VERSION } from './prompts/system-template'
import { matchSelfTalk } from './self-talk-detector'
import { findUnverifiedUrls } from './url-detector'
import type {
  AIResult,
  GenerateMessageAttempt,
  GenerateMessageInput,
  GenerateMessageResult,
} from './types'

export const MIN_VOICE_FIDELITY = 0.7
export const MAX_ATTEMPTS = 3

/**
 * Output-token ceiling for one generation attempt.
 *
 * TAC-309 raised this from 500. The measured picture, from Langfuse on live
 * Mock Sextant traffic:
 *
 *   successful single attempts   4.1-5.7s, ~121-299 emitted tokens
 *   the 2026-08-08 crash         13.7s, single call, "could not parse the
 *                                response" — at the observed ~33 tok/s that
 *                                is ~450 tokens, i.e. the old 500 cap
 *
 * The object serializes `body`, `voiceFidelity`, `reasoning` FIRST and
 * `knowledgeGap` / `contextUpdate` / `commitment` / `arrivalCapture` LAST, so
 * running out of budget truncates mid-JSON and the whole emission fails to
 * parse. `reasoning` is the only unbounded field and it sits third.
 *
 * The correlation that makes this worse than it looks: the model reasons
 * LONGEST on questions it can't answer cleanly, which is exactly the
 * knowledge-gap case. Truncation preferentially killed the path TAC-308 built
 * to catch those questions.
 *
 * 500 predates TAC-296 / TAC-297 / TAC-308, each of which appended a required
 * field to the tail while the cap stood still — the same failure class as
 * TAC-300's optional-parameter budget, without the guardrail. 1500 is ~5x the
 * largest emission observed. Raising it costs nothing on normal runs: output
 * tokens bill on what's actually produced, and generation stops at the end of
 * the object.
 */
export const MAX_OUTPUT_TOKENS = 1500

/**
 * errorCode returned when a generation attempt was cut off at
 * MAX_OUTPUT_TOKENS rather than failing for a content reason.
 *
 * Structural, not a string match on the SDK's message: callers need to tell
 * the two apart because retrying a truncation just runs into the same
 * ceiling, and the AI SDK reports both as "could not parse the response."
 */
export const AI_ERROR_TRUNCATED = 'ai_generation_truncated'
// THE-225: hard-block regex companion to the R3 voice rule. Em dash (U+2014)
// or en dash (U+2013) anywhere in the body forces a regen even if voice
// fidelity passes. Sonnet still occasionally emits dashes despite the rule
// text; this is the deterministic backstop.
const DASH_REGEX = /[—–]/
const DASH_CONSTRAINT =
  'Constraint: do not use a dash character (— or –) anywhere in your reply. Use a period or a comma instead.'

// TAC-355: deterministic backstop for reasoning/self-correction leaking into
// a guest-facing body ("...dandelion root — actually wait, no dashes."). Runs
// in the SAME per-attempt loop as the dash check, sharing its attempt budget
// deliberately — the two failures are correlated (the motivating incident
// WAS dash avoidance), so a message that trips one is likely to trip the
// other, and the terminal state here is a queue, not a send, so a shared
// small budget is already safe. Unlike a dash, a self-talk violation that
// persists through every attempt must NOT ship — see
// GenerateMessageResult.selfTalkViolationPersisted and
// lib/agent/stages.ts's SELF_TALK_DETECTED trigger.
const SELF_TALK_CONSTRAINT =
  'Constraint: do not include a self-correction, any visible reasoning, or any reference to your own instructions, rules, or nature as an AI (for example "actually wait, no dashes" or "as an AI"). Write it as a normal reply.'

// TAC-509: deterministic backstop for a link nobody curated. Runs in the SAME
// per-attempt loop as the dash and self-talk checks, sharing their attempt
// budget. Like self-talk and unlike the dash regex, a violation that survives
// every attempt must NOT ship — see unverifiedUrlsPersisted below and
// lib/agent/stages.ts's UNVERIFIED_URL trigger.
//
// The constraint names the offending links. The model cannot fix a link it
// cannot see it got wrong, and the usual miss is one character in a slug.
//
// Phrased as a standing fact about those links rather than as a report on the
// previous attempt, so it stays TRUE on every later attempt it is carried
// into: a link that is not on the list is not on the list whether or not the
// attempt just completed used it.
function unverifiedUrlConstraint(urls: readonly string[]): string {
  const quoted = urls.map((u) => `"${u}"`).join(', ')
  const isAre = urls.length === 1 ? 'is not a link' : 'are not links'
  return `Constraint: ${quoted} ${isAre} the venue has approved, and must not appear in your reply. Use only a link from the "## Links" section, copied exactly as written there, or no link at all. Do not guess a web address and do not build one from a pattern.`
}

// THE-160: pin the voiceFidelity scale unambiguously in the prompt. The Zod
// schema uses .refine() (per THE-157) so .min/.max don't get serialized into
// JSON Schema; without this instruction Sonnet defaults to a 1–10 confidence
// scale and returns e.g. 9 instead of 0.9, which then fails the [0,1] refine
// check and rejects the entire structured-output response.
export const VOICE_FIDELITY_INSTRUCTION = `# Voice fidelity self-assessment (output field)
voiceFidelity: a DECIMAL number between 0.0 and 1.0 (NOT a 1-10 score).
  0.0 = does not match the venue's voice at all
  0.5 = generic but acceptable, lacks distinctive voice markers
  0.7 = good match, voice is recognizable
  0.9 = excellent match, captures distinctive phrases and tone
  1.0 = indistinguishable from how the operator would write

# Reasoning brevity (output field)
reasoning: at most two short sentences. It is a debugging note, not a
  deliberation. Do not restate the guest's message, do not enumerate the
  options you considered, and do not explain fields you left empty.`

// Exported for the TAC-300 CI guardrail in lib/ai/schema-budget.test.ts —
// the test walks this schema's tree counting ZodOptional wrappers and fails
// CI if the count breaches OPTIONAL_FIELD_BUDGET. No other call sites; the
// generation pipeline uses the schema directly via the `schema:` arg below.
export const GeneratedMessageSchema = z.object({
  body: z.string().min(1),
  // .refine() instead of .min(0).max(1) — Anthropic's structured-output
  // validator rejects `minimum`/`maximum` constraints on JSON Schema number
  // types. Refine runs as a post-parse predicate and isn't serialized into
  // the schema sent to the model. See THE-157.
  voiceFidelity: z
    .number()
    .refine((n) => n >= 0 && n <= 1, { message: 'must be between 0 and 1' }),
  reasoning: z.string(),
  // TAC-212: model self-flag for resource commitments (comps, refunds,
  // mechanic commitments where the runtime context marked the mechanic
  // requires_operator_approval=true). When true, the approval-policy gate
  // queues the draft (review_state='pending') and skips Sendblue dispatch.
  // approvalReason is a one-clause human-readable rationale; empty string
  // when requiresOperatorApproval=false. Both fields rigidly populated on
  // every generation — no .optional() because the structured-output
  // validator is more reliable with explicit presence.
  requiresOperatorApproval: z.boolean(),
  approvalReason: z.string(),
  // v1.24.0: what this turn is doing on a complaint. Drives the ONLY
  // exemption from comp_complaint's category routing — a turn that is
  // genuinely just asking auto-sends; anything else queues for an operator.
  // REQUIRED, not optional, for two reasons: the TAC-212 precedent that
  // Anthropic's validator is more reliable with explicit presence, and
  // because a required field costs ZERO against the TAC-300 24-optional
  // budget (the counter counts properties absent from `required`), keeping
  // the schema at 20. Non-complaint turns emit 'none'. See
  // lib/agent/complaint-routing.ts for how it is consumed and why the model's
  // claim is necessary but never sufficient.
  complaintIntent: z.enum(['clarifying', 'resolving', 'none']),
  // TAC-308: true when the reply answers a guest question the model could not
  // ground in the runtime context — venue knowledge, venue_info, or the voice
  // corpus. The KNOWLEDGE_GAP approval trigger routes the turn to the operator
  // queue with a live messages.pending_until, and the guest gets nothing on
  // that turn.
  //
  // TAC-309: the model still WRITES a body (the dash regex and the fidelity
  // self-assessment both operate on real text), but that body is DISCARDED at
  // the persist boundary and the card is stored blank. TAC-308 shipped it
  // prefilled; the first live card read "Not sure on the specific matcha we
  // source. I can find out if that matters for your order." — the exact
  // promise phrasing the same ticket had just deleted from the corpus. A
  // visible guess is something an operator swipes rather than replaces, so
  // there is now nothing to swipe.
  //
  // REQUIRED, not optional, for the same two reasons as complaintIntent: the
  // TAC-212 precedent that Anthropic's validator is more reliable with
  // explicit presence, and because a required field costs ZERO against the
  // TAC-300 24-optional budget (the counter counts properties absent from
  // `required`). Turns that answer nothing, or answer it confidently, emit
  // false.
  knowledgeGap: z.boolean(),
  // TAC-296: agent-emitted patch for guests.context. Field is REQUIRED on
  // every emission (per the TAC-212 precedent — Anthropic's structured-output
  // validator is more reliable with explicit presence), but both inner fields
  // are optional so the agent emits `{}` for the no-op case. The orchestrator
  // calls isEmptyContextUpdate before any DB hit. GuestContextPatchSchema is
  // aggressively permissive (every nested field optional, unknown keys
  // stripped) so a malformed near-miss patch doesn't trigger the regen loop —
  // the model's MESSAGE quality is what regen exists to fix, not its
  // context-capture spelling.
  contextUpdate: z.object({
    structured: GuestContextPatchSchema.optional(),
    observation: z.string().optional(),
  }),
  // TAC-297: agent emits a commitment object when the reply offers something
  // we'll have ready for the guest — comp, hold, off-menu rec, discount. Same
  // rigid-presence / optional-inner posture as contextUpdate (TAC-296). When
  // type ∈ {comp, hold, discount}, the approval-policy gate's
  // COMMITMENT_TYPE_GATED trigger fires regardless of requiresOperatorApproval
  // — structural backstop per the TAC-297 plan-review call #2.
  commitment: CommitmentEmissionSchema,
  // TAC-297: agent emits an arrivalCapture object when the guest's inbound
  // signals arrival in response to an active commitment surfaced in the
  // ## Active commitments user-prompt block. signal='imminent' triggers
  // immediate transitionToPendingAck + push; signal='scheduled' stores
  // expected_arrival for the hourly cron to fire.
  arrivalCapture: ArrivalCaptureEmissionSchema,
  // TAC-513: the commitment this reply WITHDRAWS, by id, copied verbatim from
  // the `id:` on a line of the ## Active commitments block. Empty string when
  // the reply cancels nothing, which is almost every turn.
  //
  // A BARE REQUIRED STRING rather than a nested optional object, for the reason
  // knowledgeGap is a bare required boolean: Anthropic counts only optionals
  // against the 24-property cap, this schema sits at exactly 20 against a repo
  // budget of 22 (lib/ai/schema-budget.test.ts), and a nested
  // `{ commitmentId?: string }` would cost 2 and land on the budget line.
  // The sentinel is '' and the schema does not police it; resolveCancellation
  // does, against the guest's own rendered list.
  //
  // BY ID, NOT BY CODE. The 4-char verification code is not unique (31-char
  // alphabet, no constraint) and is NULL on every recommendation, so it cannot
  // address half the rows it would need to. TAC-302 is the recorded failure:
  // through v1.17.0 the id was missing from the block, the model reached for
  // the code instead, and every arrival capture no-op'd.
  cancelsCommitmentId: z.string(),
})

/**
 * Generate an outbound message in the venue's voice with a self-assessed
 * voice-fidelity score.
 *
 * Calls the model up to MAX_ATTEMPTS (3) times, returning the first attempt
 * that scores >= MIN_VOICE_FIDELITY (0.7). If no attempt clears the threshold,
 * returns the final attempt regardless. Callers should still consult
 * voiceFidelity on the result, since the loop may terminate without crossing
 * threshold and the caller may want to flag the message for operator review.
 *
 * Pure transformer. No DB writes. The caller is responsible for persisting
 * the message.
 */
export async function generateMessage(
  input: GenerateMessageInput,
): Promise<AIResult<GenerateMessageResult>> {
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof input.persona !== 'object' ||
    input.persona === null ||
    typeof input.venueInfo !== 'object' ||
    input.venueInfo === null ||
    !Array.isArray(input.ragChunks) ||
    typeof input.runtime !== 'object' ||
    input.runtime === null ||
    // TAC-495: null is a real answer (unknown channel). Anything else that is
    // not a channel, such as an undefined smuggled past the type by a cast,
    // fails here as a value rather than silently becoming the SMS copy.
    (input.channel !== null && !isMessageChannel(input.channel))
  ) {
    return { ok: false, error: 'invalid_input' }
  }

  // TAC-509: the curated link allowlist for this venue. Computed ONCE, above
  // the loop, so every attempt is judged against the same list.
  //
  // `venue_info.links` and nothing else. Deliberately NOT derived from the
  // retrieved knowledge chunks, the composed prompt or `venue_info.contact`:
  // a link is sendable because a human put it on a list, not because it turned
  // up somewhere in context. An empty list is a normal state and means no link
  // may be sent at all.
  const allowedUrls = parseVenueLinks(input.venueInfo.links).map((l) => l.url)

  const { systemPrompt, cacheableSystemPrefix, volatileSystemSuffix, userPrompt } =
    composePrompt(input)
  const augmentedSystemPrompt = `${systemPrompt}\n\n${VOICE_FIDELITY_INSTRUCTION}`
  // Same bytes as augmentedSystemPrompt, split at the stability boundary so a
  // cache breakpoint can sit between them. The voice-fidelity instruction
  // stays where it has always been — last, after the category block — so the
  // rendered content is unchanged; only the block count is.
  const volatileSystemBlock = `${volatileSystemSuffix}\n\n${VOICE_FIDELITY_INSTRUCTION}`

  // Hoisted out of the try so the catch's diagnostic log can include which
  // attempt was in-flight when generateObject threw.
  let attempts = 0

  try {
    let lastResult: {
      body: string
      voiceFidelity: number
      reasoning: string
      requiresOperatorApproval: boolean
      approvalReason: string
      complaintIntent: z.infer<typeof GeneratedMessageSchema>['complaintIntent']
      knowledgeGap: boolean
      contextUpdate: {
        structured?: z.infer<typeof GuestContextPatchSchema>
        observation?: string
      }
      commitment: z.infer<typeof CommitmentEmissionSchema>
      arrivalCapture: z.infer<typeof ArrivalCaptureEmissionSchema>
      cancelsCommitmentId: string
    } | null = null
    const attemptScores: number[] = []
    const attemptHistory: GenerateMessageAttempt[] = []
    // THE-225, made STICKY by the TAC-509 follow-up (ruled 2026-09-21).
    //
    // Once a check has fired on ANY attempt of this call, its constraint stays
    // in every later attempt's prompt. It used to be rebuilt from scratch each
    // iteration out of only the just-completed attempt's violations, so a
    // directive was dropped the moment its own check passed even when the loop
    // carried on for a different reason.
    //
    // That drop was safe BY CONSTRUCTION while the dash was the only
    // non-fidelity check: a dash-clean attempt that also passed fidelity broke
    // the loop, so nothing came after it to reintroduce a dash. TAC-355
    // (self-talk) and TAC-509 (unverified links) each added a reason to keep
    // looping past a dash-clean body, and the loop returns the LAST attempt
    // rather than the best one, so the dropped directive started costing
    // real drafts. The live case, Le Mil's 2026-09-21: attempt 1 had a dash
    // and an unlisted link, attempt 2 fixed the dash and kept the link so the
    // dash constraint left the prompt, attempt 3 worked on the link and put a
    // dash back. That body is what was held.
    //
    // Every constraint is therefore worded as a STANDING RULE rather than as
    // feedback about the previous attempt ("do not use a dash character",
    // never "your previous attempt contained a dash"). A sticky directive
    // phrased as a report becomes a false statement the moment it outlives the
    // attempt it describes.
    //
    // null on the first attempt — the parent userPrompt is sent verbatim.
    let regenFeedback: string | null = null
    let dashConstraintActive = false
    let selfTalkConstraintActive = false
    // Order-preserving and deduped, so a link flagged on attempt 1 is still
    // named on attempt 3 alongside anything new attempt 2 invented.
    const unverifiedUrlsSeen: string[] = []

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      attempts++
      const userPromptForAttempt = regenFeedback
        ? `${userPrompt}\n\n${regenFeedback}`
        : userPrompt
      const { object } = await generateObject({
        model: getGenerationModel(),
        // Two adjacent system messages, not one `system` string: the provider
        // maps each to its own Anthropic system text block and honours a
        // per-block cache_control (see @ai-sdk/anthropic's convert step). The
        // breakpoint goes on the first — template + persona + venue info,
        // stable for the (venue, channel) pair and ~10k tokens on its own,
        // comfortably over Sonnet 4.6's 1024-token cacheable minimum.
        //
        // The second block is deliberately UNCACHED: it carries the retrieved
        // RAG and knowledge chunks plus the category instructions, all of
        // which change per message. Marking it too would write a fresh entry
        // every call and read none, paying the write premium for nothing.
        //
        // ttl '1h', not the 5m default, CHOSEN FROM THE TRAFFIC (measured
        // 2026-09-23 over the last 500 inbound rows). A cache entry only pays
        // off if the next message to the same venue lands inside the window,
        // and pilot traffic is bursty with long quiet stretches:
        //
        //   venue           gap <= 5min     gap <= 60min
        //   4c523772           61%              82%
        //   5cd8231f           69%              82%
        //   a17e75d6           52%              78%
        //
        // A 5m window misses roughly a third of messages and pays the write
        // premium on each miss. 1h doubles the write premium (2x vs 1.25x)
        // but lifts the hit rate to ~82%, which is cheaper on net at these
        // volumes AND is the difference between the cache helping most
        // replies and helping half of them. Re-derive this if traffic shape
        // changes — the query is in CLAUDE.md under "Latency and cost".
        messages: [
          {
            role: 'system',
            content: cacheableSystemPrefix,
            providerOptions: {
              anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
            },
          },
          { role: 'system', content: volatileSystemBlock },
          { role: 'user', content: userPromptForAttempt },
        ],
        schema: GeneratedMessageSchema,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      })
      lastResult = object
      attemptScores.push(object.voiceFidelity)
      attemptHistory.push({
        body: object.body,
        voiceFidelity: object.voiceFidelity,
        reasoning: object.reasoning,
        requiresOperatorApproval: object.requiresOperatorApproval,
        approvalReason: object.approvalReason,
        complaintIntent: object.complaintIntent,
        knowledgeGap: object.knowledgeGap,
        contextUpdate: object.contextUpdate,
        commitment: object.commitment,
        arrivalCapture: object.arrivalCapture,
        cancelsCommitmentId: object.cancelsCommitmentId,
        userPromptOverride:
          userPromptForAttempt !== userPrompt ? userPromptForAttempt : undefined,
      })
      const hasDash = DASH_REGEX.test(object.body)
      const hasSelfTalk = matchSelfTalk(object.body).matched
      const badUrls = findUnverifiedUrls(object.body, allowedUrls)
      const fidelityPass = object.voiceFidelity >= MIN_VOICE_FIDELITY
      if (fidelityPass && !hasDash && !hasSelfTalk && badUrls.length === 0) break
      // Accumulate, never reset. All three compose (a body can trip more than
      // one at once — the motivating incident tripped two) rather than one
      // winning over the other, and each stays set for the rest of the call.
      if (hasDash) dashConstraintActive = true
      if (hasSelfTalk) selfTalkConstraintActive = true
      for (const url of badUrls) {
        if (!unverifiedUrlsSeen.includes(url)) unverifiedUrlsSeen.push(url)
      }
      const feedbackParts: string[] = []
      if (dashConstraintActive) feedbackParts.push(DASH_CONSTRAINT)
      if (selfTalkConstraintActive) feedbackParts.push(SELF_TALK_CONSTRAINT)
      if (unverifiedUrlsSeen.length > 0) {
        feedbackParts.push(unverifiedUrlConstraint(unverifiedUrlsSeen))
      }
      // feedbackParts is non-empty here whenever any check has ever fired, so
      // this only stays null while every failure so far has been fidelity.
      regenFeedback = feedbackParts.length > 0 ? feedbackParts.join('\n\n') : null
    }

    if (lastResult === null) {
      return { ok: false, error: 'no_result_returned', errorCode: 'ai_generation_failed' }
    }

    return {
      ok: true,
      data: {
        body: lastResult.body,
        voiceFidelity: lastResult.voiceFidelity,
        reasoning: lastResult.reasoning,
        // TAC-212: model self-flag for the approval-policy gate. Carries
        // through to applyApprovalPolicyStage and is recorded on the
        // draft_queued PostHog event when the gate queues.
        requiresOperatorApproval: lastResult.requiresOperatorApproval,
        complaintIntent: lastResult.complaintIntent,
        approvalReason: lastResult.approvalReason,
        // TAC-308: final-attempt knowledge-gap flag. applyApprovalPolicyStage
        // turns this into the KNOWLEDGE_GAP trigger (inbound only), which
        // queues the draft and arms messages.pending_until.
        knowledgeGap: lastResult.knowledgeGap,
        // TAC-296: final-attempt context update. Orchestrator's context-write
        // step (between generateStage success and applyApprovalPolicyStage)
        // calls updateGuestContext with this payload.
        contextUpdate: lastResult.contextUpdate,
        // TAC-297: final-attempt commitment emission. Orchestrator threads
        // this onto messages.pending_commitment for gated paths (intent
        // carrier through the approval queue) or materializes inline for
        // recommendation auto-sends. Empty emission shape `{}` is the
        // no-op; isEmptyCommitmentEmission short-circuits before any DB hit.
        commitment: lastResult.commitment,
        // TAC-297: final-attempt arrival capture. Orchestrator dispatches
        // independently of the approval-gate outcome — what the agent
        // UNDERSTOOD from the inbound is independent of what the agent
        // SAID back (TAC-296 precedent).
        arrivalCapture: lastResult.arrivalCapture,
        cancelsCommitmentId: lastResult.cancelsCommitmentId,
        attempts,
        attemptScores,
        attemptHistory,
        // System prompt sent to the model is the augmented one — what THE-160's
        // voice-fidelity instruction tacks on is part of what the model saw,
        // so the trace should match.
        systemPrompt: augmentedSystemPrompt,
        userPrompt,
        promptVersion: PROMPT_VERSION,
        // THE-225: recompute on the final shipped body rather than threading
        // loop state. Equivalent and lets us drop the variable.
        dashViolationPersisted: DASH_REGEX.test(lastResult.body),
        // TAC-355: same recompute-on-final-body pattern as dashViolationPersisted.
        // Unlike the dash case, a true here means the draft must NOT ship —
        // see lib/agent/stages.ts's SELF_TALK_DETECTED trigger.
        selfTalkViolationPersisted: matchSelfTalk(lastResult.body).matched,
        // TAC-509: same recompute-on-final-body pattern. Like self-talk and
        // unlike a dash, a true here must NOT ship — lib/agent/stages.ts's
        // UNVERIFIED_URL trigger queues the draft. The links themselves ride
        // along so the operator event can say which ones were wrong; a gate
        // whose true-positive history cannot be produced on demand is an
        // unproven gate (CLAUDE.md, Common gotchas).
        unverifiedUrls: findUnverifiedUrls(lastResult.body, allowedUrls),
        // TAC-362: same recompute-on-final-body pattern as the two above.
        // Only meaningful when this turn's directive was 'none' — 'allowed'
        // and absent have nothing to violate. Ships either way (the measured
        // violation rate is 0 in 240 responses); lib/agent/stages.ts emits a
        // PostHog observation so a change in that rate announces itself
        // instead of being discovered in a UAT session.
        emojiDirectiveViolated:
          input.runtime.emojiDirective === 'none' && containsEmoji(lastResult.body),
      },
    }
  } catch (e) {
    // Diagnostic logging for THE-159 (will be replaced by structured alerts).
    // When generateObject can't parse Sonnet's response into the schema, the
    // top-level error message ("No object generated: response did not match
    // schema") drops everything useful — raw text, cause, Zod issue paths.
    // Walk the error to surface them so the next failure is debuggable from
    // Vercel logs alone. Logs ARE in addition to the existing alert: we still
    // return the failure result below, which the orchestrator turns into an
    // AgentResult.failed and fires fireRedAlert.
    if (NoObjectGeneratedError.isInstance(e)) {
      const cause = e.cause
      const causeName = cause instanceof Error ? cause.name : null
      const causeMessage = cause instanceof Error ? cause.message : null
      const innerCause =
        cause instanceof Error ? (cause as Error & { cause?: unknown }).cause : undefined
      const issues =
        innerCause && typeof innerCause === 'object' && innerCause !== null && 'issues' in innerCause
          ? (innerCause as { issues: unknown }).issues
          : undefined
      console.log('[agent] generation diagnostic', {
        attempts,
        text: e.text ? e.text.slice(0, 1000) : null,
        finishReason: e.finishReason,
        usage: e.usage,
        message: e.message,
        causeName,
        causeMessage,
        zodIssues: issues ?? null,
      })
      // TAC-309: surface truncation without a Vercel log dig. `finishReason:
      // 'length'` means the emission hit MAX_OUTPUT_TOKENS and was cut
      // mid-JSON — a fixable ceiling problem, not a model-behavior problem,
      // and the two are indistinguishable from the generic parse error alone.
      // It took a UAT session to find the first one. Fire-and-forget; a
      // failure to report a failure must not deepen it.
      if (e.finishReason === 'length') {
        // Awaited, not floated: on Vercel a pending fetch can be lost when the
        // function freezes, and this is the alert that makes truncation
        // visible at all. The path has already failed, so the added latency
        // costs nothing anyone is waiting on.
        await captureGenerationTruncated({
          attempts,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          promptVersion: PROMPT_VERSION,
          truncatedTextPreview: e.text ? e.text.slice(0, 500) : null,
        })
      }
    }
    const message = e instanceof Error ? e.message : String(e)
    const truncated =
      NoObjectGeneratedError.isInstance(e) && e.finishReason === 'length'
    return {
      ok: false,
      error: message,
      errorCode: truncated ? AI_ERROR_TRUNCATED : 'ai_generation_failed',
    }
  }
}