// TAC-308: per-card orchestrator for the holding message.
//
// Fired by the timer processor (lib/agent/knowledge-gap-timeout.ts) AFTER it
// has won the CAS claim on `messages.pending_until`. Winning that claim is
// the right to send exactly one holding message for this card; this module
// assumes it and never re-checks.
//
// It is the fourth orchestrator in lib/agent/, alongside handle-inbound,
// handle-followup, and handle-operator-decline. Two things make it different
// from all three:
//
//   1. It SENDS with no operator in the loop. Every other outbound in this
//      repo either passes the approval gate or is an operator action. What
//      makes that acceptable here is that the message is content-free by
//      construction: it asserts nothing about the venue, commits to no time,
//      names no fact. A bad generation is an awkward sentence, not a false
//      statement to a guest. The prompt block enforces the shape and the
//      failure ladder below enforces that something goes out.
//
//   2. It runs the real gates and treats "queue" as a FAILURE. The gate has
//      nowhere to put a queued draft — the knowledge-gap card is already
//      holding this guest's one pending slot (migration 020) — so a holding
//      message that trips any trigger is regenerated once and then replaced
//      with a plain line. Silence is the worse outcome (TAC-308 decision #7).
//
// Failure ladder, in order:
//   attempt 1 → generate + gate. Clean → send.
//   attempt 2 → same, once. Clean → send.
//   fallback  → send FALLBACK_HOLDING_BODY, a fixed string.
// The fallback is not a template on the happy path; it exists so a guest who
// has been waiting never gets nothing. If it ever shows up in production
// twice in a week, the generation prompt is wrong, not the ladder.

import { randomUUID } from 'node:crypto'
import { createAdminClient } from '@/lib/db/admin'
import { capturePostHogEvent, fireRedAlert } from './alerts'
import { buildRuntimeContext } from './build-runtime-context'
import { scheduleAndSend } from './schedule-and-send'
import {
  applyApprovalPolicyStage,
  generateStage,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
  shouldRetrieveKnowledge,
} from './stages'
import { startAgentTrace } from '@/lib/observability'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import type { GenerateMessageResult, PendingQuestion } from '@/lib/ai'
import type { RuntimeContext } from './types'

/**
 * Last-resort body when two generation attempts both fail the gates.
 *
 * Deliberately says less than a generated line would: no venue voice to get
 * wrong, no time, no promise, no attempt at the answer. Lowercase to sit
 * closer to how the venues actually text than a capitalized system string
 * would.
 */
export const FALLBACK_HOLDING_BODY = "still checking on that for you"

/** How many times generation may be attempted before the fallback. */
export const HOLDING_MESSAGE_MAX_ATTEMPTS = 2

/**
 * The category holding messages persist as.
 *
 * `manual` rather than `acknowledgment`: migration 003 added
 * `acknowledgment` for exactly this kind of holding note, but v1.10.0
 * re-pointed its category instructions at guest sign-offs ("thanks!",
 * "see you then"), so routing here would apply the wrong instruction set.
 * `manual` carries venue-initiated content framing, which is what this is.
 */
const HOLDING_MESSAGE_CATEGORY = 'manual' as const

export type HoldingMessageResult =
  | { status: 'sent'; outboundMessageId: string; usedFallback: boolean }
  // Deliberately not sent. The guest opted out, or the venue holds every
  // outbound for review. Distinct from 'failed' so the processor can count
  // policy suppression separately from breakage.
  | { status: 'suppressed'; reason: 'opted_out' | 'hold_all_outbound' }
  | { status: 'failed'; stage: 'context_build' | 'send'; error: string }

/**
 * Generate and send the holding message for one knowledge-gap card.
 *
 * The caller MUST have won the pending_until CAS first. Never throws —
 * returns a result the processor folds into its counts.
 */
export async function handleHoldingMessage(input: {
  venueId: string
  guestId: string
  /** The guest's outstanding question + when they asked it. */
  pendingQuestion: Omit<PendingQuestion, 'mode'>
}): Promise<HoldingMessageResult> {
  const agentRunId = randomUUID()
  const trace = startAgentTrace({
    name: 'agent.holding_message',
    agentRunId,
    metadata: { venueId: input.venueId, guestId: input.guestId },
  })

  try {
    let ctx: RuntimeContext
    try {
      ctx = await buildRuntimeContext({
        agentRunId,
        guestId: input.guestId,
        venueId: input.venueId,
        // Outbound path. There is no new inbound — the guest hasn't said
        // anything since the question. reason='manual' puts us on the
        // followup side of the inbound-XOR-outbound invariant; buildAiRuntime
        // has a TAC-308 carve-out that suppresses its generic "the operator
        // asked you to follow up" line when mode='writing_holding', because
        // no operator asked for this and that line would compete with the
        // ## Unanswered question block that carries the real brief.
        followupTrigger: { reason: 'manual', triggeredAt: new Date() },
        trace,
      })
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      await fireRedAlert({
        agentRunId,
        venueId: input.venueId,
        guestId: input.guestId,
        kind: 'followup',
        stage: 'context_build',
        errorMessage: errMsg,
      })
      return { status: 'failed', stage: 'context_build', error: errMsg }
    }

    // Opt-out guard. Every other autonomous outbound surface checks this
    // before sending (the followup engine's venue scan, canSendFollowup,
    // dispatchOperatorOutbound, the Command Center follow-up route). This is
    // a fourth one, and it has a real reachable window: the guest asks an
    // unanswerable question, then texts STOP inside the 5-to-15 minutes
    // before the timer fires. The opt-out confirmation itself auto-sends via
    // the TAC-308 carve-out and leaves the card and its clock intact, so
    // without this check the holding message goes to someone who just left.
    if (await isOptedOut(input.guestId)) {
      console.log('[agent] holding message suppressed — guest opted out', {
        agentRunId,
        guestId: input.guestId,
      })
      return { status: 'suppressed', reason: 'opted_out' }
    }

    // A venue running hold_all_outbound (migration 031) has said every
    // guest-facing message gets human eyes first. The holding message can't
    // honor that — the gate has nowhere to queue it (the card owns this
    // guest's one pending slot) and the fallback bypasses the gate by
    // design, so shipping it would override the venue's explicit setting
    // without anyone deciding to. Skip instead: the card is already in their
    // queue, and a venue that reviews everything has accepted slower replies.
    if (ctx.venue.holdAllOutbound === true) {
      console.log('[agent] holding message suppressed — venue holds all outbound', {
        agentRunId,
        venueId: input.venueId,
      })
      return { status: 'suppressed', reason: 'hold_all_outbound' }
    }

    // Override whatever build-runtime-context loaded. It reports
    // 'outstanding' (it can't know a timer is mid-fire), and this run IS the
    // holding message — the mode is what flips the prompt block from "don't
    // promise anything" to "write the holding note."
    ctx.pendingQuestion = {
      question: input.pendingQuestion.question,
      askedAt: input.pendingQuestion.askedAt,
      mode: 'writing_holding',
    }

    // Persisted category. HOLDING_MESSAGE_CATEGORY was already driving
    // generation and knowledge retrieval, but buildOutboundInsert reads the
    // category off ctx.classification — which nothing set here, so the row
    // landed with category=null while the constant's comment claimed
    // otherwise. Both sibling orchestrators set this; so does this one now.
    ctx.classification = {
      category: HOLDING_MESSAGE_CATEGORY,
      classifierConfidence: 1,
      reasoning: 'TAC-308 holding message (system-initiated, not classified)',
    }

    try {
      ctx.corpus = await retrieveCorpusStage(ctx)
    } catch (e) {
      // Outbound path, so retrieveCorpusStage does NOT enforce the
      // strong-match floor (THE-231) — a throw here means Voyage or the DB
      // is down, not thin retrieval. No corpus means no voice, and a
      // voiceless holding message is exactly what the fallback is for.
      const errMsg = e instanceof Error ? e.message : String(e)
      console.warn(
        `[agent] holding message corpus retrieval failed for guest=${input.guestId}, using fallback: ${errMsg}`,
      )
      return await sendFallback(ctx, agentRunId, 'corpus_failed')
      // NOTE: no 'corpus' failure stage exists on HoldingMessageResult — this
      // path always resolves to the fallback's sent-or-failed, never to a
      // corpus-specific failure.
    }

    ctx.knowledgeCorpus = shouldRetrieveKnowledge(ctx)
      ? await retrieveKnowledgeStage(ctx, HOLDING_MESSAGE_CATEGORY)
      : []

    for (let attempt = 1; attempt <= HOLDING_MESSAGE_MAX_ATTEMPTS; attempt++) {
      const generated = await tryGenerateHolding(ctx, agentRunId, attempt)
      if (generated === null) continue

      const sendSpan = trace.span('send', { attempt, bodyLength: generated.body.length })
      try {
        const { outboundMessageId } = await scheduleAndSend(ctx, generated, {
          // The guest has already waited out the whole window. Adding
          // typing-indicator theatre to a message that is late by
          // construction makes it later for no gain.
          skipHumanFeelDelay: true,
        })
        sendSpan.end({ output: { outboundMessageId, attempt } })
        await capturePostHogEvent('holding_message_sent', input.guestId, {
          agentRunId,
          venueId: input.venueId,
          guestId: input.guestId,
          outboundMessageId,
          attempt,
          usedFallback: false,
          voiceFidelity: generated.voiceFidelity,
          body: generated.body,
        })
        return { status: 'sent', outboundMessageId, usedFallback: false }
      } catch (e) {
        // Sendblue failed. Retrying generation won't help — a second
        // well-written message has the same transport underneath it — so
        // stop here rather than burning the ladder on a network fault.
        const errMsg = e instanceof Error ? e.message : String(e)
        sendSpan.end({ level: 'ERROR', statusMessage: errMsg })
        return { status: 'failed', stage: 'send', error: errMsg }
      }
    }

    return await sendFallback(ctx, agentRunId, 'gates_failed')
  } finally {
    await trace.flushAsync()
  }
}

/**
 * One generation attempt, gated. Returns the result when it's clean enough to
 * send, or null when this attempt should be retried / fall through.
 *
 * "Clean" means BOTH: generateStage didn't refuse (voice fidelity above
 * SEND_FIDELITY_FLOOR), and the approval gate returned `send`. A gate that
 * says `queue` or `drop` is a failure here, not a route — there is no slot to
 * queue into, because the knowledge-gap card owns it.
 */
async function tryGenerateHolding(
  ctx: RuntimeContext,
  agentRunId: string,
  attempt: number,
): Promise<GenerateMessageResult | null> {
  const gen = await generateStage(ctx, HOLDING_MESSAGE_CATEGORY)
  if (gen.status !== 'success') {
    console.warn(
      `[agent] holding message generation attempt ${attempt} did not succeed (${gen.status}) for guest=${ctx.guest.id}`,
    )
    return null
  }

  const approval = await applyApprovalPolicyStage(ctx, gen.result)
  if (approval.action !== 'send') {
    console.warn(
      `[agent] holding message attempt ${attempt} blocked by approval gate (${approval.action}) for guest=${ctx.guest.id}`,
      { agentRunId, triggers: approval.triggers },
    )
    return null
  }
  return gen.result
}

/**
 * Send the fixed fallback line.
 *
 * Bypasses generation and the gate entirely — by this point both have been
 * given their chances, and the fallback's whole justification is that it
 * cannot be gated into silence. It carries no venue claim to review.
 */
async function sendFallback(
  ctx: RuntimeContext,
  agentRunId: string,
  cause: 'corpus_failed' | 'gates_failed',
): Promise<HoldingMessageResult> {
  const fallbackGeneration = buildFallbackGeneration()
  try {
    const { outboundMessageId } = await scheduleAndSend(ctx, fallbackGeneration, {
      skipHumanFeelDelay: true,
    })
    console.warn('[agent] holding message used plain fallback', {
      agentRunId,
      guestId: ctx.guest.id,
      cause,
    })
    await capturePostHogEvent('holding_message_sent', ctx.guest.id, {
      agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      outboundMessageId,
      attempt: HOLDING_MESSAGE_MAX_ATTEMPTS + 1,
      usedFallback: true,
      fallbackCause: cause,
      body: FALLBACK_HOLDING_BODY,
    })
    // Slack-relayed alert: the fallback firing means the generation path
    // couldn't produce a sendable holding message, which is a prompt problem
    // worth seeing rather than a per-guest blip.
    await fireRedAlert({
      agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      kind: 'followup',
      stage: 'generation',
      errorMessage: `holding message fell back to plain line (${cause})`,
      extra: { cause, outboundMessageId },
    })
    return { status: 'sent', outboundMessageId, usedFallback: true }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    return { status: 'failed', stage: 'send', error: errMsg }
  }
}

/**
 * Has this guest opted out?
 *
 * Read fresh rather than taken from the runtime context, because the whole
 * risk window is a STOP that arrived after the card was created. Fails
 * CLOSED — a read error suppresses the send. An unsent holding message costs
 * a guest a few minutes of silence; a message to someone who opted out is a
 * compliance problem.
 */
async function isOptedOut(guestId: string): Promise<boolean> {
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('guests')
      .select('opted_out_at')
      .eq('id', guestId)
      .maybeSingle()
    if (error) {
      console.warn(
        `[agent] holding message opt-out check failed for guest=${guestId}, suppressing: ${error.message}`,
      )
      return true
    }
    return data?.opted_out_at !== null && data?.opted_out_at !== undefined
  } catch (e) {
    console.warn(
      `[agent] holding message opt-out check threw for guest=${guestId}, suppressing: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    return true
  }
}

/**
 * Wrap FALLBACK_HOLDING_BODY in the GenerateMessageResult shape scheduleAndSend
 * persists from.
 *
 * voiceFidelity 0 is honest: nothing here was matched to the venue's voice.
 * It also reads correctly in the conversation viewer and in any fidelity
 * aggregate — this row genuinely is not a voice sample, and should never be
 * mistaken for one or fed back as a corpus exemplar.
 */
function buildFallbackGeneration(): GenerateMessageResult {
  return {
    body: FALLBACK_HOLDING_BODY,
    voiceFidelity: 0,
    reasoning: 'TAC-308 plain fallback: generation attempts did not clear the gates',
    requiresOperatorApproval: false,
    approvalReason: '',
    complaintIntent: 'none',
    knowledgeGap: false,
    contextUpdate: {},
    commitment: {},
    arrivalCapture: {},
    attempts: 0,
    attemptScores: [],
    attemptHistory: [],
    systemPrompt: '',
    userPrompt: '',
    // Stamped so the row is attributable to the release that produced this
    // behavior, even though no prompt built the body.
    promptVersion: PROMPT_VERSION,
    dashViolationPersisted: false,
  }
}
