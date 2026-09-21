// Load reviewed knowledge_corpus entries for one venue, without creating
// duplicates or contradictions.
//
// DRY RUN IS THE DEFAULT. It reads, embeds the proposals, and writes a
// markdown report. It writes nothing to the database.
//
// `--apply` WRITES TO THE PRODUCTION DATABASE. It inserts new
// `knowledge_corpus` rows and updates existing ones for the named venue, then
// embeds each one into `knowledge_embeddings` — the same rows the agent
// retrieves from on a live guest turn. There is no staging environment and no
// confirmation prompt. Run the dry run first and read its report.
//
// It is idempotent by `metadata.proposalRowId`: a proposal whose row already
// exists and is processed is SKIPPED, so a re-run is a no-op rather than a
// duplicate load. The corollary is the trap — re-using a row_id that has
// already been loaded writes NOTHING and still reports a clean plan. A
// proposal meant to change an existing row needs a NEW row_id plus
// `action: "replace"` and a `replaces_id`. An update preserves the prior text
// in `metadata.replacedContent`, which is the only rollback there is.
//
// Thin orchestrator per CLAUDE.md § Scripts. Decision logic is in
// ./load-venue-knowledge-pure (unit-tested), rendering in
// ./load-venue-knowledge-report.
//
//   npm run load-venue-knowledge -- --venue le-mils-coffee

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createAdminClient } from '@/lib/db/admin'
import { embedText } from '@/lib/rag'
import { EMBEDDING_MODEL } from '@/lib/rag/client'
import { chunkText } from '@/lib/rag/chunk'
import {
  ProposalsFileSchema,
  checkSplitSafety,
  decideLoadAction,
  diffAgainstBaseline,
  diffSpecifics,
  embeddingCacheKey,
  resolveReplacesId,
  entrySimilarity,
  extractSpecifics,
  findDuplicateRowIds,
  parseArgs,
  parseEmbedding,
  suggestVerdict,
  summarizeDistribution,
  type BaselineRow,
  type LoadableRow,
  type Proposal,
} from './load-venue-knowledge-pure'
import { applyLoad } from './load-venue-knowledge-apply'
import {
  renderReport,
  type EntryKind,
  type Neighbour,
  type ProposalResult,
} from './load-venue-knowledge-report'

const TOP_N = 3

interface CorpusEntry {
  label: string
  kind: EntryKind
  content: string
  chunks: number[][]
  /** Proposal row_id for proposal/replacement entries, else null. */
  rowId: string | null
}

function gitSha(): string | null {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/**
 * Vector cache, keyed on model + sha256(chunk text). Unchanged proposal text
 * costs nothing to re-check on a later run; changed text misses and is
 * re-embedded.
 *
 * This is a CACHE, never a source of truth: deleting the file only costs
 * Voyage calls. It lives beside the report under scripts/output, which is
 * gitignored.
 */
type EmbeddingCache = Record<string, number[]>

function loadEmbeddingCache(path: string): EmbeddingCache {
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as EmbeddingCache) : {}
  } catch {
    // A corrupt cache must not stop a run; the cost of ignoring it is one
    // round of embedding.
    console.warn('[dedup] embedding cache unreadable, ignoring it')
    return {}
  }
}

async function embedEntry(
  content: string,
  label: string,
  cache: EmbeddingCache,
  stats: { hits: number; misses: number },
): Promise<number[][]> {
  const chunks = chunkText(content)
  if (chunks.length === 0) throw new Error(`${label}: content chunked to nothing`)
  const out: number[][] = []
  for (const chunk of chunks) {
    const key = embeddingCacheKey(EMBEDDING_MODEL, chunk)
    const cached = cache[key]
    if (cached !== undefined) {
      stats.hits++
      out.push(cached)
      continue
    }
    stats.misses++
    let result = await embedText(chunk, 'document')
    if (!result.ok) {
      // One retry: a transient Voyage fault should not cost the whole run,
      // and a hard failure must stop it rather than yield a partial matrix.
      result = await embedText(chunk, 'document')
    }
    if (!result.ok) throw new Error(`${label}: embed failed: ${result.error}`)
    cache[key] = result.data.embedding
    out.push(result.data.embedding)
  }
  return out
}

function readProposalRowId(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null
  const v = (metadata as Record<string, unknown>).proposalRowId
  return typeof v === 'string' ? v : null
}

function textDefects(entries: readonly Proposal[]): string[] {
  const defects: string[] = []
  for (const p of entries) {
    const c = p.content
    if (/https?:\/\//.test(c)) defects.push(`${p.row_id}: content contains a full URL`)
    if (/,,|\.\.(?!\.)|;;/.test(c)) defects.push(`${p.row_id}: doubled punctuation`)
    if (/[—–]/.test(c)) defects.push(`${p.row_id}: contains an em or en dash`)
    if (/\s{2,}/.test(c)) defects.push(`${p.row_id}: contains a double space`)
    if (c.trim() !== c) defects.push(`${p.row_id}: content has leading or trailing whitespace`)
    if (!/[.!?]$/.test(c.trim())) defects.push(`${p.row_id}: content does not end in terminal punctuation`)
    if (p.contains_url && !/https?:\/\//.test(c)) {
      defects.push(`${p.row_id}: contains_url is true but no URL is present`)
    }
    if (!p.contains_url && /https?:\/\//.test(c)) {
      defects.push(`${p.row_id}: contains_url is false but a URL is present`)
    }
  }
  return defects
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const raw = JSON.parse(readFileSync(args.inputPath, 'utf8')) as unknown
  const file = ProposalsFileSchema.parse(raw)

  if (file.venue_slug !== args.venueSlug) {
    throw new Error(
      `venue mismatch: --venue is "${args.venueSlug}" but the file declares "${file.venue_slug}". ` +
        'Refusing: this script must never touch a venue other than the one named.',
    )
  }
  const dupes = findDuplicateRowIds(file.entries)
  if (dupes.length > 0) throw new Error(`duplicate row_ids in the input: ${dupes.join(', ')}`)

  const supabase = createAdminClient()

  const { data: venue, error: venueErr } = await supabase
    .from('venues')
    .select('id, slug')
    .eq('slug', args.venueSlug)
    .single()
  if (venueErr || !venue) throw new Error(`venue lookup failed: ${venueErr?.message ?? 'not found'}`)

  const { data: existingRows, error: rowsErr } = await supabase
    .from('knowledge_corpus')
    .select('id, content, source_type, primary_tags, secondary_tags, is_processed, metadata')
    .eq('venue_id', venue.id)
  if (rowsErr || !existingRows) throw new Error(`knowledge_corpus read failed: ${rowsErr?.message}`)

  const { data: embRows, error: embErr } = await supabase
    .from('knowledge_embeddings')
    .select('corpus_id, chunk_index, embedding')
    .eq('venue_id', venue.id)
  if (embErr || !embRows) throw new Error(`knowledge_embeddings read failed: ${embErr?.message}`)

  // Group stored chunk embeddings by corpus row.
  const storedChunks = new Map<string, number[][]>()
  for (const r of embRows) {
    const vec = parseEmbedding((r as { embedding: unknown }).embedding, `embedding for ${r.corpus_id}`)
    const list = storedChunks.get(r.corpus_id) ?? []
    list.push(vec)
    storedChunks.set(r.corpus_id, list)
  }
  const missing = existingRows.filter((r) => !storedChunks.has(r.id))
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} existing rows have no embedding (${missing.map((m) => m.id).join(', ')}). ` +
        'Refusing: they would be invisible to the duplicate check and read as "no match".',
    )
  }

  // Resolve every replaces_id against THIS VENUE'S ids only. A value may be a
  // full uuid or a prefix; exactly one match is required, and both zero and
  // many abort, because the next step overwrites reviewed content in place.
  // Venue scoping comes from the id list, which is already filtered by
  // venue_id above — a prefix can never reach another venue's row.
  const byId = new Map(existingRows.map((r) => [r.id, r]))
  const venueScopedIds = existingRows.map((r) => r.id)
  const replacements = file.entries.filter((e) => e.action === 'replace')
  const resolvedTargets = new Map<string, string>()
  for (const r of replacements) {
    const resolved = resolveReplacesId(r.replaces_id!, venueScopedIds)
    if (!resolved.ok) {
      throw new Error(
        resolved.reason === 'no_match'
          ? `${r.row_id}: replaces_id "${r.replaces_id}" matches no knowledge_corpus row at ${args.venueSlug}`
          : `${r.row_id}: replaces_id "${r.replaces_id}" is ambiguous at ${args.venueSlug} — ${resolved.matches.length} rows match (${resolved.matches.join(', ')})`,
      )
    }
    resolvedTargets.set(r.row_id, resolved.id)
    if (resolved.viaPrefix) {
      console.log(`[dedup] ${r.row_id}: prefix "${r.replaces_id}" resolved to ${resolved.id}`)
    }
  }
  const replacedIds = new Set(resolvedTargets.values())

  const loadableRows: LoadableRow[] = existingRows.map((r) => ({
    id: r.id,
    isProcessed: r.is_processed,
    proposalRowId: readProposalRowId((r as { metadata?: unknown }).metadata),
  }))

  // What the write path would do, computed from the SAME decision table the
  // write path uses, so the dry run's forecast cannot drift from the load.
  const plan = file.entries.map((p) => ({
    rowId: p.row_id,
    action: decideLoadAction(p, resolvedTargets.get(p.row_id) ?? null, loadableRows),
  }))
  const planned = {
    insert: plan.filter((x) => x.action.kind === 'insert').length,
    update: plan.filter((x) => x.action.kind === 'update').length,
    skip: plan.filter((x) => x.action.kind === 'skip').length,
  }

  if (args.apply) {
    console.log(
      `[apply] venue=${venue.slug} plan: insert=${planned.insert} update=${planned.update} skip=${planned.skip}`,
    )
    const result = await applyLoad({
      supabase,
      venueId: venue.id,
      venueSlug: venue.slug,
      proposalFile: args.inputPath,
      entries: file.entries,
      resolvedTargets,
      rows: loadableRows,
      now: new Date().toISOString(),
    })
    for (const o of result.outcomes) {
      console.log(
        `[apply] ${o.rowId}: ${o.kind}${o.kind === 'skipped' ? '' : ` id=${o.id} chunks=${o.chunks}`}` +
          (o.kind === 'updated' ? ` (${o.reason})` : ''),
      )
    }
    const { count, error: countErr } = await supabase
      .from('knowledge_corpus')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', venue.id)
    console.log(
      `[apply] DONE inserted=${result.inserted} updated=${result.updated} skipped=${result.skipped}`,
    )
    console.log(`[apply] ${venue.slug} knowledge_corpus total now: ${countErr ? 'unreadable' : count}`)
    return
  }

  console.log(
    `[dedup] venue=${venue.slug} existing=${existingRows.length} proposals=${file.entries.length} ` +
      `(${file.entries.length - replacements.length} new, ${replacements.length} replace)`,
  )
  const cachePath = join(dirname(args.outputPath), '.embedding-cache.json')
  const cache = loadEmbeddingCache(cachePath)
  const cacheStats = { hits: 0, misses: 0 }
  console.log(`[dedup] embedding ${file.entries.length} proposals via ${EMBEDDING_MODEL}...`)

  const proposalChunks = new Map<string, number[][]>()
  for (const p of file.entries) {
    proposalChunks.set(p.row_id, await embedEntry(p.content, p.row_id, cache, cacheStats))
  }
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, JSON.stringify(cache), 'utf8')
  console.log(`[dedup] embeddings: ${cacheStats.hits} cached, ${cacheStats.misses} computed`)

  // ── control distribution: existing vs existing, unaffected by the load ──
  const existingKeys = existingRows.map((r) => r.id)
  const controlScores: number[] = []
  for (let i = 0; i < existingKeys.length; i++) {
    for (let j = i + 1; j < existingKeys.length; j++) {
      controlScores.push(
        entrySimilarity(storedChunks.get(existingKeys[i]!)!, storedChunks.get(existingKeys[j]!)!),
      )
    }
  }
  const control = summarizeDistribution(controlScores)
  const band = control.p99

  // ── post-load corpus ────────────────────────────────────────────────────
  // Untouched existing rows keep their stored embeddings. The four replaced
  // rows are represented by their REPLACEMENT text, so a proposal is judged
  // against the corpus as it will be, not as it is.
  const postLoad: CorpusEntry[] = []
  for (const r of existingRows) {
    if (replacedIds.has(r.id)) continue
    postLoad.push({
      label: r.id,
      kind: 'existing',
      content: r.content,
      chunks: storedChunks.get(r.id)!,
      rowId: null,
    })
  }
  for (const p of file.entries) {
    postLoad.push({
      label: p.action === 'replace' ? `${p.row_id} → ${p.replaces_id}` : p.row_id,
      kind: p.action === 'replace' ? 'replacement' : 'proposal',
      content: p.content,
      chunks: proposalChunks.get(p.row_id)!,
      rowId: p.row_id,
    })
  }

  const untouchedExisting = postLoad.filter((e) => e.kind === 'existing')

  function nearest(self: CorpusEntry, pool: readonly CorpusEntry[]): Neighbour[] {
    return pool
      .filter((o) => o.label !== self.label)
      .map((o) => ({
        label: o.label,
        kind: o.kind,
        score: entrySimilarity(self.chunks, o.chunks),
        content: o.content,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_N)
  }

  const results: ProposalResult[] = file.entries.map((p) => {
    const self = postLoad.find((e) => e.rowId === p.row_id)!
    const neighbours = nearest(self, postLoad)
    const existingNeighbours = p.action === 'replace' ? nearest(self, untouchedExisting) : []
    const specifics = extractSpecifics(p.content)
    const top = neighbours[0]
    const diff = top ? diffSpecifics(specifics, extractSpecifics(top.content)) : null
    return {
      proposal: p,
      neighbours,
      existingNeighbours,
      specifics,
      diff,
      suggested: suggestVerdict(p.action, top?.score ?? null, band, diff),
    }
  })

  // ── ruling 8 + ruling 9 supporting data ─────────────────────────────────
  const rulingEight = ['bhadra', 'chikka']
    .map((needle) => {
      const row = existingRows.find((r) => r.content.toLowerCase().startsWith(needle))
      return row ? { id: row.id, label: row.content.split(' ')[0]!, content: row.content } : null
    })
    .filter((x): x is { id: string; label: string; content: string } => x !== null)

  const bareDomain = /\b(?:[a-z0-9-]+\.)+(?:com|org|net|co|io|uk)\b/i
  const bareDomainExistingRows = existingRows
    .filter((r) => bareDomain.test(r.content))
    .map((r) => ({ id: r.id, content: r.content }))

  const splitFindings = checkSplitSafety(
    file.entries.map((p) => ({ rowId: p.row_id, content: p.content })),
  )

  // ── write ───────────────────────────────────────────────────────────────
  const generatedAt = new Date().toISOString()
  const markdown = renderReport({
    venueSlug: venue.slug,
    venueId: venue.id,
    generatedAt,
    gitSha: gitSha(),
    embeddingModel: EMBEDDING_MODEL,
    inputPath: args.inputPath,
    existingCount: existingRows.length,
    proposalCount: file.entries.length,
    newCount: file.entries.length - replacements.length,
    replaceCount: replacements.length,
    control,
    band,
    results,
    replacementTargets: replacements.map((p) => {
      const id = resolvedTargets.get(p.row_id)!
      return { rowId: p.row_id, id, oldContent: byId.get(id)!.content, newContent: p.content }
    }),
    rulingEightRows: rulingEight,
    bareDomainExistingRows,
    splitFindings,
    textDefects: textDefects(file.entries),
  })

  mkdirSync(dirname(args.outputPath), { recursive: true })
  writeFileSync(args.outputPath, markdown, 'utf8')

  // Timestamped raw cache alongside the report. The expensive half of this
  // run is the Voyage calls; per CLAUDE.md § "Measurement harness convention"
  // a rerun must never be the only way to re-read the evidence.
  const rawPath = args.outputPath.replace(/\.md$/, `-raw-${generatedAt.replace(/[:.]/g, '-')}.json`)
  writeFileSync(
    rawPath,
    JSON.stringify(
      {
        __meta__: true,
        generatedAt,
        gitSha: gitSha(),
        venueSlug: venue.slug,
        venueId: venue.id,
        embeddingModel: EMBEDDING_MODEL,
        band,
        control,
        results: results.map((r) => ({
          rowId: r.proposal.row_id,
          action: r.proposal.action,
          suggested: r.suggested,
          neighbours: r.neighbours,
          existingNeighbours: r.existingNeighbours,
          diff: r.diff,
        })),
      },
      null,
      2,
    ),
    'utf8',
  )

  // ── diff against the previous run ───────────────────────────────────────
  const nowRows: BaselineRow[] = results.map((r) => ({
    rowId: r.proposal.row_id,
    suggested: r.suggested,
    topLabel: r.neighbours[0]?.label ?? null,
    topScore: r.neighbours[0]?.score ?? null,
  }))
  if (args.baselinePath !== null) {
    const prior: unknown = JSON.parse(readFileSync(args.baselinePath, 'utf8'))
    const priorResults = (prior as { results?: unknown }).results
    if (!Array.isArray(priorResults)) throw new Error('baseline file has no results array')
    const beforeRows: BaselineRow[] = priorResults.map((r) => {
      const row = r as { rowId: string; suggested: string; neighbours?: Array<{ label: string; score: number }> }
      return {
        rowId: row.rowId,
        suggested: row.suggested,
        topLabel: row.neighbours?.[0]?.label ?? null,
        topScore: row.neighbours?.[0]?.score ?? null,
      }
    })
    const changes = diffAgainstBaseline(beforeRows, nowRows)
    console.log(`[dedup] baseline ${args.baselinePath}: ${changes.length} change(s)`)
    for (const c of changes) {
      if (c.kind === 'added') {
        console.log(`  + ${c.rowId}: ${c.now.suggested} (top ${c.now.topScore?.toFixed(4)} vs ${c.now.topLabel})`)
      } else if (c.kind === 'removed') {
        console.log(`  - ${c.rowId}: was ${c.before.suggested}`)
      } else if (c.kind === 'verdict') {
        console.log(
          `  ~ ${c.rowId}: ${c.before.suggested} -> ${c.now.suggested} ` +
            `(${c.before.topScore?.toFixed(4)} vs ${c.before.topLabel} -> ${c.now.topScore?.toFixed(4)} vs ${c.now.topLabel})`,
        )
      } else {
        console.log(
          `  n ${c.rowId}: ${c.now.suggested} unchanged, nearest moved ` +
            `${c.before.topLabel} (${c.before.topScore?.toFixed(4)}) -> ${c.now.topLabel} (${c.now.topScore?.toFixed(4)})`,
        )
      }
    }
  }

  const counts = new Map<string, number>()
  for (const r of results) counts.set(r.suggested, (counts.get(r.suggested) ?? 0) + 1)
  console.log(`[dedup] control pairs=${control.count} p99(band)=${band.toFixed(4)} max=${control.max.toFixed(4)}`)
  console.log(`[dedup] suggested: ${[...counts].map(([k, v]) => `${k}=${v}`).join(' ')}`)
  console.log(`[dedup] split-safety findings: ${splitFindings.length}`)
  console.log(
    `[dedup] --apply would: insert=${planned.insert} update=${planned.update} skip=${planned.skip} ` +
      `-> ${venue.slug} total ${existingRows.length + planned.insert}`,
  )
  console.log(`[dedup] report  -> ${args.outputPath}`)
  console.log(`[dedup] raw     -> ${rawPath}`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
