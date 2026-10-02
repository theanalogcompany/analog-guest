// Regen helper for the Voices command-center critique → regen → commit
// loop. Loads the original outbound + its triggering inbound, rebuilds
// runtime context with history pinned to the moment of the inbound,
// retrieves voice + knowledge corpus, and asks lib/ai to generate a new
// message with the operator's critique injected as the dominant signal.
//
// COUPLING: this helper deliberately mirrors the wiring in
// `lib/agent/stages.ts` (classifyStage → retrieveCorpusStage →
// retrieveKnowledgeStage → generateStage) but skips the analytics
// emissions those stages own — every regen would otherwise flood
// PostHog and Langfuse with operator-driven noise.
//
// Analytics isolation means: don't invoke each other's telemetry paths.
// Sharing values AND pure helpers via imports is fine and preferred —
// TAC-183 dedupes the four retrieval thresholds by importing them from
// stages.ts, and TAC-366 does the same for `filterByRelevance`, so silent
// drift is structurally impossible rather than merely discouraged. If
// gating logic (e.g. shouldRetrieveKnowledge) or post-generation behavior
// changes there, mirror it here — and prefer IMPORTING the thing over
// restating it, because mirror-by-discipline has already failed once on
// this seam (TAC-350 shipped the relevance floor to stages.ts and left
// this path on pre-TAC-350 semantics for months). The two paths share
// pure helpers and constants, never each other's telemetry.
//
// TAC-363 DELIBERATELY NOT MIRRORED, recorded here rather than left for the
// next reader to notice as a gap. The closed-venue arrival check is the
// fourth backstop and the first one this path does not carry. Two reasons.
// It is not gating logic: the trigger it feeds holds a draft for an operator,
// and this path has no queue — the operator is already reading the output.
// And its whole question is "would a guest set off for the venue on the
// strength of this text", which needs a guest about to receive it; regen
// replays an old turn against today's clock (see the reconstruction gotcha in
// CLAUDE.md), so a reply that was correct when sent at 10am would flag when
// replayed at midnight. Mirroring it would manufacture a warning about a
// message nobody is sending. Revisit if the playground ever sends.

import { randomUUID } from 'node:crypto'
import {
  classifyMessage,
  generateMessage,
  type KnowledgeCorpusChunk as AiKnowledgeCorpusChunk,
  verifyMechanicOffer,
  verifyProsePromise,
  type VoiceCorpusChunk as AiVoiceCorpusChunk,
} from '@/lib/ai'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import {
  buildAiRuntime,
  retrieveKnowledgeWithContextStage,
} from '@/lib/agent/stages'
import type { EmojiDirective } from '@/lib/ai/emoji-cadence'
import { createAdminClient } from '@/lib/db/admin'
import { noopAgentTrace } from '@/lib/observability'
import { logger } from '@/lib/observability/logger'
import { parseMessageChannel } from '@/lib/schemas/message-channel'
import { loadVoicePack } from '@/lib/rag'

export interface RegenerateWithCritiqueInput {
  venueId: string
  /** ID of the original outbound message being regenerated. */
  originalMessageId: string
  critique: string
}

export interface RegenerateWithCritiqueResult {
  body: string
  voiceFidelity: number
  attempts: number
  attemptScores: number[]
  generatedAt: Date
  // TAC-350: the model's own self-report, surfaced here for the first time
  // (generateMessage already computed it; this path just wasn't reading it).
  knowledgeGap: boolean
  // TAC-355: final-attempt self-talk flag, surfaced here for the first time
  // (generateMessage already computes it via the shared regen loop; this
  // path just wasn't reading it — same situation knowledgeGap was in before
  // TAC-350). Advisory only: regen has no approval queue, the operator
  // reviews the raw attempt directly.
  selfTalkViolationPersisted: boolean
  // TAC-362: this attempt's emoji call, and whether the body ignored it.
  // The THIRD field to arrive on this type by the same route — computed by
  // generateMessage all along, not read here (knowledgeGap before TAC-350,
  // selfTalkViolationPersisted before TAC-355). Advisory, like its
  // neighbours: regen has no approval queue.
  //
  // `emojiDirective` is surfaced alongside the violation flag, and that is
  // the load-bearing half. buildAiRuntime re-draws the coin on every regen
  // call — deliberately NOT pinned across a critique session, since each
  // attempt is a fresh generation and pinning would hide the variation the
  // feature exists to produce — so two attempts in one session can differ in
  // emoji permission for reasons that have nothing to do with the
  // operator's critique. Without the directive in the response the operator
  // would attribute that to their critique, and this loop is what writes
  // voice_corpus rows and anti-pattern rules, so a misattribution here
  // becomes persisted venue config. undefined when the venue's policy
  // doesn't vary per message (never / sparingly).
  emojiDirective?: EmojiDirective
  emojiDirectiveViolated: boolean
  // TAC-355: independent mechanic-offer backstop, same underlying check
  // (lib/ai/verify-mechanic-offer.ts) as lib/agent/stages.ts's
  // verifyMechanicOfferStage, but ADVISORY here and with a NARROWER skip
  // condition — this path only skips on "no eligible gated mechanic this
  // turn" and demo guest. It deliberately does NOT skip on
  // requiresOperatorApproval/commitment.type already being set, unlike the
  // production gate's skip — regen has no other surface that shows those
  // fields to the operator, so skipping here would silently drop the only
  // visibility into a self-flagged mechanic offer on this path. false when
  // the check didn't run (no eligible gated mechanic, or a demo guest) or
  // ran and found nothing.
  offersGatedMechanic: boolean
  offeredMechanicId: string | null
  // TAC-401: independent prose-promise check, same underlying call
  // (lib/ai/verify-prose-promise.ts) as lib/agent/stages.ts's
  // verifyProsePromiseStage, ADVISORY here like its two neighbours above.
  //
  // NARROWER skip condition than the production stage, and deliberately so:
  // this path skips only on a demo guest and an empty body. It does NOT skip
  // when the draft already carries an obligation, because regen has no other
  // surface showing the operator what the check would have said, and the
  // production skip exists to save a call on a draft that is already queuing
  // — there is nothing to queue here.
  //
  // FAILS OPEN here, which is the opposite of the production posture and is
  // correct for the same reason the rest of this block is advisory: there is
  // no send decision on the regen path to protect. A degraded check surfaces
  // as promisesSomething=false, indistinguishable from a clean verdict, and
  // the operator is reading the raw attempt anyway.
  promisesSomething: boolean
  promisedCommitmentType: string | null
  promisedCommitmentDescription: string | null
}

export type RegenerateWithCritiqueOutcome =
  | { ok: true; data: RegenerateWithCritiqueResult }
  | {
      ok: false
      error: string
      errorCode:
        | 'message_not_found'
        | 'not_an_outbound_reply'
        | 'inbound_not_found'
        | 'context_build_failed'
        | 'classify_failed'
        | 'retrieve_failed'
        | 'generate_failed'
        // TAC-348 (code review follow-up): the triggering inbound is a
        // crisis-safety signal. Refuses BEFORE retrieval or generation ever
        // run — same posture as handle-inbound.ts's short circuit, and for
        // the same reason: a persona-driven regeneration of a crisis reply
        // would defeat the entire point of hardcoding that reply, and its
        // output could be committed to voice_corpus as a style exemplar.
        | 'crisis_safety_ineligible'
    }

interface OriginalOutboundLoad {
  outbound: { id: string; venue_id: string; created_at: string }
  inbound: {
    id: string
    body: string
    created_at: string
    provider_message_id: string | null
    channel: string
    referral_source: string | null
  }
  guestId: string
}

async function loadOriginalOutbound(
  outboundMessageId: string,
  venueId: string,
): Promise<
  | { ok: true; data: OriginalOutboundLoad }
  | {
      ok: false
      errorCode:
        'message_not_found' | 'not_an_outbound_reply' | 'inbound_not_found'
      error: string
    }
> {
  const supabase = createAdminClient()

  const { data: outbound, error: outErr } = await supabase
    .from('messages')
    .select(
      'id, venue_id, guest_id, direction, reply_to_message_id, created_at',
    )
    .eq('id', outboundMessageId)
    .eq('venue_id', venueId)
    .maybeSingle()
  if (outErr) {
    return {
      ok: false,
      errorCode: 'message_not_found',
      error: `outbound lookup failed: ${outErr.message}`,
    }
  }
  if (!outbound) {
    return {
      ok: false,
      errorCode: 'message_not_found',
      error: `outbound not found at venue: ${outboundMessageId}`,
    }
  }
  if (outbound.direction !== 'outbound') {
    return {
      ok: false,
      errorCode: 'not_an_outbound_reply',
      error: `message is not an outbound (direction=${outbound.direction})`,
    }
  }
  if (!outbound.reply_to_message_id) {
    return {
      ok: false,
      errorCode: 'not_an_outbound_reply',
      error:
        'outbound has no reply_to_message_id — regen only supports messages triggered by an inbound',
    }
  }

  const { data: inbound, error: inErr } = await supabase
    .from('messages')
    .select(
      'id, body, created_at, provider_message_id, direction, channel, referral_source',
    )
    .eq('id', outbound.reply_to_message_id)
    .maybeSingle()
  if (inErr || !inbound) {
    return {
      ok: false,
      errorCode: 'inbound_not_found',
      error: `triggering inbound not found: ${outbound.reply_to_message_id}${inErr ? ` (${inErr.message})` : ''}`,
    }
  }
  if (inbound.direction !== 'inbound') {
    return {
      ok: false,
      errorCode: 'inbound_not_found',
      error: `triggering message is not inbound (direction=${inbound.direction})`,
    }
  }

  return {
    ok: true,
    data: {
      outbound: {
        id: outbound.id,
        venue_id: outbound.venue_id,
        created_at: outbound.created_at,
      },
      inbound: {
        id: inbound.id,
        body: inbound.body,
        created_at: inbound.created_at,
        provider_message_id: inbound.provider_message_id,
        channel: inbound.channel,
        referral_source: inbound.referral_source,
      },
      guestId: outbound.guest_id,
    },
  }
}

export async function regenerateWithCritique(
  input: RegenerateWithCritiqueInput,
): Promise<RegenerateWithCritiqueOutcome> {
  // 1. Load original outbound + its triggering inbound
  const load = await loadOriginalOutbound(
    input.originalMessageId,
    input.venueId,
  )
  if (!load.ok) return load

  // 2. Rebuild runtime context. History is pinned to <inbound.created_at —
  // anything later was either the agent's own outbound (which we're
  // regenerating) or messages that arrived after, neither of which
  // should colour the regen.
  let ctx
  try {
    ctx = await buildRuntimeContext({
      agentRunId: randomUUID(),
      guestId: load.data.guestId,
      venueId: input.venueId,
      trace: noopAgentTrace,
      currentMessage: {
        id: load.data.inbound.id,
        providerMessageId: load.data.inbound.provider_message_id ?? '',
        body: load.data.inbound.body,
        receivedAt: new Date(load.data.inbound.created_at),
        // TAC-495: mirrored from handle-inbound's loadInbound, so the regen
        // gets the same channel copy the original generation did.
        channel: parseMessageChannel(load.data.inbound.channel),
        // TAC-518: mirrored for the same reason — a regen of a scan turn must
        // arm what the original did, or the playground answers a different
        // question than production did.
        referralSource: load.data.inbound.referral_source,
      },
      historyEndIso: load.data.inbound.created_at,
    })
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    return { ok: false, errorCode: 'context_build_failed', error: errMsg }
  }

  // 3. Classify (raw lib/ai — no PostHog). Same context fields stages.ts
  // passes; ctx.recentMessages is already pinned to the moment of the
  // original outbound's triggering inbound via historyEndIso above. No
  // reroute logic on this path — operator iterates on the regen output.
  const classification = await classifyMessage({
    inboundBody: load.data.inbound.body,
    persona: ctx.venue.brandPersona,
    venueInfo: ctx.venue.venueInfo,
    recentMessages: ctx.recentMessages,
    guestState: ctx.recognition.state,
  })
  if (!classification.ok) {
    return {
      ok: false,
      errorCode: 'classify_failed',
      error: classification.error,
    }
  }

  // TAC-348 (code review follow-up): refuse a crisis-safety regen BEFORE
  // retrieval or generation ever run. The original inbound triggered a
  // fixed, hardcoded reply specifically so no persona/corpus/category
  // instruction would ever touch it (see lib/agent/crisis-safety.ts and
  // handle-inbound.ts's identical short circuit) — regenerating it here
  // would run exactly the generateMessage call that mechanism exists to
  // bypass, on a message this repo has decided must never be persona-styled.
  if (classification.data.crisisSafety) {
    return {
      ok: false,
      errorCode: 'crisis_safety_ineligible',
      error:
        'This message was a crisis-safety reply (self-harm or medical-emergency signal). It sends a fixed, hardcoded response and is not eligible for voice regeneration.',
    }
  }

  // 4. Load the static voice pack (decision 0008) — the same pack the live
  // turn used, because it is the same pack every turn uses. Mirrors
  // retrieveCorpusStage's inbound direction: fail closed on a DB error or an
  // empty pack, because a regeneration with no venue voice behind it is not
  // a regeneration worth showing.
  const corpus = await loadVoicePack({ venueId: input.venueId })
  if (!corpus.ok) {
    return {
      ok: false,
      errorCode: 'retrieve_failed',
      error: `voice pack load failed: ${corpus.error}`,
    }
  }
  if (corpus.data.length === 0) {
    return {
      ok: false,
      errorCode: 'retrieve_failed',
      error: 'empty_voice_pack (venue has no usable voice_corpus entries)',
    }
  }

  // 5. Retrieve knowledge corpus.
  //
  // TAC-547: this block used to REIMPLEMENT retrieveKnowledgeStage's body —
  // the tag preference, the relevance floor and the zero-relevant-rows
  // fallback, all restated. That is the duplication this file's own header
  // warns about, and it had already drifted once: TAC-350 shipped the floor
  // to stages.ts and this copy kept the pre-TAC-350 semantics until TAC-366,
  // in the direction that HID a live bug from anyone reproducing it here.
  //
  // It now calls the shared stage, so the playground retrieves exactly what
  // production retrieves — including TAC-547's contextual arm, which is what
  // makes a regenerated follow-up see the same knowledge the live turn did.
  // Safe against this file's analytics-isolation rule: retrieveKnowledgeStage
  // emits no PostHog or Langfuse event, only a console.warn on degrade.
  const knowledgeRows = await retrieveKnowledgeWithContextStage(
    ctx,
    classification.data.category,
    load.data.inbound.body,
  )
  const knowledgeChunks: AiKnowledgeCorpusChunk[] = knowledgeRows.map((c) => ({
    id: c.id,
    text: c.text,
    sourceType: c.sourceType,
    primaryTags: c.primaryTags,
    secondaryTags: c.secondaryTags,
    relevanceScore: c.similarity,
  }))

  const ragChunks: AiVoiceCorpusChunk[] = corpus.data.map((c) => ({
    id: c.id,
    text: c.text,
    sourceType: c.sourceType as AiVoiceCorpusChunk['sourceType'],
    relevanceScore: c.similarity,
  }))

  // 6. Build AI runtime, then post-inject the critique. buildAiRuntime
  // doesn't know about critiqueToIncorporate by design — keeps the
  // standard agent path identical.
  const runtime = {
    ...buildAiRuntime(ctx),
    critiqueToIncorporate: input.critique,
  }

  // 7. Generate. lib/ai's internal regen loop runs up to MAX_ATTEMPTS=3
  // and returns the best attempt. No SEND_FIDELITY_FLOOR check — operator
  // decides what's good enough by reading the result.
  const gen = await generateMessage({
    category: classification.data.category,
    persona: ctx.venue.brandPersona,
    venueInfo: ctx.venue.venueInfo,
    ragChunks,
    knowledgeChunks,
    runtime,
    // TAC-495: mirrored from generateStage (lib/agent/stages.ts).
    channel: ctx.conversationChannel,
  })
  if (!gen.ok) {
    return { ok: false, errorCode: 'generate_failed', error: gen.error }
  }

  // 9. TAC-355: independent mechanic-offer backstop, advisory only. No skip
  // on requiresOperatorApproval/commitment.type (see the type's own comment
  // for why) — only "nothing gated eligible this turn" and demo guest, same
  // as the production stage's other two skip conditions.
  let offersGatedMechanic = false
  let offeredMechanicId: string | null = null
  const gatedMechanics = ctx.mechanics.filter((m) => m.requiresOperatorApproval)
  if (ctx.guest.isDemo !== true && gatedMechanics.length > 0) {
    const mechanicCheck = await verifyMechanicOffer({
      replyBody: gen.data.body,
      eligibleGatedMechanics: gatedMechanics.map((m) => ({
        id: m.id,
        name: m.name,
        rewardDescription: m.rewardDescription,
        qualification: m.qualification,
      })),
    })
    if (mechanicCheck.ok) {
      // Keyed on offersGatedMechanic alone — see stages.ts's
      // verifyMechanicOfferStage for why (verify-mechanic-offer.ts already
      // resolves the ambiguous "flagged but no id" shape defensively, and an
      // additional `mechanicId !== 'none'` check here would silently drop
      // that same flagged case advisory-side too).
      if (mechanicCheck.data.offersGatedMechanic) {
        offersGatedMechanic = true
        offeredMechanicId = mechanicCheck.data.mechanicId
      }
    } else {
      logger.warn(
        `[voices/regen] mechanic-offer backstop degraded for venue=${input.venueId}: ${mechanicCheck.error}`,
      )
    }
  }

  // TAC-401: the prose-promise check, advisory. This file's standing
  // obligation is to mirror stages.ts's wiring, and the failure this check
  // exists for — a promise in prose with no carrier — is exactly the kind of
  // draft an operator iterating in this playground would otherwise commit to
  // the voice corpus as a good exemplar.
  //
  // DELIBERATE EXCEPTION to ruling 2's "concurrently on every path where both
  // run". This path runs its three checks in sequence, as it already did for
  // the two above. The ruling's reason is latency on a turn a GUEST is waiting
  // on; here an operator is waiting, one regen at a time, and the existing
  // shape of this function is sequential throughout. Making just this one
  // concurrent would buy one Haiku call of an operator's time at the cost of
  // the only part of this file that does not read like its neighbours.
  let promisesSomething = false
  let promisedCommitmentType: string | null = null
  let promisedCommitmentDescription: string | null = null
  if (ctx.guest.isDemo !== true && gen.data.body.trim().length > 0) {
    const promiseCheck = await verifyProsePromise({
      replyBody: gen.data.body,
      // TAC-527: this path always has an inbound — it regenerates a reply to a
      // specific guest message — so unlike the proactive orchestrator paths it
      // is never null.
      guestInboundBody: load.data.inbound.body,
    })
    if (promiseCheck.ok) {
      promisesSomething = promiseCheck.data.promisesSomething
      promisedCommitmentType = promiseCheck.data.commitmentType
      promisedCommitmentDescription = promiseCheck.data.commitmentDescription
    } else {
      logger.warn(
        `[voices/regen] prose-promise check degraded for venue=${input.venueId}: ${promiseCheck.error}`,
      )
    }
  }

  return {
    ok: true,
    data: {
      body: gen.data.body,
      voiceFidelity: gen.data.voiceFidelity,
      attempts: gen.data.attempts,
      attemptScores: gen.data.attemptScores,
      generatedAt: new Date(),
      knowledgeGap: gen.data.knowledgeGap,
      selfTalkViolationPersisted: gen.data.selfTalkViolationPersisted,
      emojiDirective: runtime.emojiDirective,
      emojiDirectiveViolated: gen.data.emojiDirectiveViolated,
      offersGatedMechanic,
      offeredMechanicId,
      promisesSomething,
      promisedCommitmentType,
      promisedCommitmentDescription,
    },
  }
}
