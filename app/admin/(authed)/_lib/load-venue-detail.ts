import { createAdminClient } from '@/lib/db/admin'
import { firstOrNull } from '@/lib/db/postgrest'
import { type BrandPersona, BrandPersonaSchema, type VenueInfo, VenueInfoSchema } from '@/lib/schemas'

// TAC-343: per-venue detail loader for /admin/venues/[slug]. Mirrors the
// degrade-gracefully-with-a-visible-parse-error posture of
// voices/[slug]/_lib/load-voice-page.ts (venue-not-found → null; a
// malformed jsonb column → a fallback value plus a parse-error string the
// page renders as a banner, rather than a 500).
//
// Two things this loader deliberately does NOT do, per the plan review:
//   - It does not reuse build-runtime-context.ts's mechanics SELECT. That
//     list is narrowed to what the agent reads at runtime and omits
//     `trigger`, `expiration_rule`, and `redemption` — exactly the columns
//     this admin surface needs to render/decide on. Copying it would
//     silently reintroduce the same runtime/investigation-visibility gap
//     this ticket exists to close.
//   - It selects every mechanics column and does not pre-filter which ones
//     "matter" — the page's own unclaimed-fields computation (not this
//     loader) decides what's accounted for, per "render from the data."

export interface VenueDetailVenue {
  id: string
  slug: string
  name: string
  timezone: string
}

export interface VenueDetailMechanicRow {
  id: string
  name: string
  type: string
  isActive: boolean
  deactivatedAt: string | null
  createdAt: string
  updatedAt: string
  schemaVersion: number
  description: string | null
  qualification: string | null
  rewardDescription: string | null
  minState: string
  redemptionPolicy: string
  redemptionWindowDays: number | null
  requiresOperatorApproval: boolean
  trigger: unknown
  expirationRule: string | null
  redemption: unknown
  metadata: unknown
}

export interface VenueDetailKnowledgeRow {
  id: string
  content: string
  primaryTags: string[]
  secondaryTags: string[]
  isProcessed: boolean
  sourceType: string
  sourceRef: string | null
  createdAt: string
  updatedAt: string
  confidenceScore: number
  addedByOperatorId: string | null
  metadata: unknown
}

export interface VenueDetailData {
  venue: VenueDetailVenue
  venueInfo: VenueInfo
  venueInfoParseError: string | null
  brandPersona: BrandPersona | null
  brandPersonaParseError: string | null
  /** Passed through unparsed — computeReadiness owns parseApprovalPolicy. */
  rawApprovalPolicy: unknown
  mechanics: VenueDetailMechanicRow[]
  knowledgeEntries: VenueDetailKnowledgeRow[]
  voiceCorpusCount: number
}

const FALLBACK_VENUE_INFO: VenueInfo = {
  address: { line1: '', city: '', region: '', postalCode: '' },
  contact: {},
  hours: {},
  menu: { highlights: [], items: [] },
  staff: [],
  currentContext: [],
}

// Inlined literal select strings, not built via `.join()` — supabase-js's
// query builder infers row types from the select argument's literal string
// type. A `.join(', ')`-computed string widens to plain `string`, which
// collapses the inferred row type to `GenericStringError` (confirmed via
// tsc, not assumed).
const MECHANICS_SELECT =
  'id, name, type, is_active, deactivated_at, created_at, updated_at, schema_version, description, qualification, reward_description, min_state, redemption_policy, redemption_window_days, requires_operator_approval, trigger, expiration_rule, redemption, metadata' as const

const KNOWLEDGE_SELECT =
  'id, content, primary_tags, secondary_tags, is_processed, source_type, source_ref, created_at, updated_at, confidence_score, added_by_operator_id, metadata' as const

export async function loadVenueDetail(slug: string): Promise<VenueDetailData | null> {
  const supabase = createAdminClient()

  const { data: venue, error: venueErr } = await supabase
    .from('venues')
    .select('id, slug, name, timezone, venue_configs(venue_info, brand_persona, approval_policy)')
    .eq('slug', slug)
    .maybeSingle()
  if (venueErr || !venue) {
    return null
  }

  const config = firstOrNull(venue.venue_configs)

  let venueInfo: VenueInfo = FALLBACK_VENUE_INFO
  let venueInfoParseError: string | null = null
  if (config) {
    const parsed = VenueInfoSchema.safeParse(config.venue_info)
    if (parsed.success) {
      venueInfo = parsed.data
    } else {
      venueInfoParseError = parsed.error.message
    }
  } else {
    venueInfoParseError = 'venue has no venue_configs row'
  }

  let brandPersona: BrandPersona | null = null
  let brandPersonaParseError: string | null = null
  if (config) {
    const parsed = BrandPersonaSchema.safeParse(config.brand_persona)
    if (parsed.success) {
      brandPersona = parsed.data
    } else {
      brandPersonaParseError = parsed.error.message
    }
  } else {
    brandPersonaParseError = 'venue has no venue_configs row'
  }

  const [mechanicsResult, knowledgeResult, voiceCorpusCountResult] = await Promise.all([
    supabase.from('mechanics').select(MECHANICS_SELECT).eq('venue_id', venue.id),
    supabase.from('knowledge_corpus').select(KNOWLEDGE_SELECT).eq('venue_id', venue.id),
    supabase
      .from('voice_corpus')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venue.id),
  ])

  if (mechanicsResult.error) {
    console.warn('[loadVenueDetail] mechanics load failed', mechanicsResult.error.message)
  }
  if (knowledgeResult.error) {
    console.warn('[loadVenueDetail] knowledge_corpus load failed', knowledgeResult.error.message)
  }
  if (voiceCorpusCountResult.error) {
    console.warn(
      '[loadVenueDetail] voice_corpus count failed',
      voiceCorpusCountResult.error.message,
    )
  }

  const mechanics: VenueDetailMechanicRow[] = (mechanicsResult.data ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    type: m.type,
    isActive: m.is_active,
    deactivatedAt: m.deactivated_at,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    schemaVersion: m.schema_version,
    description: m.description,
    qualification: m.qualification,
    rewardDescription: m.reward_description,
    minState: m.min_state,
    redemptionPolicy: m.redemption_policy,
    redemptionWindowDays: m.redemption_window_days,
    requiresOperatorApproval: m.requires_operator_approval,
    trigger: m.trigger,
    expirationRule: m.expiration_rule,
    redemption: m.redemption,
    metadata: m.metadata,
  }))

  const knowledgeEntries: VenueDetailKnowledgeRow[] = (knowledgeResult.data ?? []).map((k) => ({
    id: k.id,
    content: k.content,
    primaryTags: k.primary_tags ?? [],
    secondaryTags: k.secondary_tags ?? [],
    isProcessed: k.is_processed,
    sourceType: k.source_type,
    sourceRef: k.source_ref,
    createdAt: k.created_at,
    updatedAt: k.updated_at,
    confidenceScore: k.confidence_score,
    addedByOperatorId: k.added_by_operator_id,
    metadata: k.metadata,
  }))

  return {
    venue: { id: venue.id, slug: venue.slug, name: venue.name, timezone: venue.timezone },
    venueInfo,
    venueInfoParseError,
    brandPersona,
    brandPersonaParseError,
    rawApprovalPolicy: config?.approval_policy ?? null,
    mechanics,
    knowledgeEntries,
    voiceCorpusCount: voiceCorpusCountResult.count ?? 0,
  }
}
