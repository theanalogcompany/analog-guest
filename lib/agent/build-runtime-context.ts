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
import { BrandPersonaSchema, filterActiveContext, VenueInfoSchema } from '@/lib/schemas'
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

const MAX_HISTORY_MESSAGES = 30
const MAX_HISTORY_DAYS = 14
const MS_PER_DAY = 24 * 60 * 60 * 1000

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
}): Promise<RuntimeContext> {
  const supabase = createAdminClient()
  const computedAt = new Date()
  const historyCutoffIso = new Date(Date.now() - MAX_HISTORY_DAYS * MS_PER_DAY).toISOString()

  // Exclude the current inbound row (it's already in the table by the time the
  // agent runs, and gets rendered separately as `inboundMessage` in the prompt).
  // For followups there's no currentMessage, so no exclusion.
  let messagesQuery = supabase
    .from('messages')
    .select('id, direction, body, created_at')
    .eq('venue_id', input.venueId)
    .eq('guest_id', input.guestId)
    .neq('body', '')
    .gte('created_at', historyCutoffIso)
    .order('created_at', { ascending: false })
    .limit(MAX_HISTORY_MESSAGES)
  if (input.currentMessage) {
    messagesQuery = messagesQuery.neq('id', input.currentMessage.id)
  }

  const [
    venueResult,
    guestResult,
    recognitionResult,
    messagesResult,
    mechanicsResult,
    redemptionsResult,
  ] = await Promise.all([
    supabase
      .from('venues')
      .select(
        'id, slug, timezone, messaging_phone_number, venue_configs(brand_persona, venue_info)',
      )
      .eq('id', input.venueId)
      .single(),
    supabase
      .from('guests')
      .select('id, phone_number, first_name, created_at, created_via')
      .eq('id', input.guestId)
      .single(),
    computeGuestState({ guestId: input.guestId, venueId: input.venueId }),
    messagesQuery,
    supabase
      .from('mechanics')
      .select(
        'id, type, name, description, qualification, reward_description, min_state, redemption_policy, redemption_window_days',
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
  }

  const guestRow = guestResult.data
  const guest: GuestContext = {
    id: guestRow.id,
    phoneNumber: guestRow.phone_number,
    firstName: guestRow.first_name,
    createdAt: new Date(guestRow.created_at),
    createdVia: guestRow.created_via,
  }

  const recognition: RecognitionSnapshot = {
    score: recognitionResult.data.score,
    state: recognitionResult.data.state,
    signals: recognitionResult.data.signals,
    computedAt,
  }

  // Query returns DESC; reverse for chronological order in the prompt.
  const recentMessages: RecentMessage[] = (messagesResult.data ?? [])
    .slice()
    .reverse()
    .map((row) => ({
      direction: row.direction as RecentMessage['direction'],
      body: row.body,
      createdAt: new Date(row.created_at),
    }))

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

  return {
    agentRunId: input.agentRunId,
    venue,
    guest,
    currentMessage: input.currentMessage ?? null,
    followupTrigger: input.followupTrigger ?? null,
    recentMessages,
    recognition,
    mechanics,
    corpus: null,
    classification: null,
    trace: input.trace,
  }
}