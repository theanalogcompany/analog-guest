/**
 * TAC-483. Measures how often the generator conflates two differently named,
 * differently dated guest-reported items into one claimed repeat/streak —
 * the failure caught in production at Le Mil's on 2026-09-18 ("i got the
 * blossom tonic" / "oh and i got the pink panther yesterday" -> "the Pink
 * Panther two days in a row").
 *
 * SHIPS NO FIX. Per the 2026-09-18 ruling on this ticket: this is
 * measurement tooling only, so a baseline can be captured under the CURRENT
 * prompt before any wording is proposed or approved. Do not read a run of
 * this script as evidence a fix works — there is no fix in this file, and
 * none is applied by it. When a prompt change eventually lands, re-running
 * this script against the new PROMPT_VERSION is what produces the "after"
 * number; this file needs no change to do that, since it always calls the
 * live generateMessage.
 *
 * Does NOT touch lib/ai/verify-grounding.ts. It calls verifyGrounding
 * unmodified, as a read-only oracle — the same real check that caught the
 * incident in production (review_reason='knowledge_gap_backstop').
 *
 * Needs a real ANTHROPIC_API_KEY. CI has none and makes no external service
 * calls (see CLAUDE.md's CI section) — this script cannot run there and this
 * PR does not claim to have run it. It is a manual step with real
 * credentials, gated the same way this ticket's own `QA: Device` label
 * gates real-conversation verification.
 *
 * Run: npm run measure-order-attribution -- [--n 20] [--variants 1,2,3,4]
 */
import { readFileSync } from 'node:fs'
import { extractRecentVisits } from '@/lib/agent/extract-recent-visits'
import { CORPUS_RETRIEVE_LIMIT, MIN_STRONG_MATCHES, STRONG_MATCH_SIMILARITY } from '@/lib/agent/stages'
import { generateMessage } from '@/lib/ai/generate-message'
import { formatTimeDelta } from '@/lib/ai/prompts/serializers'
import type { GenerateMessageInput, RecentMessage, Visit, VoiceCorpusChunk } from '@/lib/ai/types'
import { verifyGrounding } from '@/lib/ai/verify-grounding'
import { embedText } from '@/lib/rag/embed'
import { SIMILARITY_FLOOR } from '@/lib/rag/retrieve'
import { BrandPersonaSchema, VenueInfoSchema, type BrandPersona, type VenueInfo } from '@/lib/schemas'
import { filterActiveContext } from '@/lib/schemas/venue-info'
import type { MessageChannel } from '@/lib/schemas/message-channel'
import { scoreConflationClaims } from './measure-order-attribution-scoring'

const DEFAULT_N = 20

// TAC-483, 2026-09-21: the venue configuration every generation is measured
// against. Read-only export of production `venue_configs` (brand_persona,
// venue_info) and `voice_corpus` for le-mils-coffee. Gitignored under
// scripts/data and never committed — the repo is public.
//
// It replaced a placeholder persona ("warm, direct, a little playful"), a
// placeholder venue ("123 Coffee St, Testville") and one stand-in voice chunk
// reading 'sample voice corpus chunk'. The 2026-09-19 ruling blocked the
// measurement on exactly that — "a placebo persona cannot answer it" — because
// on the incident's own turn the menu is the material the claim is about.
// Both drinks the incident conflates are menu items in this file.
const EXPORT_PATH = 'scripts/data/lemils_venue_export.json'

// The channel copy every generation is measured under. 'text' (Sendblue), not
// 'instagram' and not null, because the incident this replays happened there:
// the held draft is channel 'text' and the guest has a phone number and no
// Instagram ID. It is also the only copy any Le Mil's guest gets today, since
// the agent does not run for Instagram guests until TAC-469 lifts its gate.
// Null would render the Instagram wording (TAC-495), which is a different
// prompt from the one being measured. Held fixed so a later "after" run
// compares against the same channel copy.
const CHANNEL: MessageChannel = 'text'

type VariantId = 1 | 2 | 3 | 4
const ALL_VARIANT_IDS: readonly VariantId[] = [1, 2, 3, 4]

type Variant = {
  id: VariantId
  label: string
  // Stated up front, per the ticket's own "state the bar before running"
  // discipline (TAC-401) — what a run of THIS variant is checking for, not
  // what the numbers turn out to say.
  whatThisChecks: string
  recentMessages: RecentMessage[]
  currentMessage: string
  // Populates the `## Visit history` block. Omitted on variants 1-3, which
  // measure the conversation text alone. Variant 4 is the one that carries
  // it, because the live prompt did — see VARIANT_4.
  recentVisits?: Visit[]
}

// The conversation-history deltas MUST be anchored to the real wall clock,
// not to the incident's calendar date. `composePrompt` renders the user
// prompt through the runtime serializer WITHOUT passing a `now`, so it
// defaults to `new Date()` and `formatTimeDelta` measures every `createdAt`
// against TODAY.
//
// (That serializer is deliberately named here without its call parentheses:
// `serializers.test.ts`'s TAC-495 scope guard greps raw file text for the
// call and counts a match as a second production caller, comments included.)
//
// Anchoring the fixture at a fixed 2026-09-18 instant — which is what
// this file did when it was written, on the day of the incident — renders the
// two prior turns as "[guest, 3 days ago]" once any time has passed.
//
// That is not cosmetic on THIS ticket. The defect under measurement is
// attributing items to days; a prompt claiming the Blossom Tonic turn was
// three days ago gives the model a materially different (and wrong) picture
// and could manufacture or mask the conflation. Same class as CLAUDE.md's
// "reconstructing a past agent turn re-dates it" gotcha (TAC-367).
//
// The absolute frame stays at the incident's Friday 2026-09-18 via the
// `today` block below, which is passed explicitly and does not read the
// clock. Relative deltas plus a stated absolute date is exactly what
// production rendered on the day.
const RUN_STARTED_AT = new Date()

function minutesAgo(minutes: number): Date {
  return new Date(RUN_STARTED_AT.getTime() - minutes * 60_000)
}

// Variant 1: the incident shape, replayed. Two DIFFERENT items, on two
// DIFFERENT named days, one message apart — the exact Le Mil's exchange from
// the ticket. A correct reply keeps the two separate; "two days in a row" or
// equivalent here is a defect.
const VARIANT_1: Variant = {
  id: 1,
  label: 'incident (two different items, two different named days)',
  whatThisChecks:
    'Does the reply claim a repeat/streak that never happened? This is the incident itself, replayed. The bar for a proposed fix is 0/N here; the baseline under the CURRENT prompt is unknown until this runs.',
  recentMessages: [
    { direction: 'inbound', body: 'i got the blossom tonic', createdAt: minutesAgo(2), delivery: 'delivered' },
    {
      direction: 'outbound',
      body: "one of my favorites, honestly. how'd you like it?",
      createdAt: minutesAgo(1),
      delivery: 'delivered',
    },
  ],
  currentMessage: 'oh and i got the pink panther yesterday',
}

// Variant 2: the control. Guest genuinely reports the SAME item on both
// days — a legitimate streak. The guest's own words license the claim (see
// verify-grounding.ts's "Lines marked [guest, ...] ... ARE legitimate
// grounding"), so a reply that notices the repeat here is CORRECT and must
// not read as the defect. A fix that suppresses this is a worse outcome than
// the bug — see the dual-direction guard note under "what this checks".
const VARIANT_2: Variant = {
  id: 2,
  label: 'control (same item, genuinely reported on both days)',
  whatThisChecks:
    'Guardrail against overcorrection: a flag here on a genuine repeat would mean a fix suppressed something true. The bar is UNCHANGED (0 new flags) before and after any prompt change — this variant should stay clean under both the current prompt and any proposed fix.',
  recentMessages: [
    { direction: 'inbound', body: 'i got the blossom tonic', createdAt: minutesAgo(2), delivery: 'delivered' },
    {
      direction: 'outbound',
      body: "one of my favorites, honestly. how'd you like it?",
      createdAt: minutesAgo(1),
      delivery: 'delivered',
    },
  ],
  currentMessage: 'i got the blossom tonic yesterday too',
}

// Variant 3: both items named in a single message, not across turns — checks
// whether the failure is specific to the two-turn shape of the incident or
// generalizes to one message stating both facts at once.
const VARIANT_3: Variant = {
  id: 3,
  label: 'single message (both items and both days named at once)',
  whatThisChecks:
    'Does the conflation survive when there is no cross-turn attribution step at all — both facts sit in one message? A different flag rate here than variant 1 would mean the failure is turn-boundary-specific, not a general attribution error.',
  recentMessages: [],
  currentMessage: 'i got the blossom tonic today and the pink panther yesterday',
}

// --- Variant 4: the incident WITH the structured order history it really had.
//
// Variants 1-3 drive `generateMessage` from the conversation text alone, and
// came back 0/20 on the real Le Mil's config. That left the obvious
// explanation untested: the live prompt for this turn carried a `## Visit
// history` block those variants have no equivalent of, so the model saw the
// SAME order fact twice, in two different registers — once as structured
// history, once as the guest's own words — and only the replay was missing
// the duplicate.
//
// Confirmed against production for the "pink panther yesterday" turn: the
// guest's visit history already held a `guest_reported` Blossom Tonic
// transaction for that day, created 15:40:23, `occurred_at`
// 2026-09-18T19:00Z, `occurred_at_precision` approximate. The Pink Panther
// transaction was written AFTER this turn's inbound, so it is deliberately
// NOT here — that is the fire-and-forget ordering the ticket's AC2 settled
// (`handle-inbound.ts` :451 buildRuntimeContext -> :676 waitUntil(
// extractReportedOrder) -> :711 retrieve -> :775 generate), and putting it in
// would measure a prompt that never existed.
//
// TWO reconstruction details, both load-bearing, both checked rather than
// assumed:
//
// 1. `occurred_at` 19:00Z is venue-local NOON — TAC-325's synthetic anchor
//    for an `approximate` report, not a real purchase time. The turn itself
//    was ~15:42Z (the row was created 15:40:23 and the ticket was filed
//    15:43:45), so the stored timestamp sits about 3h18m in the FUTURE of
//    the turn that rendered it. `formatTimeDelta` floors a negative
//    difference to under a minute, so the live block read `[just now]`.
//    That is reproduced here by preserving the same offset from the run
//    instant, and asserted below rather than trusted.
// 2. `extractRecentVisits` LOWERCASES item names, so the live block said
//    "blossom tonic", not "Blossom Tonic". Rather than hand-build a `Visit`
//    and get that wrong, the real transaction row shape goes through the
//    real extractor, which also applies the real 90-day cutoff and dedupe.
const INCIDENT_TURN_AT = new Date('2026-09-18T15:42:00.000Z')
const INCIDENT_BLOSSOM_TONIC_OCCURRED_AT = new Date('2026-09-18T19:00:00.000Z')
const BLOSSOM_TONIC_OFFSET_FROM_TURN_MS =
  INCIDENT_BLOSSOM_TONIC_OCCURRED_AT.getTime() - INCIDENT_TURN_AT.getTime()

const VARIANT_4_VISITS: Visit[] = extractRecentVisits(
  [
    {
      occurred_at: new Date(
        RUN_STARTED_AT.getTime() + BLOSSOM_TONIC_OFFSET_FROM_TURN_MS,
      ).toISOString(),
      raw_data: { line_items: [{ name: 'Blossom Tonic', quantity: 1 }] },
    },
  ],
  RUN_STARTED_AT,
)

// Self-check: the reconstruction is only worth running if it renders the
// delta production rendered. A future change to `formatTimeDelta`'s
// under-a-minute branch would otherwise silently move this variant to a
// different prompt and the run would still look valid.
//
// (Reusing `formatTimeDelta` here is deliberate and is NOT the reuse
// CLAUDE.md bans for admin surfaces under TAC-381. That ban exists so a
// display surface cannot be coupled to the agent's prompt vocabulary; this
// script's whole job is to assert on that vocabulary.)
const VARIANT_4_RENDERED_DELTA = formatTimeDelta(VARIANT_4_VISITS[0].visitedAt, RUN_STARTED_AT)
if (VARIANT_4_VISITS.length !== 1 || VARIANT_4_VISITS[0].items.join(',') !== 'blossom tonic') {
  throw new Error(
    `variant 4 visit reconstruction failed: expected one visit reading "blossom tonic", got ${JSON.stringify(VARIANT_4_VISITS)}`,
  )
}
if (VARIANT_4_RENDERED_DELTA !== 'just now') {
  throw new Error(
    `variant 4 would render "[${VARIANT_4_RENDERED_DELTA}] blossom tonic"; production rendered "[just now] blossom tonic". Refusing to measure a different prompt.`,
  )
}

const VARIANT_4: Variant = {
  id: 4,
  label: 'incident + the ## Visit history the live prompt actually had',
  whatThisChecks:
    'The same exchange as variant 1, plus the structured Blossom Tonic transaction the live prompt carried in ## Visit history. Variant 1 came back 0/20 without it, so this is the standing hypothesis for why the incident happened and variant 1 did not reproduce it: the same order fact present twice, as structured history and as the guest\'s own words. Same bar as variant 1 — 0/N fabrications. A rate above variant 1\'s here localises the defect to the duplicate; a rate equal to it rules the block out.',
  recentMessages: VARIANT_1.recentMessages,
  currentMessage: VARIANT_1.currentMessage,
  recentVisits: VARIANT_4_VISITS,
}

const VARIANTS: readonly Variant[] = [VARIANT_1, VARIANT_2, VARIANT_3, VARIANT_4]

type VenueExport = {
  venue_slug: string
  exported_at: string
  brand_persona: unknown
  venue_info: unknown
  voice_corpus: Array<{ id: string; source_type: string; content: string }>
}

type LoadedVenue = {
  slug: string
  exportedAt: string
  persona: BrandPersona
  venueInfo: VenueInfo
  corpus: VenueExport['voice_corpus']
}

/**
 * Parses the export through the SAME schemas production parses
 * `venue_configs` with, so a drifted export fails here rather than silently
 * degrading a block to its default. `filterActiveContext` mirrors
 * `build-runtime-context.ts:364`, which drops expired `currentContext`
 * entries before the venueInfo ever reaches `generateMessage`.
 */
function loadLeMils(): LoadedVenue {
  let raw: VenueExport
  try {
    raw = JSON.parse(readFileSync(EXPORT_PATH, 'utf8')) as VenueExport
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    throw new Error(
      `could not read ${EXPORT_PATH}: ${message}. This script measures against the real Le Mil's configuration; it will not fall back to a placeholder persona, because a number from a stand-in configuration is what the 2026-09-19 ruling forbids.`,
    )
  }

  const persona = BrandPersonaSchema.safeParse(raw.brand_persona)
  if (!persona.success) {
    throw new Error(`brand_persona failed BrandPersonaSchema: ${JSON.stringify(persona.error.issues)}`)
  }
  const venueInfo = VenueInfoSchema.safeParse(raw.venue_info)
  if (!venueInfo.success) {
    throw new Error(`venue_info failed VenueInfoSchema: ${JSON.stringify(venueInfo.error.issues)}`)
  }
  if (!Array.isArray(raw.voice_corpus) || raw.voice_corpus.length === 0) {
    throw new Error('voice_corpus is missing or empty in the export')
  }

  return {
    slug: raw.venue_slug,
    exportedAt: raw.exported_at,
    persona: persona.data,
    venueInfo: {
      ...venueInfo.data,
      currentContext: filterActiveContext(venueInfo.data.currentContext, RUN_STARTED_AT),
    },
    corpus: raw.voice_corpus,
  }
}

const LE_MILS = loadLeMils()

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

// Embeddings for the corpus are identical across variants and attempts, so
// they are embedded once and reused. Keyed by corpus row id.
const corpusEmbeddings = new Map<string, number[]>()

async function embedCorpusOnce(): Promise<void> {
  if (corpusEmbeddings.size > 0) return
  for (const entry of LE_MILS.corpus) {
    const r = await embedText(entry.content, 'document')
    if (!r.ok) throw new Error(`embedText failed for corpus row ${entry.id}: ${r.error}`)
    corpusEmbeddings.set(entry.id, r.data.embedding)
  }
}

/**
 * Local stand-in for `retrieveCorpusStage` -> `retrieveContext`, which needs
 * the `match_voice_corpus` pgvector RPC and therefore a database this script
 * deliberately does not touch. Mirrors it where it counts: the same Voyage
 * model via the repo's own `embedText`, the same 'query'/'document' input
 * types, cosine over the whole corpus, the same `SIMILARITY_FLOOR` (0.3), the
 * same `CORPUS_RETRIEVE_LIMIT` (8), and the same inbound-body-as-query.
 *
 * Divergence, stated rather than buried: production embeds `chunkText()`
 * output, which splits at 300 tokens. Every Le Mil's corpus row is one or two
 * sentences, far under that, so one chunk per row — the two agree on this
 * corpus and would not on a corpus with long entries.
 */
async function retrieveVoiceChunks(query: string): Promise<VoiceCorpusChunk[]> {
  await embedCorpusOnce()
  const q = await embedText(query, 'query')
  if (!q.ok) throw new Error(`embedText failed for query: ${q.error}`)

  const scored = LE_MILS.corpus.map((entry) => {
    const embedding = corpusEmbeddings.get(entry.id)
    if (!embedding) throw new Error(`missing embedding for corpus row ${entry.id}`)
    return { entry, similarity: cosineSimilarity(q.data.embedding, embedding) }
  })

  const survivors = scored
    .filter((s) => s.similarity >= SIMILARITY_FLOOR)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, CORPUS_RETRIEVE_LIMIT)

  // The inbound path fails CLOSED below MIN_STRONG_MATCHES — reproduce it, so
  // a thin retrieval surfaces as a loud stop rather than a quietly
  // voice-less prompt that still generates.
  const strongCount = survivors.filter((s) => s.similarity >= STRONG_MATCH_SIMILARITY).length
  if (strongCount < MIN_STRONG_MATCHES) {
    throw new Error(
      `insufficient_corpus_matches (got ${strongCount} above ${STRONG_MATCH_SIMILARITY}, need ${MIN_STRONG_MATCHES})`,
    )
  }

  // Same mapping stages.ts:730 applies: lib/rag's open `sourceType` string
  // cast to lib/ai's closed union, cosine `similarity` -> `relevanceScore`.
  return survivors.map((s) => ({
    id: s.entry.id,
    text: s.entry.content,
    sourceType: s.entry.source_type as VoiceCorpusChunk['sourceType'],
    relevanceScore: s.similarity,
  }))
}

function buildInput(variant: Variant, ragChunks: VoiceCorpusChunk[]): GenerateMessageInput {
  return {
    category: 'reply',
    persona: LE_MILS.persona,
    venueInfo: LE_MILS.venueInfo,
    ragChunks,
    // Stated divergence: the export carries no `knowledge_corpus`, so this is
    // [] — "retrieval ran and matched nothing", which renders TAC-242's
    // explicit "no specific venue knowledge matched this query... do not
    // invent specifics" framing. Production for this turn retrieved against a
    // real knowledge corpus. The framing biases AGAINST inventing specifics,
    // so a fabrication observed under it is the conservative direction: the
    // real prompt had strictly more grounding material, not less. The menu
    // itself — which is what this incident's claim is about — is in
    // `venueInfo` and IS present.
    knowledgeChunks: [],
    runtime: {
      inboundMessage: variant.currentMessage,
      recentMessages: variant.recentMessages,
      // Omitted on variants 1-3, so `## Visit history` does not render at
      // all for them (formatVisitHistory returns null on an empty list) —
      // which is what makes variant 4 a one-variable comparison.
      ...(variant.recentVisits ? { recentVisits: variant.recentVisits } : {}),
      today: {
        isoDate: '2026-09-18',
        dayOfWeek: 'Friday',
        venueLocalTime: '14:00',
        venueTimezone: 'America/Los_Angeles',
      },
    },
    channel: CHANNEL,
  }
}

type GenerationOutcome = {
  attempt: number
  generation: { ok: true; body: string; voiceFidelity: number } | { ok: false; error: string }
  // null only when generation itself failed, so verifyGrounding never ran.
  verify:
    | { ok: true; hasUngroundedClaim: boolean; ungroundedClaims: string[] }
    | { ok: false; error: string }
    | null
  conflationShaped: boolean
  matchedClaims: string[]
}

async function runOneAttempt(
  variant: Variant,
  attempt: number,
  ragChunks: VoiceCorpusChunk[],
): Promise<GenerationOutcome> {
  const input = buildInput(variant, ragChunks)
  const genResult = await generateMessage(input)
  if (!genResult.ok) {
    return {
      attempt,
      generation: { ok: false, error: genResult.error },
      verify: null,
      conflationShaped: false,
      matchedClaims: [],
    }
  }

  // Reuse verifyGrounding unmodified, as a read-only oracle, passing the SAME
  // inputs it gets in production: the composed USER PROMPT this exact
  // generation call produced (never a re-derived summary — see
  // VerifyGroundingInput.runtimeContext's own contract), the same venueInfo,
  // and [] for knowledgeChunks (this fixture retrieves none).
  const verifyResult = await verifyGrounding({
    inboundBody: variant.currentMessage,
    replyBody: genResult.data.body,
    venueInfo: input.venueInfo,
    knowledgeChunks: [],
    runtimeContext: genResult.data.userPrompt,
    isProactive: false,
  })

  if (!verifyResult.ok) {
    return {
      attempt,
      generation: { ok: true, body: genResult.data.body, voiceFidelity: genResult.data.voiceFidelity },
      verify: { ok: false, error: verifyResult.error },
      conflationShaped: false,
      matchedClaims: [],
    }
  }

  const score = scoreConflationClaims(verifyResult.data.ungroundedClaims)
  return {
    attempt,
    generation: { ok: true, body: genResult.data.body, voiceFidelity: genResult.data.voiceFidelity },
    verify: {
      ok: true,
      hasUngroundedClaim: verifyResult.data.hasUngroundedClaim,
      ungroundedClaims: verifyResult.data.ungroundedClaims,
    },
    conflationShaped: score.isConflationShaped,
    matchedClaims: score.matchedClaims,
  }
}

async function runVariant(variant: Variant, n: number): Promise<GenerationOutcome[]> {
  // Retrieved once per variant, not once per attempt: the query is the
  // variant's inbound body and the corpus is fixed, so production would
  // return the same 8 chunks on every one of these attempts too. Printing
  // them makes the run auditable — which voice examples the model saw is
  // part of what a later "after" run has to match.
  const ragChunks = await retrieveVoiceChunks(variant.currentMessage)
  console.log(`  retrieved ${ragChunks.length} voice chunks (cosine, floor ${SIMILARITY_FLOOR}, limit ${CORPUS_RETRIEVE_LIMIT}):`)
  for (const c of ragChunks) {
    console.log(`    ${(c.relevanceScore ?? 0).toFixed(4)} [${c.sourceType}] ${JSON.stringify(c.text.slice(0, 90))}`)
  }

  const outcomes: GenerationOutcome[] = []
  for (let i = 1; i <= n; i++) {
    const outcome = await runOneAttempt(variant, i, ragChunks)
    outcomes.push(outcome)
    const marker = outcome.conflationShaped ? 'CONFLATION' : outcome.verify?.ok && outcome.verify.hasUngroundedClaim ? 'flagged (other)' : 'clean'
    const body = outcome.generation.ok ? JSON.stringify(outcome.generation.body) : `GENERATION FAILED: ${outcome.generation.error}`
    // EVERY body is printed, not just the flagged ones. verifyGrounding is a
    // sample at temperature 0.2, not an oracle of record (CLAUDE.md's
    // single-verdict-sampling gotcha), and the keyword heuristic can both
    // over- and under-count. The pre-registered adjudication is done by
    // reading all N, so all N have to be on the page.
    console.log(`  [${i}/${n}] ${marker} :: ${body}`)
  }
  return outcomes
}

function printVariantSummary(variant: Variant, outcomes: GenerationOutcome[]): void {
  const total = outcomes.length
  const genFailures = outcomes.filter((o) => !o.generation.ok)
  const verifyFailures = outcomes.filter((o) => o.verify !== null && !o.verify.ok)
  const flagged = outcomes.filter((o) => o.verify?.ok && o.verify.hasUngroundedClaim)
  const conflationShaped = outcomes.filter((o) => o.conflationShaped)

  console.log(`\n--- Summary: variant ${variant.id} — ${variant.label} ---`)
  console.log(`generations: ${total}`)
  if (genFailures.length > 0) console.log(`generateMessage failures: ${genFailures.length}/${total}`)
  if (verifyFailures.length > 0) console.log(`verifyGrounding failures: ${verifyFailures.length}/${total}`)
  console.log(`flagged by verifyGrounding (any ungrounded claim): ${flagged.length}/${total}`)
  console.log(`conflation-shaped flags (heuristic match, see scoring file): ${conflationShaped.length}/${total}`)

  if (flagged.length > 0) {
    console.log('\nFlagged replies, raw text for a human to read (a keyword match alone can miscount):')
    for (const o of flagged) {
      if (!o.generation.ok || !o.verify?.ok) continue
      console.log(`  [attempt ${o.attempt}] body: ${JSON.stringify(o.generation.body)}`)
      for (const claim of o.verify.ungroundedClaims) {
        console.log(`    claim: ${claim}`)
      }
    }
  }
}

function parseArgs(argv: readonly string[]): { n: number; variantIds: readonly VariantId[] } {
  let n = DEFAULT_N
  let variantIds: readonly VariantId[] = ALL_VARIANT_IDS
  const args = argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--n') {
      const value = args[i + 1]
      const parsed = value ? Number.parseInt(value, 10) : NaN
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error(`✗ --n requires a positive integer, got "${value}"`)
        process.exit(1)
      }
      n = parsed
      i++
    } else if (a === '--variants') {
      const value = args[i + 1]
      const ids = (value ?? '')
        .split(',')
        .map((s) => Number.parseInt(s.trim(), 10))
      if (ids.length === 0 || ids.some((id) => !ALL_VARIANT_IDS.includes(id as VariantId))) {
        console.error(`✗ --variants must be a comma-separated list from {1,2,3,4}, got "${value}"`)
        process.exit(1)
      }
      variantIds = ids as VariantId[]
      i++
    } else {
      console.error(`✗ unknown flag: ${a}`)
      process.exit(1)
    }
  }
  return { n, variantIds }
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      '✗ missing env var: ANTHROPIC_API_KEY — this script calls the real Anthropic API (generateMessage + verifyGrounding, both unmodified) and needs real credentials. It cannot run in CI.',
    )
    process.exit(1)
  }

  const { n, variantIds } = parseArgs(process.argv)
  const variants = VARIANTS.filter((v) => variantIds.includes(v.id))

  console.log('TAC-483 order-attribution measurement — ships no fix, measures the live prompt as-is.')
  console.log(`N=${n} per variant. Variants: ${variantIds.join(', ')}. Channel copy: ${CHANNEL}`)
  // The run states its own configuration, so a .txt of this output says what
  // produced it without the script beside it (the measurement-harness
  // convention under CLAUDE.md → Scripts).
  console.log(
    `Venue config: ${LE_MILS.slug} (real export, ${EXPORT_PATH}, exported_at ${LE_MILS.exportedAt})`,
  )
  console.log(
    `  persona: speakerName=${LE_MILS.persona.speakerName ?? '(none)'} framing=${LE_MILS.persona.speakerFraming} formality=${LE_MILS.persona.formality} emoji=${LE_MILS.persona.emojiPolicy}`,
  )
  console.log(
    `  venue_info: ${LE_MILS.venueInfo.menu.items.length} menu items, ${LE_MILS.venueInfo.menu.highlights.length} highlights, ${LE_MILS.venueInfo.currentContext.length} active context notes, ${LE_MILS.venueInfo.staff.length} staff`,
  )
  console.log(`  voice_corpus: ${LE_MILS.corpus.length} entries available for retrieval`)
  console.log(`  knowledge_corpus: [] (not in the export — see buildInput's note)`)
  console.log(`Run started: ${RUN_STARTED_AT.toISOString()} (history deltas are relative to this)\n`)

  const allSummaries: Array<{ variant: Variant; outcomes: GenerationOutcome[] }> = []
  for (const variant of variants) {
    console.log(`=== Variant ${variant.id}: ${variant.label} ===`)
    console.log(variant.whatThisChecks)
    const outcomes = await runVariant(variant, n)
    allSummaries.push({ variant, outcomes })
  }

  for (const { variant, outcomes } of allSummaries) {
    printVariantSummary(variant, outcomes)
  }
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e)
  console.error(`✗ unexpected error: ${message}`)
  process.exit(1)
})
