import { randomUUID } from 'node:crypto'
import { waitUntil } from '@vercel/functions'
import {
  AGENT_LATENCY_HIGH_THRESHOLD_MS,
  captureAgentLatencyHigh,
  captureDraftDropped,
  captureDraftQueued,
  captureDraftRegenerated,
  captureManualFollowupSlotOccupied,
} from '@/lib/analytics/posthog'
import {
  isEmptyContextUpdate,
  updateGuestContext,
} from '@/lib/guests/context'
import { dispatchArrivalCapture } from './dispatch-arrival-capture'
import { sendDraftFlaggedPush, shouldSendDraftFlaggedPush } from '@/lib/notifications/send'
import { startAgentTrace } from '@/lib/observability'
import { capturePostHogEvent, fireRedAlert } from './alerts'
import { buildRuntimeContext } from './build-runtime-context'
import type { CommitmentIdentity, SlotDropReason } from './pending-slots'
import { persistOrRegenQueuedDraft, scheduleAndSend } from './schedule-and-send'
import {
  applyApprovalPolicyStage,
  operatorInstructionQuery,
  retrieveKnowledgeStage,
  APPROVAL_TRIGGERS,
  generateStage,
  retrieveCorpusStage,
  verifyMechanicOfferStage,
} from './stages'
import {
  buildCorpusContent,
  buildGenerateAttemptContent,
  buildGenerateContent,
  buildKnowledgeCorpusContent,
  buildRecognitionContent,
} from './trace-content'
import type {
  AgentResult,
  Classification,
  FollowupTrigger,
  RuntimeContext,
} from './types'

/**
 * TAC-394: report a followup draft that had nowhere to go.
 *
 * A refused MANUAL followup ('slot_occupied': a Follow Up click that would have
 * queued into a slot a pending card already holds) is logged and recorded as
 * its own event, never skipped silently; the Command Center route tells the
 * operator who clicked. Every other drop goes to captureDraftDropped, which
 * Slack-relays and names both commitments and the guest.
 */
async function reportFollowupDrop(args: {
  ctx: RuntimeContext
  agentRunId: string
  triggerReason: FollowupTrigger['reason']
  category: string
  drop: {
    reason: SlotDropReason
    protectedDraftId: string
    protectedCommitment: CommitmentIdentity | null
    droppedCommitment: CommitmentIdentity | null
  }
  triggers: string[]
  droppedBody: string
  viaRaceRecovery: boolean
}): Promise<void> {
  const { ctx, agentRunId, drop } = args
  if (drop.reason === 'slot_occupied') {
    console.warn('[agent] manual followup refused: a card for this guest is already waiting', {
      agentRunId,
      triggerReason: args.triggerReason,
      waitingDraftId: drop.protectedDraftId,
      triggers: args.triggers,
      viaRaceRecovery: args.viaRaceRecovery,
    })
    await captureManualFollowupSlotOccupied({
      agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      waitingDraftId: drop.protectedDraftId,
      triggers: args.triggers,
    })
    return
  }
  console.warn('[agent] followup draft dropped: a pending card holds its slot', {
    agentRunId,
    triggerReason: args.triggerReason,
    reason: drop.reason,
    protectedDraftId: drop.protectedDraftId,
    triggers: args.triggers,
    viaRaceRecovery: args.viaRaceRecovery,
  })
  await captureDraftDropped({
    agentRunId,
    venueId: ctx.venue.id,
    guestId: ctx.guest.id,
    guestFirstName: ctx.guest.firstName,
    guestPhone: ctx.guest.phoneNumber,
    reason: drop.reason,
    protectedDraftId: drop.protectedDraftId,
    protectedCommitment: drop.protectedCommitment,
    droppedCommitment: drop.droppedCommitment,
    triggers: args.triggers,
    kind: 'followup',
    category: args.category,
    droppedBody: args.droppedBody,
  })
}

function triggerToCategory(reason: FollowupTrigger['reason']): Classification['category'] {
  switch (reason) {
    case 'day_1':
    case 'day_3':
    case 'day_7':
    case 'day_14':
    // TAC-244 forward-scaffolds cold_lapsed for the TAC-123 engine. Same
    // follow_up category; the `## Follow-up context` block carries the
    // re-engagement framing.
    case 'cold_lapsed':
    // TAC-123 plan-review call: engine-initiated perk_unlock runs persist as
    // `category='follow_up'` (NOT 'perk_unlock'), so the follow_up category
    // instruction set — including its perk-weaving clause — applies. The
    // existing 'perk_unlock' MessageCategory is reserved for the inbound /
    // standalone perk moment; engine outreach is a different tuning and
    // stays inside the follow_up bucket. The actual perk detail rides via
    // `RuntimeContext.perkBeingUnlocked` + a `'perk_unlock'` entry in
    // `FollowupContext.reasons`.
    case 'perk_unlock':
      return 'follow_up'
    case 'event':
      return 'event_invite'
    case 'manual':
      return 'manual'
  }
}

/**
 * Top-level orchestrator for outbound followup messages.
 *
 * Server-only. Triggered by a cron / scheduler with a {venueId, guestId,
 * trigger} payload — there is no followups table in v1; the trigger is
 * passed live, not persisted. Generates an agentRunId then runs the pipeline:
 *   buildRuntimeContext → (synthesize Classification from trigger) →
 *   retrieveCorpusStage → generateStage → scheduleAndSend.
 *
 * Skips classification — there's no inbound to classify. The Classification
 * is derived from the trigger reason (day_* → follow_up; event → event_invite;
 * manual → manual) and persisted on the outbound row by scheduleAndSend.
 *
 * Same fail-closed behaviour as handleInbound, with kind='followup' on every
 * alert and followup_message_handled / followup_message_failed PostHog events.
 *
 * THE-200: instrumented identically to handleInbound (root trace 'agent.followup'
 * with child spans for each stage) minus the classify span. flushAsync runs
 * in finally; followup callers must invoke this inside a `waitUntil` window
 * so the flush completes.
 */
export async function handleFollowup(input: {
  venueId: string
  guestId: string
  trigger: FollowupTrigger
  /**
   * When true, scheduleAndSend skips the read receipt, both typing
   * indicators and the inter-bubble gap. Used by the Command Center Follow
   * Up button — operator clicked "send" expecting fast response, and a
   * manual outbound isn't the kind of "natural" reply where typing theatre
   * belongs. Defaults to false.
   *
   * TAC-421 removed the pre-send sleeps this used to skip, so the flag no
   * longer buys latency on any path — a cron followup is as fast either
   * way. What it still decides is whether the typing beats fire at all.
   */
  skipHumanFeelDelay?: boolean
}): Promise<AgentResult> {
  const agentRunId = randomUUID()
  const start = Date.now()
  const trace = startAgentTrace({
    name: 'agent.followup',
    agentRunId,
    metadata: {
      venueId: input.venueId,
      guestId: input.guestId,
      triggerReason: input.trigger.reason,
    },
  })
  let ctx: RuntimeContext | null = null
  // Threaded into the latency event payload. inboundBody stays null for
  // followups (no inbound). generatedBody stays null on failure paths that
  // didn't reach a successful generation.
  let generatedBody: string | null = null

  try {
    console.log('[agent] followup start', {
      agentRunId,
      venueId: input.venueId,
      guestId: input.guestId,
      triggerReason: input.trigger.reason,
      traceId: trace.id,
    })

    // Build context
    const contextSpan = trace.span('context_build', {
      venueId: input.venueId,
      guestId: input.guestId,
    })
    try {
      ctx = await buildRuntimeContext({
        agentRunId,
        guestId: input.guestId,
        venueId: input.venueId,
        followupTrigger: input.trigger,
        trace,
      })
      // TAC-244: inbound-XOR-outbound invariant. handleFollowup is the
      // outbound entry point; currentMessage MUST be null and followupTrigger
      // MUST be set. A violation here means buildRuntimeContext was called
      // with both fields populated (an upstream bug) — throw loud so the
      // top-level catch fires a red alert with stage='context_build' rather
      // than silently producing a malformed prompt.
      if (ctx.currentMessage !== null || ctx.followupTrigger === null) {
        throw new Error(
          'followup run invariant violated: ctx.currentMessage must be null and ctx.followupTrigger must be set on the followup flow',
        )
      }
      contextSpan.end({
        output: {
          recognitionState: ctx.recognition.state,
          recognitionScore: ctx.recognition.score,
          mechanicCount: ctx.mechanics.length,
          recentMessageCount: ctx.recentMessages.length,
        },
        content: trace.captureContent
          ? buildRecognitionContent(ctx.recognition)
          : undefined,
      })
      console.log('[agent] followup context built', {
        agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        recognitionState: ctx.recognition.state,
      })
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      const errStack = e instanceof Error ? e.stack : undefined
      contextSpan.end({ level: 'ERROR', statusMessage: errMsg })
      await fireRedAlert({
        agentRunId,
        venueId: input.venueId,
        guestId: input.guestId,
        kind: 'followup',
        stage: 'context_build',
        errorMessage: errMsg,
        errorStack: errStack,
      })
      return { status: 'failed', stage: 'context_build', error: errMsg }
    }

    // Synthesize a Classification from the trigger reason — used for prompt
    // category and for the outbound row's category column persisted by
    // scheduleAndSend. classifierConfidence=1.0 since the trigger is
    // operator-decided, not model-inferred.
    const category = triggerToCategory(input.trigger.reason)
    ctx.classification = {
      category,
      classifierConfidence: 1.0,
      reasoning: `Followup trigger: ${input.trigger.reason}`,
      // TAC-348: synthetic classification of an operator/system-initiated
      // trigger, not a guest message — the crisis signal is never applicable
      // on this path.
      crisisSafety: false,
    }

    // Retrieve corpus
    const retrieveSpan = trace.span('retrieve', { triggerReason: input.trigger.reason })
    try {
      ctx.corpus = await retrieveCorpusStage(ctx)
      retrieveSpan.end({
        output: {
          matchCount: ctx.corpus.length,
          topSimilarity: ctx.corpus.length > 0 ? Math.max(...ctx.corpus.map((c) => c.similarity)) : 0,
        },
        content: trace.captureContent ? buildCorpusContent(ctx.corpus) : undefined,
      })
      console.log('[agent] followup corpus retrieved', {
        agentRunId,
        matchCount: ctx.corpus.length,
      })
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      retrieveSpan.end({ level: 'ERROR', statusMessage: errMsg })
      await fireRedAlert({
        agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        kind: 'followup',
        stage: 'corpus',
        errorMessage: errMsg,
        extra: { matchCount: ctx.corpus?.length ?? 0 },
      })
      return { status: 'failed', stage: 'corpus', error: errMsg }
    }

    // Retrieve knowledge (conditional). For followups: only fires for
    // Knowledge corpus: retrieved ONLY against the operator's own instruction
    // (TAC-367 PR 3, replacing PR 2's blanket skip).
    //
    // The original defect was not "followups retrieve" — it was retrieving
    // against `Followup {reason} for {name}`, a template with no referent in
    // any corpus, which still returned a full 4/4 slate on every measured
    // variant because cosine always ranks something highest. Every chunk it
    // produced was coincidence.
    //
    // An operator note ("tell her about the new Panama lot") is real content
    // about a real topic, so retrieval against it is retrieval working as
    // designed. It is also the case that has the MOST to lose from the
    // blanket skip: a note asking the model to be specific, with nothing
    // behind it, removes the grounding while leaving the pressure — on a path
    // that still has no grounding backstop. Vague or invented, with nothing
    // checking. That is worse than the state PR 2 fixed.
    //
    // No note, or any engine reason (day_*, cold_lapsed, perk_unlock) → no
    // query, so no retrieval. Those runs have no free text to query on at all;
    // their content is structured (visit history, guest context, the perk's
    // own reward_description) and is already in the prompt. `''` is the
    // explicit "do not retrieve" answer retrieveKnowledgeStage now requires.
    const knowledgeQuery = operatorInstructionQuery(input.trigger)
    if (knowledgeQuery) {
      const knowledgeSpan = trace.span('retrieve_knowledge', {
        triggerReason: input.trigger.reason,
        queryLength: knowledgeQuery.length,
      })
      ctx.knowledgeCorpus = await retrieveKnowledgeStage(
        ctx,
        ctx.classification?.category ?? null,
        knowledgeQuery,
      )
      knowledgeSpan.end({
        output: {
          matchCount: ctx.knowledgeCorpus.length,
          topSimilarity:
            ctx.knowledgeCorpus.length > 0
              ? Math.max(...ctx.knowledgeCorpus.map((c) => c.similarity))
              : 0,
        },
        content: trace.captureContent
          ? buildKnowledgeCorpusContent(ctx.knowledgeCorpus)
          : undefined,
      })
      console.log('[agent] followup knowledge retrieved', {
        agentRunId,
        matchCount: ctx.knowledgeCorpus.length,
      })
    } else {
      ctx.knowledgeCorpus = []
    }

    // Generate
    const generateSpan = trace.span('generate', { category })
    const gen = await generateStage(ctx, category)
    if (gen.status === 'failed') {
      generateSpan.end({ level: 'ERROR', statusMessage: gen.error })
      await fireRedAlert({
        agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        kind: 'followup',
        stage: 'generation',
        errorMessage: gen.error,
      })
      return { status: 'failed', stage: 'generation', error: gen.error }
    }
    if (gen.status === 'refused') {
      gen.attemptScores.forEach((score, i) => {
        const attemptSpan = generateSpan.span(`generate.attempt_${i + 1}`, { attempt: i + 1 })
        attemptSpan.end({ output: { voiceFidelity: score } })
      })
      generateSpan.end({
        level: 'WARNING',
        statusMessage: 'fidelity_loop_exhausted',
        output: { attemptScores: gen.attemptScores, finalScore: gen.finalScore },
      })
      await fireRedAlert({
        agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        kind: 'followup',
        stage: 'generation',
        errorMessage: 'fidelity_loop_exhausted',
        extra: { attemptScores: gen.attemptScores, finalScore: gen.finalScore },
      })
      return { status: 'refused', reason: 'low_fidelity', attemptScores: gen.attemptScores }
    }
    gen.result.attemptScores.forEach((score, i) => {
      const attemptSpan = generateSpan.span(`generate.attempt_${i + 1}`, { attempt: i + 1 })
      const attempt = gen.result.attemptHistory[i]
      attemptSpan.end({
        output: { voiceFidelity: score },
        content: attempt ? buildGenerateAttemptContent(attempt) : undefined,
      })
    })
    generateSpan.end({
      output: {
        voiceFidelity: gen.result.voiceFidelity,
        attempts: gen.result.attempts,
        attemptScores: gen.result.attemptScores,
        promptVersion: gen.result.promptVersion,
        bodyLength: gen.result.body.length,
      },
      content: trace.captureContent ? buildGenerateContent(gen.result) : undefined,
    })
    generatedBody = gen.result.body
    console.log('[agent] followup generated', {
      agentRunId,
      voiceFidelity: gen.result.voiceFidelity,
      attempts: gen.result.attempts,
    })

    // TAC-296: capture what the agent UNDERSTOOD into guests.context. On
    // the followup path there's no inbound, so contextUpdate is expected to
    // be ~always empty here — kept for consistency with handle-inbound and so
    // the manual followup path (where the operator's note can plausibly
    // surface a fact about the guest) still has a write surface. Empty
    // short-circuits with no DB hit. Failures log + continue.
    if (!isEmptyContextUpdate(gen.result.contextUpdate)) {
      const contextWriteSpan = trace.span('context_write', {
        tool: 'update_guest_context',
        hasStructured: gen.result.contextUpdate.structured !== undefined,
        hasObservation:
          gen.result.contextUpdate.observation !== undefined &&
          gen.result.contextUpdate.observation.trim().length > 0,
      })
      const writeResult = await updateGuestContext({
        guestId: ctx.guest.id,
        update: gen.result.contextUpdate,
        now: ctx.recognition.computedAt,
      })
      if (writeResult.ok) {
        contextWriteSpan.end({ output: writeResult.data })
        console.log('[agent] followup context written', {
          agentRunId,
          guestId: ctx.guest.id,
          updatedFields: writeResult.data,
        })
      } else {
        contextWriteSpan.end({
          level: 'WARNING',
          statusMessage: writeResult.error,
          output: { errorCode: writeResult.errorCode },
        })
        console.warn('[agent] followup context write failed (continuing)', {
          agentRunId,
          guestId: ctx.guest.id,
          error: writeResult.error,
          errorCode: writeResult.errorCode,
        })
      }
    }

    // TAC-297: arrival-capture dispatch site mirrors handle-inbound. On the
    // followup path there's no inbound, so arrivalCapture is expected to be
    // ~always empty here — kept for consistency. Empty short-circuits.
    // Skipping the push fanout entirely on this path since followups are
    // operator/cron-triggered, not guest-arrival-triggered (the agent's
    // arrivalCapture would only fire on misread context, which is a no-op
    // here anyway via isEmptyArrivalCapture).
    const arrival = await dispatchArrivalCapture({
      arrivalCapture: gen.result.arrivalCapture,
      now: ctx.recognition.computedAt,
    })
    if (arrival.kind !== 'noop') {
      console.warn(
        '[agent] followup arrival capture fired unexpectedly (no push on followup path)',
        {
          agentRunId,
          kind: arrival.kind,
        },
      )
    }

    // TAC-212: approval-policy gate. Runs on EVERY followup path.
    //
    // TAC-307 REMOVED THE MANUAL BYPASS. The Follow Up button
    // (trigger.reason='manual') used to skip this gate entirely on the
    // reasoning that the operator had already approved by clicking. That
    // conflates two different approvals: clicking authorises THE ACT OF
    // REACHING OUT, not the text — the body is model-generated and nobody
    // reads it before it ships. A venue that has switched on an approval
    // hold asked for eyes on everything reaching its guests, and "a member
    // of Analog staff clicked a button" is not that review.
    //
    // Consequence worth knowing before you debug it: at a venue with a hold
    // configured, clicking Follow Up now produces a QUEUED CARD rather than a
    // sent message. That is the intended meaning of the switch.
    //
    // TAC-264: when the gate decides queue AND existingPendingDraftId is
    // set, persistOrRegenQueuedDraft routes to UPDATE-in-place rather than
    // INSERT (regenerate the existing pending card with the cron-triggered
    // followup's body). The card stays pending — no demotion.
    //
    // TAC-284: when the gate short-circuits for a demo guest,
    // approval.reason carries 'demo_bypass'; threaded into scheduleAndSend
    // below so the auto-send row is stamped review_reason='demo_bypass'.
    // TAC-355: independent mechanic-offer backstop. Runs on the followup
    // path too — a mechanic can be offered on a proactive outbound message
    // exactly as easily as in reply to a guest's question, unlike
    // knowledge-gap grounding (inherently about answering a question the
    // guest asked, so inbound-only). Runs for manual followups too since
    // TAC-307, same as the gate itself.
    const mechanicOfferBackstop = await verifyMechanicOfferStage(ctx, gen.result)
    if (
      mechanicOfferBackstop.status === 'flagged' ||
      mechanicOfferBackstop.status === 'check_failed'
    ) {
      console.warn('[agent] followup mechanic-offer backstop fired', {
        agentRunId,
        status: mechanicOfferBackstop.status,
      })
    }
    const approval = await applyApprovalPolicyStage(ctx, gen.result, null, mechanicOfferBackstop)
    console.log('[agent] followup approval decision', {
      agentRunId,
      triggerReason: input.trigger.reason,
      action: approval.action,
      primaryTrigger: approval.action === 'queue' ? approval.primaryTrigger : null,
      triggers: approval.action === 'queue' ? approval.triggers : [],
      voiceFidelity: gen.result.voiceFidelity,
      modelRequiresApproval: gen.result.requiresOperatorApproval,
    })
    if (approval.action === 'queue') {
      const queueSpan = trace.span('queue', {
        primaryTrigger: approval.primaryTrigger,
        triggerCount: approval.triggers.length,
        existingPendingDraftId: approval.existingPendingDraftId,
      })
      try {
        const persistResult = await persistOrRegenQueuedDraft(
          ctx,
          gen.result,
          approval.primaryTrigger,
          approval.existingPendingDraftId,
          // TAC-308: always undefined on this path (the KNOWLEDGE_GAP
          // trigger is inbound-only), passed for call-site symmetry so the
          // two orchestrators can't drift.
          // TAC-364: same symmetry. `ungroundedClaims` is always NULL on this
          // path — `verifyGroundingStage` returns early when currentMessage is
          // null, so no followup has a grounding backstop at all (that gap is
          // TAC-376) — and NULL is precisely the value that records "the check
          // did not run", as opposed to `[]`, which would claim it ran and
          // found nothing. Every followup row in `messages.ungrounded_claims`
          // is therefore NULL, and that is a true statement about the feature
          // rather than a gap in the data. `reviewTriggers` IS real here and
          // carries the same co-firing information an inbound draft does.
          //
          // TAC-394: a manual followup never regenerates over a card, even one
          // a 23505 reveals that the gate never saw ('never_regen').
          {
            pendingUntil: approval.pendingUntil,
            reviewTriggers: approval.triggers,
            ungroundedClaims: approval.ungroundedClaims,
            callerPolicy: input.trigger.reason === 'manual' ? 'never_regen' : 'regen',
          },
        )
        if (persistResult.action === 'dropped') {
          queueSpan.end({
            output: {
              persistAction: 'dropped',
              reason: persistResult.reason,
              protectedDraftId: persistResult.protectedDraftId,
            },
          })
          await reportFollowupDrop({
            ctx,
            agentRunId,
            triggerReason: input.trigger.reason,
            category,
            drop: persistResult,
            triggers: approval.triggers,
            droppedBody: gen.result.body,
            viaRaceRecovery: true,
          })
          trace.update({
            output: {
              status: 'dropped',
              reason: persistResult.reason,
              protectedDraftId: persistResult.protectedDraftId,
              triggers: approval.triggers,
            },
          })
          return {
            status: 'dropped',
            reason: persistResult.reason,
            protectedDraftId: persistResult.protectedDraftId,
            triggers: approval.triggers,
          }
        }
        const { outboundMessageId, action: persistAction, priorReviewReason } = persistResult
        queueSpan.end({
          output: {
            outboundMessageId,
            primaryTrigger: approval.primaryTrigger,
            triggers: approval.triggers,
            persistAction,
            priorReviewReason,
            bodyLength: gen.result.body.length,
          },
          content: { body: gen.result.body },
        })
        console.log(
          persistAction === 'updated'
            ? '[agent] followup regenerated existing pending draft'
            : '[agent] followup queued for review',
          {
            agentRunId,
            outboundMessageId,
            primaryTrigger: approval.primaryTrigger,
            triggers: approval.triggers,
            persistAction,
            priorReviewReason,
          },
        )
        if (persistAction === 'updated') {
          await captureDraftRegenerated({
            agentRunId,
            venueId: ctx.venue.id,
            guestId: ctx.guest.id,
            originalDraftId: outboundMessageId,
            triggers: approval.triggers,
            primaryTrigger: approval.primaryTrigger,
            priorReviewReason,
            voiceFidelity: gen.result.voiceFidelity,
            modelRequiresApproval: gen.result.requiresOperatorApproval,
            modelApprovalReason: gen.result.approvalReason,
            compRegexMatchedPattern: approval.compMatchedPattern,
            kind: 'followup',
            category,
            inboundBody: null,
            generatedBody: gen.result.body,
          })
        } else {
          await captureDraftQueued({
            agentRunId,
            venueId: ctx.venue.id,
            guestId: ctx.guest.id,
            triggers: approval.triggers,
            primaryTrigger: approval.primaryTrigger,
            voiceFidelity: gen.result.voiceFidelity,
            modelRequiresApproval: gen.result.requiresOperatorApproval,
            modelApprovalReason: gen.result.approvalReason,
            compRegexMatchedPattern: approval.compMatchedPattern,
            hasPreviousPending: approval.triggers.includes(
              APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD,
            ),
            slot: approval.slot,
            otherSlotOccupied: approval.otherSlotOccupied,
            kind: 'followup',
            category,
            inboundBody: null,
            generatedBody: gen.result.body,
          })
        }
        // TAC-207: cron-triggered followups (day_* / event) that hit the
        // queue path get a push too. TAC-307: this now fires for
        // reason='manual' as well, since manual followups run the gate — a
        // Follow Up click that a policy hold queues should reach the operator
        // the same way any other queued draft does.
        if (shouldSendDraftFlaggedPush(approval.primaryTrigger)) {
          waitUntil(
            sendDraftFlaggedPush({
              agentRunId,
              venueId: ctx.venue.id,
              guestId: ctx.guest.id,
              guestFirstName: ctx.guest.firstName,
              draftId: outboundMessageId,
              primaryTrigger: approval.primaryTrigger,
            }).catch((e) => {
              console.error('apns: sendDraftFlaggedPush threw unexpectedly', {
                agentRunId,
                draftId: outboundMessageId,
                error: e instanceof Error ? e.message : String(e),
              })
            }),
          )
        }
        trace.update({
          output: {
            status: 'queued',
            outboundMessageId,
            primaryTrigger: approval.primaryTrigger,
            voiceFidelity: gen.result.voiceFidelity,
            persistAction,
          },
          content: { outboundDraft: gen.result.body },
        })
        return {
          status: 'queued',
          outboundMessageId,
          triggers: approval.triggers,
          primaryTrigger: approval.primaryTrigger,
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e)
        queueSpan.end({ level: 'ERROR', statusMessage: errMsg, output: { stage: 'persist' } })
        return { status: 'failed', stage: 'persist', error: errMsg }
      }
    }
    // A pending card holds this draft's slot and must not be overwritten
    // (decideSlotAction in ./pending-slots), so the draft is discarded.
    //   knowledge_gap_card_protected (TAC-308): a knowledge-gap card awaits an
    //     operator answer. Reachable here only via a non-gap trigger, since the
    //     KNOWLEDGE_GAP trigger is inbound-only. The engine releases its claim,
    //     and the next tick re-evaluates once the card clears.
    //   obligation_slot_taken (TAC-394): the obligation slot holds a DIFFERENT
    //     commitment. The existing card wins.
    //   slot_occupied (TAC-394): a manual followup would have queued into an
    //     occupied slot. Refused, never regenerated over the card.
    if (approval.action === 'drop') {
      await reportFollowupDrop({
        ctx,
        agentRunId,
        triggerReason: input.trigger.reason,
        category,
        drop: approval,
        triggers: approval.triggers,
        droppedBody: gen.result.body,
        viaRaceRecovery: false,
      })
      trace.update({
        output: {
          status: 'dropped',
          reason: approval.reason,
          protectedDraftId: approval.protectedDraftId,
          triggers: approval.triggers,
        },
        content: { droppedDraft: gen.result.body },
      })
      return {
        status: 'dropped',
        reason: approval.reason,
        protectedDraftId: approval.protectedDraftId,
        triggers: approval.triggers,
      }
    }
    const demoBypassReviewReason: 'demo_bypass' | undefined = approval.reason

    // Send + persist. TAC-284: demo guests skip the read receipt and typing
    // indicators (in addition to the existing Follow Up button skip) and carry
    // the demo_bypass review_reason when the gate short-circuited above.
    // TAC-421 removed the pre-send sleep, so neither skip saves time now.
    const sendSpan = trace.span('send', { bodyLength: gen.result.body.length })
    try {
      const { outboundMessageId, providerMessageId, generationId, bubbleCount } =
        await scheduleAndSend(ctx, gen.result, {
          skipHumanFeelDelay:
            input.skipHumanFeelDelay === true || ctx.guest.isDemo === true,
          reviewReason: demoBypassReviewReason,
        })
      sendSpan.end({
        output: {
          outboundMessageId,
          providerMessageId,
          bodyLength: gen.result.body.length,
          // TAC-313: how many messages this response actually became.
          generationId,
          bubbleCount,
        },
        content: { body: gen.result.body },
      })
      console.log('[agent] followup sent + persisted', {
        agentRunId,
        outboundMessageId,
        providerMessageId,
      })
      await capturePostHogEvent('followup_message_handled', ctx.guest.id, {
        agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        triggerReason: input.trigger.reason,
        recognitionState: ctx.recognition.state,
        recognitionScore: ctx.recognition.score,
        category,
        voiceFidelity: gen.result.voiceFidelity,
        attempts: gen.result.attempts,
        attemptScores: gen.result.attemptScores,
        matchCount: ctx.corpus.length,
      })
      trace.update({
        output: {
          status: 'sent',
          outboundMessageId,
          voiceFidelity: gen.result.voiceFidelity,
        },
        content: { outboundDraft: gen.result.body },
      })
      return { status: 'sent', outboundMessageId }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      const stage: 'send' | 'persist' = errMsg.includes('persist failed') ? 'persist' : 'send'
      sendSpan.end({ level: 'ERROR', statusMessage: errMsg, output: { stage } })
      return { status: 'failed', stage, error: errMsg }
    }
  } catch (unexpected) {
    const errMsg = unexpected instanceof Error ? unexpected.message : String(unexpected)
    const errStack = unexpected instanceof Error ? unexpected.stack : undefined
    trace.update({ output: { status: 'failed', error: errMsg } })
    await fireRedAlert({
      agentRunId,
      venueId: ctx?.venue.id ?? input.venueId,
      guestId: ctx?.guest.id ?? input.guestId,
      kind: 'followup',
      stage: 'context_build',
      errorMessage: errMsg,
      errorStack: errStack,
    })
    return { status: 'failed', stage: 'context_build', error: errMsg }
  } finally {
    const totalElapsedMs = Date.now() - start
    if (totalElapsedMs > AGENT_LATENCY_HIGH_THRESHOLD_MS) {
      await captureAgentLatencyHigh({
        agentRunId,
        venueId: ctx?.venue.id ?? input.venueId,
        guestId: ctx?.guest.id ?? input.guestId,
        totalElapsedMs,
        kind: 'followup',
        inboundBody: null,
        generatedBody,
      })
    }
    await trace.flushAsync()
  }
}
