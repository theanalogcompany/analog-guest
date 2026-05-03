import {
  captureClassificationLowConfidence,
  captureCorpusRetrievalBelowThreshold,
  captureDashViolationPersisted,
  captureRegenerationTriggered,
  captureVoiceFidelityLow,
  CLASSIFICATION_CONFIDENCE_LOW_THRESHOLD,
  CORPUS_TOP_SIMILARITY_LOW_THRESHOLD,
  VOICE_FIDELITY_LOW_THRESHOLD,
} from '@/lib/analytics/posthog'
import {
  classifyMessage,
  generateMessage,
  type GenerateMessageResult,
  type RuntimeContext as AiRuntimeContext,
  type VoiceCorpusChunk as AiVoiceCorpusChunk,
} from '@/lib/ai'
import { retrieveContext } from '@/lib/rag'
import { fireRedAlert } from './alerts'
import type { Classification, CorpusMatch, RuntimeContext } from './types'

const STRONG_MATCH_SIMILARITY = 0.3
const MIN_STRONG_MATCHES = 1
const SEND_FIDELITY_FLOOR = 0.4
const CORPUS_RETRIEVE_LIMIT = 8

/**
 * Internal: classify the inbound message via lib/ai. Throws on AI failure
 * with a prefixed error message; caller catches and fires the appropriate
 * red alert.
 */
export async function classifyStage(ctx: RuntimeContext): Promise<Classification> {
  if (!ctx.currentMessage) {
    throw new Error('classifyStage: no inbound message on context')
  }
  const r = await classifyMessage({
    inboundBody: ctx.currentMessage.body,
    persona: ctx.venue.brandPersona,
    venueInfo: ctx.venue.venueInfo,
  })
  if (!r.ok) {
    throw new Error(`classifyStage: ${r.error}`)
  }

  if (r.data.classifierConfidence < CLASSIFICATION_CONFIDENCE_LOW_THRESHOLD) {
    await captureClassificationLowConfidence({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      category: r.data.category,
      classifierConfidence: r.data.classifierConfidence,
      inboundLength: ctx.currentMessage.body.length,
      inboundBody: ctx.currentMessage.body,
    })
  }

  return {
    category: r.data.category,
    classifierConfidence: r.data.classifierConfidence,
    reasoning: r.data.reasoning,
  }
}

/**
 * Internal: retrieve voice-corpus matches and enforce the orchestrator's
 * threshold rule — at least MIN_STRONG_MATCHES (1) chunk scoring at or above
 * STRONG_MATCH_SIMILARITY (0.3). Below that, fail closed; the prompt doesn't
 * have enough venue voice to ground a generation.
 *
 * TODO(THE-158): per-category thresholds — generic messages like "hi"
 * shouldn't need the same corpus depth as topic-specific ones. Calibrate
 * against real corpus data after first 100 inbound messages.
 */
export async function retrieveCorpusStage(ctx: RuntimeContext): Promise<CorpusMatch[]> {
  const query =
    ctx.currentMessage?.body ??
    (ctx.followupTrigger
      ? `Followup ${ctx.followupTrigger.reason} for ${ctx.guest.firstName ?? 'guest'}`
      : '')
  if (!query) {
    throw new Error('retrieveCorpusStage: no query available (no inbound, no followup)')
  }
  const r = await retrieveContext({
    venueId: ctx.venue.id,
    query,
    limit: CORPUS_RETRIEVE_LIMIT,
  })
  if (!r.ok) {
    throw new Error(`retrieveCorpusStage: ${r.error}`)
  }
  const strongCount = r.data.filter((m) => m.similarity >= STRONG_MATCH_SIMILARITY).length
  // THE-231: only fail closed on the inbound path. Followups are operator-
  // initiated (cron trigger or Command Center button); the synthetic followup
  // query — "Followup manual for {firstName}" — rarely embeds anywhere near
  // the venue's actual voice corpus, so the strong-match gate was failing
  // every Follow Up button click. Proceed with whatever surfaced (even zero);
  // generateStage handles an empty corpus gracefully (ragChunksToProse drops
  // the block entirely). The captureCorpusRetrievalBelowThreshold event below
  // still fires on both paths so the visibility doesn't change.
  if (ctx.currentMessage && strongCount < MIN_STRONG_MATCHES) {
    throw new Error(
      `retrieveCorpusStage: insufficient_corpus_matches (got ${strongCount} above ${STRONG_MATCH_SIMILARITY}, need ${MIN_STRONG_MATCHES}; total ${r.data.length})`,
    )
  }

  // Observability event: thin retrieval. Looser bar than the gate above —
  // retrieval succeeded structurally but the best match is weak, suggesting
  // the prompt may lack venue-voice grounding.
  const topSimilarity = r.data.length > 0 ? Math.max(...r.data.map((m) => m.similarity)) : 0
  if (topSimilarity < CORPUS_TOP_SIMILARITY_LOW_THRESHOLD) {
    const topMatch = r.data.length > 0
      ? r.data.reduce((a, b) => (a.similarity >= b.similarity ? a : b))
      : null
    await captureCorpusRetrievalBelowThreshold({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      totalMatches: r.data.length,
      strongMatchCount: strongCount,
      topSimilarity,
      inboundBody: ctx.currentMessage?.body ?? null,
      topMatchPreview: topMatch ? topMatch.text.slice(0, 200) : null,
    })
  }

  return r.data
}

export type GenerateOutcome =
  | { status: 'success'; result: GenerateMessageResult }
  | { status: 'refused'; attemptScores: number[]; finalScore: number }
  | { status: 'failed'; error: string }

/**
 * Internal: call lib/ai's generateMessage and apply the orchestrator's
 * send-floor.
 *
 * lib/ai's internal regeneration loop uses 0.7 as its loop-exit threshold
 * (it tries up to 3 times to cross 0.7). This stage applies a separate
 * orchestrator-level rule on the final returned voiceFidelity:
 *   < SEND_FIDELITY_FLOOR (0.4) → 'refused' (don't send; alert)
 *   >= 0.4                       → 'success' (send, even if below 0.7)
 *
 * The two thresholds answer different questions: 0.7 is "good enough to stop
 * trying"; 0.4 is "good enough to send to a human".
 */
export async function generateStage(
  ctx: RuntimeContext,
  category: Classification['category'],
): Promise<GenerateOutcome> {
  if (!ctx.corpus) return { status: 'failed', error: 'corpus missing on context' }
  // lib/rag types sourceType as plain string; lib/ai narrows it to a closed
  // union. The DB check constraint on voice_corpus.source_type guarantees
  // runtime values are inside that union, so the per-field cast is sound.
  // (TODO in lib/rag: tighten the type when the corpus management UI ships.)
  const ragChunks: AiVoiceCorpusChunk[] = ctx.corpus.map((c) => ({
    id: c.id,
    text: c.text,
    sourceType: c.sourceType as AiVoiceCorpusChunk['sourceType'],
    // lib/rag exposes cosine `similarity` (0–1); lib/ai's prompt composer
    // expects `relevanceScore?`. Same semantics — pass through.
    relevanceScore: c.similarity,
  }))
  const r = await generateMessage({
    category,
    persona: ctx.venue.brandPersona,
    venueInfo: ctx.venue.venueInfo,
    ragChunks,
    runtime: buildAiRuntime(ctx),
  })
  if (!r.ok) return { status: 'failed', error: r.error }

  // Observability events: emit before the floor-check return so they fire
  // for both refused (< 0.4) and below-0.5-but-above-0.4 sends.
  if (r.data.voiceFidelity < VOICE_FIDELITY_LOW_THRESHOLD) {
    await captureVoiceFidelityLow({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      voiceFidelity: r.data.voiceFidelity,
      attempts: r.data.attempts,
      attemptScores: r.data.attemptScores,
      category,
      inboundBody: ctx.currentMessage?.body ?? null,
      generatedBody: r.data.body,
    })
  }
  if (r.data.attempts > 1) {
    await captureRegenerationTriggered({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      attempts: r.data.attempts,
      attemptScores: r.data.attemptScores,
      finalFidelity: r.data.voiceFidelity,
      inboundBody: ctx.currentMessage?.body ?? null,
      finalGeneratedBody: r.data.body,
    })
  }
  // THE-225: dash check exhausted regen attempts and the body still has a
  // dash. Ship anyway (refusing on punctuation would be worse than violating
  // it) and surface the failure on PostHog + Slack alongside the other
  // generation-stage silent failures.
  if (r.data.dashViolationPersisted) {
    await captureDashViolationPersisted({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      category,
      attempts: r.data.attempts,
      attemptScores: r.data.attemptScores,
      finalFidelity: r.data.voiceFidelity,
      inboundBody: ctx.currentMessage?.body ?? null,
      finalGeneratedBody: r.data.body,
    })
  }

  if (r.data.voiceFidelity < SEND_FIDELITY_FLOOR) {
    return {
      status: 'refused',
      attemptScores: r.data.attemptScores,
      finalScore: r.data.voiceFidelity,
    }
  }
  return { status: 'success', result: r.data }
}

const FALLBACK_TIMEZONE = 'America/Los_Angeles'

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function computeToday(timezone: string, now: Date = new Date()): NonNullable<AiRuntimeContext['today']> {
  // Caller (buildAiRuntime) is responsible for passing a validated timezone —
  // otherwise Intl.DateTimeFormat throws a RangeError mid-format.
  // en-CA renders dates as YYYY-MM-DD; en-GB renders 24h HH:MM. Both are
  // locale conventions we exploit to avoid manual formatting.
  const isoDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const dayOfWeek = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
  }).format(now)
  const venueLocalTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)

  return { isoDate, dayOfWeek, venueLocalTime, venueTimezone: timezone }
}

function buildAiRuntime(ctx: RuntimeContext): AiRuntimeContext {
  let additionalContext: string | undefined
  if (ctx.followupTrigger) {
    if (ctx.followupTrigger.reason === 'manual') {
      // Operator-initiated follow-up via the Command Center button. The
      // hint (if any) is content guidance only — the agent still speaks in
      // the venue persona; we do not let operator phrasing leak into the
      // outbound voice.
      const rawHint = ctx.followupTrigger.metadata?.hint
      const hint =
        typeof rawHint === 'string' && rawHint.trim().length > 0 ? rawHint.trim() : null
      additionalContext = hint
        ? `The venue operator has asked you to follow up with this guest. Their note: "${hint}". Use this as guidance for what to address; keep your usual voice.`
        : `The venue operator has asked you to follow up with this guest. Use your judgment about what to say based on the conversation history and guest context.`
    } else {
      // Cron-triggered follow-ups (day_1/day_3/etc., event). Existing path.
      const meta = ctx.followupTrigger.metadata
      additionalContext = meta
        ? `Followup trigger: ${ctx.followupTrigger.reason} (${JSON.stringify(meta)})`
        : `Followup trigger: ${ctx.followupTrigger.reason}`
    }
  }

  // Validate venue timezone. On failure, log + fire a meta-alert (Slack
  // surface so the broken venue config gets fixed) and proceed with a sane
  // fallback. Fire-and-forget — fireRedAlert never throws, and we don't want
  // generation to block on a webhook roundtrip.
  let timezone = ctx.venue.timezone
  if (!isValidTimezone(timezone)) {
    console.warn(
      `computeToday: invalid timezone "${timezone}" for venue ${ctx.venue.id}, falling back to ${FALLBACK_TIMEZONE}`,
    )
    void fireRedAlert({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      kind: ctx.currentMessage ? 'inbound' : 'followup',
      stage: 'venue_config_integrity',
      errorCode: 'invalid_timezone',
      errorMessage: `invalid timezone string: "${timezone}"`,
      extra: {
        providedTimezone: timezone,
        fallbackUsed: FALLBACK_TIMEZONE,
      },
    })
    timezone = FALLBACK_TIMEZONE
  }

  return {
    guestName: ctx.guest.firstName ?? undefined,
    inboundMessage: ctx.currentMessage?.body,
    additionalContext,
    today: computeToday(timezone),
    recentMessages: ctx.recentMessages,
    mechanics: ctx.mechanics,
    // THE-229: thread the LastVisit projection from the orchestrator's
    // RuntimeContext to the AI module's RuntimeContext. The serializer
    // gates rendering by category (welcome / opt_out skip the block).
    lastVisit: ctx.lastVisit ?? undefined,
  }
}