// Pure half of the venue knowledge loader (scripts/load-venue-knowledge.ts).
//
// Split per CLAUDE.md "Module split for testability": the orchestrator builds
// the Voyage and Supabase admin clients at module load, which runs that init
// inside vitest. Everything here is pure so the tests can import it directly.
//
// DELIBERATE DEVIATION from the "-pure.ts has no @/* imports" letter: this
// file imports three @/* modules BY PATH, never via a barrel. All three are
// import-free or zod-only, so none triggers SDK init:
//   - @/lib/schemas/knowledge-tags   (zod only)
//   - @/lib/agent/sentence-split     (imports only ./split-message, which is
//                                     itself dependency-free)
// The alternative is hand-copying KNOWLEDGE_PRIMARY_TAGS and the sentence
// splitter, and this file already documents why that is the worse failure:
// a copied canonical list drifts silently. Same call scripts/onboarding/
// extract.ts makes when it imports MECHANIC_TRIGGER_TYPES rather than
// restating it.
//
// NEVER import from '@/lib/rag' (the barrel) here — it pulls in client.ts,
// which constructs the Voyage client at module load. Import '@/lib/rag/chunk'
// by path if chunking is ever needed on this side.

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { isCanonicalPrimaryTag } from '@/lib/schemas/knowledge-tags'
import { resolveDispatchBubbles } from '@/lib/agent/sentence-split'

// ── input schema ────────────────────────────────────────────────────────────

/**
 * A `replaces_id` is either a full uuid or a PREFIX of one, resolved against
 * the venue's own rows at load time (see resolveReplacesId). A prefix is
 * allowed because a human writing a replacement by hand has the short form
 * in front of them; 8 hex chars is the floor so a typo is overwhelmingly
 * likely to resolve to zero rows rather than to the wrong row, and
 * resolution refuses anything that is not exactly one match either way.
 */
export const REPLACES_ID_RE = /^[0-9a-f][0-9a-f-]{7,35}$/

export const ProposalSchema = z
  .object({
    row_id: z.string().min(1),
    action: z.enum(['new', 'replace']),
    replaces_id: z.string().regex(REPLACES_ID_RE, 'must be a uuid or a hex id prefix of at least 8 chars').nullable(),
    dedup_status: z.string(),
    contains_url: z.boolean(),
    primary_tags: z.array(z.string()).min(1),
    secondary_tags: z.array(z.string()),
    content: z.string().min(1),
    source_ref: z.string().min(1),
    note: z.string(),
  })
  .superRefine((p, ctx) => {
    if (p.action === 'replace' && p.replaces_id === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${p.row_id}: action=replace needs replaces_id` })
    }
    if (p.action === 'new' && p.replaces_id !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${p.row_id}: action=new must have replaces_id null` })
    }
    for (const tag of p.primary_tags) {
      if (isCanonicalPrimaryTag(tag) === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${p.row_id}: non-canonical primary tag "${tag}"` })
      }
    }
  })

export type Proposal = z.infer<typeof ProposalSchema>

export const ProposalsFileSchema = z.object({
  venue_slug: z.string().min(1),
  prepared: z.string(),
  rules: z.record(z.string(), z.string()),
  entries: z.array(ProposalSchema).min(1),
})

export type ProposalsFile = z.infer<typeof ProposalsFileSchema>

/** Duplicate row_ids would silently collide on the metadata idempotency key. */
export function findDuplicateRowIds(entries: readonly Proposal[]): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const e of entries) {
    if (seen.has(e.row_id)) dupes.add(e.row_id)
    seen.add(e.row_id)
  }
  return [...dupes].sort()
}

// ── args ────────────────────────────────────────────────────────────────────

export interface Args {
  venueSlug: string
  apply: boolean
  inputPath: string
  outputPath: string
  /** Prior raw run file to diff this run's verdicts against, if any. */
  baselinePath: string | null
}

export const DEFAULT_INPUT = 'scripts/data/lemils_knowledge_proposals.json'
export const DEFAULT_OUTPUT = 'scripts/output/lemils_dedup_report.md'

export function parseArgs(argv: readonly string[]): Args {
  let venueSlug = ''
  let apply = false
  let inputPath = DEFAULT_INPUT
  let outputPath = DEFAULT_OUTPUT
  let baselinePath: string | null = null

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') apply = true
    else if (a === '--venue') venueSlug = argv[++i] ?? ''
    else if (a === '--input') inputPath = argv[++i] ?? ''
    else if (a === '--output') outputPath = argv[++i] ?? ''
    else if (a === '--baseline') baselinePath = argv[++i] ?? ''
    else throw new Error(`unrecognized argument: ${a}`)
  }

  if (venueSlug.length === 0) {
    throw new Error('--venue <slug> is required (there is no default: this writes to a real venue)')
  }
  return { venueSlug, apply, inputPath, outputPath, baselinePath }
}

// ── vectors ─────────────────────────────────────────────────────────────────

/**
 * pgvector comes back over PostgREST as a JSON string ("[0.1,0.2,...]"), but
 * some client/driver combinations hand back a real array. Accept both rather
 * than assuming, and fail loudly on anything else — a silently-zero vector
 * would score 0 against everything and read as "no duplicates found".
 */
export function parseEmbedding(raw: unknown, label: string): number[] {
  if (Array.isArray(raw)) {
    if (raw.length === 0) throw new Error(`${label}: empty embedding array`)
    return raw.map((n) => {
      const v = typeof n === 'number' ? n : Number(n)
      if (!Number.isFinite(v)) throw new Error(`${label}: non-finite value in embedding`)
      return v
    })
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
      throw new Error(`${label}: embedding string is not a bracketed vector literal`)
    }
    const inner = trimmed.slice(1, -1).trim()
    if (inner.length === 0) throw new Error(`${label}: empty embedding literal`)
    return inner.split(',').map((part) => {
      const v = Number(part)
      if (!Number.isFinite(v)) throw new Error(`${label}: non-finite value in embedding literal`)
      return v
    })
  }
  throw new Error(`${label}: embedding is ${raw === null ? 'null' : typeof raw}, expected string or array`)
}

/**
 * True cosine, not a dot product. Voyage embeddings are documented as
 * normalized, but assuming it would make every score silently wrong if that
 * ever changed, and the division is free at this scale.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`cosine: dimension mismatch ${a.length} vs ${b.length}`)
  if (a.length === 0) throw new Error('cosine: empty vectors')
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) throw new Error('cosine: zero-magnitude vector')
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Entry-level similarity is the MAX over chunk pairs. An entry that chunks
 * into several pieces is a duplicate of another if any piece is: taking a
 * mean would let one shared paragraph be diluted by unrelated neighbours.
 * (Every Le Mil's row is single-chunk today, so this only matters for a
 * longer future entry.)
 */
export function entrySimilarity(a: readonly number[][], b: readonly number[][]): number {
  let best = -1
  for (const ca of a) for (const cb of b) best = Math.max(best, cosineSimilarity(ca, cb))
  if (best === -1) throw new Error('entrySimilarity: an entry had no chunks')
  return best
}

// ── distribution ────────────────────────────────────────────────────────────

export interface Distribution {
  count: number
  min: number
  p50: number
  p90: number
  p95: number
  p99: number
  max: number
  histogram: Array<{ lo: number; hi: number; count: number }>
}

export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) throw new Error('percentile: empty input')
  if (sortedAsc.length === 1) return sortedAsc[0]!
  const idx = (sortedAsc.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sortedAsc[lo]!
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (idx - lo)
}

export function summarizeDistribution(scores: readonly number[], bucket = 0.05): Distribution {
  if (scores.length === 0) throw new Error('summarizeDistribution: empty input')
  const sorted = [...scores].sort((x, y) => x - y)
  const buckets = new Map<number, number>()
  for (const s of sorted) {
    const clamped = Math.min(Math.max(s, 0), 0.999999)
    const lo = Math.floor(clamped / bucket) * bucket
    buckets.set(lo, (buckets.get(lo) ?? 0) + 1)
  }
  const histogram = [...buckets.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([lo, count]) => ({ lo, hi: lo + bucket, count }))
  return {
    count: sorted.length,
    min: sorted[0]!,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1]!,
    histogram,
  }
}

// ── specifics ───────────────────────────────────────────────────────────────

export interface Specifics {
  money: string[]
  percentages: string[]
  ranges: string[]
  measures: string[]
  years: string[]
  ordinals: string[]
  numbers: string[]
  domains: string[]
  emails: string[]
  properNouns: string[]
}

export const NUMERIC_KEYS = [
  'money',
  'percentages',
  'ranges',
  'measures',
  'years',
  'ordinals',
  'numbers',
] as const satisfies ReadonlyArray<keyof Specifics>

// Capitalised tokens that carry no identifying weight. Deliberately short:
// over-reporting a proper noun costs a glance, dropping a real one (a store
// name, a variety, a place) costs the finding.
const PROPER_NOUN_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'but', 'for', 'it', 'its', 'this', 'that', 'these', 'those',
  'every', 'all', 'both', 'each', 'other', 'good', 'made', 'sold', 'very', 'before',
  'after', 'when', 'where', 'what', 'who', 'how', 'why', 'let', 'mix', 'put', 'set',
  'pour', 'legend', 'says', 'online', 'wholesale', 'roasted', 'whole', 'non',
])

const UNIT = 'oz|lbs?|ml|l|g|kg|mm|cm|km|m|tbsp|tsp|cups?|minutes?|mins?|hours?|hrs?|days?|business days|°f|°c|am|pm'

function collect(text: string, re: RegExp, out: string[]): string {
  return text.replace(re, (m) => {
    out.push(m.trim())
    return ' '.repeat(m.length)
  })
}

/**
 * Pull the checkable specifics out of an entry. This is an ATTENTION AID, not
 * a verdict: embeddings score "16th century" and "17th century" at ~0.98, so
 * the similarity score says "read this pair" and this says "look here first".
 *
 * Order matters — each pass masks what it consumed, so "$9.99" is money and
 * never also the bare number 9.99, and "10 oz" is a measure and never 10.
 */
export function extractSpecifics(text: string): Specifics {
  const money: string[] = []
  const percentages: string[] = []
  const ranges: string[] = []
  const measures: string[] = []
  const years: string[] = []
  const ordinals: string[] = []
  const numbers: string[] = []
  const domains: string[] = []
  const emails: string[] = []

  let t = text
  t = collect(t, /[\w.+-]+@[\w.-]+\.\w+/g, emails)
  t = collect(t, /\b(?:[a-z0-9-]+\.)+(?:com|org|net|co|io|uk)\b/gi, domains)
  t = collect(t, /\$\d[\d,]*(?:\.\d+)?/g, money)
  t = collect(t, /\b\d{1,3}(?:\.\d+)?\s*%/g, percentages)
  t = collect(t, /\b\d{1,2}(?:st|nd|rd|th)\s+century\b/gi, ordinals)
  t = collect(
    t,
    /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)[-\s]generation\b/gi,
    ordinals,
  )
  // Ranges and ratios before measures and bare numbers: "10-15 minutes",
  // "80/20", "3 x 10 oz", "500-1,000 m" must not decompose into halves.
  t = collect(t, new RegExp(String.raw`\b\d[\d,]*(?:\.\d+)?\s*(?:-|–|to)\s*\d[\d,]*(?:\.\d+)?\s*(?:${UNIT})?\b`, 'gi'), ranges)
  t = collect(t, /\b\d+\s*\/\s*\d+\b/g, ranges)
  t = collect(t, /\b\d+\s*x\s*\d[\d,]*(?:\.\d+)?\s*(?:oz|lb|lbs)?\b/gi, ranges)
  t = collect(t, /\b(?:1[5-9]|20)\d{2}\b/g, years)
  t = collect(t, new RegExp(String.raw`\b\d[\d,]*(?:\.\d+)?\s*(?:${UNIT})\b`, 'gi'), measures)
  collect(t, /\b\d[\d,]*(?:\.\d+)?\b/g, numbers)

  const properNouns = [
    ...new Set(
      (text.match(/\b[A-Z][A-Za-z'’-]{2,}\b/g) ?? []).filter(
        (w) => !PROPER_NOUN_STOPWORDS.has(w.toLowerCase()),
      ),
    ),
  ].sort()

  // Whitespace is stripped ENTIRELY, not collapsed. Two entries writing the
  // same fact as "80%" and "80 %", or "10 oz" and "10oz", must compare equal
  // — otherwise the diff reports a divergence that is purely typographic and
  // the numeric flag fires on entries that agree. Costs a slightly compact
  // display form ("1lb"), which is the right trade for an attention aid.
  const uniq = (xs: string[]): string[] =>
    [...new Set(xs.map((x) => x.replace(/\s+/g, '').toLowerCase()))].sort()

  return {
    money: uniq(money),
    percentages: uniq(percentages),
    ranges: uniq(ranges),
    measures: uniq(measures),
    years: uniq(years),
    ordinals: uniq(ordinals),
    numbers: uniq(numbers),
    domains: uniq(domains),
    emails: uniq(emails),
    properNouns,
  }
}

export interface SpecificsDiff {
  onlyLeft: Partial<Record<keyof Specifics, string[]>>
  onlyRight: Partial<Record<keyof Specifics, string[]>>
  sharedNumericCount: number
  /** Both sides state numerics and the sets differ. Over-flags on purpose. */
  numericDivergence: boolean
}

export function diffSpecifics(left: Specifics, right: Specifics): SpecificsDiff {
  const onlyLeft: Partial<Record<keyof Specifics, string[]>> = {}
  const onlyRight: Partial<Record<keyof Specifics, string[]>> = {}
  const keys = Object.keys(left) as Array<keyof Specifics>

  for (const k of keys) {
    const l = new Set(left[k])
    const r = new Set(right[k])
    const ol = [...l].filter((x) => !r.has(x))
    const or = [...r].filter((x) => !l.has(x))
    if (ol.length > 0) onlyLeft[k] = ol
    if (or.length > 0) onlyRight[k] = or
  }

  const numericLeft = new Set(NUMERIC_KEYS.flatMap((k) => left[k]))
  const numericRight = new Set(NUMERIC_KEYS.flatMap((k) => right[k]))
  const shared = [...numericLeft].filter((x) => numericRight.has(x))
  const differ =
    numericLeft.size !== numericRight.size || [...numericLeft].some((x) => !numericRight.has(x))

  return {
    onlyLeft,
    onlyRight,
    sharedNumericCount: shared.length,
    numericDivergence: numericLeft.size > 0 && numericRight.size > 0 && differ,
  }
}

// ── verdicts ────────────────────────────────────────────────────────────────

export type SuggestedVerdict = 'NEW' | 'BORDERLINE' | 'CONFLICT_CANDIDATE' | 'REPLACES'

/**
 * A SUGGESTION, never a decision. Three properties are deliberate:
 *   - DUPLICATE is never suggested. Dropping an entry needs someone to read
 *     both texts and agree they say the same thing; a score cannot establish
 *     it, and the cost of a wrong drop is a fact the venue loses.
 *   - A 'replace' row is REPLACES by construction — Jaipal confirmed those.
 *   - Above the band, the specifics diff only chooses between BORDERLINE and
 *     CONFLICT_CANDIDATE, i.e. between "read this" and "read this first".
 */
export function suggestVerdict(
  action: Proposal['action'],
  topScore: number | null,
  band: number,
  diff: SpecificsDiff | null,
): SuggestedVerdict {
  if (action === 'replace') return 'REPLACES'
  if (topScore === null || topScore < band) return 'NEW'
  if (diff !== null && diff.numericDivergence && diff.sharedNumericCount > 0) return 'CONFLICT_CANDIDATE'
  return 'BORDERLINE'
}

// ── ruling 9: bare-domain split safety ──────────────────────────────────────

export interface SplitSafetyFinding {
  rowId: string
  bubbles: string[]
  brokenToken: string
}

/**
 * Ruling 9, measured rather than read. Runs each proposal body through the
 * real dispatch splitter with the coin forced to SPLIT (rng = 0), and reports
 * any bubble boundary that lands INSIDE a bare domain like "lemils.com".
 *
 * Forcing the split is the point: the no-split branch is trivially safe, so
 * testing it would prove nothing.
 *
 * `split` is injectable ONLY so the detector itself is falsifiable. Against
 * the real splitter this check is expected to pass for every input, because a
 * domain contains no whitespace and the splitter requires whitespace after
 * the punctuation before it will break — so a green result here confirms that
 * reasoning on real bodies rather than establishing it. Without the seam,
 * "no findings" would be indistinguishable from a detector that cannot fire,
 * which is the shape CLAUDE.md keeps logging (comp_regex_backstop, the
 * future-add-safety push test).
 */
export function checkSplitSafety(
  entries: ReadonlyArray<{ rowId: string; content: string }>,
  split: (body: string, rng: () => number) => string[] = resolveDispatchBubbles,
): SplitSafetyFinding[] {
  const findings: SplitSafetyFinding[] = []
  const domain = /\b(?:[a-z0-9-]+\.)+(?:com|org|net|co|io|uk)\b/gi

  for (const e of entries) {
    const tokens = e.content.match(domain) ?? []
    if (tokens.length === 0) continue
    const bubbles = split(e.content, () => 0)
    for (const token of tokens) {
      // A domain is intact if some single bubble still contains it whole.
      if (!bubbles.some((b) => b.includes(token))) {
        findings.push({ rowId: e.rowId, bubbles, brokenToken: token })
      }
    }
  }
  return findings
}

// ── replaces_id resolution ──────────────────────────────────────────────────

export type ResolveIdResult =
  | { ok: true; id: string; viaPrefix: boolean }
  | { ok: false; reason: 'no_match' | 'ambiguous'; matches: string[] }

/**
 * Resolve a `replaces_id` (full uuid or prefix) against candidate ids.
 *
 * CALLER MUST PASS VENUE-SCOPED IDS ONLY. Venue isolation is established by
 * what goes in, not by anything this function checks — passing the whole
 * table would let a prefix resolve to another venue's row, which is the one
 * outcome a replacement must never have.
 *
 * Exactly one match or nothing: zero and many are both refusals, because the
 * caller is about to overwrite reviewed content in place.
 */
export function resolveReplacesId(
  value: string,
  venueScopedIds: readonly string[],
): ResolveIdResult {
  const exact = venueScopedIds.filter((id) => id === value)
  if (exact.length === 1) return { ok: true, id: exact[0]!, viaPrefix: false }

  const matches = venueScopedIds.filter((id) => id.startsWith(value))
  if (matches.length === 1) return { ok: true, id: matches[0]!, viaPrefix: true }
  if (matches.length === 0) return { ok: false, reason: 'no_match', matches: [] }
  return { ok: false, reason: 'ambiguous', matches: [...matches].sort() }
}

// ── load decision table ─────────────────────────────────────────────────────

/** The shape the decision needs off an existing knowledge_corpus row. */
export interface LoadableRow {
  id: string
  isProcessed: boolean
  /** metadata->>'proposalRowId', or null for a row this loader never wrote. */
  proposalRowId: string | null
}

export type LoadAction =
  | { kind: 'skip'; reason: 'already_loaded'; id: string }
  | { kind: 'insert' }
  | { kind: 'update'; id: string; reason: 'replace' | 'resume_unprocessed' }

/**
 * What to do with one proposal, given the venue's current rows.
 *
 * Two properties are load-bearing, and both exist because knowledge_corpus has
 * NO unique index on (venue_id, source_ref) — nothing at the storage layer
 * stops a second run inserting everything again.
 *
 *  1. IDEMPOTENCY. A row already stamped with this proposal's row_id is
 *     skipped, so a re-run is a no-op rather than a duplicate load.
 *
 *  2. RESUME. The skip requires is_processed as well as the stamp. A row
 *     whose insert or update succeeded but whose embedding then failed is
 *     stamped but unprocessed — invisible to retrieval, and a stamp-only
 *     check would skip it forever, leaving a row that exists and can never be
 *     retrieved. That case re-runs the write and the embed instead.
 *     (editKnowledgeEntry documents the same fix path: resubmitting the
 *     content IS the retry.)
 */
export function decideLoadAction(
  proposal: Pick<Proposal, 'row_id' | 'action'>,
  resolvedTargetId: string | null,
  rows: readonly LoadableRow[],
): LoadAction {
  const prior = rows.find((r) => r.proposalRowId === proposal.row_id)
  if (prior !== undefined) {
    return prior.isProcessed
      ? { kind: 'skip', reason: 'already_loaded', id: prior.id }
      : { kind: 'update', id: prior.id, reason: 'resume_unprocessed' }
  }
  if (proposal.action === 'replace') {
    if (resolvedTargetId === null) {
      throw new Error(`${proposal.row_id}: replace with no resolved target id`)
    }
    return { kind: 'update', id: resolvedTargetId, reason: 'replace' }
  }
  return { kind: 'insert' }
}

// ── embedding cache key ─────────────────────────────────────────────────────

/**
 * Cache key for one embedded chunk. Keyed on the MODEL as well as the text:
 * a model change must miss the cache rather than silently mix vector spaces,
 * which would make every score meaningless while looking fine.
 */
export function embeddingCacheKey(model: string, text: string): string {
  return `${model}:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

// ── baseline diff ───────────────────────────────────────────────────────────

export interface BaselineRow {
  rowId: string
  suggested: string
  topLabel: string | null
  topScore: number | null
}

export type VerdictChange =
  | { rowId: string; kind: 'added'; now: BaselineRow }
  | { rowId: string; kind: 'removed'; before: BaselineRow }
  | { rowId: string; kind: 'verdict'; before: BaselineRow; now: BaselineRow }
  | { rowId: string; kind: 'neighbour'; before: BaselineRow; now: BaselineRow }

/**
 * Differences between two runs, per row. Reports a verdict change and a
 * change of nearest neighbour separately: a row can keep the same verdict
 * while the entry it sits closest to moves, which is a different fact about
 * the corpus and worth seeing.
 *
 * Score drift alone is NOT reported. Re-embedding the same text can move a
 * score in the last decimals, and reporting that would bury the changes that
 * mean something.
 */
export function diffAgainstBaseline(
  before: readonly BaselineRow[],
  now: readonly BaselineRow[],
): VerdictChange[] {
  const beforeById = new Map(before.map((r) => [r.rowId, r]))
  const nowById = new Map(now.map((r) => [r.rowId, r]))
  const changes: VerdictChange[] = []

  for (const n of now) {
    const b = beforeById.get(n.rowId)
    if (b === undefined) {
      changes.push({ rowId: n.rowId, kind: 'added', now: n })
      continue
    }
    if (b.suggested !== n.suggested) {
      changes.push({ rowId: n.rowId, kind: 'verdict', before: b, now: n })
      continue
    }
    if (b.topLabel !== n.topLabel) {
      changes.push({ rowId: n.rowId, kind: 'neighbour', before: b, now: n })
    }
  }
  for (const b of before) {
    if (!nowById.has(b.rowId)) changes.push({ rowId: b.rowId, kind: 'removed', before: b })
  }
  return changes.sort((x, y) => x.rowId.localeCompare(y.rowId))
}
