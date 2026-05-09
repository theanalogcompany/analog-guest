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
  type VoiceCorpusChunk as AiVoiceCorpusChunk,
} from '@/lib/ai'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
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

  // 5. Retrieve knowledge corpus (graceful degradation, mirrors stages.ts)
  let knowledgeChunks: AiKnowledgeCorpusChunk[] = []
  const knowledge = await retrieveKnowledgeContext({
    venueId: input.venueId,
    query: load.data.inbound.body,
    limit: KNOWLEDGE_RETRIEVE_LIMIT,
  })
  if (knowledge.ok) {
    knowledgeChunks = knowledge.data.map((c) => ({
      id: c.id,
      text: c.text,
      sourceType: c.sourceType,
      tags: c.tags,
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

  return {
    ok: true,
    data: {
      body: gen.data.body,
      voiceFidelity: gen.data.voiceFidelity,
      attempts: gen.data.attempts,
      attemptScores: gen.data.attemptScores,
      generatedAt: new Date(),
    },
  }
}
