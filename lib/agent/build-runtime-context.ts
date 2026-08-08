import { createAdminClient } from '@/lib/db/admin'
import type { AgentTrace } from '@/lib/observability'
import {
  computeGuestState,
  type EligibilityCandidate,
  filterEligibleMechanics,
  type MechanicType,
  type RedemptionPolicy,
  type RedemptionRecord,
} from '@/lib/recognition'
import {
  BrandPersonaSchema,
  filterActiveContext,
  GuestContextSchema,
  toActiveCommitment,
  toParsedGuestContext,
  VenueInfoSchema,
} from '@/lib/schemas'
import { findActiveCommitmentsForGuest } from '@/lib/guests/commitments'
import { parseApprovalPolicy } from '@/lib/schemas/approval-policy'
import { extractRecentVisits } from './extract-recent-visits'
import { groupIntoResponses } from './group-responses'
import { findPendingQuestion } from './pending-question'
import { MAX_BUBBLES_PER_RESPONSE } from './split-message'
import type {
  AgentRunId,
  FollowupTrigger,
  GuestContext,
  InboundMessage,
  RecentMessage,
  RecognitionSnapshot,
  RuntimeContext,
  VenueContext,
} from './types'

// TAC-313: a cap on RESPONSES, not on rows. A split reply occupies one slot
// here however many bubbles it was dispatched as — otherwise the agent's sense
// of what was just said would get shallower every time it split.
export const MAX_HISTORY_MESSAGES = 30
export const MAX_HISTORY_DAYS = 14
const MS_PER_DAY = 24 * 60 * 60 * 1000
// TAC-234: visit history loaded into RuntimeContext.recentVisits. Cap
// guards against prompt bloat on chatty regulars; window matches recognition's
// visit-frequency scoring window so "what we surface" and "what counts toward
// state" stay aligned.
export const MAX_VISIT_HISTORY_TRANSACTIONS = 20
export const MAX_VISIT_HISTORY_DAYS = 90

/**
 * Build the full RuntimeContext for an agent run by fetching venue + guest +
 * recognition snapshot in parallel, then validating the venue's JSONB config
 * blobs at the boundary.
 *
 * Server-only. Uses the admin DB client, which bypasses RLS. Fails closed —
 * throws on venue/guest not found, missing venue_configs row, missing
 * messaging_phone_number, brand_persona or venue_info Zod validation
 * failures, or recognition module returning a failure result. The caller
 * (handle-inbound / handle-followup) catches and fires a red alert at the
 * 'context_build' stage.
 *
 * Mutually exclusive: pass exactly one of `currentMessage` (inbound flow) or
 * `followupTrigger` (followup flow) per call. Not enforced via a
 * discriminated union for v1 — document and trust the caller.
 *
 * The returned RuntimeContext has `corpus: null` and `classification: null`;
 * those are populated by later stages in the orchestrator.
 *
 * Side effect: computeGuestState writes a state-transition row if the
 * computed state differs from the persisted state. This is intentional —
 * recognition is live-computed every run with no caching.
 */
export async function buildRuntimeContext(input: {
  agentRunId: AgentRunId
  guestId: string
  venueId: string
  trace: AgentTrace
  currentMessage?: InboundMessage
  followupTrigger?: FollowupTrigger
  /**
   * Upper bound for the recent-conversation history query — when set,
   * filters `messages.created_at < historyEndIso`. Used by the Voices
   * regen path to pin history to the moment of the original outbound
   * (regenerating a historical message shouldn't see messages that came
   * after it). Production agent paths leave this undefined and get the
   * default unbounded-upward behavior.
   */
  historyEndIso?: string
}): Promise<RuntimeContext> {
  const supabase = createAdminClient()
  const computedAt = new Date()
  const historyCutoffIso = new Date(Date.now() - MAX_HISTORY_DAYS * MS_PER_DAY).toISOString()

  // Exclude the current inbound row (it's already in the table by the time the
  // agent runs, and gets rendered separately as `inboundMessage` in the prompt).
  // For followups there's no currentMessage, so no exclusion.
  // TAC-313: fetch enough ROWS to guarantee MAX_HISTORY_MESSAGES RESPONSES,
  // then group. The bound is exact because the cap on bubbles per response is
  // enforced in the sender (splitIntoBubbles), so this many rows can never
  // yield fewer than MAX_HISTORY_MESSAGES groups.
  let messagesQuery = supabase
    .from('messages')
    .select('id, direction, body, created_at, generation_id')
    .eq('venue_id', input.venueId)
    .eq('guest_id', input.guestId)
    .neq('body', '')
    .gte('created_at', historyCutoffIso)
    .order('created_at', { ascending: false })
    .limit(MAX_HISTORY_MESSAGES * MAX_BUBBLES_PER_RESPONSE)
  if (input.currentMessage) {
    messagesQuery = messagesQuery.neq('id', input.currentMessage.id)
  }
  if (input.historyEndIso) {
    messagesQuery = messagesQuery.lt('created_at', input.historyEndIso)
  }

  const visitHistoryCutoffIso = new Date(
    Date.now() - MAX_VISIT_HISTORY_DAYS * MS_PER_DAY,
  ).toISOString()

  const [
    venueResult,
    guestResult,
    recognitionResult,
    messagesResult,
    mechanicsResult,
    redemptionsResult,
    visitHistoryResult,
    activeCommitmentsResult,
    pendingQuestionResult,
  ] = await Promise.all([
    supabase
      .from('venues')
      .select(
        'id, slug, timezone, messaging_phone_number, hold_all_outbound, venue_configs(brand_persona, venue_info, approval_policy)',
      )
      .eq('id', input.venueId)
      .single(),
    supabase
      .from('guests')
      .select('id, phone_number, first_name, created_at, created_via, is_demo, context, last_visit_at')
      .eq('id', input.guestId)
      .single(),
    computeGuestState({ guestId: input.guestId, venueId: input.venueId }),
    messagesQuery,
    supabase
      .from('mechanics')
      .select(
        'id, type, name, description, qualification, reward_description, min_state, redemption_policy, redemption_window_days, requires_operator_approval',
      )
      .eq('venue_id', input.venueId)
      .eq('is_active', true),
    supabase
      .from('engagement_events')
      .select('mechanic_id, created_at')
      .eq('venue_id', input.venueId)
      .eq('guest_id', input.guestId)
      .eq('event_type', 'mechanic_redeemed')
      .not('mechanic_id', 'is', null),
    // TAC-234: up to MAX_VISIT_HISTORY_TRANSACTIONS within the past
    // MAX_VISIT_HISTORY_DAYS, most-recent-first. Runs in parallel with the
    // other six queries so it adds no serial latency. extractRecentVisits
    // applies the per-row freshness + line-item parseability filters.
    supabase
      .from('transactions')
      .select('occurred_at, raw_data')
      .eq('venue_id', input.venueId)
      .eq('guest_id', input.guestId)
      .gte('occurred_at', visitHistoryCutoffIso)
      .order('occurred_at', { ascending: false })
      .limit(MAX_VISIT_HISTORY_TRANSACTIONS),
    // TAC-297: open + pending_ack commitments for this guest at this venue.
    // Fail-OPEN at load (RAGResult-typed helper logs + returns error; we
    // degrade to [] so the agent run continues without the block rather than
    // crashing on a commitments-load DB hiccup). Runs in parallel with the
    // other seven queries.
    findActiveCommitmentsForGuest({
      venueId: input.venueId,
      guestId: input.guestId,
    }),
    // TAC-308: the question this guest is still owed an answer to, if a
    // knowledge-gap card is holding the pending slot. Fail-OPEN inside the
    // helper (returns null on any DB error) — the block is a nudge on top of
    // the universal no-promise rules, not the guardrail itself. Runs in
    // parallel with the other eight queries; the common case is one indexed
    // lookup that matches nothing.
    findPendingQuestion(input.venueId, input.guestId),
  ])

  if (venueResult.error || !venueResult.data) {
    throw new Error(
      `buildRuntimeContext: venue not found (${input.venueId}): ${
        venueResult.error?.message ?? 'no data'
      }`,
    )
  }
  if (guestResult.error || !guestResult.data) {
    throw new Error(
      `buildRuntimeContext: guest not found (${input.guestId}): ${
        guestResult.error?.message ?? 'no data'
      }`,
    )
  }
  if (!recognitionResult.ok) {
    throw new Error(
      `buildRuntimeContext: recognition compute failed: ${recognitionResult.error}`,
    )
  }
  if (messagesResult.error) {
    throw new Error(
      `buildRuntimeContext: messages history load failed: ${messagesResult.error.message}`,
    )
  }
  if (mechanicsResult.error) {
    throw new Error(
      `buildRuntimeContext: mechanics load failed: ${mechanicsResult.error.message}`,
    )
  }
  if (redemptionsResult.error) {
    throw new Error(
      `buildRuntimeContext: redemption events load failed: ${redemptionsResult.error.message}`,
    )
  }
  if (visitHistoryResult.error) {
    throw new Error(
      `buildRuntimeContext: visit history load failed: ${visitHistoryResult.error.message}`,
    )
  }

  const venueRow = venueResult.data
  if (!venueRow.messaging_phone_number) {
    throw new Error(
      `buildRuntimeContext: venue ${input.venueId} has no messaging_phone_number`,
    )
  }

  // venue_configs is an embedded relation. PostgREST may return it as either
  // a nested object (1:1 by PK), an array, or null when no row exists.
  // Normalize all three to a single record-or-null shape.
  const configRaw = venueRow.venue_configs
  const config = Array.isArray(configRaw) ? configRaw[0] ?? null : configRaw

  if (!config) {
    throw new Error(
      `buildRuntimeContext: venue ${input.venueId} has no venue_configs row`,
    )
  }

  const brandPersonaParsed = BrandPersonaSchema.safeParse(config.brand_persona)
  if (!brandPersonaParsed.success) {
    throw new Error(
      `buildRuntimeContext: brand_persona JSONB validation failed: ${brandPersonaParsed.error.message}`,
    )
  }

  const venueInfoParsed = VenueInfoSchema.safeParse(config.venue_info)
  if (!venueInfoParsed.success) {
    throw new Error(
      `buildRuntimeContext: venue_info JSONB validation failed: ${venueInfoParsed.error.message}`,
    )
  }

  const venueInfo = {
    ...venueInfoParsed.data,
    currentContext: filterActiveContext(venueInfoParsed.data.currentContext, computedAt),
  }

  const venue: VenueContext = {
    id: venueRow.id,
    slug: venueRow.slug,
    brandPersona: brandPersonaParsed.data,
    venueInfo,
    timezone: venueRow.timezone,
    sendblueNumber: venueRow.messaging_phone_number,
    // TAC-XXX: NOT NULL DEFAULT false at the column level, so this is always
    // a real boolean. `=== true` guards against a hand-patched-types drift.
    holdAllOutbound: venueRow.hold_all_outbound === true,
    // v1.24.0: first reader of venue_configs.approval_policy since the column
    // was seeded on 2026-04-27. parseApprovalPolicy fails OPEN to defaults on
    // null/malformed; the defaults route comp_complaint to operator review, so
    // a bad policy row yields more oversight rather than less.
    approvalPolicy: parseApprovalPolicy(config.approval_policy),
  }

  const guestRow = guestResult.data
  // TAC-296: parse guests.context JSONB at the boundary. fail-OPEN on
  // malformed payload — log + treat as empty context. The agent already
  // tolerates missing context (the ## Guest context block is omitted when
  // empty), so a malformed row degrades gracefully rather than crashing the
  // run on stored bad data. Per-entry resilience (expired/malformed
  // life_context expires_at) is handled inside toParsedGuestContext via
  // filterActiveLifeContext.
  const guestContextParsed = GuestContextSchema.safeParse(guestRow.context)
  if (!guestContextParsed.success) {
    console.warn(
      `[agent] buildRuntimeContext: malformed guests.context for ${guestRow.id}: ${guestContextParsed.error.message}. Treating as empty.`,
    )
  }
  const parsedGuestContext = toParsedGuestContext(
    guestContextParsed.success ? guestContextParsed.data : {},
    computedAt,
  )

  const guest: GuestContext = {
    id: guestRow.id,
    phoneNumber: guestRow.phone_number,
    firstName: guestRow.first_name,
    createdAt: new Date(guestRow.created_at),
    createdVia: guestRow.created_via,
    isDemo: guestRow.is_demo,
    context: parsedGuestContext,
    // TAC-244: anchor source for `cold_lapsed` follow-up reasons. `null` for
    // guests who have never visited; deriveFollowupContext (stages.ts)
    // ignores this field for post_visit_* reasons (those anchor on
    // recentVisits[0]).
    lastVisitAt: guestRow.last_visit_at ? new Date(guestRow.last_visit_at) : null,
  }

  const recognition: RecognitionSnapshot = {
    score: recognitionResult.data.score,
    state: recognitionResult.data.state,
    signals: recognitionResult.data.signals,
    weights: recognitionResult.data.weights,
    contributions: recognitionResult.data.contributions,
    computedAt,
  }

  // Query returns DESC. groupIntoResponses folds each response's bubbles into
  // one entry, caps at MAX_HISTORY_MESSAGES responses, and returns
  // chronological order for the prompt.
  const recentMessages: RecentMessage[] = groupIntoResponses(
    messagesResult.data ?? [],
    MAX_HISTORY_MESSAGES,
  )

  const mechanicCandidates: EligibilityCandidate[] = (mechanicsResult.data ?? []).map((m) => ({
    id: m.id,
    type: m.type as MechanicType,
    name: m.name,
    description: m.description,
    qualification: m.qualification,
    rewardDescription: m.reward_description,
    minState: m.min_state,
    redemptionPolicy: m.redemption_policy as RedemptionPolicy,
    redemptionWindowDays: m.redemption_window_days,
    requiresOperatorApproval: m.requires_operator_approval,
  }))

  const redemptions: RedemptionRecord[] = (redemptionsResult.data ?? [])
    .filter((r): r is { mechanic_id: string; created_at: string } => r.mechanic_id !== null)
    .map((r) => ({
      mechanicId: r.mechanic_id,
      createdAt: new Date(r.created_at),
    }))

  const mechanics = filterEligibleMechanics(
    mechanicCandidates,
    redemptions,
    recognition.state,
    computedAt,
  )

  // TAC-234: project the recent transactions into the agent-facing Visit[]
  // shape. extractRecentVisits drops rows whose raw_data has no parseable
  // items or whose timestamp is malformed. Empty array is meaningful — it
  // means "no qualifying visits to surface" and the serializer omits the
  // ## Visit history block entirely.
  const recentVisits = extractRecentVisits(
    visitHistoryResult.data,
    computedAt,
    MAX_VISIT_HISTORY_DAYS,
  )

  // TAC-297: project active commitment rows into the prompt-facing
  // ActiveCommitment shape. Fail-OPEN: if the load errored, degrade to []
  // and continue — a commitments DB hiccup shouldn't break the agent run.
  // The block is omitted entirely when empty (zero tokens).
  const activeCommitments = activeCommitmentsResult.ok
    ? activeCommitmentsResult.data
        .map((row) => toActiveCommitment(row))
        .filter((c): c is NonNullable<typeof c> => c !== null)
    : (console.warn(
        `[agent] buildRuntimeContext: active commitments load failed for guest ${input.guestId}: ${activeCommitmentsResult.error}. Continuing with empty list.`,
      ),
      [])

  return {
    agentRunId: input.agentRunId,
    venue,
    guest,
    currentMessage: input.currentMessage ?? null,
    followupTrigger: input.followupTrigger ?? null,
    recentMessages,
    recognition,
    mechanics,
    recentVisits,
    activeCommitments,
    // TAC-308: null when nothing is outstanding (the overwhelmingly common
    // case) — the serializer omits the block entirely at zero token cost.
    pendingQuestion: pendingQuestionResult?.question ?? null,
    corpus: null,
    knowledgeCorpus: null,
    classification: null,
    trace: input.trace,
  }
}