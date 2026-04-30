import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Database } from '@/db/types'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import { classifyStage, retrieveCorpusStage } from '@/lib/agent/stages'
import type { RuntimeContext as AgentRuntimeContext } from '@/lib/agent/types'
import {
  generateMessage,
  type RuntimeContext as AiRuntimeContext,
  type VoiceCorpusChunk as AiVoiceCorpusChunk,
} from '@/lib/ai'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability'
import { computeGuestState, type GuestState } from '@/lib/recognition'

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

const FALLBACK_TIMEZONE = 'America/Los_Angeles'
const MS_PER_DAY = 24 * 60 * 60 * 1000

// Seed-message dating: pinned >30 days ago so the recent-conversation block
// (THE-173, 14-day window) doesn't pick them up. Recognition signal counts
// are time-unfiltered, so old messages still drive responseRate.
const SEED_MESSAGE_AGE_DAYS = 35

// ---------------------------------------------------------------------------
// 07-file schema validation
// ---------------------------------------------------------------------------

const Scenario07Schema = z.object({
  sample_id: z.string().min(1),
  category: z.string().min(1),
  guest_state: z.enum(['new', 'returning', 'regular', 'raving_fan']),
  scenario: z.string().min(1),
  inbound_message: z.string().min(1),
  expected_failure: z.string().nullable(),
  is_mechanic_derived: z.boolean(),
})
export type Scenario07 = z.infer<typeof Scenario07Schema>

export const TestScenariosFileSchema = z.object({
  slug: z.string().min(1),
  generated_at: z.string().min(1),
  prompt_version: z.string().min(1),
  scenarios: z.array(Scenario07Schema).min(1),
})
export type TestScenariosFile = z.infer<typeof TestScenariosFileSchema>

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
// Per-scenario execution
// ---------------------------------------------------------------------------

export interface RowOutput {
  sample_id: string
  run_date: string
  category: string
  guest_state: GuestState
  scenario: string
  inbound_message: string
  generated_message: string
  voice_fidelity: number | null
  verdict: string
  edited_message: string
  comment: string
}

export interface RunScenarioInput {
  scenario: Scenario07
  venueId: string
  guestId: string
}

/**
 * Run a single scenario synchronously: build runtime context, classify,
 * retrieve corpus, generate. Captures the message body + voice_fidelity even
 * when fidelity is below the 0.4 send floor (we want bad outputs visible in
 * the review file). Pre-fills `comment` with `expected_failure: {value}` for
 * known-broken categories so THE-178 ingestion can skip them.
 *
 * On failure: returns a row with generated_message: '<ERROR>',
 * voice_fidelity: null, comment: 'runner_error: {message}'. Doesn't throw —
 * the caller iterates.
 */
export async function runScenario(input: RunScenarioInput): Promise<RowOutput> {
  const { scenario, venueId, guestId } = input
  const runDateIso = new Date().toISOString()
  const baseRow = {
    sample_id: scenario.sample_id,
    run_date: runDateIso,
    category: scenario.category,
    guest_state: scenario.guest_state,
    scenario: scenario.scenario,
    inbound_message: scenario.inbound_message,
    verdict: '',
    edited_message: '',
    comment: scenario.expected_failure ? `expected_failure: ${scenario.expected_failure}` : '',
  }

  try {
    const agentRunId = randomUUID()
    const ctx = await buildRuntimeContext({
      agentRunId,
      guestId,
      venueId,
      // Synthetic-guest tuning runs aren't real agent flows — no need to write
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
    ctx.corpus = await retrieveCorpusStage(ctx)

    const aiRuntime = inlineBuildAiRuntime(ctx)
    const ragChunks: AiVoiceCorpusChunk[] = (ctx.corpus ?? []).map((c) => ({
      id: c.id,
      text: c.text,
      sourceType: c.sourceType as AiVoiceCorpusChunk['sourceType'],
      relevanceScore: c.similarity,
    }))

    const result = await generateMessage({
      category: ctx.classification.category,
      persona: ctx.venue.brandPersona,
      venueInfo: ctx.venue.venueInfo,
      ragChunks,
      runtime: aiRuntime,
    })
    if (!result.ok) {
      return {
        ...baseRow,
        generated_message: '<ERROR>',
        voice_fidelity: null,
        comment: `runner_error: ${result.error}`,
      }
    }

    return {
      ...baseRow,
      generated_message: result.data.body,
      voice_fidelity: result.data.voiceFidelity,
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return {
      ...baseRow,
      generated_message: '<ERROR>',
      voice_fidelity: null,
      comment: `runner_error: ${message}`,
    }
  }
}

/**
 * Inline port of lib/agent/stages.ts::buildAiRuntime. Kept private to the
 * runner per the design decision to not broaden lib/agent's public surface
 * for a one-off testing script. If this drifts from the real one in stages.ts,
 * the symptom is the runner producing different prompts than production —
 * worth keeping the two visually similar so review catches drift.
 */
function inlineBuildAiRuntime(ctx: AgentRuntimeContext): AiRuntimeContext {
  let additionalContext: string | undefined
  if (ctx.followupTrigger) {
    const meta = ctx.followupTrigger.metadata
    additionalContext = meta
      ? `Followup trigger: ${ctx.followupTrigger.reason} (${JSON.stringify(meta)})`
      : `Followup trigger: ${ctx.followupTrigger.reason}`
  }

  let timezone = ctx.venue.timezone
  if (!isValidTimezone(timezone)) {
    console.warn(
      `inlineBuildAiRuntime: invalid timezone "${timezone}" for venue ${ctx.venue.id}, falling back to ${FALLBACK_TIMEZONE}`,
    )
    timezone = FALLBACK_TIMEZONE
  }

  return {
    guestName: ctx.guest.firstName ?? undefined,
    inboundMessage: ctx.currentMessage?.body,
    additionalContext,
    today: computeToday(timezone),
    recentMessages: ctx.recentMessages,
  }
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function computeToday(timezone: string, now: Date = new Date()): NonNullable<AiRuntimeContext['today']> {
  const isoDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const dayOfWeek = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(now)
  const venueLocalTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)
  return { isoDate, dayOfWeek, venueLocalTime, venueTimezone: timezone }
}

// ---------------------------------------------------------------------------
// CSV assembly
// ---------------------------------------------------------------------------

const CSV_COLUMNS: ReadonlyArray<keyof RowOutput> = [
  'sample_id',
  'run_date',
  'category',
  'guest_state',
  'scenario',
  'inbound_message',
  'generated_message',
  'voice_fidelity',
  'verdict',
  'edited_message',
  'comment',
]

/**
 * RFC-4180 escape: wrap in double-quotes if the cell contains a comma,
 * double-quote, or newline; double up internal double-quotes.
 */
function csvEscape(cell: string): string {
  if (/[",\n\r]/.test(cell)) {
    return `"${cell.replace(/"/g, '""')}"`
  }
  return cell
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  return String(value)
}

export function buildCsv(rows: RowOutput[]): string {
  const headerLine = CSV_COLUMNS.join(',')
  const dataLines = rows.map((row) =>
    CSV_COLUMNS.map((col) => csvEscape(cellToString(row[col]))).join(','),
  )
  return [headerLine, ...dataLines].join('\n')
}