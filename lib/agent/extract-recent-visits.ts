// Pure helper for TAC-234 (replaces THE-229's single-visit projection):
// project an ordered set of transactions rows into the agent-facing
// `Visit[]` shape, applying the freshness cutoff and item-name extraction
// per row.
//
// Lives next to build-runtime-context.ts because that's the only consumer
// today. If a third call site appears (e.g. a guest-detail page surface
// that wants the same projection), promote to a shared `lib/transactions/`
// module.
//
// Defensive parsing: any row whose timestamp is malformed, whose age
// exceeds the cutoff, or whose raw_data yields zero recoverable item
// names is dropped silently. The caller gets back an array containing
// only well-formed visits, in the same order as the input.

const MS_PER_DAY = 24 * 60 * 60 * 1000

export type Visit = {
  // Line item names from one transaction's raw_data.line_items.
  // Lowercased, deduped case-insensitively, stripped of empty / non-string
  // entries. Always non-empty for a Visit that survives extraction.
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
 * Extract an ordered Visit[] from a set of transaction rows.
 *
 * Per-row drop conditions (silent):
 *   - occurred_at is unparseable
 *   - row is older than `cutoffDays` (default 90)
 *   - raw_data is null or its shape is unparseable
 *   - line_items contains zero recoverable item names
 *
 * Caller is expected to have already capped + ordered the rows
 * (DESC by occurred_at, limited to MAX_VISIT_HISTORY_TRANSACTIONS).
 * This helper preserves order — no reshuffling.
 *
 * Returns `[]` when the input is null/undefined/empty or when every row
 * fails the per-row checks. An empty array is meaningful: "no qualifying
 * visits to surface."
 */
export function extractRecentVisits(
  rows: readonly TransactionRow[] | null | undefined,
  now: Date = new Date(),
  cutoffDays = 90,
): Visit[] {
  if (!rows || rows.length === 0) return []

  const out: Visit[] = []
  const cutoffMs = cutoffDays * MS_PER_DAY
  const nowMs = now.getTime()

  for (const row of rows) {
    const visitedAt = new Date(row.occurred_at)
    if (Number.isNaN(visitedAt.getTime())) continue
    if (nowMs - visitedAt.getTime() > cutoffMs) continue

    const items = extractItemNames(row.raw_data)
    if (items.length === 0) continue

    out.push({ items, visitedAt })
  }

  return out
}

function extractItemNames(rawData: unknown): string[] {
  if (typeof rawData !== 'object' || rawData === null) return []
  const r = rawData as Record<string, unknown>
  const lineItems = r.line_items
  if (!Array.isArray(lineItems)) return []

  // Dedupe by lowercased name; values are stored lowercase regardless of the
  // original casing. Map preserves insertion order, so the first-seen entry
  // determines position in the output array.
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
