import { redirect } from 'next/navigation'
import { formatInTimeZone } from 'date-fns-tz'
import { AuthError, verifyAnalogAdminAccess } from '@/lib/auth'
import { createAdminClient } from '@/lib/db/admin'
import { createServerClient } from '@/lib/db/server'
import { type ApiTraceWithFullDetails, fetchTrace } from '@/lib/observability'
import { type GuestState } from '@/lib/recognition'
import { BrandPersonaSchema, VenueInfoSchema, filterActiveContext } from '@/lib/schemas'
import { ConversationsClient, type InitialData } from './conversations-client'
import { EmptyState } from './_components/empty-state'
import { Filters } from './_components/filters'
import type { RecentActivityRow } from './_components/recent-activity'

// Server orchestrator. Fetches everything the client needs in one render path
// so initial paint is one network round trip. The client is responsible for
// follow-up: trace fetches on click, Realtime subscription, filter changes
// (which trigger this server fetch again via router.replace + RSC re-render).
//
// Auth: layout already gates the (authed) tree; we re-resolve the operator
// here only to scope `allowedVenueIds`.

export const dynamic = 'force-dynamic'

const MESSAGE_LIMIT = 200
const RECENT_ACTIVITY_LIMIT = 5
const RECENT_GUESTS_LIMIT = 50
const TRACE_PREFETCH_LIMIT = 5
const VISIT_LOOKBACK_DAYS = 90
const RECENT_EVENTS_LIMIT = 3
const MS_PER_DAY = 24 * 60 * 60 * 1000

interface PageProps {
  searchParams: Promise<{ venue?: string; guest?: string }>
}

export default async function ConversationsPage({ searchParams }: PageProps) {
  const params = await searchParams

  // Resolve operator + allowed venues
  const supabaseSession = await createServerClient()
  const {
    data: { session },
  } = await supabaseSession.auth.getSession()
  if (!session) redirect('/admin/sign-in')

  let allowedVenueIds: string[]
  try {
    const op = await verifyAnalogAdminAccess(session.user.id)
    allowedVenueIds = op.allowedVenueIds
  } catch (e) {
    if (e instanceof AuthError && e.status === 403) redirect('/admin')
    throw e
  }

  const supabase = createAdminClient()

  // Venues for dropdown — analog admins see every venue regardless of
  // operator_venues. The allowlist matters for non-admin operators (future).
  const { data: venuesRaw, error: venuesErr } = await supabase
    .from('venues')
    .select('id, slug, name, timezone, messaging_phone_number')
    .order('name', { ascending: true })
  if (venuesErr) throw new Error(`venues load failed: ${venuesErr.message}`)
  const venues = (venuesRaw ?? []).filter((v) => allowedVenueIds.length === 0 || allowedVenueIds.includes(v.id))

  // Validate filter ids against the allowlist — reject foreign IDs cleanly.
  const venueId = params.venue && venues.some((v) => v.id === params.venue) ? params.venue : null
  const guestId = params.guest ?? null

  // Pre-filter / venue-only path: render empty-state with recent activity.
  if (!venueId) {
    const recent = await loadRecentActivity({ supabase, allowedVenueIds, venueId: null })
    return (
      <FullShell>
        <Filters venues={venues} guests={[]} selectedVenueId={null} selectedGuestId={null} />
        <EmptyState variant="pre-filter" recentRows={recent} />
      </FullShell>
    )
  }

  // Always need the venue's guest list at this point for the dropdown.
  const { data: guestsRaw } = await supabase
    .from('guests')
    .select('id, first_name, last_name, phone_number, last_interaction_at')
    .eq('venue_id', venueId)
    .order('last_interaction_at', { ascending: false, nullsFirst: false })
    .limit(RECENT_GUESTS_LIMIT)
  const guests = (guestsRaw ?? []).map((g) => ({
    id: g.id,
    firstName: g.first_name,
    lastName: g.last_name,
    phoneNumber: g.phone_number,
  }))

  if (!guestId) {
    const recent = await loadRecentActivity({ supabase, allowedVenueIds, venueId })
    return (
      <FullShell>
        <Filters venues={venues} guests={guests} selectedVenueId={venueId} selectedGuestId={null} />
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

  if (!initialData) {
    return (
      <FullShell>
        <Filters venues={venues} guests={guests} selectedVenueId={venueId} selectedGuestId={guestId} />
        <div className="flex-1 flex items-center justify-center text-sm text-ink-soft">
          Guest not found at this venue.
        </div>
      </FullShell>
    )
  }

  return (
    <FullShell>
      <Filters venues={venues} guests={guests} selectedVenueId={venueId} selectedGuestId={guestId} />
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
  // Negative margin undoes admin-shell <main>'s px-8 py-10 so conversations
  // renders edge-to-edge within main's box. main's max-w-5xl cap stays — the
  // conversation column + trace panel comfortably fit within 64rem. Other
  // admin routes keep their padded layout because they apply this only here.
  return <div className="-mx-8 -my-10">{children}</div>
}

// ---------------------------------------------------------------------------

interface LoadConversationArgs {
  supabase: ReturnType<typeof createAdminClient>
  venueRow: { id: string; slug: string; name: string; timezone: string; messaging_phone_number: string | null }
  guestId: string
}

async function loadConversationData({
  supabase,
  venueRow,
  guestId,
}: LoadConversationArgs): Promise<InitialData | null> {
  const { data: guestRow, error: guestErr } = await supabase
    .from('guests')
    .select('id, first_name, last_name, phone_number, distance_to_venue_miles, created_via, last_visit_at')
    .eq('id', guestId)
    .eq('venue_id', venueRow.id)
    .maybeSingle()
  if (guestErr) throw new Error(`guest load failed: ${guestErr.message}`)
  if (!guestRow) return null

  const lookbackIso = new Date(Date.now() - VISIT_LOOKBACK_DAYS * MS_PER_DAY).toISOString()

  const [
    messagesResult,
    venueConfigResult,
    mechanicsResult,
    stateResult,
    transactionsResult,
    eventsResult,
  ] = await Promise.all([
    supabase
      .from('messages')
      .select(
        'id, body, direction, created_at, langfuse_trace_id, reply_to_message_id, voice_fidelity, category, status, provider_message_id',
      )
      .eq('venue_id', venueRow.id)
      .eq('guest_id', guestId)
      .neq('body', '')
      .order('created_at', { ascending: true })
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
      .select('occurred_at')
      .eq('guest_id', guestId)
      .eq('venue_id', venueRow.id)
      .gte('occurred_at', lookbackIso),
    supabase
      .from('engagement_events')
      .select('event_type, created_at')
      .eq('guest_id', guestId)
      .eq('venue_id', venueRow.id)
      .order('created_at', { ascending: false })
      .limit(RECENT_EVENTS_LIMIT),
  ])

  if (messagesResult.error) throw new Error(`messages load failed: ${messagesResult.error.message}`)
  if (venueConfigResult.error) throw new Error(`venue_configs load failed: ${venueConfigResult.error.message}`)
  if (mechanicsResult.error) throw new Error(`mechanics load failed: ${mechanicsResult.error.message}`)
  if (stateResult.error) throw new Error(`guest_states load failed: ${stateResult.error.message}`)
  if (transactionsResult.error) throw new Error(`transactions load failed: ${transactionsResult.error.message}`)
  if (eventsResult.error) throw new Error(`engagement_events load failed: ${eventsResult.error.message}`)

  // Defensive parse — bad JSONB at this seam shouldn't fail the page; log and
  // render a placeholder so the operator can still browse the conversation.
  let persona: ReturnType<typeof BrandPersonaSchema.parse> | null = null
  let venueInfo: ReturnType<typeof VenueInfoSchema.parse> | null = null
  if (venueConfigResult.data) {
    const p = BrandPersonaSchema.safeParse(venueConfigResult.data.brand_persona)
    if (p.success) persona = p.data
    else console.warn('[conversations] brand_persona parse failed', p.error.message)
    const vi = VenueInfoSchema.safeParse(venueConfigResult.data.venue_info)
    if (vi.success) {
      venueInfo = { ...vi.data, currentContext: filterActiveContext(vi.data.currentContext, new Date()) }
    } else {
      console.warn('[conversations] venue_info parse failed', vi.error.message)
    }
  }

  // Visit count: distinct calendar days in venue tz.
  const visitDates = new Set<string>()
  for (const t of transactionsResult.data ?? []) {
    visitDates.add(formatInTimeZone(new Date(t.occurred_at), venueRow.timezone, 'yyyy-MM-dd'))
  }

  // Pre-fetch last 5 outbound traces in parallel. allSettled so one Langfuse
  // hiccup doesn't 500 the whole page.
  const outboundWithTrace = (messagesResult.data ?? [])
    .filter((m) => m.direction === 'outbound' && m.langfuse_trace_id)
    .slice(-TRACE_PREFETCH_LIMIT)
  const traceFetches = await Promise.allSettled(
    outboundWithTrace.map(async (m) => {
      const trace = await fetchTrace(m.langfuse_trace_id as string)
      return { messageId: m.id, trace }
    }),
  )
  const traceMap: Record<string, ApiTraceWithFullDetails | null> = {}
  for (const f of traceFetches) {
    if (f.status === 'fulfilled') traceMap[f.value.messageId] = f.value.trace
  }

  const todayLocalIso = formatInTimeZone(new Date(), venueRow.timezone, 'yyyy-MM-dd')

  return {
    venue: {
      id: venueRow.id,
      slug: venueRow.slug,
      name: venueRow.name,
      timezone: venueRow.timezone,
      messagingPhone: venueRow.messaging_phone_number ?? '',
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
      distanceMiles: guestRow.distance_to_venue_miles,
      createdVia: guestRow.created_via,
    },
    state: (stateResult.data?.state ?? null) as GuestState | null,
    lastVisitAt: guestRow.last_visit_at ? new Date(guestRow.last_visit_at) : null,
    visitCountLast90Days: visitDates.size,
    recentEvents: (eventsResult.data ?? []).map((e) => ({
      eventType: e.event_type,
      createdAt: new Date(e.created_at),
    })),
    messages: (messagesResult.data ?? []).map((m) => ({
      id: m.id,
      body: m.body,
      direction: m.direction === 'outbound' ? 'outbound' : 'inbound',
      createdAt: new Date(m.created_at),
      langfuseTraceId: m.langfuse_trace_id,
      replyToMessageId: m.reply_to_message_id,
      providerMessageId: m.provider_message_id,
    })),
    traceMap,
    todayLocalIso,
  }
}

// ---------------------------------------------------------------------------

interface LoadRecentActivityArgs {
  supabase: ReturnType<typeof createAdminClient>
  allowedVenueIds: string[]
  venueId: string | null
}

async function loadRecentActivity({
  supabase,
  allowedVenueIds,
  venueId,
}: LoadRecentActivityArgs): Promise<RecentActivityRow[]> {
  // No DISTINCT ON in the supabase-js builder; pull the latest 200 messages
  // and dedupe in memory by (venue_id, guest_id). Cheap given the cap.
  let q = supabase
    .from('messages')
    .select('venue_id, guest_id, created_at, venues(name), guests(first_name, last_name, phone_number)')
    .neq('body', '')
    .order('created_at', { ascending: false })
    .limit(200)
  if (venueId) {
    q = q.eq('venue_id', venueId)
  } else if (allowedVenueIds.length > 0) {
    q = q.in('venue_id', allowedVenueIds)
  }
  const { data, error } = await q
  if (error) {
    console.warn('[conversations] recent activity load failed', error.message)
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
    const name = [guest.first_name, guest.last_name].filter(Boolean).join(' ').trim()
    rows.push({
      venueId: m.venue_id,
      venueName: venue.name,
      guestId: m.guest_id,
      guestLabel: name ? `${name} · ${guest.phone_number}` : guest.phone_number,
      lastActivityAt: new Date(m.created_at),
    })
    if (rows.length >= RECENT_ACTIVITY_LIMIT) break
  }
  return rows
}
