import { createAdminClient } from '@/lib/db/admin'
import type { RawSignals, RecognitionResult } from './types'
import { dedupeVisitsByLocalDate } from './visit-dedupe'

const VISIT_LOOKBACK_DAYS = 90
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Internal: load all raw signals for a guest at a venue from the database.
 *
 * Server-only. Uses the admin DB client, which bypasses RLS. Issues five
 * SELECTs in parallel (venue timezone, transactions, outbound/inbound
 * message counts, engagement events). Visits and the visit-date list are
 * deduplicated by calendar date in the venue's local timezone — multiple
 * transactions on the same local day count as one visit.
 */
export async function loadSignals({
  guestId,
  venueId,
}: {
  guestId: string
  venueId: string
}): Promise<RecognitionResult<RawSignals>> {
  const supabase = createAdminClient()
  const lookbackIso = new Date(Date.now() - VISIT_LOOKBACK_DAYS * MS_PER_DAY).toISOString()

  const [
    venueResult,
    transactionsResult,
    outboundMessagesResult,
    inboundMessagesResult,
    engagementEventsResult,
  ] = await Promise.all([
    supabase
      .from('venues')
      .select('timezone')
      .eq('id', venueId)
      .maybeSingle(),
    supabase
      .from('transactions')
      .select('amount_cents, occurred_at')
      .eq('venue_id', venueId)
      .eq('guest_id', guestId)
      .gte('occurred_at', lookbackIso),
    supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueId)
      .eq('guest_id', guestId)
      .eq('direction', 'outbound')
      .in('status', ['sent', 'delivered']),
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
  ])

  if (venueResult.error) {
    return { ok: false, error: venueResult.error.message, errorCode: 'load_venue_failed' }
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
    totalSpentCents += row.amount_cents
    occurredAtList.push(row.occurred_at)
  }
  const visitDateList = dedupeVisitsByLocalDate(occurredAtList, timezone)

  const visitsLast90Days = visitDateList.length
  const lastVisit = visitDateList[visitDateList.length - 1]
  const daysSinceLastVisit =
    lastVisit === undefined
      ? Number.POSITIVE_INFINITY
      : Math.floor((Date.now() - lastVisit.getTime()) / MS_PER_DAY)

  const engagementEventsByType: Record<string, number> = {}
  for (const row of engagementEventsResult.data ?? []) {
    engagementEventsByType[row.event_type] = (engagementEventsByType[row.event_type] ?? 0) + 1
  }
  const referralsMade = engagementEventsByType['referral_made'] ?? 0

  return {
    ok: true,
    data: {
      visitsLast90Days,
      daysSinceLastVisit,
      totalSpentLast90Days: totalSpentCents / 100,
      outboundMessageCount: outboundMessagesResult.count ?? 0,
      // TODO: refine to per-message reply attribution when message threading is wired up.
      repliedMessageCount: inboundMessagesResult.count ?? 0,
      engagementEventsByType,
      // TODO: populate from POS line items once THE-125 ships.
      uniqueMenuItemsOrdered: 0,
      totalMenuItems: 0,
      referralsMade,
      // TODO: source 'referral_converted' once that event_type is added to the engagement_events check constraint.
      referralsConverted: 0,
      // TODO: compute from guests.home_postal_code once next migration adds the field.
      distanceMiles: null,
      visitDateList,
    },
  }
}