// Pure helper for THE-229: project a transactions row into the agent-facing
// `LastVisit` shape, applying the freshness cutoff and item-name extraction.
//
// Lives next to build-runtime-context.ts because that's the only consumer
// today. If a third call site appears (e.g. a guest-detail page surface that
// wants the same projection), promote to a shared `lib/transactions/` module.
//
// Defensive parsing: any field missing or wrong-typed is dropped silently.
// `raw_data` shape is owned by POS integrations (mock / Square / Toast); we
// don't want a malformed line item to crash the agent run, so each item is
// validated independently.

const MS_PER_DAY = 24 * 60 * 60 * 1000

export type LastVisit = {
  // Line item names from the most recent transaction's raw_data.line_items.
  // Lowercased, deduped case-insensitively, stripped of empty / non-string
  // entries. Always non-empty when LastVisit is non-null.
  items: string[]
  // The transaction's occurred_at as a Date. Renderer feeds this directly
  // into formatTimeDelta to produce "yesterday" / "N days ago".
  visitedAt: Date
}

interface TransactionRow {
  occurred_at: string
  raw_data: unknown
}

/**
 * Extract the agent-facing LastVisit projection from a transactions row.
 *
 * Returns `null` when:
 *   - row is null/undefined (no transactions on file)
 *   - the transaction is older than `cutoffDays` (default 60)
 *   - raw_data is null or its shape is unparseable
 *   - line_items contains zero recoverable item names
 *
 * The "no parseable items → null" rule means a transaction without item
 * detail doesn't surface to the agent at all. A visit with no recoverable
 * names isn't useful context to reference; better to omit than to render
 * an empty list.
 */
export function extractLastVisit(
  row: TransactionRow | null | undefined,
  now: Date = new Date(),
  cutoffDays = 60,
): LastVisit | null {
  if (!row) return null

  const visitedAt = new Date(row.occurred_at)
  // Guard against malformed timestamps so we don't surface NaN dates.
  if (Number.isNaN(visitedAt.getTime())) return null

  const ageMs = now.getTime() - visitedAt.getTime()
  if (ageMs > cutoffDays * MS_PER_DAY) return null

  const items = extractItemNames(row.raw_data)
  if (items.length === 0) return null

  return { items, visitedAt }
}

function extractItemNames(rawData: unknown): string[] {
  if (typeof rawData !== 'object' || rawData === null) return []
  const r = rawData as Record<string, unknown>
  const lineItems = r.line_items
  if (!Array.isArray(lineItems)) return []

  // Dedupe by lowercased name. Map preserves insertion order so the first
  // occurrence wins (i.e. the order Sonnet sees matches the order on the
  // ticket).
  const seen = new Map<string, string>()
  for (const item of lineItems) {
    if (typeof item !== 'object' || item === null) continue
    const name = (item as Record<string, unknown>).name
    if (typeof name !== 'string') continue
    const trimmed = name.trim()
    if (trimmed.length === 0) continue
    const lower = trimmed.toLowerCase()
    if (!seen.has(lower)) seen.set(lower, lower)
  }
  return Array.from(seen.values())
}
