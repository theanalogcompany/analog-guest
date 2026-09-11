import { createAdminClient } from '@/lib/db/admin'
import { BrandPersonaSchema, type BrandPersona } from '@/lib/schemas/brand-persona'
import { VenueInfoSchema, type VenueInfo } from '@/lib/schemas/venue-info'

/**
 * TAC-347 Stage 1 (redesign). Single DB read for everything the generation
 * pipeline needs about a venue — every generator (topics, per-topic,
 * mechanics, unanswerable) reads from this one loaded context rather than
 * each re-querying the same tables.
 */

export interface KnowledgeCorpusRow {
  id: string
  content: string
  primaryTags: string[]
  isProcessed: boolean
}

export interface MechanicRow {
  id: string
  name: string
  type: string
  minState: string
  requiresOperatorApproval: boolean
  qualification: string | null
  description: string | null
  rewardDescription: string | null
  isActive: boolean
}

export interface VenueContext {
  venueId: string
  slug: string
  isTest: boolean
  status: string
  venueInfo: VenueInfo
  knowledgeRows: KnowledgeCorpusRow[]
  mechanics: MechanicRow[]
}

export async function loadVenueContext(slug: string): Promise<VenueContext> {
  const supabase = createAdminClient()

  const { data: venueRow, error: venueError } = await supabase
    .from('venues')
    .select('id, slug, is_test, status')
    .eq('slug', slug)
    .maybeSingle()
  if (venueError) throw new Error(`loadVenueContext: venue lookup failed: ${venueError.message}`)
  if (!venueRow) throw new Error(`loadVenueContext: no venue found for slug "${slug}"`)

  const [configResult, knowledgeResult, mechanicsResult] = await Promise.all([
    supabase.from('venue_configs').select('venue_info').eq('venue_id', venueRow.id).maybeSingle(),
    supabase
      .from('knowledge_corpus')
      .select('id, content, primary_tags, is_processed')
      .eq('venue_id', venueRow.id),
    supabase
      .from('mechanics')
      .select(
        'id, name, type, min_state, requires_operator_approval, qualification, description, reward_description, is_active',
      )
      .eq('venue_id', venueRow.id),
  ])

  if (configResult.error) {
    throw new Error(`loadVenueContext: venue_configs load failed: ${configResult.error.message}`)
  }
  if (!configResult.data) {
    throw new Error(`loadVenueContext: no venue_configs row for venue ${venueRow.id}`)
  }
  if (knowledgeResult.error) {
    throw new Error(`loadVenueContext: knowledge_corpus load failed: ${knowledgeResult.error.message}`)
  }
  if (mechanicsResult.error) {
    throw new Error(`loadVenueContext: mechanics load failed: ${mechanicsResult.error.message}`)
  }

  const venueInfo = VenueInfoSchema.parse(configResult.data.venue_info)

  const knowledgeRows: KnowledgeCorpusRow[] = (knowledgeResult.data ?? []).map((r) => ({
    id: r.id,
    content: r.content,
    primaryTags: r.primary_tags,
    isProcessed: r.is_processed,
  }))

  const mechanics: MechanicRow[] = (mechanicsResult.data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    minState: r.min_state,
    requiresOperatorApproval: r.requires_operator_approval,
    qualification: r.qualification,
    description: r.description,
    rewardDescription: r.reward_description,
    isActive: r.is_active,
  }))

  return {
    venueId: venueRow.id,
    slug: venueRow.slug,
    isTest: venueRow.is_test,
    status: venueRow.status,
    venueInfo,
    knowledgeRows,
    mechanics,
  }
}

/**
 * TAC-347 Stage 3. Separate from loadVenueContext because brand_persona is
 * needed only by the grader (deterministic voice checks + the LLM voice
 * verdict), not by generation — keeps the Stage 1 read shape unchanged for
 * its existing callers.
 */
export async function loadBrandPersona(venueId: string): Promise<BrandPersona> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('venue_configs')
    .select('brand_persona')
    .eq('venue_id', venueId)
    .maybeSingle()
  if (error) throw new Error(`loadBrandPersona: read failed: ${error.message}`)
  if (!data) throw new Error(`loadBrandPersona: no venue_configs row for venue ${venueId}`)
  return BrandPersonaSchema.parse(data.brand_persona)
}

/**
 * Recorded owner decision: "Venue guard. Preflight aborts unless the venue
 * has is_test = true and a status other than active, with no override
 * flag." Applied here too (generation-only, no approval-gate contact) as
 * defense-in-depth — cheap to enforce now, and it's the concrete mechanism
 * behind "Le Mil's is the first and only target."
 */
export function assertVenueGuard(ctx: VenueContext): void {
  if (!ctx.isTest) {
    throw new Error(
      `venue guard: refusing to generate against "${ctx.slug}" — is_test is false. No override flag exists.`,
    )
  }
  if (ctx.status === 'active') {
    throw new Error(
      `venue guard: refusing to generate against "${ctx.slug}" — status is "active". No override flag exists.`,
    )
  }
}
