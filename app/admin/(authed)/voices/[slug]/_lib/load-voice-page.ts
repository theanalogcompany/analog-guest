import { createAdminClient } from '@/lib/db/admin'
import { type BrandPersona, BrandPersonaSchema } from '@/lib/schemas'

// THE-237: per-voice page server-side data fetch. One Promise.all to load
// everything the page needs:
//   - venue (id, slug, name, timezone)
//   - persona (BrandPersona — voiceName etc; antipatterns are read here)
//   - corpus entries (full text, source_type, tags, created_at,
//     added_by_operator_id, source_ref → for rendering reply-paired vs
//     standalone display)
//   - threads list (last 50 guests by latest message activity)
//   - thread bubbles (last 200 messages for the selected guest, if any)
//   - "Last refined" timestamp (max of latest corpus.created_at + latest
//     antipattern.addedAt)
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

export async function loadVoicePage(input: {
  slug: string
  selectedGuestId: string | null
}): Promise<VoicePageData | null> {
  const supabase = createAdminClient()

  // ---- venue + venue_configs ----
  const { data: venue, error: venueErr } = await supabase
    .from('venues')
    .select('id, slug, name, timezone, venue_configs(brand_persona)')
    .eq('slug', input.slug)
    .maybeSingle()
  if (venueErr || !venue) {
    return null
  }

  const configRaw = venue.venue_configs
  const config = Array.isArray(configRaw) ? configRaw[0] ?? null : configRaw
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

  // ---- corpus + threads (parallel) ----
  const lookbackIso = new Date(
    Date.now() - VISIT_LOOKBACK_DAYS * MS_PER_DAY,
  ).toISOString()

  const [corpusResult, recentMessagesResult, transactionsResult] =
    await Promise.all([
      supabase
        .from('voice_corpus')
        .select('id, content, source_type, tags, created_at, source_ref, added_by_operator_id')
        .eq('venue_id', venue.id)
        .order('created_at', { ascending: false }),
      // Last 200 message rows in this venue, regardless of guest. We bucket
      // by guest in JS to derive the threads list — keeps to one query.
      supabase
        .from('messages')
        .select('id, guest_id, body, direction, created_at, reply_to_message_id, guests(first_name, last_name, phone_number)')
        .eq('venue_id', venue.id)
        .neq('body', '')
        .order('created_at', { ascending: false })
        .limit(500),
      // Visit counts per guest in the lookback window. Cheap to compute
      // distinct calendar days in venue tz client-side over the rows.
      supabase
        .from('transactions')
        .select('guest_id, occurred_at')
        .eq('venue_id', venue.id)
        .gte('occurred_at', lookbackIso),
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

  // Latest guest_states per guest in this venue.
  const guestIdSet = new Set<string>()
  for (const m of recentMessagesResult.data ?? []) guestIdSet.add(m.guest_id)
  const guestIds = [...guestIdSet]

  const guestStateMap = new Map<string, VoicePageThread['state']>()
  if (guestIds.length > 0) {
    const { data: stateRows } = await supabase
      .from('guest_states')
      .select('guest_id, state')
      .eq('venue_id', venue.id)
      .is('exited_at', null)
      .in('guest_id', guestIds)
    for (const s of stateRows ?? []) {
      guestStateMap.set(s.guest_id, s.state as VoicePageThread['state'])
    }
  }

  // Bucket messages by guest_id, take the most recent per guest, dedupe to
  // THREAD_LIMIT.
  const seen = new Set<string>()
  const threads: VoicePageThread[] = []
  for (const m of recentMessagesResult.data ?? []) {
    if (seen.has(m.guest_id)) continue
    seen.add(m.guest_id)
    const guest = Array.isArray(m.guests) ? m.guests[0] : m.guests
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

  // Selected guest details + thread bubbles.
  let selectedGuest: VoicePageData['selectedGuest'] = null
  let selectedMessages: VoicePageMessage[] = []
  if (input.selectedGuestId) {
    const [guestResult, messagesResult] = await Promise.all([
      supabase
        .from('guests')
        .select('id, first_name, last_name, phone_number')
        .eq('id', input.selectedGuestId)
        .eq('venue_id', venue.id)
        .maybeSingle(),
      supabase
        .from('messages')
        .select('id, body, direction, created_at, reply_to_message_id')
        .eq('venue_id', venue.id)
        .eq('guest_id', input.selectedGuestId)
        .neq('body', '')
        .order('created_at', { ascending: true })
        .limit(MESSAGE_LIMIT),
    ])
    if (guestResult.data) {
      selectedGuest = {
        id: guestResult.data.id,
        firstName: guestResult.data.first_name,
        lastName: guestResult.data.last_name,
        phoneNumber: guestResult.data.phone_number,
      }
    }
    selectedMessages = (messagesResult.data ?? []).map((m) => ({
      id: m.id,
      body: m.body,
      direction: (m.direction === 'outbound' ? 'outbound' : 'inbound') as 'inbound' | 'outbound',
      createdAt: new Date(m.created_at),
      replyToMessageId: m.reply_to_message_id,
    }))
  }

  // Last refined: max(latest corpus.created_at, latest antipattern.addedAt).
  const corpusLatest = corpus[0]?.createdAt ?? null
  const antipatternLatest = persona.voiceAntiPatterns
    .map((p) => (p.addedAt ? new Date(p.addedAt) : null))
    .filter((d): d is Date => d !== null && !Number.isNaN(d.getTime()))
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null
  const lastRefinedAt =
    corpusLatest && antipatternLatest
      ? corpusLatest > antipatternLatest
        ? corpusLatest
        : antipatternLatest
      : corpusLatest ?? antipatternLatest

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
