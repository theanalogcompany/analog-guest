/**
 * TAC-523: write one `inbound_turn_outcomes` row per inbound turn.
 *
 * WHY. Both webhooks call `waitUntil(runInboundAgent(id))` and discard the
 * returned AgentResult. Eighteen paths can end a turn with no outbound row,
 * and none of them wrote anything queryable: every record was a console line,
 * a PostHog event or a Slack post. The 2026-09-20 incident was diagnosable
 * only because Vercel still held the runtime logs.
 *
 * THIS MODULE CHANGES NO DECISION. It records what already happened, after it
 * has happened. It never throws, never blocks a send, and nothing downstream
 * reads its return value — a recorder that can alter a reply is a worse bug
 * than the blindness it fixes.
 *
 * A COMPLETE LEDGER (ruled 2026-09-23): successes are recorded too, so a
 * failure count has a denominator. See migration 055's header for what is
 * deliberately not a turn (echoes, read receipts, redeliveries).
 */

import { createAdminClient } from '@/lib/db/admin'
import type { Json } from '@/db/types'
import { parseMessageChannel } from '@/lib/schemas/message-channel'
import type {
  InboundTurnLayer,
  InboundTurnOutcome,
  InboundTurnReason,
} from '@/lib/schemas/inbound-turn-outcome'
// capturePostHogEvent via ./alerts, not the analytics barrel: alerts.ts
// re-exports it precisely so this directory imports from one place, and the
// orchestrator test files mock ./alerts rather than the barrel.
import { capturePostHogEvent } from './alerts'
import type { AgentResult } from './types'

/** Error text is truncated before it is stored. */
const MAX_DETAIL_ERROR_CHARS = 200

/**
 * A run of digits long enough to be a phone number, with the separators people
 * write them with. Deliberately loose: over-redacting a digit-heavy error
 * message costs nothing, and the failure this guards is a guest's number
 * landing in a durable table.
 */
const PHONE_LIKE = /\+?\d[\d\s().-]{6,}\d/g

const REDACTED = '[redacted]'

/**
 * Masked before PHONE_LIKE runs, and restored after.
 *
 * Without this the guard ate its own subject: an all-numeric uuid like
 * `22222222-2222-4222-8222-222222222222` is digits and hyphens, which is
 * exactly what PHONE_LIKE matches, so `missingInboundMessageId` came back
 * `[redacted]`. A redactor that destroys the ids is worse than the leak it
 * prevents — the ids are what the table is FOR. Caught by an existing test
 * failing, not by the new ones.
 */
const UUID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/**
 * Migration 055's header says this table never holds a full phone number. That
 * was a comment, not a guarantee, until this existed: `detail` was passed
 * straight through, and the test named for the invariant planted its own
 * fixture and asserted a string it had never inserted — so it could not fail,
 * and TAC-523 PR 2 (the Sendblue bails, the one layer that HAS phone numbers
 * in scope) would have walked into it.
 *
 * Applied at the single INSERT rather than at each caller, so a new caller
 * inherits it instead of having to remember it. Keys are left alone; only
 * string values are scrubbed.
 */
export function redactDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const scrubString = (value: string): string => {
    const preserved: string[] = []
    const masked = value.replace(UUID_LIKE, (uuid) => {
      preserved.push(uuid)
      return `\u0000${preserved.length - 1}\u0000`
    })
    return masked
      .replace(PHONE_LIKE, REDACTED)
      .replace(/\u0000(\d+)\u0000/g, (_m, i) => preserved[Number(i)] ?? '')
  }
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') return scrubString(value)
    if (Array.isArray(value)) return value.map(scrub)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]))
    }
    return value
  }
  return scrub(detail) as Record<string, unknown>
}

/** What one outcome resolves to, before identity columns are attached. */
interface LedgerEntry {
  outcome: InboundTurnOutcome
  reason: InboundTurnReason | null
  /** The row this turn produced, for `sent` and `queued`. */
  outboundMessageId: string | null
  detail: Record<string, unknown>
}

/**
 * Total over `AgentResult['status']` BY TYPE, not by a table of literal calls.
 *
 * TAC-424's lesson, in this repo, on this exact shape: a table of five literal
 * calls cannot see a sixth union member, and the comment claiming it could was
 * false for months. A seventh `AgentResult` member fails `tsc` here until
 * someone decides what it records.
 */
type LedgerDerivers = {
  [S in AgentResult['status']]: (result: Extract<AgentResult, { status: S }>) => LedgerEntry
}

const LEDGER_DERIVERS: LedgerDerivers = {
  sent: (r) => ({
    outcome: 'sent',
    reason: null,
    outboundMessageId: r.outboundMessageId,
    detail: {},
  }),
  queued: (r) => ({
    outcome: 'queued',
    reason: null,
    outboundMessageId: r.outboundMessageId,
    // The operator-facing label and the full trigger set. Vocabulary
    // constants, never guest text.
    detail: { primaryTrigger: r.primaryTrigger, triggers: r.triggers },
  }),
  refused: (r) => ({
    outcome: 'refused',
    reason: 'low_fidelity',
    outboundMessageId: null,
    // `reason` on AgentResult.refused is 'low_fidelity' today and is the only
    // value generateStage produces; recorded in detail so a second refusal
    // reason shows up in the data before it shows up in the vocabulary.
    detail: { refusedReason: r.reason, attemptScores: r.attemptScores ?? null },
  }),
  skipped_duplicate: () => ({
    outcome: 'skipped_duplicate',
    reason: null,
    outboundMessageId: null,
    detail: {},
  }),
  dropped: (r) => ({
    outcome: 'dropped',
    // SlotDropReason is the same closed vocabulary INBOUND_TURN_REASONS
    // carries, so this passes straight through.
    reason: r.reason,
    outboundMessageId: null,
    detail: { protectedDraftId: r.protectedDraftId, triggers: r.triggers },
  }),
  superseded: (r) => ({
    outcome: 'superseded',
    reason: null,
    outboundMessageId: null,
    detail: { byMessageId: r.byMessageId },
  }),
  // TAC-526: folded into another run's turn. Recorded as outcome 'superseded'
  // with a distinct reason, so the one bucket stays countable while the two
  // causes stay apart: a bare 'superseded' is TAC-469's reply check (staff
  // answered by hand in the Instagram app), this is a burst the agent
  // coalesced. Merging them would make both unanswerable in SQL.
  //
  // A DECISION, NOT A FAILURE — the guest was answered, by the run named in
  // detail. With 'skipped_duplicate' it is the second value meaning the agent
  // ran more than once for one guest action, so a strict turn count excludes
  // it. Migration 057's header carries that query.
  coalesced: (r) => ({
    outcome: 'superseded',
    reason: 'coalesced_into_turn',
    outboundMessageId: null,
    // Vocabulary and ids only, never guest text. The run id is what joins this
    // row to the turn that actually replied.
    detail: { coalescedIntoAgentRunId: r.intoAgentRunId, coalescedIntoMessageId: r.intoMessageId },
  }),
  // TAC-397, mapped when the rebase made `tsc` refuse to compile without it —
  // the total map firing on a real merge rather than on a mutant. A decision,
  // not a failure: the guest said "haha" and already holds a pending card.
  silenced: () => ({
    outcome: 'silenced',
    reason: null,
    outboundMessageId: null,
    detail: {},
  }),
  // TAC-529. `not_run` is the right outcome: the agent was never invoked for
  // this turn — the gate sits before context build, so nothing classified,
  // retrieved or generated. The guest gets silence and this row is what makes
  // that countable, which is the whole reason this table exists.
  //
  // `detail.venueStatus` carries which of the two it was, so 'paused' and
  // 'archived' stay tellable apart without a second reason value. A venue
  // status is vocabulary, never guest text.
  venue_halted: (r) => ({
    outcome: 'not_run',
    reason: 'venue_paused',
    outboundMessageId: null,
    detail: { venueStatus: r.venueStatus },
  }),
  failed: (r) => ({
    outcome: 'failed',
    // AlertContext['stage'] overlaps INBOUND_TURN_REASONS for every stage the
    // inbound path can produce. `venue_config_integrity` is followup-only and
    // is mapped defensively rather than trusted not to arrive.
    reason: isRecordableStage(r.stage) ? r.stage : 'unexpected',
    outboundMessageId: null,
    detail: { stage: r.stage, error: truncate(r.error) },
  }),
}

// `satisfies` is what makes isRecordableStage's type predicate honest. A type
// predicate is an assertion tsc never verifies against the body, so without
// this the list was a third, unbound copy of the stage vocabulary: renaming a
// value in INBOUND_TURN_REASONS and migration 055 together would pass the
// binding test, miss this, and every `failed` row at that stage would violate
// the CHECK and be swallowed — the exact blindness this table removes.
const RECORDABLE_STAGES = [
  'context_build',
  'classification',
  'corpus',
  'generation',
  'persist',
  'send',
] as const satisfies readonly InboundTurnReason[]

function isRecordableStage(stage: string): stage is InboundTurnReason {
  return (RECORDABLE_STAGES as readonly string[]).includes(stage)
}

function truncate(value: string): string {
  return value.length > MAX_DETAIL_ERROR_CHARS
    ? `${value.slice(0, MAX_DETAIL_ERROR_CHARS)}…`
    : value
}

/**
 * Exported for tests: the pure half, with no database in it. The mapping from
 * an outcome to a ledger entry is the part worth asserting directly.
 */
export function ledgerEntryFor(result: AgentResult): LedgerEntry {
  // LEDGER_DERIVERS is total over the union by its TYPE — that is the
  // guarantee. TypeScript cannot carry the per-key narrowing through an index
  // access, so the call is cast; the map's own type is what a new member
  // breaks.
  const derive = LEDGER_DERIVERS[result.status] as (result: AgentResult) => LedgerEntry
  return derive(result)
}

/** The entry for a throw the orchestrator's own top-level catch did not produce. */
export function ledgerEntryForUnexpected(error: unknown): LedgerEntry {
  return {
    outcome: 'failed',
    reason: 'unexpected',
    outboundMessageId: null,
    detail: { error: truncate(error instanceof Error ? error.message : String(error)) },
  }
}

export interface InsertInboundTurnOutcomeInput {
  layer: InboundTurnLayer
  entry: LedgerEntry
  venueId: string | null
  guestId: string | null
  inboundMessageId: string | null
  channel: string | null
  agentRunId: string | null
}

/**
 * The one INSERT. Shared by the agent recorder below and by the webhook layer.
 * Never throws: a failure to record a failure must not deepen it.
 */
export async function insertInboundTurnOutcome(
  input: InsertInboundTurnOutcomeInput,
): Promise<void> {
  let reported = false
  try {
    const supabase = createAdminClient()
    const { error } = await supabase.from('inbound_turn_outcomes').insert({
      venue_id: input.venueId,
      guest_id: input.guestId,
      inbound_message_id: input.inboundMessageId,
      outbound_message_id: input.entry.outboundMessageId,
      agent_run_id: input.agentRunId,
      // parse rather than pass through: an unrecognized stored value degrades
      // to null instead of violating the CHECK and losing the whole row.
      channel: parseMessageChannel(input.channel),
      layer: input.layer,
      outcome: input.entry.outcome,
      reason: input.entry.reason,
      detail: redactDetail(input.entry.detail) as Json,
    })
    if (error) {
      reported = true
      await reportWriteFailure(input, error.message, error.code)
    }
  } catch (e) {
    // Guarded, and gated on `reported`. Unguarded, a throw from the report on
    // the line above would land here and report a SECOND time — the
    // recorded-twice shape handle-inbound's wrapper was restructured to avoid.
    // It only never throws today because capturePostHogEvent swallows
    // everything, and that is a guarantee in another file.
    if (reported) return
    try {
      await reportWriteFailure(input, e instanceof Error ? e.message : String(e), null)
    } catch {
      // Nothing left to report with.
    }
  }
}

/**
 * PostHog and the console, NO Slack relay. This fires on every insert during
 * an outage, which is exactly when Slack is already loud with the red alerts
 * for the underlying failures.
 */
async function reportWriteFailure(
  input: InsertInboundTurnOutcomeInput,
  message: string,
  code: string | null,
): Promise<void> {
  console.error('[agent] inbound turn outcome could not be recorded', {
    layer: input.layer,
    outcome: input.entry.outcome,
    reason: input.entry.reason,
    inboundMessageId: input.inboundMessageId,
    agentRunId: input.agentRunId,
    error: message,
    code,
  })
  await capturePostHogEvent(
    'inbound_turn_outcome_write_failed',
    input.guestId ?? input.agentRunId ?? input.inboundMessageId ?? 'unknown',
    {
      layer: input.layer,
      outcome: input.entry.outcome,
      reason: input.entry.reason,
      venueId: input.venueId,
      guestId: input.guestId,
      inboundMessageId: input.inboundMessageId,
      agentRunId: input.agentRunId,
      error: message,
      code,
    },
  )
}

/**
 * The agent-layer recorder. Called once per run by `handleInbound`, after the
 * orchestrator has returned.
 *
 * Resolves the identity columns from the inbound row itself rather than
 * threading them out of the orchestrator: one cheap read, and the
 * orchestrator's body stays untouched, which is what keeps "no decision
 * changed" true by construction rather than by review.
 */
type InboundIdentity =
  | { kind: 'found'; venueId: string | null; guestId: string | null; channel: string | null }
  /** The read succeeded and the row is not there. */
  | { kind: 'absent' }
  /** The read did not complete, so whether the row exists is unknown. */
  | { kind: 'read_failed'; error: string }

async function loadInboundIdentity(inboundMessageId: string): Promise<InboundIdentity> {
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('messages')
      .select('venue_id, guest_id, channel')
      .eq('id', inboundMessageId)
      .maybeSingle()
    if (error) return { kind: 'read_failed', error: truncate(error.message) }
    if (!data) return { kind: 'absent' }
    return {
      kind: 'found',
      venueId: data.venue_id,
      guestId: data.guest_id,
      channel: data.channel,
    }
  } catch (e) {
    return { kind: 'read_failed', error: truncate(e instanceof Error ? e.message : String(e)) }
  }
}

export async function recordInboundTurnOutcome(input: {
  inboundMessageId: string
  agentRunId: string
  /** null when the wrapper caught a throw the orchestrator did not. */
  result: AgentResult | null
  unexpected?: unknown
}): Promise<void> {
  const entry =
    input.result === null ? ledgerEntryForUnexpected(input.unexpected) : ledgerEntryFor(input.result)

  // THREE states, not two. supabase-js returns a network failure as `{ error }`
  // rather than throwing (CLAUDE.md's own gotcha, which is why the Sendblue
  // route 200s on a failed insert), so reading only `data` would make a failed
  // read indistinguishable from a message row that genuinely is not there —
  // and write `missingInboundMessageId`, a false claim, into a durable record.
  // The correlated case is the expensive one: a blip that fails the agent turn
  // fails this read too, so the row for the incident would be the one that
  // lied about it.
  const identity = await loadInboundIdentity(input.inboundMessageId)

  await insertInboundTurnOutcome({
    layer: 'agent',
    // The FK would reject an id whose row is absent or unverified, taking the
    // whole record with it, so the id rides as data instead. Which key it
    // takes says WHY — a reader can tell "the message was deleted" from "we
    // could not check".
    entry:
      identity.kind === 'found'
        ? entry
        : {
            ...entry,
            detail: {
              ...entry.detail,
              [identity.kind === 'absent' ? 'missingInboundMessageId' : 'unverifiedInboundMessageId']:
                input.inboundMessageId,
              ...(identity.kind === 'read_failed' ? { identityReadError: identity.error } : {}),
            },
          },
    venueId: identity.kind === 'found' ? identity.venueId : null,
    guestId: identity.kind === 'found' ? identity.guestId : null,
    inboundMessageId: identity.kind === 'found' ? input.inboundMessageId : null,
    channel: identity.kind === 'found' ? identity.channel : null,
    agentRunId: input.agentRunId,
  })
}
