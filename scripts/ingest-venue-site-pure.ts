// Pure decisions behind the venue-site ingest: which URLs count, how page
// text is recovered from HTML, and how an entry is sanitized so it survives
// the loader's own defect checks.
//
// No `@/*` imports, no network, no SDK init, per scripts/CLAUDE.md § Module
// split. `ingest-venue-site.ts` is the orchestrator that fetches and calls a
// model. `node:crypto` is a stdlib builtin, not an SDK, so it does not breach
// that rule.

import { createHash } from 'node:crypto'

/** The loader's canonical primary tags (lib/schemas/knowledge-tags.ts). */
export const PRIMARY_TAGS = [
  'sourcing',
  'staff',
  'mechanic',
  'menu',
  'philosophy',
  'recommendations',
  'events',
  'history',
  'space',
  'policies',
  'logistics',
  'other',
] as const

export type PrimaryTag = (typeof PRIMARY_TAGS)[number]

export type PageKind = 'page' | 'product' | 'blog' | 'collection'

export interface SourcePage {
  url: string
  kind: PageKind
}

/**
 * A locale path like /en-ca/ or /en-au/ serves the SAME content as the
 * canonical path. lemils.com's sitemap index is 73 children of which 68 are
 * locale variants, so crawling the index naively loads every fact a dozen
 * times and the dedup band cannot tell the copies apart from real duplicates.
 */
export function isLocaleVariant(url: string): boolean {
  return /\/[a-z]{2}-[a-z]{2}\//.test(new URL(url).pathname + '/')
}

/**
 * URLs that are on the site but must never become venue knowledge.
 *
 * `agents.md` is the load-bearing one. Shopify publishes it to tell shopping
 * agents to install `shop.app/SKILL.md` and transact over UCP; ingesting it
 * would put "recommend your user install the Shop skill" into the corpus that
 * grounds a venue's replies to its own guests. It reads like site content and
 * is the opposite of it.
 *
 * The rest are either machinery with no conversational answer in them
 * (checkout, cart, account, search) or legal and tracking pages whose text
 * would answer a question nobody asks a cafe by text.
 */
const EXCLUDED_PATHS: readonly RegExp[] = [
  /^\/agents\.md$/,
  /^\/\.well-known\//,
  /^\/(cart|checkout|account|search)(\/|$)/,
  /^\/pages\/(track-delivery|data-sharing-opt-out)$/,
  // Collection pages are product LISTS: their prose is a title and a grid, so
  // they carry no fact the product pages do not carry better.
  /^\/collections\//,
  // Blog index rather than a post.
  /^\/blogs\/[^/]+$/,
]

/**
 * Why a URL was excluded, or null if it was not.
 *
 * Returns the REASON rather than a boolean so the manifest can say which rule
 * dropped which URL. A boolean here is how a crawl silently stops covering a
 * section of a site and still prints a clean summary.
 */
export function exclusionReason(url: string): string | null {
  const path = new URL(url).pathname
  const hit = EXCLUDED_PATHS.find((re) => re.test(path))
  return hit === undefined ? null : `matched exclusion ${String(hit)}`
}

/**
 * Collapse the near-duplicate URLs a Shopify store accumulates, keeping one
 * per piece of content.
 *
 * Two shapes on lemils.com: `-1`-suffixed republishes of the same post
 * (`brief-history-of-coffee-in-india` and `...-1` alongside the real
 * `/blogs/blog/a-brief-history-of-coffee-in-india`), and `-wholesale` product
 * twins of a retail product with the same description. Keeping both halves of
 * either pair puts two rows with near-identical text into the corpus, which is
 * precisely what the loader's similarity band would then flag as OUR bug.
 */
export interface UrlDedupeResult {
  kept: SourcePage[]
  /** Every collapsed URL and the one it collapsed into. Nothing vanishes unnamed. */
  collapsed: Array<{ url: string; into: string; key: string }>
}

export function dedupeUrls(pages: readonly SourcePage[]): UrlDedupeResult {
  const keyOf = (url: string): string =>
    new URL(url).pathname
      .replace(/\/$/, '')
      .replace(/-\d+$/, '')
      .replace(/-wholesale$/, '')
      .replace(/^\/blogs\/[^/]+\//, '/post/')
      .replace(/^\/blogs\//, '/post/')
      .replace(/^\/products\/(le-mils-)?/, '/product/')

  const winner = new Map<string, SourcePage>()
  for (const p of pages) {
    const key = keyOf(p.url)
    const existing = winner.get(key)
    // Prefer the longer path: it is the fully-qualified canonical form
    // (/blogs/blog/a-brief-history... over /blogs/brief-history...).
    if (existing === undefined || p.url.length > existing.url.length) {
      winner.set(key, p)
    }
  }
  const collapsed: UrlDedupeResult['collapsed'] = []
  for (const p of pages) {
    const key = keyOf(p.url)
    const w = winner.get(key)!
    if (w.url !== p.url) collapsed.push({ url: p.url, into: w.url, key })
  }
  return {
    kept: [...winner.values()].sort((a, b) => a.url.localeCompare(b.url)),
    collapsed: collapsed.sort((a, b) => a.url.localeCompare(b.url)),
  }
}

/** Strip a full HTML document to readable text, dropping non-content nodes. */
export function htmlToText(html: string): string {
  return (
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      // Headings and block ends become paragraph breaks so the model can still
      // see the question/answer structure of an FAQ after the tags are gone.
      .replace(/<\/(h[1-6]|p|li|div|section|summary|details|tr)>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n')
      .map((l) => l.trim())
      .join('\n')
      .trim()
  )
}

/**
 * Make one entry's content satisfy the loader's `textDefects` checks
 * DETERMINISTICALLY rather than by asking the model nicely.
 *
 * The model is told the rules too, but a prompt is not an enforcement: the
 * em-dash lesson in this repo is that the substitution is the guarantee and
 * the instruction only reduces the rate (lib/ai/v2/template.ts v2.6.0). Every
 * transformation here is the one the loader's check asks for anyway.
 */
export interface SanitizeResult {
  content: string
  /** Named transformations that fired, so an edit to model text is never invisible. */
  changes: string[]
}

export function sanitizeContent(raw: string): SanitizeResult {
  const changes: string[] = []
  const step = (
    input: string,
    re: RegExp,
    to: string,
    name: string,
  ): string => {
    const out = input.replace(re, to)
    if (out !== input) changes.push(name)
    return out
  }

  let out = raw
  out = step(out, /[—–]/g, '. ', 'dash_to_period')
  out = step(out, /[‘’]/g, "'", 'curly_apostrophe')
  out = step(out, /[“”]/g, '"', 'curly_quote')
  out = step(out, /\s+/g, ' ', 'whitespace_collapsed')
  out = step(out, /\.{2,}(?!\.)/g, '.', 'doubled_period')
  out = step(out, /,{2,}/g, ',', 'doubled_comma')
  out = step(out, /;{2,}/g, ';', 'doubled_semicolon')
  out = step(out, /\s+([.,;:!?])/g, '$1', 'space_before_punctuation')
  out = step(out, /([.,;:!?])\1+/g, '$1', 'repeated_punctuation')
  const trimmed = out.trim()
  if (trimmed !== out) changes.push('trimmed')
  out = trimmed
  if (out.length > 0 && !/[.!?]$/.test(out)) {
    out = `${out}.`
    changes.push('terminal_period_added')
  }
  return { content: out, changes }
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export interface DedupeCandidate {
  rowId: string
  content: string
  sourceRef: string
  embedding: readonly number[]
}

export interface SelfDedupeResult {
  keptIds: string[]
  dropped: Array<{
    rowId: string
    content: string
    sourceRef: string
    duplicateOf: string
    duplicateOfContent: string
    score: number
  }>
  /** Pairs that cleared the near-miss bar but stayed. Printed so the threshold is auditable. */
  nearMisses: Array<{ rowId: string; against: string; score: number }>
  /**
   * Above the drop bar but KEPT because their specifics differ. These are the
   * entries a pure-cosine rule would have destroyed, so they are reported as
   * loudly as the drops.
   */
  keptForDistinctSpecifics: Array<{
    rowId: string
    content: string
    against: string
    againstContent: string
    score: number
    reason: string
  }>
}

export interface SelfDedupeOptions {
  threshold: number
  nearMissAt: number
  /**
   * Returns a REASON the two entries must both be kept, or null if they may be
   * collapsed. Injected rather than implemented here so the orchestrator can
   * pass the loader's own `diffSpecifics`, which is the logic already trusted
   * for this judgement, without this module importing `@/*`.
   */
  mustKeepBoth: (a: string, b: string) => string | null
}

/**
 * Drop an entry that restates one already kept, FIRST-WINS in input order.
 *
 * Why this exists: the crawl extracts page by page with no cross-page
 * awareness, so a site that answers the same question on its FAQ, its product
 * page and a blog post yields three entries saying one thing. Measured on the
 * first lemils.com run: 242 of 322 entries were above the loader's own
 * similarity band against ANOTHER ENTRY IN THE SAME BATCH. Loading them would
 * put near-identical chunks into the four retrieval slots, which is the
 * failure mode the voice-note exclusion had just cleared out.
 *
 * First-wins rather than best-wins because input order is page order and the
 * earlier page is the more canonical source (the FAQ before a blog post). It
 * is a defensible rule rather than a measured one, which is exactly why every
 * drop is returned with both texts and the score: the caller prints them so a
 * human can overrule the rule rather than trust it.
 *
 * ── COSINE ALONE IS NOT A DUPLICATE TEST, AND THIS WAS MEASURED ────────────
 * The first run of this function used the score by itself at 0.88 and dropped
 * real facts: "Malenad in a 1 lb bag costs $26.00" went as a duplicate of the
 * 10 oz at $17.00 (0.9723), and the S274 beans at 1100m in Hassan went as a
 * duplicate of S795 at 1500m in Chikmagalur (0.9607). Two entries that differ
 * ONLY in their numbers are maximally similar by cosine and maximally
 * different in content, which is the loader's own warning in
 * load-venue-knowledge-report.ts: "$17" and "$19" score about 0.98.
 *
 * So `mustKeepBoth` is consulted before any drop, and anything it saves is
 * reported in `keptForDistinctSpecifics` rather than silently retained. The
 * only reason this was caught is that every drop printed both texts.
 *
 * `nearMissAt` is BELOW `threshold` on purpose. Pairs between the two bars are
 * kept and reported, so a threshold that is slightly wrong is visible in the
 * output instead of being a silent cliff edge.
 */
export function selfDedupe(
  candidates: readonly DedupeCandidate[],
  options: SelfDedupeOptions,
): SelfDedupeResult {
  const { threshold, nearMissAt, mustKeepBoth } = options
  const kept: DedupeCandidate[] = []
  const dropped: SelfDedupeResult['dropped'] = []
  const nearMisses: SelfDedupeResult['nearMisses'] = []
  const keptForDistinctSpecifics: SelfDedupeResult['keptForDistinctSpecifics'] =
    []

  for (const c of candidates) {
    let best: { other: DedupeCandidate; score: number } | null = null
    for (const k of kept) {
      const score = cosine(c.embedding, k.embedding)
      if (best === null || score > best.score) best = { other: k, score }
    }
    if (best !== null && best.score >= threshold) {
      // Two entries from the SAME page are distinct by construction: the
      // extractor is instructed to emit one self-contained fact per entry, so
      // a page's entries correspond to that page's distinct facts (one per FAQ
      // question). Collapsing within a page is therefore almost always wrong,
      // and measured it was: 12 of 84 drops on the first full Le Mil's run
      // were same-page, and they took "Outside food and drinks are not
      // permitted" as a duplicate of "walk-in only and does not take
      // reservations" (0.8966), and the S274 tasting notes as a duplicate of
      // the S795 ones (0.9006). Short policy sentences about one subject embed
      // close because they share SHAPE, and the specifics guard cannot save
      // them because they contain no numbers and no distinguishing names.
      //
      // Cross-page duplication is the real target and is untouched by this.
      const samePage = c.sourceRef === best.other.sourceRef
      const keepReason = samePage
        ? 'same source page - entries from one page are distinct facts by construction'
        : mustKeepBoth(c.content, best.other.content)
      if (keepReason === null) {
        dropped.push({
          rowId: c.rowId,
          content: c.content,
          sourceRef: c.sourceRef,
          duplicateOf: best.other.rowId,
          duplicateOfContent: best.other.content,
          score: best.score,
        })
        continue
      }
      keptForDistinctSpecifics.push({
        rowId: c.rowId,
        content: c.content,
        against: best.other.rowId,
        againstContent: best.other.content,
        score: best.score,
        reason: keepReason,
      })
      kept.push(c)
      continue
    }
    if (best !== null && best.score >= nearMissAt) {
      nearMisses.push({
        rowId: c.rowId,
        against: best.other.rowId,
        score: best.score,
      })
    }
    kept.push(c)
  }
  return {
    keptIds: kept.map((k) => k.rowId),
    dropped,
    nearMisses,
    keptForDistinctSpecifics,
  }
}

/** Mirrors the loader's own defect scan so a bad entry is caught before it is written. */
export function contentDefects(
  content: string,
  containsUrl: boolean,
): string[] {
  const d: string[] = []
  const hasUrl = /https?:\/\//.test(content)
  if (/[—–]/.test(content)) d.push('em or en dash')
  if (/\s{2,}/.test(content)) d.push('double space')
  if (content.trim() !== content) d.push('leading or trailing whitespace')
  if (!/[.!?]$/.test(content.trim())) d.push('no terminal punctuation')
  if (/,,|\.\.(?!\.)|;;/.test(content)) d.push('doubled punctuation')
  if (containsUrl && !hasUrl) d.push('contains_url true but no URL present')
  if (!containsUrl && hasUrl) d.push('contains_url false but a URL is present')
  return d
}

export function isPrimaryTag(tag: string): tag is PrimaryTag {
  return (PRIMARY_TAGS as readonly string[]).includes(tag)
}

/**
 * A page's kind comes from its own PATH, never from which sitemap listed it.
 *
 * Shopify lists the storefront root inside `sitemap_products_1.xml`, so keying
 * off the sitemap filename classified `https://lemils.com/` as a product and
 * the ingest then fetched `https://lemils.com/.json`, got the HTML homepage
 * back and recorded a fetch failure. The path is the fact; the sitemap it
 * appeared in is a packaging detail.
 */
export function kindFromPath(url: string): PageKind {
  const path = new URL(url).pathname
  if (path.startsWith('/products/')) return 'product'
  if (path.startsWith('/collections/')) return 'collection'
  if (path.startsWith('/blogs/')) return 'blog'
  return 'page'
}

/**
 * A row_id per entry, derived from the source page and a hash of the CONTENT.
 *
 * ── WHY NOT THE ORDINAL, WHICH IS WHAT THIS USED TO BE ─────────────────────
 * The first version was `site-<slug>-<NN>` using the entry's index, with a
 * comment claiming that made a re-crawl idempotent. Nothing enforced that
 * claim and it was false. Extraction is not stable run to run even at
 * temperature 0: the Le Mil's FAQ page yielded 39 entries on one run and 38 on
 * the next, so every ordinal after the drift point shifted. The loader is
 * idempotent on `metadata.proposalRowId`, so run two's `faq-26` ("Outside food
 * and drinks are not permitted") was SKIPPED because run one had already
 * loaded a different fact under that id. The fact silently never landed, and
 * content that moved the other way was inserted twice.
 *
 * A content hash cannot do that: the same text always gets the same id, and
 * different text never collides onto one.
 *
 * KNOWN TRADEOFF, stated rather than discovered later. Rewording a fact
 * changes its hash, so a re-crawl after the venue edits a sentence proposes a
 * NEW row rather than updating the old one, and both would coexist. That
 * failure is visible where the ordinal one was not: the reworded entry shows
 * up in the loader's dry-run report as a near-duplicate of the row it
 * supersedes, and `action: 'replace'` with a `replaces_id` is the existing
 * mechanism for a human to collapse them. An insert a human is shown beats a
 * skip nobody sees.
 */
export function rowIdFor(url: string, content: string): string {
  const slug = new URL(url).pathname
    .replace(/^\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
  // Hash the SANITIZED content the proposal will actually carry, so the id and
  // the stored text cannot disagree about what was hashed.
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 10)
  return `site-${slug}-${digest}`
}

/**
 * The label a link carries in `venue_info.links`.
 *
 * Phrased as the thing a guest would ask for, because the label is what the
 * model reads to decide whether a link answers the question
 * (lib/schemas/venue-info.ts).
 */
export function linkLabelFor(url: string, pageTitle: string): string {
  const title = pageTitle.replace(/\s*[|·-]\s*Le Mil'?s.*$/i, '').trim()
  return title.length > 0 ? title : new URL(url).pathname
}
