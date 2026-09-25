// TAC-536: greet a guest who scanned the counter code and said nothing.
//
// Called every minute by the external HTTP cron (cron-job.org) that hits
// /api/cron/instagram-scan-greetings. FIFTH concrete sibling of
// processDueCommitments, processDueFollowups, processDueKnowledgeGaps,
// processDueCommitmentLifecycle and processInstagramWindowWarnings. Still
// concrete-not-generic: the shared find-eligible -> claim -> side-effect seam
// stays unextracted.
//
// A ROUTE OF ITS OWN, not a third processor on /api/cron/pending-timeout,
// which is where TAC-473 put its sibling and was right to. This one SENDS
// UNPROMPTED MESSAGES TO GUESTS. A dedicated job can be paused at
// cron-job.org in one click without also switching off the operator window
// warnings, and that is worth one more entry to monitor for the only
// scheduled path in this repo that talks to a guest with no operator and no
// inbound behind it.
//
// EVERY CONDITION IS RE-CHECKED HERE, NOT AT SCAN TIME (ruled 2026-09-25).
// Five minutes is long enough for all of them to change: the guest writes,
// the venue closes, someone pauses the venue, another scan gets there first.
// Checking at scan time would be checking the wrong instant.
//
// ORDER, and it is not arbitrary. The cheap reads that mean "this greeting
// should never happen" run BEFORE the claim, so a suppressed scan does not
// burn the guest's one greeting for the day (the claim is what burns it; see
// scan-arrival-store.ts). The claim runs last, immediately before generation.
//
// WHAT IS NOT CHECKED HERE: Meta's 24-hour reply window. The scan's own row
// opens it, and dispatch-instagram-reply.ts re-derives it unconditionally
// immediately before every Instagram send. A second copy here would be a
// second definition of the same deadline, and the one that matters is the one
// the send gate uses.

import { randomUUID } from 'node:crypto'

import { createAdminClient } from '@/lib/db/admin'
import { VenueHoursSchema, type VenueInfo } from '@/lib/schemas'
import { isVenueProcessingHalted } from '@/lib/venues/status'
import { captureInstagramScanGreeting } from '@/lib/analytics/posthog'
import { handleFollowup } from './handle-followup'
import {
  insertInboundTurnOutcome,
  ledgerEntryFor,
  ledgerEntryForUnexpected,
} from './record-inbound-turn-outcome'
import {
  isScanGreetingDue,
  isScanTooStale,
  venueLocalDate,
} from './scan-arrival'
import {
  claimScanArrival,
  loadDueScanArrivals,
  resolveScanArrival,
  type PendingScanArrival,
  type ScanArrivalOutcome,
} from './scan-arrival-store'
import { isVenueClosed } from './venue-open-state'
import type { InboundTurnReason } from '@/lib/schemas/inbound-turn-outcome'

type AdminSupabaseClient = ReturnType<typeof createAdminClient>

export interface ProcessScanGreetingsResult {
  /** Pending rows considered. */
  scanned: number
  /** Rows whose five minutes have not elapsed. */
  notYet: number
  /** Rows this run claimed and generated a greeting for. */
  greeted: number
  /** Rows suppressed before the claim, by reason. */
  suppressed: Record<string, number>
  /** Rows another tick claimed first. */
  casLost: number
  /** Rows that threw. */
  errored: number
}

/**
 * The suppressions that happen BEFORE the claim, and the ledger reason each
 * writes. A total map, so a new suppression has to state its reason rather
 * than inherit one: the five reasons exist precisely because collapsing any
 * pair makes the distinction unanswerable in SQL.
 */
const LEDGER_REASON_FOR: Record<
  Exclude<ScanArrivalOutcome, 'greeted' | 'errored'>,
  InboundTurnReason
> = {
  inbound_during_window: 'inbound_during_window',
  too_stale: 'scan_too_stale',
  venue_paused: 'venue_paused',
  venue_closed: 'venue_closed',
  guest_opted_out: 'guest_opted_out',
  already_greeted_today: 'already_greeted_today',
}

interface VenueClock {
  timezone: string | null
  hours: VenueInfo['hours'] | null
  status: string | null
}

/**
 * The three venue facts a greeting decision needs, in one round trip each.
 *
 * Fails SOFT on the clock and HARD on nothing: an unreadable timezone or
 * unreadable hours resolve the open state to `unknown`, which TAC-363's rule
 * treats as open, so the greeting proceeds. Refusing on merely-unreadable
 * data is the worse failure, and it is the convention every other consumer of
 * this verdict already follows.
 *
 * Parses the HOURS SUB-OBJECT, never the whole VenueInfoSchema: that schema
 * requires `address`, so a venue missing an unrelated field would have its
 * open state read as unknown for a reason that has nothing to do with hours.
 * Same trap loadVenueClock in lib/guests/commitments.ts documents.
 */
async function loadVenueClock(
  supabase: AdminSupabaseClient,
  venueId: string,
): Promise<VenueClock> {
  const [venue, config] = await Promise.all([
    supabase.from('venues').select('timezone, status').eq('id', venueId).maybeSingle(),
    supabase.from('venue_configs').select('venue_info').eq('venue_id', venueId).maybeSingle(),
  ])

  const timezone =
    typeof venue.data?.timezone === 'string' && venue.data.timezone.length > 0
      ? venue.data.timezone
      : null

  let hours: VenueInfo['hours'] | null = null
  const rawInfo = config.data?.venue_info
  if (rawInfo != null && typeof rawInfo === 'object' && !Array.isArray(rawInfo)) {
    const parsed = VenueHoursSchema.safeParse((rawInfo as Record<string, unknown>).hours ?? {})
    hours = parsed.success ? parsed.data : null
  }

  return { timezone, hours, status: venue.data?.status ?? null }
}

/**
 * Has a real message arrived since the scan?
 *
 * A SCAN ROW IS THE ONLY INBOUND INSTAGRAM ROW WITH A NULL
 * provider_message_id, so `not null` is exactly "a message, a postback or
 * anything else the guest actually sent". Without that filter a second scan
 * would read as the guest having written, and every repeat scanner would be
 * silently suppressed rather than guarded by the once-per-day rule.
 *
 * Fails CLOSED: an unreadable answer suppresses the greeting. The cost of a
 * miss is silence at a guest who scanned; the cost of guessing the other way
 * is greeting over someone mid-sentence, which is the thing the five-minute
 * delay exists to prevent.
 */
async function guestWroteSince(
  supabase: AdminSupabaseClient,
  row: PendingScanArrival,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('messages')
    .select('id')
    .eq('venue_id', row.venueId)
    .eq('guest_id', row.guestId)
    .eq('direction', 'inbound')
    .not('provider_message_id', 'is', null)
    .gte('created_at', row.scannedAt.toISOString())
    .limit(1)
    .maybeSingle()
  if (error) {
    console.warn('[scan-greeting] inbound-since read failed; suppressing this greeting', {
      scanArrivalId: row.id,
      error: error.message,
    })
    return true
  }
  return data !== null
}

/** Fails CLOSED, for the reason handle-holding-message.ts gives: nobody sends to someone who left. */
async function isOptedOut(supabase: AdminSupabaseClient, guestId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('guests')
    .select('opted_out_at')
    .eq('id', guestId)
    .maybeSingle()
  if (error) {
    console.warn('[scan-greeting] opt-out read failed; suppressing this greeting', {
      guestId,
      error: error.message,
    })
    return true
  }
  return data?.opted_out_at != null
}

async function recordLedger(
  row: PendingScanArrival,
  entry: ReturnType<typeof ledgerEntryFor>,
  agentRunId: string | null,
): Promise<void> {
  await insertInboundTurnOutcome({
    layer: 'agent',
    entry,
    venueId: row.venueId,
    guestId: row.guestId,
    inboundMessageId: row.scanMessageId,
    channel: 'instagram',
    agentRunId,
  })
}

async function suppress(
  supabase: AdminSupabaseClient,
  row: PendingScanArrival,
  outcome: Exclude<ScanArrivalOutcome, 'greeted' | 'errored'>,
  now: Date,
): Promise<void> {
  await resolveScanArrival(supabase, row.id, outcome, now)
  await recordLedger(
    row,
    {
      outcome: 'not_run',
      reason: LEDGER_REASON_FOR[outcome],
      outboundMessageId: null,
      detail: { scanArrivalId: row.id },
    },
    null,
  )
  await captureInstagramScanGreeting({
    venueId: row.venueId,
    guestId: row.guestId,
    scanMessageId: row.scanMessageId,
    outcome,
    hadPriorConversation: null,
  })
}

/**
 * One tick. Never throws: a throw handling one row becomes an `errored`
 * outcome for that row and the rest are still handled, the posture every
 * sibling processor takes.
 */
export async function processDueScanGreetings(
  now: Date = new Date(),
  supabase: AdminSupabaseClient = createAdminClient(),
): Promise<ProcessScanGreetingsResult> {
  const result: ProcessScanGreetingsResult = {
    scanned: 0,
    notYet: 0,
    greeted: 0,
    suppressed: {},
    casLost: 0,
    errored: 0,
  }

  const due = await loadDueScanArrivals(supabase)
  if (!due.ok) {
    console.error('[scan-greeting] could not read pending scans', { error: due.error })
    result.errored += 1
    return result
  }

  const bump = (outcome: string) => {
    result.suppressed[outcome] = (result.suppressed[outcome] ?? 0) + 1
  }

  for (const row of due.data) {
    result.scanned += 1
    try {
      if (!isScanGreetingDue(row.scannedAt, now)) {
        result.notYet += 1
        continue
      }
      if (isScanTooStale(row.scannedAt, now)) {
        await suppress(supabase, row, 'too_stale', now)
        bump('too_stale')
        continue
      }
      if (await guestWroteSince(supabase, row)) {
        await suppress(supabase, row, 'inbound_during_window', now)
        bump('inbound_during_window')
        continue
      }

      const clock = await loadVenueClock(supabase, row.venueId)
      if (isVenueProcessingHalted(clock.status)) {
        await suppress(supabase, row, 'venue_paused', now)
        bump('venue_paused')
        continue
      }
      if (await isOptedOut(supabase, row.guestId)) {
        await suppress(supabase, row, 'guest_opted_out', now)
        bump('guest_opted_out')
        continue
      }
      // `unknown` hours proceed: isVenueClosed is true only for a POSITIVE
      // closed verdict, which is how TAC-363's ruling holds by construction
      // rather than by each caller remembering it.
      if (
        clock.timezone !== null &&
        isVenueClosed({ venueInfo: { hours: clock.hours ?? {} }, timezone: clock.timezone }, now)
      ) {
        await suppress(supabase, row, 'venue_closed', now)
        bump('venue_closed')
        continue
      }

      // The venue-local day the claim is keyed on. An unreadable timezone
      // falls back to UTC rather than refusing: the guard would otherwise be
      // switched off entirely for that venue, and a UTC day is still one day.
      const localDate = (clock.timezone !== null ? venueLocalDate(now, clock.timezone) : null) ??
        venueLocalDate(now, 'UTC') ??
        now.toISOString().slice(0, 10)

      const claim = await claimScanArrival(supabase, row.id, localDate, now)
      if (claim.status === 'lost') {
        result.casLost += 1
        continue
      }
      if (claim.status === 'already_greeted_today') {
        await suppress(supabase, row, 'already_greeted_today', now)
        bump('already_greeted_today')
        continue
      }
      if (claim.status === 'failed') {
        console.error('[scan-greeting] claim failed', { scanArrivalId: row.id, error: claim.error })
        result.errored += 1
        continue
      }

      const agentRunId = randomUUID()
      const outcome = await handleFollowup({
        venueId: row.venueId,
        guestId: row.guestId,
        agentRunId,
        trigger: {
          reason: 'instagram_scan_arrival',
          triggeredAt: now,
          instagramScanArrival: {
            scanMessageId: row.scanMessageId,
            hadPriorConversation: row.hadPriorConversation,
          },
        },
      })

      await resolveScanArrival(supabase, row.id, 'greeted', new Date())
      await recordLedger(row, ledgerEntryFor(outcome), agentRunId)
      await captureInstagramScanGreeting({
        venueId: row.venueId,
        guestId: row.guestId,
        scanMessageId: row.scanMessageId,
        outcome: 'greeted',
        hadPriorConversation: row.hadPriorConversation,
        agentStatus: outcome.status,
      })
      result.greeted += 1
    } catch (e) {
      result.errored += 1
      console.error('[scan-greeting] row threw', {
        scanArrivalId: row.id,
        error: e instanceof Error ? e.message : String(e),
      })
      await resolveScanArrival(supabase, row.id, 'errored', now).catch(() => undefined)
      await recordLedger(row, ledgerEntryForUnexpected(e), null).catch(() => undefined)
    }
  }

  return result
}
