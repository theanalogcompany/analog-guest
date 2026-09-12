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
// Sharing _values_ via imports is fine and preferred — TAC-183 dedupes
// the four retrieval thresholds by importing them from stages.ts so
// silent drift is structurally impossible. If gating logic (e.g.
// shouldRetrieveKnowledge) or post-generation behavior changes there,
// mirror it here. The two paths still don't share runtime code.

import { randomUUID } from 'node:crypto'
import {
  classifyMessage,
  generateMessage,
  type KnowledgeCorpusChunk as AiKnowledgeCorpusChunk,
  verifyGrounding,
  verifyMechanicOffer,
  type VoiceCorpusChunk as AiVoiceCorpusChunk,
} from '@/lib/ai'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import { getPrimaryTagPreference } from '@/lib/agent/knowledge-tag-mapping'
import {
  buildAiRuntime,
  CORPUS_RETRIEVE_LIMIT,
  KNOWLEDGE_RETRIEVE_LIMIT,
  MIN_STRONG_MATCHES,
  STRONG_MATCH_SIMILARITY,
} from '@/lib/agent/stages'
import { createAdminClient } from '@/lib/db/admin'
import { noopAgentTrace } from '@/lib/observability'
import { retrieveContext, retrieveKnowledgeContext } from '@/lib/rag'

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
  // TAC-350: independent grounding backstop, same underlying check
  // (lib/ai/verify-grounding.ts) as lib/agent/stages.ts's
  // verifyGroundingStage, but ADVISORY here rather than gating and with a
  // NARROWER skip condition — this path only checks knowledgeGap, not
  // currentMessage-null or isDemo (verifyGroundingStage's other two skips),
  // because a regen always has a real triggering inbound and there's no
  // send/queue decision here to protect a demo guest from. A demo guest's
  // regen does still pay for the extra Haiku call; accepted, since regen is
  // an operator-initiated, low-volume action, not live guest traffic. There
  // is no send/queue decision on the regen path to gate — the operator
  // reviews the raw attempt directly — so this is a signal for the Voices
  // UI to surface, not a trigger. false when the check didn't run (gap
  // already self-reported) or ran and found nothing.
  hasUngroundedClaim: boolean
  ungroundedClaims: string[]
  // TAC-355: final-attempt self-talk flag, surfaced here for the first time
  // (generateMessage already computes it via the shared regen loop; this
  // path just wasn't reading it — same situation knowledgeGap was in before
  // TAC-350). Advisory only: regen has no approval queue, the operator
  // reviews the raw attempt directly.
  selfTalkViolationPersisted: boolean
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
  }
  guestId: string
}

async function loadOriginalOutbound(
  outboundMessageId: string,
  venueId: string,
): Promise<{ ok: true; data: OriginalOutboundLoad } | {
  ok: false
  errorCode: 'message_not_found' | 'not_an_outbound_reply' | 'inbound_not_found'
  error: string
}> {
  const supabase = createAdminClient()

  const { data: outbound, error: outErr } = await supabase
    .from('messages')
    .select('id, venue_id, guest_id, direction, reply_to_message_id, created_at')
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
    .select('id, body, created_at, provider_message_id, direction')
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
      },
      guestId: outbound.guest_id,
    },
  }
}

export async function regenerateWithCritique(
  input: RegenerateWithCritiqueInput,
): Promise<RegenerateWithCritiqueOutcome> {
  // 1. Load original outbound + its triggering inbound
  const load = await loadOriginalOutbound(input.originalMessageId, input.venueId)
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

  // 4. Retrieve voice corpus (mirrors stages.ts retrieveCorpusStage's
  // strong-match floor for inbound paths — fail closed when grounding
  // is too thin). No PostHog event on retrieval-thinness here.
  const corpus = await retrieveContext({
    venueId: input.venueId,
    query: load.data.inbound.body,
    limit: CORPUS_RETRIEVE_LIMIT,
  })
  if (!corpus.ok) {
    return {
      ok: false,
      errorCode: 'retrieve_failed',
      error: `voice corpus retrieval failed: ${corpus.error}`,
    }
  }
  const strongCount = corpus.data.filter((m) => m.similarity >= STRONG_MATCH_SIMILARITY).length
  if (strongCount < MIN_STRONG_MATCHES) {
    return {
      ok: false,
      errorCode: 'retrieve_failed',
      error: `insufficient_corpus_matches (got ${strongCount} above ${STRONG_MATCH_SIMILARITY}, need ${MIN_STRONG_MATCHES}; total ${corpus.data.length})`,
    }
  }

  // 5. Retrieve knowledge corpus (graceful degradation, mirrors stages.ts).
  // TAC-242: derive primary-tag preference from the just-classified category,
  // fall back to no-filter retrieval when the preferenced query returns
  // zero matches.
  const knowledgePreference = getPrimaryTagPreference(classification.data.category)
  let knowledgeChunks: AiKnowledgeCorpusChunk[] = []
  const knowledge = await retrieveKnowledgeContext({
    venueId: input.venueId,
    query: load.data.inbound.body,
    limit: KNOWLEDGE_RETRIEVE_LIMIT,
    primaryTagPreference: knowledgePreference,
  })
  if (knowledge.ok) {
    let rows = knowledge.data
    if (knowledgePreference !== undefined && rows.length === 0) {
      const fallback = await retrieveKnowledgeContext({
        venueId: input.venueId,
        query: load.data.inbound.body,
        limit: KNOWLEDGE_RETRIEVE_LIMIT,
      })
      if (fallback.ok) {
        rows = fallback.data
      } else {
        console.warn(
          `[voices/regen] knowledge retrieval (fallback) degraded for venue=${input.venueId}: ${fallback.error}`,
        )
      }
    }
    knowledgeChunks = rows.map((c) => ({
      id: c.id,
      text: c.text,
      sourceType: c.sourceType,
      primaryTags: c.primaryTags,
      secondaryTags: c.secondaryTags,
      relevanceScore: c.similarity,
    }))
  } else {
    console.warn(
      `[voices/regen] knowledge retrieval degraded for venue=${input.venueId}: ${knowledge.error}`,
    )
  }

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
  })
  if (!gen.ok) {
    return { ok: false, errorCode: 'generate_failed', error: gen.error }
  }

  // 8. TAC-350: independent grounding backstop — only spend the extra Haiku
  // call when the model didn't already self-report a gap (see
  // RegenerateWithCritiqueResult's own comment for how this narrows
  // verifyGroundingStage's full skip condition). No PostHog event here
  // (analytics isolation, see this file's header comment) — the operator is
  // staring at the screen and IS the observability surface for regen, same
  // reasoning the route's own header gives for skipping PostHog/Langfuse
  // entirely on this path.
  let hasUngroundedClaim = false
  let ungroundedClaims: string[] = []
  if (!gen.data.knowledgeGap) {
    const verify = await verifyGrounding({
      inboundBody: load.data.inbound.body,
      replyBody: gen.data.body,
      venueInfo: ctx.venue.venueInfo,
      knowledgeChunks,
    })
    if (verify.ok) {
      hasUngroundedClaim = verify.data.hasUngroundedClaim
      ungroundedClaims = verify.data.ungroundedClaims
    } else {
      console.warn(
        `[voices/regen] grounding backstop degraded for venue=${input.venueId}: ${verify.error}`,
      )
    }
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
      console.warn(
        `[voices/regen] mechanic-offer backstop degraded for venue=${input.venueId}: ${mechanicCheck.error}`,
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
      hasUngroundedClaim,
      ungroundedClaims,
      selfTalkViolationPersisted: gen.data.selfTalkViolationPersisted,
      offersGatedMechanic,
      offeredMechanicId,
    },
  }
}
