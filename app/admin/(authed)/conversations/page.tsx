import { redirect } from 'next/navigation'
import { formatInTimeZone } from 'date-fns-tz'
import { AuthError, devAuthBypass, verifyAnalogAdminAccess } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import { createServerClient } from '@/lib/db/server'
import { logger } from '@/lib/observability/logger'
import { type GuestState } from '@/lib/recognition'
import {
  BrandPersonaSchema,
  VenueInfoSchema,
  filterActiveContext,
} from '@/lib/schemas'
import { guestNameWithPhone } from '../_lib/guest-name'
import {
  SLOW_RENDER_MS,
  createStageTimer,
  type StageTimer,
} from '../_lib/stage-timer'
import { ConversationsClient, type InitialData } from './conversations-client'
import { EmptyState } from './_components/empty-state'
import { Filters } from './_components/filters'
import type { RecentActivityRow } from './_components/recent-activity'
import { loadVenueGuestsByActivity } from '../_lib/load-venue-guests'
import { computeMessageStats } from './lib/compute-message-stats'
import {
  type ConversationMessageRow,
  projectThread,
  wasDispatched,
} from './lib/project-thread'
import {
  allowsVenue,
  venueFilterIds,
  type VenueScope,
} from '@/lib/auth/venue-scope'

// Server orchestrator. Fetches everything the client needs in one render path
// so initial paint is one network round trip. The client is responsible for
// follow-up: trace fetches (including the default selection's), Realtime
// subscription, filter changes (which trigger this server fetch again via
// router.replace + RSC re-render).
//
// NOTHING IN THIS RENDER MAY WAIT ON A THIRD PARTY. It used to prefetch the
// last five Langfuse traces before sending any HTML. Langfuse rate-limits the
// read API, and the SDK retried a 429 twice honoring Retry-After, so one
// click on a guest could hang for minutes with no error. Measured on prod:
// every database query here is under 300ms, a trace read is 0.2 to 3.8s and
// ~115KB (five of them were also ~550KB of RSC payload). The trace panel
// fetches its own trace through the bounded /api/trace route instead.
//
// BOUNDED: `maxDuration` caps the whole render, and the Supabase client aborts
// any single request after SUPABASE_TIMEOUT_MS, so a stalled query becomes the
// labeled "... load failed" error rather than an indefinite spinner.
//
// Auth: layout already gates the (authed) tree; we re-resolve the operator
// here only to resolve the operator's `venueScope`.

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const SUPABASE_TIMEOUT_MS = 10_000
const MESSAGE_LIMIT = 200
const RECENT_ACTIVITY_LIMIT = 5
const RECENT_GUESTS_LIMIT = 50
const VISIT_LOOKBACK_DAYS = 90
const RECENT_EVENTS_LIMIT = 3
const TRANSACTIONS_LIMIT = 50
const MS_PER_DAY = 24 * 60 * 60 * 1000

interface PageProps {
  searchParams: Promise<{ venue?: string; guest?: string }>
}

// redirect() and notFound() unwind by throwing; those are control flow, not
// failures, and must not be logged as errors.
function isNextControlFlow(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false
  const digest = (e as { digest?: unknown }).digest
  return typeof digest === 'string' && digest.startsWith('NEXT_')
}

// One line per render with where the time went. A render that never returns
// logs nothing, which is itself the signal: look for the request without a
// matching line. `lastStage` on a failure names the stage it got past.
export default async function ConversationsPage(props: PageProps) {
  const timer = createStageTimer()
  const params = await props.searchParams
  const fields = {
    venueId: params.venue ?? null,
    guestId: params.guest ?? null,
  }
  try {
    const page = await renderConversations(params, timer)
    const rendered = {
      ...fields,
      totalMs: timer.totalMs(),
      stages: timer.stages(),
    }
    if (rendered.totalMs >= SLOW_RENDER_MS) {
      logger.warn('[conversations] render slow', rendered)
    } else {
      logger.info('[conversations] render', rendered)
    }
    return page
  } catch (e) {
    if (!isNextControlFlow(e)) {
      logger.error('[conversations] render failed', {
        ...fields,
        totalMs: timer.totalMs(),
        lastStage: timer.lastStage(),
        stages: timer.stages(),
        error: e,
      })
    }
    throw e
  }
}

async function renderConversations(
  params: { venue?: string; guest?: string },
  timer: StageTimer,
) {
  // Resolve operator + allowed venues
  let venueScope: VenueScope
  // Local-dev bypass (lib/auth/dev-bypass.ts): triple-guarded, null anywhere
  // but a developer's own `next dev` on localhost.
  const bypass = await devAuthBypass()
  if (bypass) {
    venueScope = bypass.venueScope
  } else {
    const supabaseSession = await createServerClient()
    const {
      data: { session },
    } = await supabaseSession.auth.getSession()
    if (!session) redirect('/admin/sign-in')

    try {
      const op = await verifyAnalogAdminAccess(session.user.id)
      venueScope = op.venueScope
    } catch (e) {
      if (e instanceof AuthError && e.status === 403) redirect('/admin')
      throw e
    }
  }
  timer.mark('auth')

  const supabase = createAdminClient({ timeoutMs: SUPABASE_TIMEOUT_MS })

  // Venues for dropdown — analog admins see every venue regardless of
  // operator_venues. The allowlist matters for non-admin operators (future).
  const { data: venuesRaw, error: venuesErr } = await supabase
    .from('venues')
    .select('id, slug, name, timezone, messaging_phone_number, status, is_test')
    .order('name', { ascending: true })
  if (venuesErr) throw new Error(`venues load failed: ${venuesErr.message}`)
  const venues = (venuesRaw ?? []).filter((v) => allowsVenue(venueScope, v.id))
  timer.mark('venues')

  // Validate filter ids against the allowlist — reject foreign IDs cleanly.
  const venueId =
    params.venue && venues.some((v) => v.id === params.venue)
      ? params.venue
      : null
  const guestId = params.guest ?? null

  // Pre-filter / venue-only path: render empty-state with recent activity.
  if (!venueId) {
    const recent = await loadRecentActivity({
      supabase,
      venueScope,
      venueId: null,
    })
    timer.mark('recent_activity')
    return (
      <FullShell>
        <Filters
          venues={venues}
          guests={[]}
          selectedVenueId={null}
          selectedGuestId={null}
        />
        <EmptyState variant="pre-filter" recentRows={recent} />
      </FullShell>
    )
  }

  // Always need the venue's guest list at this point for the dropdown.
  //
  // TAC-476: ordered by DERIVED activity (the venue_guest_activity RPC), not
  // by guests.last_interaction_at, which is written once at guest creation and
  // so held enrollment date. See order-guests-by-activity.ts for why the
  // ordering is load-bearing rather than cosmetic.
  const { rows: guestRows } = await loadVenueGuestsByActivity(
    supabase,
    venueId,
    RECENT_GUESTS_LIMIT,
  )
  const guests = guestRows.map((g) => ({
    id: g.id,
    firstName: g.first_name,
    lastName: g.last_name,
    phoneNumber: g.phone_number,
    instagramUsername: g.instagram_username,
  }))
  timer.mark('guest_list')

  if (!guestId) {
    const recent = await loadRecentActivity({ supabase, venueScope, venueId })
    timer.mark('recent_activity')
    return (
      <FullShell>
        <Filters
          venues={venues}
          guests={guests}
          selectedVenueId={venueId}
          selectedGuestId={null}
        />
        <EmptyState variant="venue-only" recentRows={recent} />
      </FullShell>
    )
  }

  // Both filters set — load conversation + context.
  const venueRow = venues.find((v) => v.id === venueId)!
  const initialData = await loadConversationData({
    supabase,
    venueRow,
    guestId,
  })
  timer.mark('conversation')

  if (!initialData) {
    return (
      <FullShell>
        <Filters
          venues={venues}
          guests={guests}
          selectedVenueId={venueId}
          selectedGuestId={guestId}
        />
        <div className="flex-1 flex items-center justify-center text-sm text-ink-soft">
          Guest not found at this venue.
        </div>
      </FullShell>
    )
  }

  return (
    <FullShell>
      <Filters
        venues={venues}
        guests={guests}
        selectedVenueId={venueId}
        selectedGuestId={guestId}
      />
      {/* key forces a fresh mount on every (venue, guest) change so the
          client component's useState initializers re-run with the new
          initialData. Without this, App Router soft-navigation can reuse
          the prior instance and useState (which only consults its initial
          value once) keeps stale messages — observed as "conversation
          empty until refresh" on first filter selection. Trace cache
          resets on remount; acceptable trade-off given how rare guest
          switching is mid-debug. */}
      <ConversationsClient
        key={`${venueId}:${guestId}`}
        venueId={venueId}
        guestId={guestId}
        initialData={initialData}
      />
    </FullShell>
  )
}

// ---------------------------------------------------------------------------

function FullShell({ children }: { children: React.ReactNode }) {
  // 5-region layout (PR-5). Page-level scroll is now allowed — the
  // transactions section at the bottom needs room to grow. Vertical model:
  //   1. Filters (sticky top-0, h-14, z-20 — stays accessible during scroll)
  //   2. Conversation thread + trace panel (h-[calc(100dvh-7rem)], internally
  //      split 400px / 1fr) — fills first viewport on initial paint
  //   3. Context cards (240px fixed, internally split 1/2 / 1/2)
  //   4. Transactions section (natural height, full-width)
  //
  // The wrapper has min-h instead of h so content longer than the viewport
  // can grow the page. Filters stay reachable via sticky top-0 within
  // <main> (admin-shell's overflow-auto is the scroll container).
  //
  // -mx-8 -my-10 cancels admin-shell <main>'s default px-8 py-10 padding so
  // the conversation viewer renders edge-to-edge within main's box. Other
  // admin routes keep their padded layout because the negation is local here.
  return (
    <div className="min-h-[calc(100dvh-3.5rem)] -mx-8 -my-10 flex flex-col bg-paper">
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------

interface LoadConversationArgs {
  supabase: ReturnType<typeof createAdminClient>
  venueRow: {
    id: string
    slug: string
    name: string
    timezone: string
    messaging_phone_number: string | null
    status: string
    is_test: boolean
  }
  guestId: string
}

async function loadConversationData({
  supabase,
  venueRow,
  guestId,
}: LoadConversationArgs): Promise<InitialData | null> {
  const { data: guestRow, error: guestErr } = await supabase
    .from('guests')
    .select(
      'id, first_name, last_name, phone_number, instagram_username, distance_to_venue_miles, created_via, last_visit_at',
    )
    .eq('id', guestId)
    .eq('venue_id', venueRow.id)
    .maybeSingle()
  if (guestErr) throw new Error(`guest load failed: ${guestErr.message}`)
  if (!guestRow) return null

  const lookbackIso = new Date(
    Date.now() - VISIT_LOOKBACK_DAYS * MS_PER_DAY,
  ).toISOString()

  const [
    messagesResult,
    venueConfigResult,
    mechanicsResult,
    stateResult,
    transactionsResult,
    eventsResult,
    messageCountResult,
    earliestMessageResult,
    earliestTransactionResult,
    transactionsListResult,
    operatorsResult,
  ] = await Promise.all([
    // TAC-316: newest-first window (DESC + limit), matching lib/operator/
    // thread.ts's loadGuestThread. The previous ASC order kept the OLDEST 200
    // rows and silently hid everything newer once a thread crossed the cap —
    // the truncation this ticket exists to fix. No body filter and no
    // status/review_state filter: the viewer's contract is show-everything
    // (blank knowledge-gap cards included). projectThread groups split
    // responses client- and server-side from these raw rows.
    supabase
      .from('messages')
      .select(
        'id, body, direction, created_at, langfuse_trace_id, reply_to_message_id, voice_fidelity, category, status, review_state, review_reason, generation_id, reaction_type, media_urls, provider_message_id, response_review',
      )
      .eq('venue_id', venueRow.id)
      .eq('guest_id', guestId)
      .order('created_at', { ascending: false })
      .limit(MESSAGE_LIMIT),
    supabase
      .from('venue_configs')
      .select('brand_persona, venue_info')
      .eq('venue_id', venueRow.id)
      .maybeSingle(),
    supabase
      .from('mechanics')
      .select('id, name, min_state, redemption_policy, redemption_window_days')
      .eq('venue_id', venueRow.id)
      .eq('is_active', true)
      .order('name', { ascending: true }),
    supabase
      .from('guest_states')
      .select('state, entered_at')
      .eq('guest_id', guestId)
      .eq('venue_id', venueRow.id)
      .is('exited_at', null)
      .maybeSingle(),
    supabase
      .from('transactions')
      .select('occurred_at, amount_cents')
      .eq('guest_id', guestId)
      .eq('venue_id', venueRow.id)
      // TAC-573: a visit the guest took back counts toward neither the visit
      // count nor the spend.
      .is('retracted_at', null)
      .gte('occurred_at', lookbackIso),
    supabase
      .from('engagement_events')
      .select('event_type, created_at')
      .eq('guest_id', guestId)
      .eq('venue_id', venueRow.id)
      .order('created_at', { ascending: false })
      .limit(RECENT_EVENTS_LIMIT),
    // Total message count for the venue/guest pair, all-time. Separate from
    // the 200-row messages array because that's display-windowed; this is
    // the headline number on the guest card.
    supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venueRow.id)
      .eq('guest_id', guestId)
      .neq('body', ''),
    // Earliest message timestamp — for the "since" date on the guest card.
    // ASC + limit 1 is cheaper than min() across a potentially-large table
    // and gives the same answer.
    supabase
      .from('messages')
      .select('created_at')
      .eq('venue_id', venueRow.id)
      .eq('guest_id', guestId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    // Earliest transaction timestamp — also for "since". Together with the
    // earliest message, the smaller of the two is the operator's "first
    // signal we had on this guest at this venue."
    supabase
      .from('transactions')
      .select('occurred_at')
      .eq('venue_id', venueRow.id)
      .eq('guest_id', guestId)
      .is('retracted_at', null)
      .order('occurred_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    // Full transaction rows for the bottom Transactions section (PR-5).
    // 50-row cap is a default; if a guest has >50 in 90 days the section
    // header reflects "showing 50 of N" via a caveat in copy. Real-pilot
    // guests shouldn't hit this cap; if/when they do, "show all" is a
    // separate ticket.
    //
    // TAC-573: NOT filtered on retracted_at, unlike the two reads above. A
    // retracted row is kept as the record of what the guest said and took
    // back, so the operator still sees it; TransactionsList lists it apart
    // from the visits and leaves it out of the count and the totals.
    supabase
      .from('transactions')
      .select(
        'id, occurred_at, amount_cents, item_count, raw_data, source, retracted_at',
      )
      .eq('venue_id', venueRow.id)
      .eq('guest_id', guestId)
      .gte('occurred_at', lookbackIso)
      .order('occurred_at', { ascending: false })
      .limit(TRANSACTIONS_LIMIT),
    // Operators table is small (single-digit rows in the analog admin pool).
    // Loading the whole list once per page render is fine — the alternative
    // (per-message lookup) burns more round trips. Used to map the JSONB's
    // reviewedBy uuid to a display name in the review form's status row.
    supabase.from('operators').select('id, email'),
  ])

  if (messagesResult.error)
    throw new Error(`messages load failed: ${messagesResult.error.message}`)
  if (venueConfigResult.error)
    throw new Error(
      `venue_configs load failed: ${venueConfigResult.error.message}`,
    )
  if (mechanicsResult.error)
    throw new Error(`mechanics load failed: ${mechanicsResult.error.message}`)
  if (stateResult.error)
    throw new Error(`guest_states load failed: ${stateResult.error.message}`)
  if (transactionsResult.error)
    throw new Error(
      `transactions load failed: ${transactionsResult.error.message}`,
    )
  if (eventsResult.error)
    throw new Error(
      `engagement_events load failed: ${eventsResult.error.message}`,
    )
  if (messageCountResult.error) {
    throw new Error(
      `message count load failed: ${messageCountResult.error.message}`,
    )
  }
  if (earliestMessageResult.error) {
    throw new Error(
      `earliest message load failed: ${earliestMessageResult.error.message}`,
    )
  }
  if (earliestTransactionResult.error) {
    throw new Error(
      `earliest transaction load failed: ${earliestTransactionResult.error.message}`,
    )
  }
  if (transactionsListResult.error) {
    throw new Error(
      `transactions list load failed: ${transactionsListResult.error.message}`,
    )
  }
  if (operatorsResult.error) {
    throw new Error(`operators load failed: ${operatorsResult.error.message}`)
  }

  // Defensive parse — bad JSONB at this seam shouldn't fail the page; log and
  // render a placeholder so the operator can still browse the conversation.
  let persona: ReturnType<typeof BrandPersonaSchema.parse> | null = null
  let venueInfo: ReturnType<typeof VenueInfoSchema.parse> | null = null
  if (venueConfigResult.data) {
    const p = BrandPersonaSchema.safeParse(venueConfigResult.data.brand_persona)
    if (p.success) persona = p.data
    else
      logger.warn('[conversations] brand_persona parse failed', {
        error: p.error.message,
      })
    const vi = VenueInfoSchema.safeParse(venueConfigResult.data.venue_info)
    if (vi.success) {
      venueInfo = {
        ...vi.data,
        currentContext: filterActiveContext(vi.data.currentContext, new Date()),
      }
    } else {
      logger.warn('[conversations] venue_info parse failed', {
        error: vi.error.message,
      })
    }
  }

  // Visit count: distinct calendar days in venue tz. Spend total: sum of
  // amount_cents across the 90-day window. Avg per visit derives in JS and
  // is left null when visit count is 0 (UI omits the "avg" clause).
  //
  // TAC-323: a guest-reported transaction can carry a null amount_cents.
  // `visitCount90d` (the headline "N visits" figure) still counts every
  // visit-day regardless of whether we know the amount — a visit is a visit.
  // `pricedVisitCount90d` is the narrower denominator used ONLY for the
  // average: a visit-day with no known-amount transaction on it would
  // otherwise silently drag avgPerVisitCents down (spend treated as $0 for a
  // day whose true spend is simply unknown, not zero).
  const visitDates = new Set<string>()
  const pricedVisitDates = new Set<string>()
  let spendCents90d = 0
  for (const t of transactionsResult.data ?? []) {
    const dateKey = formatInTimeZone(
      new Date(t.occurred_at),
      venueRow.timezone,
      'yyyy-MM-dd',
    )
    visitDates.add(dateKey)
    if (t.amount_cents !== null) {
      pricedVisitDates.add(dateKey)
      spendCents90d += t.amount_cents
    }
  }
  const visitCount90d = visitDates.size
  const pricedVisitCount90d = pricedVisitDates.size
  const avgPerVisitCents =
    pricedVisitCount90d > 0
      ? Math.round(spendCents90d / pricedVisitCount90d)
      : null

  // "Since" = earliest signal we have on this guest at this venue, considering
  // both transactions and messages. A guest may have texted before transacting
  // (NFC tap → inbound message, no purchase yet) or vice versa.
  const earliestMessageAt = earliestMessageResult.data?.created_at
    ? new Date(earliestMessageResult.data.created_at)
    : null
  const earliestTransactionAt = earliestTransactionResult.data?.occurred_at
    ? new Date(earliestTransactionResult.data.occurred_at)
    : null
  const sinceAt: Date | null =
    earliestMessageAt && earliestTransactionAt
      ? earliestMessageAt < earliestTransactionAt
        ? earliestMessageAt
        : earliestTransactionAt
      : (earliestMessageAt ?? earliestTransactionAt)

  // TAC-316: group raw rows into responses once here — stats below are
  // response-grained; the client re-derives the same projection from the raw
  // rows it receives (single source: projectThread).
  const messageRows: ConversationMessageRow[] = messagesResult.data ?? []
  const responses = projectThread(messageRows)

  const todayLocalIso = formatInTimeZone(
    new Date(),
    venueRow.timezone,
    'yyyy-MM-dd',
  )

  // Build operator display-name map. email local-part (jaipal@x → jaipal) is
  // the cheapest stable display label since the operators table has no
  // separate name column. Falls back to full email if the address is
  // malformed (no '@'). Used by the review form's "reviewed by …" status row.
  const operatorMap: Record<string, string> = {}
  for (const op of operatorsResult.data ?? []) {
    const at = op.email.indexOf('@')
    operatorMap[op.id] = at > 0 ? op.email.slice(0, at) : op.email
  }
  // Response rate computed from the loaded conversation window (200-row cap,
  // newest-first as of TAC-316), grouped to RESPONSES so a split reply counts
  // once — consistent with count_outbound_responses on the recognition side.
  // Never-sent drafts, pending cards, and failed sends are excluded: a guest
  // can't reply to a message they never received.
  const responseStats = computeMessageStats(
    responses
      .filter(wasDispatched)
      .map((r) => ({ direction: r.direction, createdAt: r.createdAt })),
  )
  // Total messages is from the dedicated count query (all-time, not capped),
  // so the headline number on the guest card stays accurate even when the
  // conversation array is truncated.
  const totalMessageCount = messageCountResult.count ?? 0

  const transactions = (transactionsListResult.data ?? []).map((t) => ({
    id: t.id,
    occurredAt: new Date(t.occurred_at),
    amountCents: t.amount_cents,
    itemCount: t.item_count,
    rawData: t.raw_data,
    source: t.source,
    retractedAt: t.retracted_at === null ? null : new Date(t.retracted_at),
  }))

  return {
    venue: {
      id: venueRow.id,
      slug: venueRow.slug,
      name: venueRow.name,
      timezone: venueRow.timezone,
      messagingPhone: venueRow.messaging_phone_number ?? '',
      status: venueRow.status,
      isTest: venueRow.is_test,
    },
    persona,
    venueInfo,
    mechanics: (mechanicsResult.data ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      minState: m.min_state,
      redemptionPolicy: m.redemption_policy,
      redemptionWindowDays: m.redemption_window_days,
    })),
    guest: {
      id: guestRow.id,
      firstName: guestRow.first_name,
      lastName: guestRow.last_name,
      phoneNumber: guestRow.phone_number,
      instagramUsername: guestRow.instagram_username,
      distanceMiles: guestRow.distance_to_venue_miles,
      createdVia: guestRow.created_via,
    },
    state: (stateResult.data?.state ?? null) as GuestState | null,
    lastVisitAt: guestRow.last_visit_at
      ? new Date(guestRow.last_visit_at)
      : null,
    sinceAt,
    visitCountLast90Days: visitCount90d,
    spendCents90d,
    avgPerVisitCents,
    totalMessageCount,
    responseRatePct: responseStats.responseRatePct,
    responseWindowHours: responseStats.responseWindowHours,
    recentEvents: (eventsResult.data ?? []).map((e) => ({
      eventType: e.event_type,
      createdAt: new Date(e.created_at),
    })),
    messageRows,
    todayLocalIso,
    transactions,
    transactionsWindowDays: VISIT_LOOKBACK_DAYS,
    operatorMap,
  }
}

// ---------------------------------------------------------------------------

interface LoadRecentActivityArgs {
  supabase: ReturnType<typeof createAdminClient>
  venueScope: VenueScope
  venueId: string | null
}

async function loadRecentActivity({
  supabase,
  venueScope,
  venueId,
}: LoadRecentActivityArgs): Promise<RecentActivityRow[]> {
  // No DISTINCT ON in the supabase-js builder; pull the latest 200 messages
  // and dedupe in memory by (venue_id, guest_id). Cheap given the cap.
  let q = supabase
    .from('messages')
    .select(
      'venue_id, guest_id, created_at, venues(name), guests(first_name, last_name, phone_number, instagram_username)',
    )
    .neq('body', '')
    .order('created_at', { ascending: false })
    .limit(200)
  const venueIds = venueFilterIds(venueScope)
  if (venueId) {
    q = q.eq('venue_id', venueId)
  } else if (venueIds !== null) {
    // TAC-530: null means fleet-wide, so no filter. An EMPTY list is still
    // applied and matches nothing -- the two are no longer the same value.
    q = q.in('venue_id', venueIds)
  }
  const { data, error } = await q
  if (error) {
    logger.warn('[conversations] recent activity load failed', {
      error: error.message,
    })
    return []
  }

  const seen = new Set<string>()
  const rows: RecentActivityRow[] = []
  for (const m of data ?? []) {
    const key = `${m.venue_id}:${m.guest_id}`
    if (seen.has(key)) continue
    seen.add(key)
    // PostgREST relation embeds may return either an object or an array
    // depending on cardinality inference. Normalize.
    const venue = Array.isArray(m.venues) ? m.venues[0] : m.venues
    const guest = Array.isArray(m.guests) ? m.guests[0] : m.guests
    if (!venue || !guest) continue
    rows.push({
      venueId: m.venue_id,
      venueName: venue.name,
      guestId: m.guest_id,
      guestLabel: guestNameWithPhone({
        firstName: guest.first_name,
        lastName: guest.last_name,
        phoneNumber: guest.phone_number,
        instagramUsername: guest.instagram_username,
      }),
      lastActivityAt: new Date(m.created_at),
    })
    if (rows.length >= RECENT_ACTIVITY_LIMIT) break
  }
  return rows
}
