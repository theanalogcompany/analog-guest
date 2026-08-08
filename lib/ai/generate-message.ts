import { generateObject, NoObjectGeneratedError } from 'ai'
import { z } from 'zod'
import {
  ArrivalCaptureEmissionSchema,
  CommitmentEmissionSchema,
} from '@/lib/schemas/guest-commitment'
import { GuestContextPatchSchema } from '@/lib/schemas/guest-context'
import { captureGenerationTruncated } from '@/lib/analytics/posthog'
import { getGenerationModel } from './client'
import { composePrompt } from './compose-prompt'
import { PROMPT_VERSION } from './prompts/system-template'
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
const DASH_REGEN_FEEDBACK =
  'Your previous attempt contained a dash character (— or –). Rewrite without it, using a period or comma instead.'

// THE-160: pin the voiceFidelity scale unambiguously in the prompt. The Zod
// schema uses .refine() (per THE-157) so .min/.max don't get serialized into
// JSON Schema; without this instruction Sonnet defaults to a 1–10 confidence
// scale and returns e.g. 9 instead of 0.9, which then fails the [0,1] refine
// check and rejects the entire structured-output response.
const VOICE_FIDELITY_INSTRUCTION = `# Voice fidelity self-assessment (output field)
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
    input.runtime === null
  ) {
    return { ok: false, error: 'invalid_input' }
  }

  const { systemPrompt, userPrompt } = composePrompt(input)
  const augmentedSystemPrompt = `${systemPrompt}\n\n${VOICE_FIDELITY_INSTRUCTION}`

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
    } | null = null
    const attemptScores: number[] = []
    const attemptHistory: GenerateMessageAttempt[] = []
    // THE-225: when the previous attempt tripped the dash regex, append a
    // rewrite directive to the next attempt's user prompt. Reset to null when
    // the previous attempt was clean (so a fidelity-only retry doesn't carry
    // stale dash feedback). null on the first attempt — parent userPrompt is
    // sent verbatim.
    let regenFeedback: string | null = null

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      attempts++
      const userPromptForAttempt = regenFeedback
        ? `${userPrompt}\n\n${regenFeedback}`
        : userPrompt
      const { object } = await generateObject({
        model: getGenerationModel(),
        system: augmentedSystemPrompt,
        prompt: userPromptForAttempt,
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
        userPromptOverride:
          userPromptForAttempt !== userPrompt ? userPromptForAttempt : undefined,
      })
      const hasDash = DASH_REGEX.test(object.body)
      const fidelityPass = object.voiceFidelity >= MIN_VOICE_FIDELITY
      if (fidelityPass && !hasDash) break
      // Set feedback for the next iteration. Dash always wins — even if
      // fidelity also failed, the rewrite directive is the more actionable
      // signal. When neither dash nor a fidelity-specific feedback message
      // applies, clear so a stale dash directive doesn't carry forward.
      regenFeedback = hasDash ? DASH_REGEN_FEEDBACK : null
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