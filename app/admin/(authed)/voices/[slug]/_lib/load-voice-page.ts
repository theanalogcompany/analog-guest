import { createAdminClient } from '@/lib/db/admin'
import { firstOrNull } from '@/lib/db/postgrest'
import { type BrandPersona, BrandPersonaSchema } from '@/lib/schemas'

// Per-voice page server-side data fetch. The venue lookup runs first
// (slug → venue id, no parallel candidate); everything else fans out
// from there in a single Promise.all so guest_states + the selected
// guest's bubble thread don't add serial round-trips.
//
// Defensive parse on persona — log + use a minimal fallback. The page
// renders a banner when persona parse fails so the operator sees something
// is wrong without the page 500-ing.

export interface VoicePageVenue {
  id: string
  slug: string
  name: string
  timezone: string
}

export interface VoicePageCorpusRow {
  id: string
  content: string
  sourceType: string
  tags: string[]
  createdAt: Date
  sourceRef: string | null
  addedByOperatorId: string | null
}

export interface VoicePageThread {
  guestId: string
  firstName: string | null
  lastName: string | null
  phoneNumber: string
  lastMessagePreview: string
  lastMessageAt: Date
  state: 'new' | 'returning' | 'regular' | 'raving_fan' | null
  visitCount90d: number
}

export interface VoicePageMessage {
  id: string
  body: string
  direction: 'inbound' | 'outbound'
  createdAt: Date
  replyToMessageId: string | null
}

export interface VoicePageData {
  venue: VoicePageVenue
  persona: BrandPersona
  personaParseError: string | null
  corpus: VoicePageCorpusRow[]
  threads: VoicePageThread[]
  selectedGuest: {
    id: string
    firstName: string | null
    lastName: string | null
    phoneNumber: string
  } | null
  selectedMessages: VoicePageMessage[]
  lastRefinedAt: Date | null
}

const THREAD_LIMIT = 50
const MESSAGE_LIMIT = 200
const THREAD_PROBE_LIMIT = 500
const VISIT_LOOKBACK_DAYS = 90
const MS_PER_DAY = 24 * 60 * 60 * 1000

const FALLBACK_PERSONA: BrandPersona = {
  tone: '',
  formality: 'casual',
  speakerFraming: 'venue',
  signaturePhrases: [],
  bannedTopics: [],
  emojiPolicy: 'never',
  lengthGuide: '',
  voiceAntiPatterns: [],
  voiceTouchstones: [],
}

function maxDate(...dates: Array<Date | null | undefined>): Date | null {
  let best: Date | null = null
  for (const d of dates) {
    if (!d) continue
    if (!best || d > best) best = d
  }
  return best
}

export async function loadVoicePage(input: {
  slug: string
  selectedGuestId: string | null
}): Promise<VoicePageData | null> {
  const supabase = createAdminClient()

  // Venue lookup runs first — every downstream query needs venue.id.
  const { data: venue, error: venueErr } = await supabase
    .from('venues')
    .select('id, slug, name, timezone, venue_configs(brand_persona)')
    .eq('slug', input.slug)
    .maybeSingle()
  if (venueErr || !venue) {
    return null
  }

  const config = firstOrNull(venue.venue_configs)
  let persona: BrandPersona = FALLBACK_PERSONA
  let personaParseError: string | null = null
  if (config) {
    const parsed = BrandPersonaSchema.safeParse(config.brand_persona)
    if (parsed.success) {
      persona = parsed.data
    } else {
      personaParseError = parsed.error.message
    }
  } else {
    personaParseError = 'venue has no venue_configs row'
  }

  const lookbackIso = new Date(
    Date.now() - VISIT_LOOKBACK_DAYS * MS_PER_DAY,
  ).toISOString()
  const selectedGuestId = input.selectedGuestId

  // Single fan-out. guest_states is filtered by venue + null-exited only;
  // the threads-list bucketing then cherry-picks the rows it needs by
  // guest id. Optional selected guest queries piggyback so they don't add
  // a serial round-trip.
  const [
    corpusResult,
    recentMessagesResult,
    transactionsResult,
    guestStatesResult,
    selectedGuestResult,
    selectedMessagesResult,
  ] = await Promise.all([
    supabase
      .from('voice_corpus')
      .select('id, content, source_type, tags, created_at, source_ref, added_by_operator_id')
      .eq('venue_id', venue.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('messages')
      .select('id, guest_id, body, direction, created_at, reply_to_message_id, guests(first_name, last_name, phone_number)')
      .eq('venue_id', venue.id)
      .neq('body', '')
      .order('created_at', { ascending: false })
      .limit(THREAD_PROBE_LIMIT),
    supabase
      .from('transactions')
      .select('guest_id, occurred_at')
      .eq('venue_id', venue.id)
      .gte('occurred_at', lookbackIso),
    supabase
      .from('guest_states')
      .select('guest_id, state')
      .eq('venue_id', venue.id)
      .is('exited_at', null),
    selectedGuestId
      ? supabase
          .from('guests')
          .select('id, first_name, last_name, phone_number')
          .eq('id', selectedGuestId)
          .eq('venue_id', venue.id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    selectedGuestId
      ? supabase
          .from('messages')
          .select('id, body, direction, created_at, reply_to_message_id')
          .eq('venue_id', venue.id)
          .eq('guest_id', selectedGuestId)
          .neq('body', '')
          .order('created_at', { ascending: true })
          .limit(MESSAGE_LIMIT)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (corpusResult.error) {
    console.warn('[loadVoicePage] corpus load failed', corpusResult.error.message)
  }
  if (recentMessagesResult.error) {
    console.warn('[loadVoicePage] messages load failed', recentMessagesResult.error.message)
  }
  if (transactionsResult.error) {
    console.warn(
      '[loadVoicePage] transactions load failed',
      transactionsResult.error.message,
    )
  }
  if (guestStatesResult.error) {
    console.warn(
      '[loadVoicePage] guest_states load failed',
      guestStatesResult.error.message,
    )
  }

  const corpus: VoicePageCorpusRow[] = (corpusResult.data ?? []).map((r) => ({
    id: r.id,
    content: r.content,
    sourceType: r.source_type,
    tags: r.tags ?? [],
    createdAt: new Date(r.created_at),
    sourceRef: r.source_ref ?? null,
    addedByOperatorId: r.added_by_operator_id ?? null,
  }))

  // Visit counts by guest (90-day window). transactions.guest_id is
  // nullable in the schema (legacy import rows); skip those — they don't
  // attribute to a guest's visit count anyway.
  const visitCount = new Map<string, Set<string>>()
  for (const t of transactionsResult.data ?? []) {
    if (!t.guest_id) continue
    const day = (t.occurred_at as string).slice(0, 10)
    const set = visitCount.get(t.guest_id) ?? new Set<string>()
    set.add(day)
    visitCount.set(t.guest_id, set)
  }

  const guestStateMap = new Map<string, VoicePageThread['state']>()
  for (const s of guestStatesResult.data ?? []) {
    guestStateMap.set(s.guest_id, s.state as VoicePageThread['state'])
  }

  const seen = new Set<string>()
  const threads: VoicePageThread[] = []
  for (const m of recentMessagesResult.data ?? []) {
    if (seen.has(m.guest_id)) continue
    seen.add(m.guest_id)
    const guest = firstOrNull(m.guests)
    if (!guest) continue
    threads.push({
      guestId: m.guest_id,
      firstName: guest.first_name,
      lastName: guest.last_name,
      phoneNumber: guest.phone_number,
      lastMessagePreview: m.body,
      lastMessageAt: new Date(m.created_at),
      state: guestStateMap.get(m.guest_id) ?? null,
      visitCount90d: visitCount.get(m.guest_id)?.size ?? 0,
    })
    if (threads.length >= THREAD_LIMIT) break
  }

  const selectedGuestRow = selectedGuestResult.data
  const selectedGuest: VoicePageData['selectedGuest'] = selectedGuestRow
    ? {
        id: selectedGuestRow.id,
        firstName: selectedGuestRow.first_name,
        lastName: selectedGuestRow.last_name,
        phoneNumber: selectedGuestRow.phone_number,
      }
    : null

  const selectedMessages: VoicePageMessage[] = (
    selectedMessagesResult.data ?? []
  ).map((m) => ({
    id: m.id,
    body: m.body,
    direction: (m.direction === 'outbound' ? 'outbound' : 'inbound') as 'inbound' | 'outbound',
    createdAt: new Date(m.created_at),
    replyToMessageId: m.reply_to_message_id,
  }))

  // Last refined: max of (latest corpus.created_at, latest antipattern.addedAt).
  const antipatternLatest = persona.voiceAntiPatterns
    .map((p) => (p.addedAt ? new Date(p.addedAt) : null))
    .filter((d): d is Date => d !== null && !Number.isNaN(d.getTime()))
    .reduce<Date | null>((best, d) => (best && best > d ? best : d), null)
  const lastRefinedAt = maxDate(corpus[0]?.createdAt, antipatternLatest)

  return {
    venue: {
      id: venue.id,
      slug: venue.slug,
      name: venue.name,
      timezone: venue.timezone,
    },
    persona,
    personaParseError,
    corpus,
    threads,
    selectedGuest,
    selectedMessages,
    lastRefinedAt,
  }
}
