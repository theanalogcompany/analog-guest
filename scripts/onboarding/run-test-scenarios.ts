import { randomUUID } from 'node:crypto'
import type { Database } from '@/db/types'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import { buildCrisisSafetyResult, CRISIS_SAFETY_REVIEW_REASON } from '@/lib/agent/crisis-safety'
import {
  classifyStage,
  generateStage,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
  verifyGroundingStage,
} from '@/lib/agent/stages'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability'
import { computeGuestState, type GuestState } from '@/lib/recognition'
import { evaluateApprovalDecision } from './evaluate-approval-decision'
import type { ScenarioSheetRow } from './scenario-schema'

type TransactionInsert = Database['public']['Tables']['transactions']['Insert']
type MessageInsert = Database['public']['Tables']['messages']['Insert']
type EngagementEventInsert = Database['public']['Tables']['engagement_events']['Insert']

// Locked deterministic phone numbers, reused across venues. The corresponding
// guest rows are per-venue (schema requires guests.venue_id NOT NULL), so
// each venue we run scenarios against gets its own four synthetic guest rows
// keyed by these phones. THE-181.
export const SYNTHETIC_PHONES: Record<GuestState, string> = {
  new: '+15550001000',
  returning: '+15550001100',
  regular: '+15550001200',
  raving_fan: '+15550001300',
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

// Seed-message dating: pinned >30 days ago so the recent-conversation block
// (THE-173, 14-day window) doesn't pick them up. Recognition signal counts
// are time-unfiltered, so old messages still drive responseRate.
const SEED_MESSAGE_AGE_DAYS = 35

// ---------------------------------------------------------------------------
// Synthetic guest seeding
// ---------------------------------------------------------------------------

interface SeedOutcome {
  state: GuestState
  phone: string
  guestId: string
  computedScore: number
  computedState: GuestState
  matched: boolean
}

/**
 * Ensures four synthetic guest rows exist at this venue (one per state),
 * each with enough seeded signal data for the recognition module to compute
 * the right state. Idempotent — safe to call repeatedly. Returns a per-state
 * map of guestIds plus per-state outcome rows for the operator log.
 *
 * States are seeded and verified SEQUENTIALLY (this loop, one state at a
 * time) — this is the "settle state before running in parallel" guardrail
 * from the Stage 2 authorization: computeGuestState writes a guest_states
 * transition row the first time it sees a changed state, and doing that
 * settling here, before the concurrent scenario loop starts, means the
 * zero-delta guardrail check on guest_states/engagement_events (preflight.ts)
 * covers only the concurrent portion — no state transition can race a
 * concurrent buildRuntimeContext call into a duplicate row.
 */
export async function seedSyntheticGuests(
  venueId: string,
): Promise<{ guestIdsByState: Record<GuestState, string>; outcomes: SeedOutcome[] }> {
  const states: GuestState[] = ['new', 'returning', 'regular', 'raving_fan']
  const guestIdsByState = {} as Record<GuestState, string>
  const outcomes: SeedOutcome[] = []

  for (const state of states) {
    const phone = SYNTHETIC_PHONES[state]
    const guestId = await ensureSyntheticGuest(venueId, phone, state)
    guestIdsByState[state] = guestId

    // Seed signals if needed. seedSignalsForState is per-signal-type
    // idempotent: if any rows already exist for this guest at this venue
    // (per signal type), it skips that type. Re-runs after partial failures
    // can leave half-seeded data — operator response is to delete the
    // synthetic guest in Supabase Studio and rerun.
    if (state !== 'new') {
      await seedSignalsForState(venueId, guestId, state)
    }

    // Verify by recomputing state. computeGuestState has a side effect of
    // writing a transition row in guest_states the first time it sees a
    // changed state — that's intentional (we WANT the synthetic guest to
    // have a guest_states row reflecting their target).
    const result = await computeGuestState({ guestId, venueId })
    if (!result.ok) {
      throw new Error(
        `seedSyntheticGuests: computeGuestState failed for ${state} (${phone}): ${result.error}`,
      )
    }
    outcomes.push({
      state,
      phone,
      guestId,
      computedScore: result.data.score,
      computedState: result.data.state,
      matched: result.data.state === state,
    })
  }

  return { guestIdsByState, outcomes }
}

async function ensureSyntheticGuest(
  venueId: string,
  phone: string,
  state: GuestState,
): Promise<string> {
  const supabase = createAdminClient()
  const { data: existing, error: lookupError } = await supabase
    .from('guests')
    .select('id, is_test_synthetic')
    .eq('venue_id', venueId)
    .eq('phone_number', phone)
    .maybeSingle()

  if (lookupError) {
    throw new Error(`ensureSyntheticGuest: lookup failed for ${phone}: ${lookupError.message}`)
  }
  if (existing) {
    if (!existing.is_test_synthetic) {
      throw new Error(
        `ensureSyntheticGuest: real guest collision — phone ${phone} at venue ${venueId} is a real guest, not synthetic. Pick a different synthetic phone or delete the real guest.`,
      )
    }
    return existing.id
  }

  const { data: inserted, error: insertError } = await supabase
    .from('guests')
    .insert({
      venue_id: venueId,
      phone_number: phone,
      first_name: `Synthetic-${state}`,
      created_via: 'manual',
      is_test_synthetic: true,
    })
    .select('id')
    .single()
  if (insertError || !inserted) {
    throw new Error(
      `ensureSyntheticGuest: insert failed for ${phone}: ${insertError?.message ?? 'no row'}`,
    )
  }
  return inserted.id
}

interface SignalCounts {
  transactions: number
  messages: number
  engagementEvents: number
}

async function countExistingSignals(venueId: string, guestId: string): Promise<SignalCounts> {
  const supabase = createAdminClient()
  const [t, m, e] = await Promise.all([
    supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('guest_id', guestId),
    supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('guest_id', guestId),
    supabase
      .from('engagement_events')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('guest_id', guestId),
  ])
  if (t.error) throw new Error(`countExistingSignals: transactions: ${t.error.message}`)
  if (m.error) throw new Error(`countExistingSignals: messages: ${m.error.message}`)
  if (e.error) throw new Error(`countExistingSignals: engagement_events: ${e.error.message}`)
  return {
    transactions: t.count ?? 0,
    messages: m.count ?? 0,
    engagementEvents: e.count ?? 0,
  }
}

async function seedSignalsForState(
  venueId: string,
  guestId: string,
  state: Exclude<GuestState, 'new'>,
): Promise<void> {
  const counts = await countExistingSignals(venueId, guestId)
  const supabase = createAdminClient()
  const now = Date.now()

  // Transactions. Tuned to hit the right band per the default formula.
  // 'returning' ~27, 'regular' ~57, 'raving_fan' ~81 — math derived in plan.
  if (counts.transactions === 0) {
    const txRows = buildTransactionsForState(state, venueId, guestId, now)
    if (txRows.length > 0) {
      const { error } = await supabase.from('transactions').insert(txRows)
      if (error) throw new Error(`seedSignalsForState: transactions insert: ${error.message}`)
    }
  }

  // Messages. Dated >30 days ago so they drive responseRate but stay out of
  // the 14-day recent-conversation window in the prompt (THE-173).
  if (counts.messages === 0) {
    const msgRows = buildMessagesForState(state, venueId, guestId, now)
    if (msgRows.length > 0) {
      const { error } = await supabase.from('messages').insert(msgRows)
      if (error) throw new Error(`seedSignalsForState: messages insert: ${error.message}`)
    }
  }

  // Engagement events.
  if (counts.engagementEvents === 0) {
    const eventRows = buildEngagementEventsForState(state, venueId, guestId)
    if (eventRows.length > 0) {
      const { error } = await supabase.from('engagement_events').insert(eventRows)
      if (error) {
        throw new Error(`seedSignalsForState: engagement_events insert: ${error.message}`)
      }
    }
  }
}

function buildTransactionsForState(
  state: Exclude<GuestState, 'new'>,
  venueId: string,
  guestId: string,
  now: number,
): TransactionInsert[] {
  // Per-state visit-day offsets (days ago) and per-visit dollar amount.
  let offsets: number[] = []
  let dollarsEach = 0
  if (state === 'returning') {
    offsets = [5, 12]
    dollarsEach = 15
  } else if (state === 'regular') {
    // 8 evenly-spread visits across last 58 days (every 8 days, last 2 days ago).
    offsets = [2, 10, 18, 26, 34, 42, 50, 58]
    dollarsEach = 15
  } else {
    // raving_fan: 12 visits, last visit today (offset 0), spread 8 days apart.
    offsets = [0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88]
    dollarsEach = 25
  }
  return offsets.map((daysAgo, i) => ({
    venue_id: venueId,
    guest_id: guestId,
    amount_cents: dollarsEach * 100,
    occurred_at: new Date(now - daysAgo * MS_PER_DAY).toISOString(),
    source: 'manual',
    external_id: `synthetic-${state}-${i}`,
  }))
}

function buildMessagesForState(
  state: Exclude<GuestState, 'new'>,
  venueId: string,
  guestId: string,
  now: number,
): MessageInsert[] {
  // Outbound + inbound counts per state. Returning has 0 (responseRate
  // contributes 0 with sample < 3 anyway, so don't bother).
  const counts = state === 'returning'
    ? { outbound: 0, inbound: 0 }
    : state === 'regular'
      ? { outbound: 5, inbound: 5 }
      : { outbound: 10, inbound: 10 }
  const dated = new Date(now - SEED_MESSAGE_AGE_DAYS * MS_PER_DAY).toISOString()
  const rows: MessageInsert[] = []
  for (let i = 0; i < counts.outbound; i++) {
    rows.push({
      venue_id: venueId,
      guest_id: guestId,
      direction: 'outbound',
      status: 'sent',
      body: '[synthetic seed]',
      created_at: dated,
    })
  }
  for (let i = 0; i < counts.inbound; i++) {
    rows.push({
      venue_id: venueId,
      guest_id: guestId,
      direction: 'inbound',
      status: 'received',
      body: '[synthetic seed]',
      created_at: dated,
    })
  }
  return rows
}

function buildEngagementEventsForState(
  state: Exclude<GuestState, 'new'>,
  venueId: string,
  guestId: string,
): EngagementEventInsert[] {
  // Event-type weights drive the engagement signal (see normalize-signals.ts).
  // Per-state mix tuned to land in target band.
  let mix: Array<{ type: string; count: number }> = []
  if (state === 'returning') {
    mix = []
  } else if (state === 'regular') {
    mix = [
      { type: 'perk_unlocked', count: 2 },
      { type: 'perk_redeemed', count: 1 },
    ]
  } else {
    mix = [
      { type: 'perk_unlocked', count: 5 },
      { type: 'perk_redeemed', count: 3 },
      { type: 'event_attended', count: 2 },
      { type: 'milestone_reached', count: 1 },
      { type: 'referral_made', count: 2 },
    ]
  }
  const rows: EngagementEventInsert[] = []
  for (const entry of mix) {
    for (let i = 0; i < entry.count; i++) {
      rows.push({ venue_id: venueId, guest_id: guestId, event_type: entry.type })
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// Per-scenario execution (TAC-347 Stage 2)
// ---------------------------------------------------------------------------

/**
 * Terminal outcome of one scenario run. 'refused' and 'failed' are both
 * RESULTS, not runner errors — a generateStage voice-fidelity refusal is
 * exactly the kind of thing this harness exists to surface, and a real
 * production stage throw (e.g. retrieveCorpusStage's insufficient-corpus
 * gate) is faithfully-reproduced production behavior, not a bug in this
 * script. Per the Stage 2 authorization: "A generateStage refusal (voice
 * fidelity below the floor) is recorded as its own outcome and graded, not
 * treated as a runner error."
 */
export type ScenarioOutcome = 'sent' | 'queued' | 'dropped' | 'refused' | 'failed'

export interface RetrievedKnowledgeChunk {
  text: string
  primaryTags: string[]
}

export interface ScenarioResult {
  sampleId: string
  topic: string
  category: string
  scenarioSource: string
  mode: 'graded' | 'exploratory'
  guestState: GuestState
  inboundMessage: string
  expectedRoute: string
  expectedBehavior: string
  outcome: ScenarioOutcome
  replyBody: string | null
  voiceFidelity: number | null
  route: 'send' | 'queue' | 'drop' | null
  triggers: string[] | null
  primaryTrigger: string | null
  // True when the approval decision would blank this body before persisting
  // in production (TAC-309, knowledge_gap cards). replyBody above still
  // carries what the model actually generated, for pilot-review purposes —
  // this flag is what tells the reader "production would have shown the
  // guest nothing."
  wouldBlankBody: boolean
  errorMessage: string | null
  elapsedMs: number
  // TAC-347 Stage 3 grader fix: the SAME retrieval the generation call
  // itself grounded on, threaded through so the grader judges "invented"
  // and "voice" against what was actually available, not just the
  // scenario's own (sometimes narrower) expected_facts. Empty when
  // retrieval never ran (a stage threw before it, e.g. classifyStage).
  retrievedVoiceExamples: string[]
  retrievedKnowledge: RetrievedKnowledgeChunk[]
}

export interface RunScenarioInput {
  scenario: ScenarioSheetRow
  venueId: string
  guestId: string
}

/**
 * Run a single scenario through the real agent pipeline: build runtime
 * context, classify, retrieve corpus, retrieve knowledge, generate, then
 * evaluate the approval decision — decision only, via
 * evaluateApprovalDecision (never persists, never dispatches, never pushes).
 *
 * Never throws — every failure mode (a stage throw, a generation failure, a
 * voice-fidelity refusal) is captured as its own ScenarioResult.outcome so
 * the caller can iterate without a try/catch of its own.
 */
export async function runScenario(input: RunScenarioInput): Promise<ScenarioResult> {
  const { scenario, venueId, guestId } = input
  const start = Date.now()
  const base = {
    sampleId: scenario.sample_id,
    topic: scenario.topic,
    category: scenario.category,
    scenarioSource: scenario.scenario_source,
    mode: scenario.mode,
    guestState: scenario.guest_state,
    inboundMessage: scenario.inbound_message,
    expectedRoute: scenario.expected_route,
    expectedBehavior: scenario.expected_behavior,
  }
  const empty = {
    replyBody: null,
    voiceFidelity: null,
    route: null,
    triggers: null,
    primaryTrigger: null,
    wouldBlankBody: false,
    errorMessage: null,
  } as const
  let retrievedVoiceExamples: string[] = []
  let retrievedKnowledge: RetrievedKnowledgeChunk[] = []

  try {
    const agentRunId = randomUUID()
    const ctx = await buildRuntimeContext({
      agentRunId,
      guestId,
      venueId,
      // Synthetic-guest test runs aren't real agent flows — no need to write
      // to Langfuse. startAgentTrace returns a no-op trace when LANGFUSE_*
      // env vars are unset (and these scripts run with .env.local, which we
      // expect to leave the keys blank locally).
      trace: startAgentTrace({ name: 'agent.test-scenario', agentRunId }),
      currentMessage: {
        id: randomUUID(),
        providerMessageId: `synthetic-${scenario.sample_id}`,
        body: scenario.inbound_message,
        receivedAt: new Date(),
      },
    })
    ctx.classification = await classifyStage(ctx)

    // TAC-348: harness parity with handle-inbound.ts's crisis-safety short
    // circuit. Fires in the SAME place relative to classifyStage (before any
    // retrieval or generation) so a scenario that trips crisisSafety is
    // graded against the actual fixed reply the pipeline would send, not
    // against a full-pipeline generation the shipped code never runs.
    if (ctx.classification.crisisSafety) {
      const result = buildCrisisSafetyResult()
      return {
        ...base,
        outcome: 'sent',
        replyBody: result.body,
        voiceFidelity: result.voiceFidelity,
        route: 'send',
        triggers: [],
        primaryTrigger: CRISIS_SAFETY_REVIEW_REASON,
        wouldBlankBody: false,
        errorMessage: null,
        elapsedMs: Date.now() - start,
        retrievedVoiceExamples,
        retrievedKnowledge,
      }
    }

    ctx.corpus = await retrieveCorpusStage(ctx)
    ctx.knowledgeCorpus = await retrieveKnowledgeStage(ctx, ctx.classification.category)
    retrievedVoiceExamples = ctx.corpus.map((c) => c.text)
    retrievedKnowledge = ctx.knowledgeCorpus.map((c) => ({ text: c.text, primaryTags: c.primaryTags }))

    const outcome = await generateStage(ctx, ctx.classification.category)
    const elapsedMs = Date.now() - start

    if (outcome.status === 'failed') {
      return { ...base, ...empty, outcome: 'failed', errorMessage: outcome.error, elapsedMs, retrievedVoiceExamples, retrievedKnowledge }
    }
    if (outcome.status === 'refused') {
      return {
        ...base,
        ...empty,
        outcome: 'refused',
        voiceFidelity: outcome.finalScore,
        elapsedMs,
        retrievedVoiceExamples,
        retrievedKnowledge,
      }
    }

    // TAC-350: harness parity with handle-inbound.ts's grounding backstop —
    // called in the same place, same skip condition (verifyGroundingStage
    // itself checks knowledgeGap / currentMessage / isDemo), so a scenario
    // that trips the backstop is graded against the actual gate the shipped
    // pipeline would apply, not against a knowledgeGap-only decision the
    // real pipeline no longer makes on its own.
    const groundingBackstop = await verifyGroundingStage(ctx, outcome.result)

    // status === 'success' — evaluate the approval decision. Decision only:
    // this never persists a draft, dispatches to Sendblue, or fires a push.
    const decision = await evaluateApprovalDecision(ctx, outcome.result, groundingBackstop)
    const generated = outcome.result

    if (decision.action === 'send') {
      return {
        ...base,
        outcome: 'sent',
        replyBody: generated.body,
        voiceFidelity: generated.voiceFidelity,
        route: 'send',
        triggers: [],
        primaryTrigger: decision.reason ?? null,
        wouldBlankBody: false,
        errorMessage: null,
        elapsedMs,
        retrievedVoiceExamples,
        retrievedKnowledge,
      }
    }
    if (decision.action === 'queue') {
      return {
        ...base,
        outcome: 'queued',
        replyBody: generated.body,
        voiceFidelity: generated.voiceFidelity,
        route: 'queue',
        triggers: decision.triggers,
        primaryTrigger: decision.primaryTrigger,
        wouldBlankBody: decision.blankBody,
        errorMessage: null,
        elapsedMs,
        retrievedVoiceExamples,
        retrievedKnowledge,
      }
    }
    // action === 'drop' (TAC-308: knowledge-gap card protection)
    return {
      ...base,
      outcome: 'dropped',
      replyBody: generated.body,
      voiceFidelity: generated.voiceFidelity,
      route: 'drop',
      triggers: decision.triggers,
      primaryTrigger: decision.reason,
      wouldBlankBody: false,
      errorMessage: null,
      elapsedMs,
      retrievedVoiceExamples,
      retrievedKnowledge,
    }
  } catch (e) {
    const elapsedMs = Date.now() - start
    const message = e instanceof Error ? e.message : String(e)
    return { ...base, ...empty, outcome: 'failed', errorMessage: message, elapsedMs, retrievedVoiceExamples, retrievedKnowledge }
  }
}
