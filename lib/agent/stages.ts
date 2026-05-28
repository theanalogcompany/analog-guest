import {
  captureClassificationLowConfidence,
  captureCorpusRetrievalBelowThreshold,
  captureDashViolationPersisted,
  captureDemoBypassedApprovalGate,
  captureRegenerationTriggered,
  captureVoiceFidelityLow,
  CLASSIFICATION_CONFIDENCE_LOW_THRESHOLD,
  CLASSIFICATION_CONFIDENCE_REROUTE_THRESHOLD,
  CORPUS_TOP_SIMILARITY_LOW_THRESHOLD,
  VOICE_FIDELITY_LOW_THRESHOLD,
} from '@/lib/analytics/posthog'
import {
  classifyMessage,
  generateMessage,
  type GenerateMessageResult,
  type KnowledgeCorpusChunk as AiKnowledgeCorpusChunk,
  type RuntimeContext as AiRuntimeContext,
  type VoiceCorpusChunk as AiVoiceCorpusChunk,
} from '@/lib/ai'
import { createAdminClient } from '@/lib/db/admin'
import { retrieveContext, retrieveKnowledgeContext } from '@/lib/rag'
import { fireRedAlert } from './alerts'
import { matchComp } from './comp-backstop'
import { getPrimaryTagPreference } from './knowledge-tag-mapping'
import type { Classification, CorpusMatch, KnowledgeMatch, RuntimeContext } from './types'
import type { MessageCategory } from '@/lib/ai'

export const STRONG_MATCH_SIMILARITY = 0.3
export const MIN_STRONG_MATCHES = 1
export const SEND_FIDELITY_FLOOR = 0.4
// TAC-212: voice fidelity below this queues the draft for operator review;
// above auto-sends (subject to the rest of applyApprovalPolicyStage).
// Sits above SEND_FIDELITY_FLOOR — < 0.4 still refuses, 0.4..0.6 queues,
// >= 0.6 evaluates the resource-commitment + sticky-pending triggers.
export const AUTO_SEND_FIDELITY_FLOOR = 0.6
export const CORPUS_RETRIEVE_LIMIT = 8
export const KNOWLEDGE_RETRIEVE_LIMIT = 4

/**
 * TAC-212 approval-policy triggers. Used as both the keys for the
 * `triggers: string[]` array on a queue decision AND the lookup keys for
 * PRIMARY_TRIGGER_PRIORITY. Exported so the orchestrator (handle-inbound,
 * handle-followup), the PostHog event helper, and tests can reuse the
 * literal strings without copy-paste drift.
 */
export const APPROVAL_TRIGGERS = {
  FIDELITY_BELOW_AUTO_SEND_FLOOR: 'fidelity_below_auto_send_floor',
  MODEL_FLAGGED: 'model_flagged',
  COMP_REGEX_BACKSTOP: 'comp_regex_backstop',
  PREVIOUS_PENDING_HELD: 'previous_pending_held',
} as const

/**
 * Union of every trigger code that can land on `messages.review_reason`.
 * Consumed by the operator-queue normalizer (lib/operator/queue.ts) to
 * keep the human-readable label map exhaustive at compile time — adding
 * a new trigger above without a corresponding label there is a TS error.
 */
export type ApprovalTrigger = (typeof APPROVAL_TRIGGERS)[keyof typeof APPROVAL_TRIGGERS]

/**
 * Priority order for picking the `primaryTrigger` (the value that lands on
 * messages.review_reason and shows up first in the operator queue UI). NOT
 * the order triggers are evaluated in (that's enumeration order, which
 * controls the `triggers: string[]` array — `triggers[0]` is the first one
 * that fired during evaluation).
 *
 * Severity rationale: irreversible financial commitments (comp regex hit)
 * outrank model self-flag because the regex is deterministic + the failure
 * mode it protects against is a comp going out unreviewed. Model-flagged
 * resource commitments outrank sticky-pending because operator attention
 * should land on the new commitment, not on "we already had a pending
 * draft." Soft signals (fidelity_below_auto_send_floor) come last.
 */
export const PRIMARY_TRIGGER_PRIORITY = [
  APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP,
  APPROVAL_TRIGGERS.MODEL_FLAGGED,
  APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD,
  APPROVAL_TRIGGERS.FIDELITY_BELOW_AUTO_SEND_FLOOR,
] as const

function pickPrimaryTrigger(triggers: readonly string[]): string {
  // Caller guarantees triggers.length > 0; the fallback to triggers[0]
  // covers the impossible case of a trigger appearing in the array but
  // missing from PRIMARY_TRIGGER_PRIORITY (future-add safety).
  for (const t of PRIMARY_TRIGGER_PRIORITY) {
    if (triggers.includes(t)) return t
  }
  return triggers[0]
}

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
    recentMessages: ctx.recentMessages,
    guestState: ctx.recognition.state,
  })
  if (!r.ok) {
    throw new Error(`classifyStage: ${r.error}`)
  }

  // 3-tier routing: < 0.3 → `unknown` (holding ack); 0.3..0.7 → classifier's
  // pick + observation event; >= 0.7 → classifier's pick + silent.
  const autoRoutedToUnknown =
    r.data.classifierConfidence < CLASSIFICATION_CONFIDENCE_REROUTE_THRESHOLD

  if (r.data.classifierConfidence < CLASSIFICATION_CONFIDENCE_LOW_THRESHOLD) {
    await captureClassificationLowConfidence({
      agentRunId: ctx.agentRunId,
      venueId: ctx.venue.id,
      guestId: ctx.guest.id,
      category: r.data.category,
      classifierConfidence: r.data.classifierConfidence,
      inboundLength: ctx.currentMessage.body.length,
      inboundBody: ctx.currentMessage.body,
      autoRoutedToUnknown,
    })
  }

  return {
    category: autoRoutedToUnknown ? 'unknown' : r.data.category,
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

/**
 * Pure predicate: should knowledge_corpus retrieval fire for this run?
 *
 *   - inbound (currentMessage present)         → true (every reply benefits
 *     from grounding; the agent doesn't know in advance whether the guest's
 *     question is substantive)
 *   - followup with reason='event' or 'manual' → true (substantive outbound:
 *     event invites raise follow-up questions; manual notes are operator-
 *     authored and typically content-heavy)
 *   - followup with reason='day_*'             → false (routine cron-triggered
 *     "thinking of you" message; pure voice exercise)
 *
 * Voice retrieval is always-on; this predicate gates only knowledge.
 */
export function shouldRetrieveKnowledge(ctx: RuntimeContext): boolean {
  if (ctx.currentMessage !== null) return true
  const reason = ctx.followupTrigger?.reason
  return reason === 'event' || reason === 'manual'
}

/**
 * Internal: retrieve knowledge_corpus matches for grounding. Degrades
 * gracefully on Voyage / DB failure — logs the error and returns []. The
 * generation can still proceed (without knowledge grounding); knowledge is
 * opportunistic context, not structural.
 *
 * Asymmetric to retrieveCorpusStage on purpose. Voice failure breaks voice
 * fidelity (the whole point of the message). Knowledge failure means the
 * reply lacks topical grounding — still a coherent message in the venue's
 * voice, just less specific. Different roles, different policies.
 *
 * TAC-242: when the inbound's classification category has a primary-tag
 * preference, the first call passes it as primary_tag_filter. If the
 * preference yields zero matches (sparse corpus for that topic), retry
 * without the filter — cosine on the raw query is the universal floor.
 */
export async function retrieveKnowledgeStage(
  ctx: RuntimeContext,
  category: MessageCategory | null,
): Promise<KnowledgeMatch[]> {
  const query =
    ctx.currentMessage?.body ??
    (ctx.followupTrigger
      ? `Followup ${ctx.followupTrigger.reason} for ${ctx.guest.firstName ?? 'guest'}`
      : '')
  if (!query) return []

  const preference = getPrimaryTagPreference(category)

  const r = await retrieveKnowledgeContext({
    venueId: ctx.venue.id,
    query,
    limit: KNOWLEDGE_RETRIEVE_LIMIT,
    primaryTagPreference: preference,
  })
  if (!r.ok) {
    console.warn(
      `[agent] knowledge retrieval degraded for venue=${ctx.venue.id}: ${r.error}${r.errorCode ? ` (${r.errorCode})` : ''}`,
    )
    return []
  }

  if (preference !== undefined && r.data.length === 0) {
    const fallback = await retrieveKnowledgeContext({
      venueId: ctx.venue.id,
      query,
      limit: KNOWLEDGE_RETRIEVE_LIMIT,
    })
    if (!fallback.ok) {
      console.warn(
        `[agent] knowledge retrieval (fallback) degraded for venue=${ctx.venue.id}: ${fallback.error}`,
      )
      return []
    }
    return fallback.data
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
  // knowledgeCorpus is null when retrieval was gated off (composer omits the
  // block), [] when it fired and matched nothing (composer renders the
  // explicit "no venue knowledge matched" block — TAC-242). Pass through
  // with the same similarity → relevanceScore mapping voice uses, plus the
  // primary/secondary tag split for the new prompt rendering.
  const knowledgeChunks: AiKnowledgeCorpusChunk[] | undefined =
    ctx.knowledgeCorpus === null
      ? undefined
      : ctx.knowledgeCorpus.map((c) => ({
          id: c.id,
          text: c.text,
          sourceType: c.sourceType,
          primaryTags: c.primaryTags,
          secondaryTags: c.secondaryTags,
          relevanceScore: c.similarity,
        }))
  const r = await generateMessage({
    category,
    persona: ctx.venue.brandPersona,
    venueInfo: ctx.venue.venueInfo,
    ragChunks,
    knowledgeChunks,
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

/**
 * TAC-212 approval-policy gate. Runs after generateStage returns success;
 * decides whether to dispatch via Sendblue (action='send') or persist as a
 * pending draft for operator review (action='queue').
 *
 * Four triggers compose. Any one fires → queue. The triggers[] array
 * preserves enumeration order (the order checks fired). primaryTrigger is
 * picked via PRIMARY_TRIGGER_PRIORITY so the operator queue UI surfaces the
 * most severe signal first.
 *
 * Fail-OPEN on the sticky-pending DB read (returns send rather than queue
 * when the lookup throws) — refusing to send because of an observability
 * read failure is worse than the rare race of a draft auto-sending while a
 * sibling pending draft exists. TAC-264 closes this loop structurally via
 * the partial unique index on `messages (venue_id, guest_id) WHERE
 * review_state='pending'` (migration 020) — concurrent INSERTs from rapid
 * inbounds get caught by the index and recovered to UPDATE inside
 * persistOrRegenQueuedDraft.
 *
 * TAC-264: queue decisions carry `existingPendingDraftId` so the persist
 * layer knows whether to INSERT a fresh pending row or UPDATE the existing
 * one in place (regenerate). When non-null, PREVIOUS_PENDING_HELD is also
 * in `triggers`, structurally guaranteeing the gate returns action='queue'
 * — no-demotion-on-regeneration is enforced by the trigger, not by the
 * orchestrator. (The orchestrator-layer override per the TAC-264 plan
 * review is the dispatch of existingPendingDraftId to the persist layer;
 * the trigger does the queue-vs-send decision.)
 *
 * Not invoked when the followup trigger reason is `manual` — that path
 * bypasses the gate entirely (the Command Center Follow Up button is an
 * explicit operator action; operator already approved by clicking).
 *
 * TAC-284: when `ctx.guest.isDemo === true` the gate short-circuits to
 * `{ action: 'send', reason: 'demo_bypass' }` regardless of trigger
 * evaluation — every trigger including the comp regex backstop is
 * overridden. The orchestrator stamps `messages.review_reason='demo_bypass'`
 * on the send so the row is self-describing. See applyApprovalPolicyStage.
 */
export type ApprovalDecision =
  // `reason` is only present on the demo-bypass send. A normal
  // (untriggered) send leaves it undefined. The orchestrator threads
  // `reason` into scheduleAndSend's `reviewReason` option so the demo
  // bypass lands on messages.review_reason.
  | { action: 'send'; reason?: 'demo_bypass' }
  | {
      action: 'queue'
      triggers: string[]
      primaryTrigger: string
      compMatchedPattern: string | null
      // TAC-264: when non-null, the persist layer UPDATEs this row in place
      // (regenerate) instead of INSERTing a new pending row. Captured from
      // findPendingDraft() during trigger 4 evaluation so the persist layer
      // doesn't need a second round-trip.
      existingPendingDraftId: string | null
    }

export async function applyApprovalPolicyStage(
  ctx: RuntimeContext,
  generation: GenerateMessageResult,
): Promise<ApprovalDecision> {
  const triggers: string[] = []

  // Trigger 1: voice fidelity in the 0.4–0.6 band → queue.
  // (< 0.4 already refused by generateStage upstream; >= 0.6 passes here.)
  if (generation.voiceFidelity < AUTO_SEND_FIDELITY_FLOOR) {
    triggers.push(APPROVAL_TRIGGERS.FIDELITY_BELOW_AUTO_SEND_FLOOR)
  }

  // Trigger 2: model self-flagged a resource commitment via the structured
  // output's requiresOperatorApproval field.
  if (generation.requiresOperatorApproval) {
    triggers.push(APPROVAL_TRIGGERS.MODEL_FLAGGED)
  }

  // Trigger 3: comp regex backstop — runs INDEPENDENTLY of trigger 2 so a
  // missed model self-flag on a comp commitment still queues.
  const comp = matchComp(generation.body)
  if (comp.matched) {
    triggers.push(APPROVAL_TRIGGERS.COMP_REGEX_BACKSTOP)
  }

  // Trigger 4: sticky pending — there's already a pending draft for this
  // (venue_id, guest_id). TAC-264 routes regeneration through the persist
  // layer using the captured row ID rather than the boolean signal alone.
  const existingPending = await findPendingDraft(ctx.venue.id, ctx.guest.id)
  if (existingPending !== null) {
    triggers.push(APPROVAL_TRIGGERS.PREVIOUS_PENDING_HELD)
  }

  // TAC-284: demo guest bypass. Evaluated AFTER all four triggers (so the
  // would-have-queued set — including the previous_pending_held DB read — is
  // accurate for the analytics event) but BEFORE the queue return. The
  // bypass is total: every trigger, including the comp regex backstop, is
  // overridden. Fail-CLOSED — only the literal boolean `true` bypasses;
  // `undefined` / `null` / a missing column all fall through to the normal
  // policy below. The demo_bypassed_approval_gate event fires only when the
  // bypass actually overrode a queue decision (triggers non-empty); a clean
  // demo reply that would have auto-sent anyway produces no event.
  if (ctx.guest.isDemo === true) {
    if (triggers.length > 0) {
      await captureDemoBypassedApprovalGate({
        agentRunId: ctx.agentRunId,
        venueId: ctx.venue.id,
        guestId: ctx.guest.id,
        wouldHaveQueuedTriggers: triggers,
        voiceFidelity: generation.voiceFidelity,
        generatedBody: generation.body,
      })
    }
    return { action: 'send', reason: 'demo_bypass' }
  }

  if (triggers.length === 0) {
    return { action: 'send' }
  }
  return {
    action: 'queue',
    triggers,
    primaryTrigger: pickPrimaryTrigger(triggers),
    compMatchedPattern: comp.matched ? comp.pattern : null,
    existingPendingDraftId: existingPending?.id ?? null,
  }
}

/**
 * Read-side lookup for an existing pending draft for the (venue, guest)
 * pair. Hits the migration 018 partial index
 * `idx_messages_review_state_pending (venue_id, created_at) WHERE review_state='pending'`
 * — single cheap lookup. Returns the row's id + body when found (body is
 * captured for forensic logging and future no-op detection; not load-bearing
 * at the route level), or null on miss / DB error.
 *
 * Fails OPEN: any throw is caught + logged + returns null so the approval
 * gate proceeds to send rather than refusing on a DB read failure. The
 * sticky-pending signal is the lowest-stakes of the four triggers; the
 * regex backstop and model self-flag don't depend on it. The partial
 * unique index from migration 020 is the structural backstop against
 * concurrent rapid-inbound races that slip past this read.
 *
 * Exported for the test suite. TAC-264 renamed from hasPendingDraft (which
 * returned a boolean) to surface the row identity for the persist layer.
 */
export async function findPendingDraft(
  venueId: string,
  guestId: string,
): Promise<{ id: string; body: string } | null> {
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('messages')
      .select('id, body')
      .eq('venue_id', venueId)
      .eq('guest_id', guestId)
      .eq('direction', 'outbound')
      .eq('review_state', 'pending')
      .limit(1)
      .maybeSingle()
    if (error) {
      console.warn(
        `[agent] findPendingDraft lookup degraded for venue=${venueId} guest=${guestId}: ${error.message}`,
      )
      return null
    }
    return data
  } catch (e) {
    console.warn(
      `[agent] findPendingDraft threw for venue=${venueId} guest=${guestId}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    return null
  }
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

/**
 * Map orchestrator RuntimeContext → lib/ai's RuntimeContext shape.
 * Exported so the Voices regen helper can reuse the same mapping without
 * duplicating timezone validation, follow-up framing, or the recentVisits
 * threading. Regen post-injects `critiqueToIncorporate` on top of the
 * returned object — this function deliberately doesn't know about that
 * field so the standard agent paths stay identical.
 */
export function buildAiRuntime(ctx: RuntimeContext): AiRuntimeContext {
  let additionalContext: string | undefined
  let operatorInstruction: string | undefined
  if (ctx.followupTrigger) {
    if (ctx.followupTrigger.reason === 'manual') {
      // Operator-initiated follow-up via the Command Center button. THE-232
      // splits the operator's note out of additionalContext into its own
      // dedicated field, which the serializer renders as a prominent
      // top-level "## Operator instruction" block. This makes the note the
      // dominant signal rather than an easy-to-miss line at the bottom of
      // the user prompt.
      //
      // The note still travels as content guidance, not voice mimicry — the
      // agent speaks in the venue persona regardless of how the operator
      // phrased their note. That voice discipline is reinforced in the
      // manual-category instructions and the new prompt block.
      const rawHint = ctx.followupTrigger.metadata?.hint
      const hint =
        typeof rawHint === 'string' && rawHint.trim().length > 0 ? rawHint.trim() : null
      if (hint) {
        operatorInstruction = hint
      } else {
        // No note — fall back to the generic framing as before, via
        // additionalContext. Without the block firing, Sonnet still needs
        // to know this was operator-initiated.
        additionalContext =
          'The venue operator has asked you to follow up with this guest. Use your judgment about what to say based on the conversation history and guest context.'
      }
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
    operatorInstruction,
    today: computeToday(timezone),
    recentMessages: ctx.recentMessages,
    mechanics: ctx.mechanics,
    // TAC-234: thread the recent transactions through to the AI module's
    // RuntimeContext. The serializer gates rendering by category (welcome /
    // opt_out skip) and on non-emptiness. recognition state is surfaced as
    // a `Guest relationship: <state>` line near the inbound framing.
    recentVisits: ctx.recentVisits,
    recognition: { state: ctx.recognition.state },
    // TAC-296: thread parsed guest context (post-filterActiveLifeContext +
    // observations-truncated) through to the AI module. The serializer
    // (formatGuestContext) renders the `## Guest context` block between
    // visit history and recent conversation; empty context omits the block.
    guestContext: ctx.guest.context,
  }
}