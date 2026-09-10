import { createAdminClient } from '@/lib/db/admin'
import type { Json } from '@/db/types'
import { ingestCorpusEntry, ingestKnowledgeCorpusEntry } from '@/lib/rag'
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
  // TAC-343 Phase 0b: seed-venue is first-write-only by default (see the
  // already-exists guard below). `force: true` is the explicit escape hatch —
  // narrowed on plan review to CONFIG stores only (venue_configs, mechanics,
  // voice_corpus + embeddings, knowledge_corpus + embeddings). It never
  // touches the `venues` row itself or any guest-relationship table (guests,
  // messages, transactions, engagement_events, guest_states), and it refuses
  // outright — even with force — if the venue has any guests or messages, so
  // it can never be used to erase real guest history. The only real use is
  // re-seeding a mock venue during development; a live venue is edited on the
  // venue config page (§0), never re-seeded. Nothing in this repo calls it
  // yet.
  force?: boolean
}

export interface SeedVenueResult {
  venueId: string
  insertedCorpusIds: string[]
  embeddedChunkCounts: number[]
  insertedKnowledgeCorpusIds: string[]
  knowledgeEmbeddedChunkCounts: number[]
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
  const { parsed, messagingPhoneNumber, menuItems, force = false } = options
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

  // TAC-343 Phase 0b: seed-venue is first-write-only. Under the "this page is
  // the ongoing source of truth" framing (once seeded, every edit happens on
  // the venue config surface, not via re-extraction), a silent re-seed would
  // destroy every edit made since — to ANY store this function writes, not
  // just menu.items. Hard-fail by default; `force` is the explicit escape
  // hatch, and it says plainly what it is about to overwrite before doing so.
  const { data: existing, error: checkError } = await supabase
    .from('venues')
    .select('id, slug')
    .eq('slug', parsed.slug)
    .maybeSingle()
  if (checkError) {
    throw new Error(`seed: failed to check for existing venue: ${checkError.message}`)
  }
  if (existing && !force) {
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
        `If you are certain you want to wipe and reseed this venue's config`,
        `───────────────────────────────────────────────────────────────────`,
        ``,
        `Re-run with --force. It will DELETE and rewrite CONFIG STORES ONLY:`,
        `  - venue_configs (brand persona, venue_info, thresholds)`,
        `  - mechanics`,
        `  - voice_corpus AND voice_embeddings (including all Phase 5`,
        `    review additions written by ingest-response-review)`,
        `  - knowledge_corpus AND knowledge_embeddings`,
        ``,
        `It never touches the venues row itself, or any guest-relationship`,
        `table — guests, messages, transactions, engagement_events,`,
        `guest_states. If this venue has any guests or messages, --force`,
        `refuses outright (see below): re-seeding a venue with real guest`,
        `history is not a thing we do. Once a venue has guests, config`,
        `changes happen on the venue config page, not by re-seeding.`,
      ].join('\n'),
    )
  }
  let venueId: string
  if (existing && force) {
    // TAC-343 (plan review): --force must never be able to erase guest
    // history, so it refuses outright — even with the flag — the moment any
    // guest or message row exists for this venue. The only legitimate use is
    // re-seeding a mock venue during development, which by construction has
    // neither yet.
    const [guestsCheck, messagesCheck] = await Promise.all([
      supabase.from('guests').select('id').eq('venue_id', existing.id).limit(1),
      supabase.from('messages').select('id').eq('venue_id', existing.id).limit(1),
    ])
    if (guestsCheck.error) {
      throw new Error(`seed: --force guest-history check failed: ${guestsCheck.error.message}`)
    }
    if (messagesCheck.error) {
      throw new Error(`seed: --force guest-history check failed: ${messagesCheck.error.message}`)
    }
    if ((guestsCheck.data ?? []).length > 0 || (messagesCheck.data ?? []).length > 0) {
      throw new Error(
        [
          `seed: --force refused for venue "${parsed.slug}" (id=${existing.id}).`,
          ``,
          `This venue has real guest history (a guests or messages row exists).`,
          `--force only rewrites config stores and will never touch guest data,`,
          `so re-seeding a venue with guest history is not something it can do`,
          `safely — the config it would write may no longer match what those`,
          `guests have actually experienced. Edit this venue's config directly`,
          `instead (Supabase Studio, or the venue config page once it ships).`,
        ].join('\n'),
      )
    }

    console.warn(
      [
        `[seed] --force: rewriting config stores for existing venue "${parsed.slug}" (id=${existing.id})`,
        `[seed] this deletes and re-inserts venue_configs, mechanics,`,
        `[seed] voice_corpus/voice_embeddings, and knowledge_corpus/`,
        `[seed] knowledge_embeddings. The venues row and all guest-relationship`,
        `[seed] tables (guests, messages, transactions, engagement_events,`,
        `[seed] guest_states) are left untouched.`,
      ].join('\n'),
    )
    for (const table of ['venue_configs', 'mechanics', 'voice_corpus', 'knowledge_corpus'] as const) {
      const { error: deleteError } = await supabase.from(table).delete().eq('venue_id', existing.id)
      if (deleteError) {
        throw new Error(`seed: --force delete of ${table} failed: ${deleteError.message}`)
      }
    }
    venueId = existing.id
  } else {
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
    venueId = venue.id
  }

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
      // TAC-212: pass through operator-approval flag. DB default (false) when
      // the spec omits it. Per-venue overrides land via the Supabase Studio
      // UPDATE template documented in CLAUDE.md Common gotchas.
      ...(m.requires_operator_approval !== undefined
        ? { requires_operator_approval: m.requires_operator_approval }
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

  // 6. knowledge_corpus rows + embeddings (mirrors the voice block above).
  // Empty knowledgeCorpus is fine — older 06-specs predate this section
  // (parser returns []), no rows get inserted.
  const insertedKnowledgeCorpusIds: string[] = []
  const knowledgeEmbeddedChunkCounts: number[] = []
  if (parsed.knowledgeCorpus.length > 0) {
    const knowledgeRows = parsed.knowledgeCorpus.map((c) => ({
      venue_id: venueId,
      source_type: c.source_type,
      content: c.content,
      // TAC-242: write the split tag arrays. The legacy `tags` column still
      // exists this cycle (drop scheduled in a follow-up migration) but new
      // rows leave it default-empty.
      primary_tags: c.primary_tags,
      secondary_tags: c.secondary_tags,
      confidence_score: c.confidence_score,
    }))
    const { data: knowledgeInserted, error: knowledgeError } = await supabase
      .from('knowledge_corpus')
      .insert(knowledgeRows)
      .select('id')
    if (knowledgeError) {
      throw new Error(`seed: knowledge_corpus insert failed: ${knowledgeError.message}`)
    }
    insertedKnowledgeCorpusIds.push(...(knowledgeInserted ?? []).map((r) => r.id))

    for (const id of insertedKnowledgeCorpusIds) {
      const result = await ingestKnowledgeCorpusEntry(id)
      if (!result.ok) {
        console.warn(
          `[seed] knowledge corpus ingest failed for id=${id}: ${result.error} (errorCode=${result.errorCode})`,
        )
        knowledgeEmbeddedChunkCounts.push(0)
      } else {
        knowledgeEmbeddedChunkCounts.push(result.data.embeddedChunkCount)
      }
    }
  }

  return {
    venueId,
    insertedCorpusIds,
    embeddedChunkCounts,
    insertedKnowledgeCorpusIds,
    knowledgeEmbeddedChunkCounts,
    mechanicsInsertedCount: parsed.mechanics.length,
  }
}