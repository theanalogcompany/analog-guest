// Turn a venue's own website into a proposals file for the knowledge loader.
//
// WRITES NOTHING TO THE DATABASE, ever. It fetches the site, converts each
// page into corpus-style entries with a model, drops entries that restate one
// it already kept, and writes three artifacts:
//
//   scripts/output/<slug>-site-proposals.json  -> feeds `load-venue-knowledge`
//   scripts/output/<slug>-site-links.json      -> the venue_info.links patch
//   scripts/output/<slug>-site-manifest.json   -> the decision log (see below)
//
// The existing loader stays the only path to the database, so its similarity
// band against the live corpus, the replaces_id resolution and the idempotency
// on metadata.proposalRowId all still apply. This script is the front end that
// was missing: the loader has always started from a hand-authored proposals
// file (PR #241, written for one specific Le Mil's load), which is why no URL
// had ever actually been ingested.
//
// ── NOTHING IS DROPPED SILENTLY ────────────────────────────────────────────
// Every URL discovered and every entry extracted gets a row in the manifest
// with an explicit disposition and reason. The dispositions are a closed union
// (`UrlDisposition`, `EntryDisposition`) counted with `satisfies
// Record<...>`, so adding an outcome without reporting it fails `tsc` rather
// than disappearing into a total. This matters because a crawl's natural
// failure shape is a quiet one: a 404, a model refusal, a truncated page and a
// page that genuinely has no facts all end as "fewer entries than you
// expected" and none of them announce themselves.
//
// Three consequences, each of them a rule this repo already paid for:
//   - A page that FAILED is never counted as a page with no facts
//     (scripts/CLAUDE.md rule 5: a failed unit is not a result).
//   - The process EXITS NON-ZERO if any page failed to fetch, failed in the
//     model, or had its text truncated, so a partial crawl cannot be read as a
//     complete one (rule 6: a crashed or skipped run is not a result either).
//   - Truncation is its own disposition, not a silent slice (lib/ai/CLAUDE.md,
//     "truncation is a distinct failure").
//
//   npm run ingest-venue-site -- --venue le-mils-coffee --site https://lemils.com
//   npm run load-venue-knowledge -- --venue le-mils-coffee --input scripts/output/le-mils-coffee-site-proposals.json
//
// Idempotent by construction: row_id is derived from the URL path and the entry
// ordinal, so a re-crawl produces the same ids and the loader skips rather than
// duplicates.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { generateObject } from 'ai'
import { z } from 'zod'
import { getGenerationModel } from '@/lib/ai/client'
import { embedText } from '@/lib/rag'
import { EMBEDDING_MODEL } from '@/lib/rag/client'
import { diffSpecifics, extractSpecifics } from './load-venue-knowledge-pure'
import {
  contentDefects,
  dedupeUrls,
  exclusionReason,
  htmlToText,
  isLocaleVariant,
  isPrimaryTag,
  kindFromPath,
  linkLabelFor,
  PRIMARY_TAGS,
  rowIdFor,
  sanitizeContent,
  selfDedupe,
  type DedupeCandidate,
  type SourcePage,
} from './ingest-venue-site-pure'

const OUTPUT_DIR = 'scripts/output'
/** Page text handed to the model. Exceeding it is REPORTED, never silent. */
const MAX_PAGE_CHARS = 24_000
/**
 * Self-dedupe bars. The drop bar sits above the loader's measured
 * existing-vs-existing p99 on Le Mil's (0.8282) so only clear restatements go;
 * the near-miss bar is below it so the band either side of the cliff is
 * printed rather than invisible. Both are overridable per run.
 */
const DEFAULT_DEDUPE_AT = 0.88
const DEFAULT_NEAR_MISS_AT = 0.82

type UrlDisposition =
  | 'ingested'
  | 'locale_variant'
  | 'excluded_by_rule'
  | 'collapsed_duplicate_url'
  | 'sitemap_fetch_failed'
  | 'page_fetch_failed'
  | 'model_failed'
  | 'no_storable_fact'

type EntryDisposition = 'kept' | 'dropped_defective' | 'dropped_self_duplicate'

const URL_DISPOSITION_IS_FAILURE = {
  ingested: false,
  locale_variant: false,
  excluded_by_rule: false,
  collapsed_duplicate_url: false,
  no_storable_fact: false,
  sitemap_fetch_failed: true,
  page_fetch_failed: true,
  model_failed: true,
} satisfies Record<UrlDisposition, boolean>

interface UrlRecord {
  url: string
  disposition: UrlDisposition
  reason: string
  entriesKept: number
  /** Set when the page's text exceeded MAX_PAGE_CHARS. */
  truncatedFrom?: number
}

interface EntryRecord {
  rowId: string
  sourceRef: string
  disposition: EntryDisposition
  reason: string
  /** Deterministic rewrites applied to the model's text, by name. */
  sanitizeChanges: string[]
  /** Non-canonical primary tags the model proposed and we could not use. */
  droppedTags: string[]
  content: string
}

const EntrySchema = z.object({
  content: z.string(),
  primary_tags: z.array(z.string()),
  secondary_tags: z.array(z.string()),
})

const PageEntriesSchema = z.object({
  page_title: z.string(),
  entries: z.array(EntrySchema),
})

interface Proposal {
  row_id: string
  action: 'new'
  replaces_id: null
  dedup_status: string
  contains_url: boolean
  primary_tags: string[]
  secondary_tags: string[]
  content: string
  source_ref: string
  note: string
}

function parseArgs(argv: readonly string[]): {
  venueSlug: string
  site: string
  limit: number | null
  dedupeAt: number
  nearMissAt: number
} {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag)
    return i === -1 ? null : (argv[i + 1] ?? null)
  }
  const venueSlug = get('--venue')
  const site = get('--site')
  if (venueSlug === null || site === null) {
    throw new Error(
      'usage: --venue <slug> --site <https://example.com> [--limit N] [--dedupe-at 0.88] [--near-miss-at 0.82]',
    )
  }
  const num = (flag: string, fallback: number): number => {
    const raw = get(flag)
    if (raw === null) return fallback
    const v = Number(raw)
    if (!Number.isFinite(v)) throw new Error(`${flag} must be a number`)
    return v
  }
  const limitRaw = get('--limit')
  return {
    venueSlug,
    site: site.replace(/\/$/, ''),
    limit: limitRaw === null ? null : Number(limitRaw),
    dedupeAt: num('--dedupe-at', DEFAULT_DEDUPE_AT),
    nearMissAt: num('--near-miss-at', DEFAULT_NEAR_MISS_AT),
  }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'analog-guest venue knowledge ingest' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

function locs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) =>
    m[1]!.replace(/&amp;/g, '&').trim(),
  )
}

/**
 * Walk the sitemap index, recording a disposition for EVERY url seen rather
 * than returning only the survivors.
 */
async function discover(
  site: string,
): Promise<{ pages: SourcePage[]; records: UrlRecord[] }> {
  const records: UrlRecord[] = []
  const index = await fetchText(`${site}/sitemap.xml`)

  const children: string[] = []
  for (const child of locs(index)) {
    if (isLocaleVariant(child)) {
      records.push({
        url: child,
        disposition: 'locale_variant',
        reason: 'sitemap child serves the same content under a locale path',
        entriesKept: 0,
      })
      continue
    }
    children.push(child)
  }

  const candidates: SourcePage[] = []
  for (const child of children) {
    let xml: string
    try {
      xml = await fetchText(child)
    } catch (e) {
      records.push({
        url: child,
        disposition: 'sitemap_fetch_failed',
        reason: e instanceof Error ? e.message : String(e),
        entriesKept: 0,
      })
      continue
    }
    for (const url of locs(xml)) {
      if (isLocaleVariant(url)) {
        records.push({
          url,
          disposition: 'locale_variant',
          reason: 'same content under a locale path',
          entriesKept: 0,
        })
        continue
      }
      const excluded = exclusionReason(url)
      if (excluded !== null) {
        records.push({
          url,
          disposition: 'excluded_by_rule',
          reason: excluded,
          entriesKept: 0,
        })
        continue
      }
      candidates.push({ url, kind: kindFromPath(url) })
    }
  }

  const { kept, collapsed } = dedupeUrls(candidates)
  for (const c of collapsed) {
    records.push({
      url: c.url,
      disposition: 'collapsed_duplicate_url',
      reason: `same content key "${c.key}" as ${c.into}`,
      entriesKept: 0,
    })
  }
  return { pages: kept, records }
}

async function productText(url: string): Promise<string> {
  const res = await fetch(`${url}.json`, {
    headers: { 'user-agent': 'analog-guest venue knowledge ingest' },
  })
  if (!res.ok) throw new Error(`product JSON: HTTP ${res.status}`)
  const json = (await res.json()) as {
    product?: {
      title?: string
      body_html?: string
      product_type?: string
      variants?: Array<{ title?: string; price?: string }>
    }
  }
  const p = json.product
  if (p === undefined) throw new Error('product JSON had no product')
  const variants = (p.variants ?? [])
    .map((v) => `${v.title ?? ''} $${v.price ?? ''}`)
    .join('; ')
  return [
    `TITLE: ${p.title ?? ''}`,
    `TYPE: ${p.product_type ?? ''}`,
    `DESCRIPTION: ${htmlToText(p.body_html ?? '')}`,
    `VARIANTS AND PRICES: ${variants}`,
  ].join('\n\n')
}

const SYSTEM = `You convert a venue's own web page into discrete knowledge entries for a hospitality assistant that answers guest text messages.

Each entry is ONE self-contained fact, written as a flat declarative statement a host would know. The assistant retrieves entries individually, so an entry that depends on another to make sense is useless.

Rules for every entry:
- State the fact plainly. No marketing voice, no second person, no instructions to the assistant.
- Name the subject explicitly. "It is vegan" is useless once retrieved alone; "The Pink Panther is vegan" is not.
- Include specifics: prices, sizes, names, times, varieties, places.
- Never use an em dash or en dash. End the sentence and start a new one.
- Never use double spaces or doubled punctuation. End with a full stop.
- Include a URL ONLY if the page's own purpose is that link (a shop page, a booking page). Then the URL must appear in full. Otherwise never write a URL.
- Skip navigation, cookie notices, shipping banners, review widgets, newsletter prompts and anything about buying through an AI shopping agent.
- Skip anything that is not a fact about this venue, its products, its space, its people or its policies.

primary_tags: one or more of ${PRIMARY_TAGS.join(', ')}. secondary_tags: free-form descriptive words.

If the page carries no storable fact, return an empty entries array.`

/** Embedding cache keyed on model + sha256(text). A cache, never a source of truth. */
type Cache = Record<string, number[]>

function loadCache(path: string): Cache {
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Cache)
      : {}
  } catch {
    console.warn('[ingest] embedding cache unreadable, ignoring it')
    return {}
  }
}

async function embedOne(
  text: string,
  cache: Cache,
  stats: { hits: number; misses: number },
): Promise<number[]> {
  const key = `${EMBEDDING_MODEL}:${createHash('sha256').update(text).digest('hex')}`
  const cached = cache[key]
  if (cached !== undefined) {
    stats.hits += 1
    return cached
  }
  stats.misses += 1
  let r = await embedText(text, 'document')
  if (!r.ok) r = await embedText(text, 'document')
  if (!r.ok) throw new Error(`embed failed: ${r.error}`)
  cache[key] = r.data.embedding
  return r.data.embedding
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  console.log(`[ingest] discovering ${args.site} ...`)
  const discovered = await discover(args.site)
  const urlRecords: UrlRecord[] = [...discovered.records]
  let pages = discovered.pages
  if (args.limit !== null) {
    for (const p of pages.slice(args.limit)) {
      urlRecords.push({
        url: p.url,
        disposition: 'excluded_by_rule',
        reason: `beyond --limit ${args.limit}`,
        entriesKept: 0,
      })
    }
    pages = pages.slice(0, args.limit)
  }
  console.log(
    `[ingest] ${pages.length} pages to fetch; ${urlRecords.length} urls already dispositioned`,
  )

  const entryRecords: EntryRecord[] = []
  const links: Array<{ label: string; url: string }> = []
  const pending: Array<{ proposal: Proposal; record: EntryRecord }> = []

  for (const page of pages) {
    let text: string
    try {
      text =
        page.kind === 'product'
          ? await productText(page.url)
          : htmlToText(await fetchText(page.url))
    } catch (e) {
      console.warn(`[ingest] FETCH FAILED ${page.url}: ${e}`)
      urlRecords.push({
        url: page.url,
        disposition: 'page_fetch_failed',
        reason: e instanceof Error ? e.message : String(e),
        entriesKept: 0,
      })
      continue
    }

    const originalLength = text.length
    const truncated = originalLength > MAX_PAGE_CHARS
    if (truncated) text = text.slice(0, MAX_PAGE_CHARS)

    let result: z.infer<typeof PageEntriesSchema>
    try {
      const { object } = await generateObject({
        model: getGenerationModel(),
        schema: PageEntriesSchema,
        temperature: 0,
        system: SYSTEM,
        prompt: `URL: ${page.url}\nPAGE TYPE: ${page.kind}\n\n${text}`,
      })
      result = object
    } catch (e) {
      console.warn(`[ingest] MODEL FAILED ${page.url}: ${e}`)
      urlRecords.push({
        url: page.url,
        disposition: 'model_failed',
        reason: e instanceof Error ? e.message : String(e),
        entriesKept: 0,
        ...(truncated ? { truncatedFrom: originalLength } : {}),
      })
      continue
    }

    if (result.entries.length === 0) {
      urlRecords.push({
        url: page.url,
        disposition: 'no_storable_fact',
        reason: 'model returned an empty entries array',
        entriesKept: 0,
        ...(truncated ? { truncatedFrom: originalLength } : {}),
      })
      console.log(`[ingest] ${page.url}: no storable fact`)
      continue
    }

    let kept = 0
    result.entries.forEach((e) => {
      const { content, changes } = sanitizeContent(e.content)
      const containsUrl = /https?:\/\//.test(content)
      const defects = contentDefects(content, containsUrl)
      // Hashed from the sanitized content, never the ordinal. See rowIdFor.
      const rowId = rowIdFor(page.url, content)
      const sourceRef = `web:${page.url}`
      const usableTags = e.primary_tags.filter(isPrimaryTag)
      const droppedTags = e.primary_tags.filter((t) => !isPrimaryTag(t))

      if (defects.length > 0) {
        entryRecords.push({
          rowId,
          sourceRef,
          disposition: 'dropped_defective',
          reason: defects.join(', '),
          sanitizeChanges: changes,
          droppedTags,
          content,
        })
        return
      }
      const record: EntryRecord = {
        rowId,
        sourceRef,
        disposition: 'kept',
        reason: '',
        sanitizeChanges: changes,
        droppedTags,
        content,
      }
      pending.push({
        proposal: {
          row_id: rowId,
          action: 'new',
          replaces_id: null,
          dedup_status: 'pending_dry_run',
          contains_url: containsUrl,
          primary_tags: usableTags.length > 0 ? usableTags : ['other'],
          secondary_tags: e.secondary_tags,
          content,
          source_ref: sourceRef,
          note: `auto-extracted from ${page.url}`,
        },
        record,
      })
      kept += 1
    })

    urlRecords.push({
      url: page.url,
      disposition: 'ingested',
      reason: '',
      entriesKept: kept,
      ...(truncated ? { truncatedFrom: originalLength } : {}),
    })
    console.log(
      `[ingest] ${page.url}: ${kept} entries${truncated ? ` (TEXT TRUNCATED from ${originalLength})` : ''}`,
    )
    if (page.kind !== 'collection') {
      links.push({
        label: linkLabelFor(page.url, result.page_title),
        url: page.url,
      })
    }
  }

  // ── self-dedupe ──────────────────────────────────────────────────────────
  const cachePath = join(OUTPUT_DIR, '.ingest-embedding-cache.json')
  const cache = loadCache(cachePath)
  const stats = { hits: 0, misses: 0 }
  console.log(
    `\n[ingest] embedding ${pending.length} entries for self-dedupe...`,
  )
  const candidates: DedupeCandidate[] = []
  for (const p of pending) {
    candidates.push({
      rowId: p.proposal.row_id,
      content: p.proposal.content,
      sourceRef: p.proposal.source_ref,
      embedding: await embedOne(p.proposal.content, cache, stats),
    })
  }
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, JSON.stringify(cache), 'utf8')
  console.log(
    `[ingest] embeddings: ${stats.hits} cached, ${stats.misses} computed`,
  )

  // The guard that stops cosine destroying facts. Reuses the loader's own
  // specifics extraction rather than a second implementation: it is the logic
  // already trusted to tell CONFLICT_CANDIDATE from BORDERLINE, and a parallel
  // copy here is the drift this repo keeps paying for.
  const mustKeepBoth = (a: string, b: string): string | null => {
    const diff = diffSpecifics(extractSpecifics(a), extractSpecifics(b))
    if (diff.numericDivergence) {
      return `numeric specifics differ (shared tokens ${diff.sharedNumericCount})`
    }
    // Proper nouns need normalising before they mean anything. Raw, this
    // branch fired on "Mils" against "Mil's" and on "Coffee" against
    // "California" - two restatements of one fact, saved by an apostrophe.
    // Possessives and case are noise, and the venue's own name plus bare
    // geography are carried by almost every entry, so they cannot distinguish
    // two of them.
    const GENERIC = new Set([
      'le',
      'mil',
      'mils',
      'coffee',
      'california',
      'india',
      'blend',
      'bundle',
      'premium',
      'filter',
      'san',
      'francisco',
      'berkeley',
    ])
    const norm = (names: readonly string[]): Set<string> =>
      new Set(
        names
          .map((n) =>
            n
              .toLowerCase()
              .replace(/['’]s$/, '')
              .replace(/['’]/g, ''),
          )
          .filter((n) => n.length > 2 && !GENERIC.has(n)),
      )
    const left = norm(diff.onlyLeft.properNouns ?? [])
    const right = norm(diff.onlyRight.properNouns ?? [])
    if (left.size > 0 && right.size > 0) {
      return `each names something the other does not (${[...left].join('/')} vs ${[...right].join('/')})`
    }
    return null
  }

  const deduped = selfDedupe(candidates, {
    threshold: args.dedupeAt,
    nearMissAt: args.nearMissAt,
    mustKeepBoth,
  })
  const droppedById = new Map(deduped.dropped.map((d) => [d.rowId, d]))
  const proposals: Proposal[] = []
  for (const p of pending) {
    const drop = droppedById.get(p.proposal.row_id)
    if (drop !== undefined) {
      entryRecords.push({
        ...p.record,
        disposition: 'dropped_self_duplicate',
        reason: `restates ${drop.duplicateOf} at ${drop.score.toFixed(4)} (>= ${args.dedupeAt})`,
      })
      continue
    }
    entryRecords.push(p.record)
    proposals.push(p.proposal)
  }

  // ── artifacts ────────────────────────────────────────────────────────────
  const proposalsPath = join(
    OUTPUT_DIR,
    `${args.venueSlug}-site-proposals.json`,
  )
  const linksPath = join(OUTPUT_DIR, `${args.venueSlug}-site-links.json`)
  const manifestPath = join(OUTPUT_DIR, `${args.venueSlug}-site-manifest.json`)
  mkdirSync(dirname(proposalsPath), { recursive: true })

  const keptLinks = links.filter((l) =>
    proposals.some((p) => p.source_ref === `web:${l.url}`),
  )

  writeFileSync(
    proposalsPath,
    JSON.stringify(
      {
        venue_slug: args.venueSlug,
        prepared: new Date().toISOString(),
        rules: {
          source: `crawled from ${args.site} via sitemap.xml`,
          locale_variants: 'excluded: same content under /xx-xx/ paths',
          agents_md:
            'excluded: Shopify agent-commerce boilerplate, not venue knowledge',
          collections:
            'excluded: product lists carry no fact the product pages do not',
          self_dedupe: `entries restating an earlier entry at >= ${args.dedupeAt} cosine were dropped; see the manifest`,
          manifest: `every url and entry disposition is in ${manifestPath}`,
        },
        entries: proposals,
      },
      null,
      2,
    ),
    'utf8',
  )
  writeFileSync(linksPath, JSON.stringify(keptLinks, null, 2), 'utf8')

  const urlCounts = urlRecords.reduce<Record<string, number>>((acc, r) => {
    acc[r.disposition] = (acc[r.disposition] ?? 0) + 1
    return acc
  }, {})
  const entryCounts = entryRecords.reduce<Record<string, number>>((acc, r) => {
    acc[r.disposition] = (acc[r.disposition] ?? 0) + 1
    return acc
  }, {})
  const failures = urlRecords.filter(
    (r) => URL_DISPOSITION_IS_FAILURE[r.disposition],
  )
  const truncatedPages = urlRecords.filter((r) => r.truncatedFrom !== undefined)

  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        venueSlug: args.venueSlug,
        site: args.site,
        generatedAt: new Date().toISOString(),
        thresholds: { dedupeAt: args.dedupeAt, nearMissAt: args.nearMissAt },
        maxPageChars: MAX_PAGE_CHARS,
        urlCounts,
        entryCounts,
        failures,
        truncatedPages,
        selfDuplicatesDropped: deduped.dropped,
        keptForDistinctSpecifics: deduped.keptForDistinctSpecifics,
        nearMisses: deduped.nearMisses,
        urls: urlRecords.sort((a, b) => a.url.localeCompare(b.url)),
        entries: entryRecords.sort((a, b) => a.rowId.localeCompare(b.rowId)),
      },
      null,
      2,
    ),
    'utf8',
  )

  // ── summary: failures FIRST, before any count that could read as success ──
  console.log(`\n${'='.repeat(72)}`)
  if (failures.length > 0) {
    console.log(
      `[ingest] ${failures.length} PAGE FAILURE(S) - this crawl is INCOMPLETE:`,
    )
    for (const f of failures)
      console.log(`    ${f.disposition}: ${f.url} (${f.reason})`)
  }
  if (truncatedPages.length > 0) {
    console.log(
      `[ingest] ${truncatedPages.length} page(s) TRUNCATED at ${MAX_PAGE_CHARS} chars - facts past the cut were never seen:`,
    )
    for (const t of truncatedPages)
      console.log(`    ${t.url} (${t.truncatedFrom} chars)`)
  }

  console.log(`\n[ingest] url dispositions:`)
  for (const [k, v] of Object.entries(urlCounts).sort())
    console.log(`    ${k}: ${v}`)
  console.log(`[ingest] entry dispositions:`)
  for (const [k, v] of Object.entries(entryCounts).sort())
    console.log(`    ${k}: ${v}`)

  if (deduped.dropped.length > 0) {
    console.log(
      `\n[ingest] self-duplicates dropped (worst first), full texts in the manifest:`,
    )
    for (const d of [...deduped.dropped]
      .sort((a, b) => b.score - a.score)
      .slice(0, 15)) {
      console.log(`    ${d.score.toFixed(4)} ${d.rowId}`)
      console.log(`        dropped: ${d.content.slice(0, 110)}`)
      console.log(`        kept   : ${d.duplicateOfContent.slice(0, 110)}`)
    }
    if (deduped.dropped.length > 15)
      console.log(`    ... ${deduped.dropped.length - 15} more in the manifest`)
  }
  if (deduped.keptForDistinctSpecifics.length > 0) {
    console.log(
      `\n[ingest] ${deduped.keptForDistinctSpecifics.length} entr(ies) above ${args.dedupeAt} KEPT because their specifics differ.`,
    )
    console.log(
      `          A cosine-only rule would have destroyed these. Sample:`,
    )
    for (const k of [...deduped.keptForDistinctSpecifics]
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)) {
      console.log(`    ${k.score.toFixed(4)} ${k.rowId} - ${k.reason}`)
      console.log(`        kept : ${k.content.slice(0, 105)}`)
      console.log(`        vs   : ${k.againstContent.slice(0, 105)}`)
    }
  }
  if (deduped.nearMisses.length > 0) {
    console.log(
      `\n[ingest] ${deduped.nearMisses.length} near-miss pair(s) between ${args.nearMissAt} and ${args.dedupeAt}, KEPT - review if the bar looks wrong`,
    )
  }

  console.log(`\n[ingest] entries written: ${proposals.length}`)
  console.log(`[ingest] links written:   ${keptLinks.length}`)
  console.log(`[ingest] proposals -> ${proposalsPath}`)
  console.log(`[ingest] links     -> ${linksPath}`)
  console.log(`[ingest] manifest  -> ${manifestPath}`)
  console.log(
    `\n[ingest] NOTHING WAS WRITTEN TO THE DATABASE. Next, the dry run:\n` +
      `  npm run load-venue-knowledge -- --venue ${args.venueSlug} --input ${proposalsPath}`,
  )

  if (failures.length > 0 || truncatedPages.length > 0) {
    console.error(
      `\n[ingest] EXIT 1: ${failures.length} failure(s), ${truncatedPages.length} truncation(s). ` +
        `A partial crawl must not be read as a complete one.`,
    )
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
