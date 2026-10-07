import { formatInTimeZone } from 'date-fns-tz'
import { createAdminClient } from '@/lib/db/admin'
import { logger } from '@/lib/observability/logger'
import { extractMenuExploration } from './extract-menu-exploration'
import {
  loadInstagramScanInstants,
  scanVisitInstants,
} from './load-scan-visits'
import type { RawSignals, RecognitionResult } from './types'
import { dedupeVisitsByLocalDate, visitDaysThatCount } from './visit-dedupe'

export const VISIT_LOOKBACK_DAYS = 90
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Internal: load all raw signals for a guest at a venue from the database.
 *
 * Server-only. Uses the admin DB client, which bypasses RLS. Issues seven
 * SELECTs in parallel (venue + venue_configs embed for timezone and menu;
 * transactions; outbound/inbound message counts; engagement events; the
 * guest's enrolment; their scans). Visits and the visit-date list are
 * deduplicated by calendar date in the venue's local timezone — multiple
 * transactions on the same local day count as one visit.
 *
 * TAC-575 (ruled 2026-10-06): A SCAN DAY IS A VISIT. A guest who scans the
 * counter code five mornings and never says what they got was at the counter
 * five times, and counted as zero visits before this. Scan days are merged
 * into the visit list AT READ TIME, before the per-day dedupe, so a scan and
 * an order on one day are one visit. Nothing is written: no `transactions`
 * row and no `last_visit_at`, whose three writers (lib/guests/CLAUDE.md) stay
 * three. Spend is untouched; visit count, recency and consistency move.
 *
 * TODAY ALONE IS NOT A VISIT ON FILE (ruled 2026-10-07). A guest whose only
 * visit day in the window is today counts zero visits here, whether that day
 * came from a scan or an order: see visitDaysThatCount.
 *
 * THE SCAN READS FAIL OPEN TO ORDERS ALONE, unlike the five above. An
 * unreadable scan history undercounts a guest for one turn, which is what
 * every guest got before this change; failing recognition over it would cost
 * the turn its state band.
 *
 * The venue SELECT embeds venue_configs(venue_info) so percentMenuExplored
 * has the menu universe to intersect against. We do defensive shallow
 * extraction rather than VenueInfoSchema.safeParse: a malformed venue_info
 * here should degrade percentMenuExplored to 0, not crash the whole
 * recognition computation. buildRuntimeContext fails closed on the same
 * blob for prompt-assembly reasons; recognition has no such constraint.
 */
export async function loadSignals({
  guestId,
  venueId,
  includeScanVisits = true,
}: {
  guestId: string
  venueId: string
  // NOT A RUNTIME SWITCH. Nothing in the app passes it, and no venue setting
  // reads it. `false` exists for one caller,
  // scripts/measurement/scan-visits-before-after.ts, which needs the count the
  // way it was before scans were visits to print the difference.
  includeScanVisits?: boolean
}): Promise<RecognitionResult<RawSignals>> {
  const supabase = createAdminClient()
  const lookbackIso = new Date(
    Date.now() - VISIT_LOOKBACK_DAYS * MS_PER_DAY,
  ).toISOString()

  const [
    venueResult,
    transactionsResult,
    outboundMessagesResult,
    inboundMessagesResult,
    engagementEventsResult,
    guestResult,
    scansResult,
  ] = await Promise.all([
    supabase
      .from('venues')
      .select('timezone, venue_configs(venue_info)')
      .eq('id', venueId)
      .maybeSingle(),
    supabase
      .from('transactions')
      .select('amount_cents, occurred_at, raw_data')
      .eq('venue_id', venueId)
      .eq('guest_id', guestId)
      // TAC-573: a visit the guest took back is not a visit. See
      // lib/agent/retract-reported-visit.ts.
      .is('retracted_at', null)
      .gte('occurred_at', lookbackIso),
    // TAC-313: counts RESPONSES, not rows. A split reply is dispatched as up
    // to three `messages` rows sharing a `generation_id`, and this count is the
    // denominator of `responseRate = replied / sent` (weight 0.10 in
    // computeRelationshipStrength). Splitting inflates the denominator ONLY —
    // the guest's replies don't multiply — so a row count would walk guests
    // downward out of `regular` with no change in their behavior. Not a display
    // bug: it changes who the product treats as a regular.
    //
    // The RPC (migration 032) is `count(distinct coalesce(generation_id, id))`,
    // the same grouping identity used by list_operator_queue and by
    // groupIntoResponses. COUNT(DISTINCT) has no PostgREST expression, hence
    // the function.
    supabase.rpc('count_outbound_responses', {
      p_venue_id: venueId,
      p_guest_id: guestId,
    }),
    supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('guest_id', guestId)
      .eq('direction', 'inbound'),
    supabase
      .from('engagement_events')
      .select('event_type')
      .eq('venue_id', venueId)
      .eq('guest_id', guestId),
    supabase
      .from('guests')
      .select('created_via, created_at')
      .eq('id', guestId)
      .maybeSingle(),
    loadInstagramScanInstants(supabase, {
      venueId,
      guestId,
      sinceIso: lookbackIso,
    }),
  ])

  if (venueResult.error) {
    return {
      ok: false,
      error: venueResult.error.message,
      errorCode: 'load_venue_failed',
    }
  }
  if (!venueResult.data) {
    return { ok: false, error: 'venue_not_found' }
  }
  const timezone = venueResult.data.timezone

  if (transactionsResult.error) {
    return {
      ok: false,
      error: transactionsResult.error.message,
      errorCode: 'load_transactions_failed',
    }
  }
  if (outboundMessagesResult.error) {
    return {
      ok: false,
      error: outboundMessagesResult.error.message,
      errorCode: 'load_messages_failed',
    }
  }
  if (inboundMessagesResult.error) {
    return {
      ok: false,
      error: inboundMessagesResult.error.message,
      errorCode: 'load_messages_failed',
    }
  }
  if (engagementEventsResult.error) {
    return {
      ok: false,
      error: engagementEventsResult.error.message,
      errorCode: 'load_engagement_events_failed',
    }
  }

  let totalSpentCents = 0
  const occurredAtList: string[] = []
  for (const row of transactionsResult.data ?? []) {
    // TAC-323: guest_reported transactions can carry a null amount_cents
    // (resolved item with no price in venue_info). Treating null as a
    // 0-contribution to this sum is SQL SUM()-ignores-NULL semantics, not a
    // claim that the order cost $0 — the row still counts as a visit via
    // occurredAtList below.
    totalSpentCents += row.amount_cents ?? 0
    occurredAtList.push(row.occurred_at)
  }
  for (const iso of !includeScanVisits
    ? []
    : scanVisitIsoList({
        guest: guestResult,
        scans: scansResult,
        lookbackIso,
        venueId,
        guestId,
      })) {
    occurredAtList.push(iso)
  }
  // Today alone is not a visit on file: see visitDaysThatCount. Today's key is
  // only computed when there is a day to compare, so a guest with no visits
  // never reaches formatInTimeZone (it throws on an unknown zone).
  const dedupedDays = dedupeVisitsByLocalDate(occurredAtList, timezone)
  const visitDateList =
    dedupedDays.length === 0
      ? dedupedDays
      : visitDaysThatCount(
          dedupedDays,
          formatInTimeZone(new Date(), timezone, 'yyyy-MM-dd'),
        )

  const visitsLast90Days = visitDateList.length
  const lastVisit = visitDateList[visitDateList.length - 1]
  const daysSinceLastVisit =
    lastVisit === undefined
      ? Number.POSITIVE_INFINITY
      : Math.floor((Date.now() - lastVisit.getTime()) / MS_PER_DAY)

  const engagementEventsByType: Record<string, number> = {}
  for (const row of engagementEventsResult.data ?? []) {
    engagementEventsByType[row.event_type] =
      (engagementEventsByType[row.event_type] ?? 0) + 1
  }
  const referralsMade = engagementEventsByType['referral_made'] ?? 0

  const menuItems = extractMenuItemsFromVenueRow(venueResult.data.venue_configs)
  const { uniqueMenuItemsOrdered, totalMenuItems } = extractMenuExploration(
    transactionsResult.data ?? [],
    menuItems,
  )

  return {
    ok: true,
    data: {
      visitsLast90Days,
      daysSinceLastVisit,
      totalSpentLast90Days: totalSpentCents / 100,
      // TAC-313: RPC returns a bigint response count. Deliberately no fallback
      // to a row count on failure — the error branch above returns instead, so
      // a broken RPC surfaces as a recognition failure rather than silently
      // restoring the row-counting bug.
      outboundMessageCount: outboundMessagesResult.data ?? 0,
      // TODO: refine to per-message reply attribution when message threading is wired up.
      repliedMessageCount: inboundMessagesResult.count ?? 0,
      engagementEventsByType,
      // Exact-match-after-normalization (lowercase + trim) against the venue
      // menu universe. Fuzzy matching / a name-mapping table is the next
      // iteration when real POS data introduces noise that exact match can't
      // handle. `availability` field is freeform text today — TODO: filter
      // archived/seasonal entries from the universe once the schema gains a
      // clean active flag.
      uniqueMenuItemsOrdered,
      totalMenuItems,
      referralsMade,
      // TODO: source 'referral_converted' once that event_type is added to the engagement_events check constraint.
      referralsConverted: 0,
      // TODO: compute from guests.home_postal_code once next migration adds the field.
      distanceMiles: null,
      visitDateList,
    },
  }
}

/**
 * The scan instants inside the lookback window, as ISO strings for the visit
 * list. Empty, with a warning, when either read failed: see the header for why
 * that fails open.
 *
 * The enrolment day needs the window applied here, because `guests.created_at`
 * is not filtered by the query the way `scanned_at` is.
 */
function scanVisitIsoList(input: {
  guest: {
    data: { created_via: string; created_at: string } | null
    error: { message: string } | null
  }
  scans: Awaited<ReturnType<typeof loadInstagramScanInstants>>
  lookbackIso: string
  venueId: string
  guestId: string
}): string[] {
  if (input.guest.error || !input.scans.ok) {
    logger.warn('[recognition] scans unreadable; counting visits from orders', {
      venueId: input.venueId,
      guestId: input.guestId,
      error:
        input.guest.error?.message ??
        (input.scans.ok ? null : input.scans.error),
    })
    return []
  }
  if (input.guest.data === null) return []
  const lookbackMs = new Date(input.lookbackIso).getTime()
  return scanVisitInstants({
    createdVia: input.guest.data.created_via,
    createdAt: new Date(input.guest.data.created_at),
    instagramScans: input.scans.data,
  })
    .filter((instant) => instant.getTime() >= lookbackMs)
    .map((instant) => instant.toISOString())
}

// PostgREST returns `venue_configs` as either an object or a single-element
// array depending on relationship cardinality (same shape note as
// build-runtime-context.ts). Defensive read: if anything is missing or
// malformed, return [] so percentMenuExplored degrades to 0 rather than
// crashing recognition.
function extractMenuItemsFromVenueRow(
  venueConfigs: unknown,
): Array<{ name: string }> {
  const config = unwrapVenueConfig(venueConfigs)
  if (config === null) return []
  const venueInfo = config.venue_info
  if (typeof venueInfo !== 'object' || venueInfo === null) return []
  const menu = (venueInfo as Record<string, unknown>).menu
  if (typeof menu !== 'object' || menu === null) return []
  const items = (menu as Record<string, unknown>).items
  if (!Array.isArray(items)) return []
  const result: Array<{ name: string }> = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const name = (item as Record<string, unknown>).name
    if (typeof name !== 'string') continue
    result.push({ name })
  }
  return result
}

function unwrapVenueConfig(
  venueConfigs: unknown,
): Record<string, unknown> | null {
  if (Array.isArray(venueConfigs)) {
    const first = venueConfigs[0]
    return typeof first === 'object' && first !== null
      ? (first as Record<string, unknown>)
      : null
  }
  if (typeof venueConfigs === 'object' && venueConfigs !== null) {
    return venueConfigs as Record<string, unknown>
  }
  return null
}
