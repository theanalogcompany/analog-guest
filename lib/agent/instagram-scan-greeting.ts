// TAC-536: greet a guest who scanned the counter code and said nothing.
//
// TWO RUNNERS, ONE PER-ROW PATH (2026-10-06). `runScanGreetingFastPath` is
// started by the Instagram webhook when it records the scan and checks the row
// about twenty seconds later; `processDueScanGreetings` is the every-minute
// cron behind it, the backstop for anything the fast path missed (an instance
// recycled mid-sleep, a deploy, a hold). Both call `processScanArrival`, so
// there is one copy of every re-check and one claim, and the claim is what
// makes a double greeting impossible when the two overlap.
//
// The cron is called every minute by the external HTTP cron (cron-job.org) at
// /api/cron/instagram-scan-greetings. FIFTH concrete sibling of
// processDueCommitments, processDueFollowups, processDueKnowledgeGaps,
// processDueCommitmentLifecycle and processInstagramWindowWarnings. Still
// concrete-not-generic: the shared find-eligible -> claim -> side-effect seam
// stays unextracted.
//
// A ROUTE OF ITS OWN, not a third processor on /api/cron/pending-timeout,
// which is where TAC-473 put its sibling and was right to. This one SENDS
// UNPROMPTED MESSAGES TO GUESTS, the only scheduled path in this repo that
// talks to a guest with no operator and no inbound behind it.
//
// PAUSING THE CRON-JOB.ORG JOB NO LONGER STOPS THESE GREETINGS: the fast path
// does not go through it. Ruled 2026-10-06, the emergency switch is pausing
// the venue (`venues.status`, re-checked below on every row by both runners),
// which halts everything for that venue. There is no scan-only switch short
// of a deploy.
//
// EVERY CONDITION IS RE-CHECKED HERE, NOT AT SCAN TIME (ruled 2026-09-25).
// Even twenty seconds is long enough for any of them to change, and the cron
// can reach a row up to fifteen minutes later: the guest writes, the venue
// closes, someone pauses the venue, another scan gets there first. Checking
// at scan time would be checking the wrong instant.
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
import { logger } from '@/lib/observability/logger'
import { VenueHoursSchema, type VenueInfo } from '@/lib/schemas'
import { isVenueProcessingHalted } from '@/lib/venues/status'
import { captureInstagramScanGreeting } from '@/lib/analytics/posthog'
import { recordProactiveSend } from '@/lib/followups/inquiry-followup-store'
import { isTooSoonAfterProactive } from '@/lib/followups/proactive-spacing'
import { handleFollowup } from './handle-followup'
import {
  insertInboundTurnOutcome,
  ledgerEntryFor,
  ledgerEntryForUnexpected,
} from './record-inbound-turn-outcome'
import {
  isScanGreetingDue,
  isScanTooStale,
  msUntilScanGreetingDue,
  SCAN_FAST_PATH_WAKE_MARGIN_MS,
  venueLocalDate,
} from './scan-arrival'
import {
  claimScanArrival,
  loadDueScanArrivals,
  loadPendingScanArrival,
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
  /** Rows whose greeting delay has not elapsed. */
  notYet: number
  /**
   * TAC-386: rows held because another proactive message reached the guest
   * within the last hour.
   *
   * Its own counter rather than a `suppressed` reason, because it is NOT a
   * suppression: nothing is written to the row and the next tick reconsiders
   * it, exactly like `notYet`. A `suppressed` entry would also need a new
   * `instagram_scan_arrivals.outcome` value, which is a CHECK widening.
   */
  heldForSpacing: number
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
    supabase
      .from('venues')
      .select('timezone, status')
      .eq('id', venueId)
      .maybeSingle(),
    supabase
      .from('venue_configs')
      .select('venue_info')
      .eq('venue_id', venueId)
      .maybeSingle(),
  ])

  const timezone =
    typeof venue.data?.timezone === 'string' && venue.data.timezone.length > 0
      ? venue.data.timezone
      : null

  let hours: VenueInfo['hours'] | null = null
  const rawInfo = config.data?.venue_info
  if (
    rawInfo != null &&
    typeof rawInfo === 'object' &&
    !Array.isArray(rawInfo)
  ) {
    const parsed = VenueHoursSchema.safeParse(
      (rawInfo as Record<string, unknown>).hours ?? {},
    )
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
 * is greeting over someone mid-sentence, which is the thing the greeting
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
    logger.warn(
      '[scan-greeting] inbound-since read failed; suppressing this greeting',
      {
        scanArrivalId: row.id,
        error: error.message,
      },
    )
    return true
  }
  return data !== null
}

/** Fails CLOSED, for the reason handle-holding-message.ts gives: nobody sends to someone who left. */
async function isOptedOut(
  supabase: AdminSupabaseClient,
  guestId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('guests')
    .select('opted_out_at')
    .eq('id', guestId)
    .maybeSingle()
  if (error) {
    logger.warn(
      '[scan-greeting] opt-out read failed; suppressing this greeting',
      {
        guestId,
        error: error.message,
      },
    )
    return true
  }
  return data?.opted_out_at != null
}

/**
 * Has another proactive message reached this guest too recently for a greeting?
 *
 * Fails OPEN on an unreadable row, unlike `isOptedOut` above, and the asymmetry
 * is deliberate: an opt-out we cannot read might mean the guest left, where a
 * spacing marker we cannot read at worst costs one greeting landing closer to
 * another message than the rule prefers. Suppressing every greeting at a venue
 * on a transient read error is the worse failure.
 */
async function isTooSoonAfterAnotherProactiveSend(
  supabase: AdminSupabaseClient,
  guestId: string,
  now: Date,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('guests')
    .select('last_proactive_send_at')
    .eq('id', guestId)
    .maybeSingle()
  if (error) {
    logger.warn('[scan-greeting] spacing read failed; allowing the greeting', {
      guestId,
      error: error.message,
    })
    return false
  }
  const last = data?.last_proactive_send_at
  return isTooSoonAfterProactive(last ? new Date(last) : null, now)
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
  const resolved = await resolveScanArrival(
    supabase,
    row.id,
    outcome,
    now,
    'unclaimed',
  )
  // The other runner resolved this row first, or claimed it and is greeting,
  // so the ledger row and the event for this scan are its to write. Only a
  // POSITIVE loss returns: an unreadable result still records, as it did
  // before the resolve was a CAS.
  if (resolved.ok && !resolved.data) return
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

/** What became of one row on one visit by one runner. */
export type ScanArrivalRowResult =
  /** The greeting delay has not elapsed. Nothing written. */
  | { kind: 'not_yet' }
  /** TAC-386's spacing hold. Nothing written; a later tick reconsiders it. */
  | { kind: 'held_for_spacing' }
  /** Resolved without a greeting, before the claim. */
  | {
      kind: 'suppressed'
      outcome: Exclude<ScanArrivalOutcome, 'greeted' | 'errored'>
    }
  /** The other runner claimed this row first. Nothing written. */
  | { kind: 'cas_lost' }
  /** This call claimed the row and generated a greeting for it. */
  | { kind: 'greeted' }
  | { kind: 'errored' }

/**
 * One row, start to finish: every suppression re-check, then the claim, then
 * the greeting. THE ONE PATH BOTH RUNNERS TAKE.
 *
 * Lifted out of `processDueScanGreetings`'s loop unchanged in order and
 * content, so that the fast path could call it rather than carry a second
 * copy of the checks. A check added here is added for both; a check added to
 * either caller instead is the fork this function exists to prevent.
 *
 * `now` is the instant the decision is made at, NOT the instant of the scan.
 * The fast path reads its clock after its sleep for exactly that reason.
 *
 * Never throws: a throw becomes an `errored` outcome for the row, the posture
 * every sibling processor takes.
 */
export async function processScanArrival(
  supabase: AdminSupabaseClient,
  row: PendingScanArrival,
  now: Date,
): Promise<ScanArrivalRowResult> {
  // What this call has done to the row so far, for the catch below: a throw
  // before the claim and a throw after it are not the same event.
  let claimed = false
  let recordedGreeting = false
  try {
    if (!isScanGreetingDue(row.scannedAt, now)) {
      return { kind: 'not_yet' }
    }
    if (isScanTooStale(row.scannedAt, now)) {
      await suppress(supabase, row, 'too_stale', now)
      return { kind: 'suppressed', outcome: 'too_stale' }
    }
    if (await guestWroteSince(supabase, row)) {
      await suppress(supabase, row, 'inbound_during_window', now)
      return { kind: 'suppressed', outcome: 'inbound_during_window' }
    }

    const clock = await loadVenueClock(supabase, row.venueId)
    if (isVenueProcessingHalted(clock.status)) {
      await suppress(supabase, row, 'venue_paused', now)
      return { kind: 'suppressed', outcome: 'venue_paused' }
    }
    if (await isOptedOut(supabase, row.guestId)) {
      await suppress(supabase, row, 'guest_opted_out', now)
      return { kind: 'suppressed', outcome: 'guest_opted_out' }
    }
    // TAC-386: no two proactive messages to one guest within the hour. This
    // mechanism WROTE the shared marker before it read it, which made the
    // rule a claim four files asserted and two enforced: a scan greeting
    // could still land minutes after a warm close or an inquiry follow-up.
    // Found in review.
    //
    // A HOLD, not a suppression: the row is left for the next tick, so a scan
    // whose hour is nearly up is greeted a few minutes later rather than
    // dropped. `isScanTooStale` is the bound that eventually gives up on it.
    // The fast path does not retry a hold; the cron is what comes back.
    if (await isTooSoonAfterAnotherProactiveSend(supabase, row.guestId, now)) {
      return { kind: 'held_for_spacing' }
    }
    // `unknown` hours proceed: isVenueClosed is true only for a POSITIVE
    // closed verdict, which is how TAC-363's ruling holds by construction
    // rather than by each caller remembering it.
    if (
      clock.timezone !== null &&
      isVenueClosed(
        { venueInfo: { hours: clock.hours ?? {} }, timezone: clock.timezone },
        now,
      )
    ) {
      await suppress(supabase, row, 'venue_closed', now)
      return { kind: 'suppressed', outcome: 'venue_closed' }
    }

    // The venue-local day the claim is keyed on. An unreadable timezone
    // falls back to UTC rather than refusing: the guard would otherwise be
    // switched off entirely for that venue, and a UTC day is still one day.
    const localDate =
      (clock.timezone !== null ? venueLocalDate(now, clock.timezone) : null) ??
      venueLocalDate(now, 'UTC') ??
      now.toISOString().slice(0, 10)

    const claim = await claimScanArrival(supabase, row.id, localDate, now)
    if (claim.status === 'lost') {
      return { kind: 'cas_lost' }
    }
    if (claim.status === 'already_greeted_today') {
      await suppress(supabase, row, 'already_greeted_today', now)
      return { kind: 'suppressed', outcome: 'already_greeted_today' }
    }
    if (claim.status === 'failed') {
      logger.error('[scan-greeting] claim failed', {
        scanArrivalId: row.id,
        error: claim.error,
      })
      return { kind: 'errored' }
    }

    claimed = true

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

    await resolveScanArrival(
      supabase,
      row.id,
      'greeted',
      new Date(),
      'claim_owner',
    )
    recordedGreeting = true
    // TAC-386: the shared proactive-send spacing marker, so the warm close and
    // the inquiry follow-up can both see that this guest has just heard from
    // us unprompted. On a confirmed send only: a queued card is an operator's
    // decision and an operator can see the whole thread.
    if (outcome.status === 'sent') {
      await recordProactiveSend(supabase, row.guestId, now)
    }
    await recordLedger(row, ledgerEntryFor(outcome), agentRunId)
    await captureInstagramScanGreeting({
      venueId: row.venueId,
      guestId: row.guestId,
      scanMessageId: row.scanMessageId,
      outcome: 'greeted',
      hadPriorConversation: row.hadPriorConversation,
      agentStatus: outcome.status,
    })
    return { kind: 'greeted' }
  } catch (e) {
    logger.error('[scan-greeting] row threw', {
      scanArrivalId: row.id,
      error: e instanceof Error ? e.message : String(e),
    })
    // A greeting already recorded stays recorded: it went out, and a later
    // bookkeeping throw does not change that. Otherwise `errored` is written
    // as whoever this call is. Unclaimed, it can lose to the other runner,
    // and then the row and its ledger entry are that runner's.
    if (!recordedGreeting) {
      const resolved = await resolveScanArrival(
        supabase,
        row.id,
        'errored',
        now,
        claimed ? 'claim_owner' : 'unclaimed',
      ).catch(() => null)
      if (!claimed && resolved?.ok === true && !resolved.data) {
        return { kind: 'errored' }
      }
    }
    await recordLedger(row, ledgerEntryForUnexpected(e), null).catch(
      () => undefined,
    )
    return { kind: 'errored' }
  }
}

/**
 * One tick of the backstop cron. Never throws: `processScanArrival` turns a
 * throw handling one row into an `errored` outcome for that row and the rest
 * are still handled.
 */
export async function processDueScanGreetings(
  now: Date = new Date(),
  supabase: AdminSupabaseClient = createAdminClient(),
): Promise<ProcessScanGreetingsResult> {
  const result: ProcessScanGreetingsResult = {
    scanned: 0,
    notYet: 0,
    heldForSpacing: 0,
    greeted: 0,
    suppressed: {},
    casLost: 0,
    errored: 0,
  }

  const due = await loadDueScanArrivals(supabase)
  if (!due.ok) {
    logger.error('[scan-greeting] could not read pending scans', {
      error: due.error,
    })
    result.errored += 1
    return result
  }

  for (const row of due.data) {
    result.scanned += 1
    const rowResult = await processScanArrival(supabase, row, now)
    switch (rowResult.kind) {
      case 'not_yet':
        result.notYet += 1
        break
      case 'held_for_spacing':
        result.heldForSpacing += 1
        break
      case 'suppressed':
        result.suppressed[rowResult.outcome] =
          (result.suppressed[rowResult.outcome] ?? 0) + 1
        break
      case 'cas_lost':
        result.casLost += 1
        break
      case 'greeted':
        result.greeted += 1
        break
      case 'errored':
        result.errored += 1
        break
    }
  }

  return result
}

/** The two things the fast path does not own: time passing, and what time it is. */
export interface ScanGreetingFastPathDeps {
  sleep: (ms: number) => Promise<void>
  now: () => Date
}

const FAST_PATH_DEPS: ScanGreetingFastPathDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
}

/**
 * Greet about twenty seconds after the scan, instead of whenever the next
 * cron tick after that happens to land.
 *
 * Started by the Instagram webhook inside the `waitUntil` that recorded the
 * scan, so the wait happens after Meta has its 200. It sleeps until the row
 * is due, re-reads it, and hands it to `processScanArrival`: the cron's own
 * per-row path, with nothing skipped and nothing added.
 *
 * WHY A SLEEP IN THE INVOCATION AND NOT A QUEUE. This is an accelerator, not
 * the delivery guarantee. An instance that dies mid-sleep loses nothing: the
 * row is still unclaimed and unresolved, and the cron's next tick greets it
 * up to a minute later. A delayed-delivery queue would buy durability the
 * cron already provides, for a new vendor, a new signed route and new
 * credentials. Same shape as COALESCE_SETTLE_MS, which already sleeps inside
 * this webhook's `waitUntil` before every inbound turn.
 *
 * BOTH CLOCK READS ARE DELIBERATE. The first sizes the sleep. The second is
 * taken AFTER it and is the `now` every re-check sees, so a venue that closed
 * or a guest who wrote during the twenty seconds is judged at the moment the
 * greeting would go out.
 *
 * The row is re-read rather than carried across the sleep: `null` means the
 * cron or a second delivery got there first, and that is a normal ending.
 * A row not yet due on waking (Meta's clock well ahead of ours) is left for
 * the cron rather than slept on again; the wake margin covers timer jitter,
 * not clock skew.
 *
 * Never throws and never rejects: it runs under `waitUntil`, where an
 * escaping rejection is an unhandled one. supabase-js throws on some failures
 * rather than returning them, so the guard is around everything.
 */
export async function runScanGreetingFastPath(
  supabase: AdminSupabaseClient,
  scheduled: { id: string; scannedAt: Date },
  deps: ScanGreetingFastPathDeps = FAST_PATH_DEPS,
): Promise<void> {
  try {
    await deps.sleep(
      msUntilScanGreetingDue(scheduled.scannedAt, deps.now()) +
        SCAN_FAST_PATH_WAKE_MARGIN_MS,
    )

    const pending = await loadPendingScanArrival(supabase, scheduled.id)
    if (!pending.ok) {
      logger.warn(
        '[scan-greeting] fast path could not re-read the scan; leaving it to the cron',
        { scanArrivalId: scheduled.id, error: pending.error },
      )
      return
    }
    if (pending.data === null) return

    const rowResult = await processScanArrival(
      supabase,
      pending.data,
      deps.now(),
    )
    logger.info('[scan-greeting] fast path complete', {
      scanArrivalId: scheduled.id,
      result: rowResult.kind,
      ...(rowResult.kind === 'suppressed'
        ? { outcome: rowResult.outcome }
        : {}),
    })
  } catch (e) {
    logger.error(
      '[scan-greeting] fast path threw; leaving the scan to the cron',
      {
        scanArrivalId: scheduled.id,
        error: e instanceof Error ? e.message : String(e),
      },
    )
  }
}
