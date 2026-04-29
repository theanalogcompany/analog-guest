import { createAdminClient } from '@/lib/db/admin'
import type { Json } from '@/db/types'
import { ingestCorpusEntry } from '@/lib/rag'
import { DEFAULT_FORMULA, DEFAULT_STATE_THRESHOLDS } from '@/lib/recognition'
import type { MenuItem } from '@/lib/schemas'
import type { ParsedVenueSpec } from './parse-venue-spec'

// Serialize through JSON.stringify/parse to coerce Date instances (from Zod's
// z.coerce.date() in VenueContextNoteSchema) and Record<string, unknown>
// values into the strict `Json` shape Supabase's regenerated insert types
// expect. Round-tripping is lossy in principle (Date → ISO string) but that's
// exactly what jsonb storage does anyway.
function toJson<T>(value: T): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

const APPROVAL_POLICY_DEFAULT = { default: 'auto_send', perCategory: {} }
const MESSAGING_CADENCE_DEFAULT = {
  day_1: true,
  day_3: false,
  day_7: true,
  day_14: true,
}

export interface SeedVenueOptions {
  parsed: ParsedVenueSpec
  messagingPhoneNumber: string | null
  // Parsed menu items from the 04-{slug} CSV. Merged into
  // venue_info.menu.items before the venue_configs row is written; the spec
  // markdown's menu.notes and menu.highlights stay as-is.
  menuItems: MenuItem[]
}

export interface SeedVenueResult {
  venueId: string
  insertedCorpusIds: string[]
  embeddedChunkCounts: number[]
  mechanicsInsertedCount: number
}

/**
 * Seed a venue end-to-end: venues → venue_configs → mechanics → voice_corpus,
 * then ingest each corpus row via the RAG module to embed and write
 * voice_embeddings. Fails closed if a venue with the slug already exists
 * (rerun by deleting in Supabase Studio).
 *
 * Server-only. Uses the admin DB client.
 */
export async function seedVenue(options: SeedVenueOptions): Promise<SeedVenueResult> {
  const { parsed, messagingPhoneNumber, menuItems } = options
  const supabase = createAdminClient()

  // Merge CSV-sourced menu items into the parsed spec's venue_info before
  // writing. Items array is the source-of-truth for structured menu lookups;
  // the spec markdown only carries prose (notes) and highlights.
  const mergedVenueInfo = {
    ...parsed.venueInfo,
    menu: {
      ...parsed.venueInfo.menu,
      items: menuItems,
    },
  }

  // Idempotency: hard-fail if venue with this slug exists.
  const { data: existing, error: checkError } = await supabase
    .from('venues')
    .select('id, slug')
    .eq('slug', parsed.slug)
    .maybeSingle()
  if (checkError) {
    throw new Error(`seed: failed to check for existing venue: ${checkError.message}`)
  }
  if (existing) {
    throw new Error(
      [
        `seed: venue "${parsed.slug}" already exists (id=${existing.id}).`,
        ``,
        `═══════════════════════════════════════════════════════════════════`,
        `STOP. The seed script creates venues. It does not update them.`,
        `═══════════════════════════════════════════════════════════════════`,
        ``,
        `If you came here to change something on this venue, do not delete`,
        `and reseed. Use the right tool for the change you want to make:`,
        ``,
        `  • Voice corpus / response review additions:`,
        `      npm run ingest-response-review -- ${parsed.slug}`,
        `      (Phase 5 pipeline — surgical, idempotent.)`,
        ``,
        `  • Mechanics, menu, hours, brand persona, venue_info config:`,
        `      Supabase Studio → SQL editor.`,
        `      SQL templates are documented under "Common gotchas" in`,
        `      CLAUDE.md (in-place mechanic edits, redemption events,`,
        `      etc.). Run them directly against the live row.`,
        ``,
        `───────────────────────────────────────────────────────────────────`,
        `If you proceed anyway`,
        `───────────────────────────────────────────────────────────────────`,
        ``,
        `DELETE FROM venues WHERE slug = '<slug>' cascades through:`,
        `  - venue_configs (brand persona, venue_info, thresholds)`,
        `  - mechanics`,
        `  - voice_corpus AND voice_embeddings (including all Phase 5`,
        `    review additions written by ingest-response-review)`,
        `  - guests (real guest profiles tied to phone numbers)`,
        `  - messages (every conversation ever held with every guest)`,
        `  - transactions (visit history)`,
        `  - engagement_events (recognition signal trail, including`,
        `    mechanic_redeemed events)`,
        `  - guest_states (current relationship band per guest)`,
        ``,
        `This is irreversible without a database backup. Do NOT do this on`,
        `a live pilot venue. Only on test venues with is_test=true and no`,
        `real guest data.`,
        ``,
        `If you are sure this is a test venue and you want to proceed,`,
        `delete the rows manually in Supabase Studio first, then re-run.`,
      ].join('\n'),
    )
  }

  // 1. venues row
  const { data: venue, error: venueError } = await supabase
    .from('venues')
    .insert({
      name: parsed.name,
      slug: parsed.slug,
      status: 'pending',
      messaging_phone_number: messagingPhoneNumber,
      timezone: parsed.timezone,
      is_test: true,
    })
    .select('id')
    .single()
  if (venueError || !venue) {
    throw new Error(`seed: venues insert failed: ${venueError?.message ?? 'no row returned'}`)
  }
  const venueId = venue.id

  // 2. venue_configs row
  const { error: configError } = await supabase.from('venue_configs').insert({
    venue_id: venueId,
    brand_persona: toJson(parsed.brandPersona),
    venue_info: toJson(mergedVenueInfo),
    relationship_strength_formula: toJson(DEFAULT_FORMULA),
    state_thresholds: toJson(DEFAULT_STATE_THRESHOLDS),
    messaging_cadence: toJson(MESSAGING_CADENCE_DEFAULT),
    approval_policy: toJson(APPROVAL_POLICY_DEFAULT),
    onboarding_status: 'mechanics_configured',
  })
  if (configError) {
    throw new Error(`seed: venue_configs insert failed: ${configError.message}`)
  }

  // 3. mechanics rows
  if (parsed.mechanics.length > 0) {
    const mechanicRows = parsed.mechanics.map((m) => ({
      venue_id: venueId,
      type: m.type,
      name: m.name,
      description: m.description ?? null,
      qualification: m.qualification ?? null,
      reward_description: m.reward_description ?? null,
      expiration_rule: m.expiration_rule ?? null,
      trigger: toJson(m.trigger),
      redemption: m.redemption ? toJson(m.redemption) : null,
      metadata: toJson(m.metadata ?? {}),
      // THE-170: pass through eligibility + redemption-policy fields. Spec
      // defaults at the DB layer ('new' / 'one_time' / null) when omitted.
      ...(m.min_state !== undefined ? { min_state: m.min_state } : {}),
      ...(m.redemption_policy !== undefined ? { redemption_policy: m.redemption_policy } : {}),
      ...(m.redemption_window_days !== undefined
        ? { redemption_window_days: m.redemption_window_days }
        : {}),
    }))
    const { error: mechanicError } = await supabase.from('mechanics').insert(mechanicRows)
    if (mechanicError) {
      throw new Error(`seed: mechanics insert failed: ${mechanicError.message}`)
    }
  }

  // 4. voice_corpus rows
  const corpusRows = parsed.voiceCorpus.map((c) => ({
    venue_id: venueId,
    source_type: c.source_type,
    content: c.content,
    tags: c.tags,
    confidence_score: c.confidence_score,
  }))
  const { data: corpusInserted, error: corpusError } = await supabase
    .from('voice_corpus')
    .insert(corpusRows)
    .select('id')
  if (corpusError) {
    throw new Error(`seed: voice_corpus insert failed: ${corpusError.message}`)
  }
  const insertedCorpusIds = (corpusInserted ?? []).map((r) => r.id)

  // 5. Embed each corpus row via the RAG module.
  const embeddedChunkCounts: number[] = []
  for (const id of insertedCorpusIds) {
    const result = await ingestCorpusEntry(id)
    if (!result.ok) {
      console.warn(
        `[seed] corpus ingest failed for id=${id}: ${result.error} (errorCode=${result.errorCode})`,
      )
      embeddedChunkCounts.push(0)
    } else {
      embeddedChunkCounts.push(result.data.embeddedChunkCount)
    }
  }

  return {
    venueId,
    insertedCorpusIds,
    embeddedChunkCounts,
    mechanicsInsertedCount: parsed.mechanics.length,
  }
}