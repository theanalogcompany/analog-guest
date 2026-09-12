/**
 * TAC-347 Stage 4 follow-up. The Report/Run tabs used to be a single
 * reused tab per sheet (writeTabValues clears-then-writes), so every run
 * destroyed the previous run's result set — a 455-scenario run was lost
 * this way. Each run now writes to its own timestamped tab
 * (`${prefix} YYYY-MM-DD HH-MM`), and old tabs beyond a retention count are
 * pruned. Pure: no Sheets API here — see drive.ts's pruneTabsByPrefix for
 * the orchestration (list tabs, compute deletions via this module, delete).
 *
 * Hyphen, not colon, in the time component: Google Sheets tab titles
 * reject `: \ / ? * [ ]`, and a colon in the timestamp would fail the
 * addSheet call mid-run.
 */

const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/

export function buildTimestampedTabName(prefix: string, runDateIso: string): string {
  const m = TIMESTAMP_RE.exec(runDateIso)
  if (!m) {
    throw new Error(`buildTimestampedTabName: runDateIso "${runDateIso}" is not a recognizable ISO timestamp`)
  }
  return `${prefix} ${m[1]} ${m[2]}-${m[3]}`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Which of `existingTitles` (all tabs currently on the sheet) should be
 * deleted to keep at most `keep` timestamped tabs under `prefix`. Only
 * tabs matching the exact `${prefix} YYYY-MM-DD HH-MM` shape are
 * considered — a legacy plain "Report"/"Run" tab from before this change,
 * or an unrelated tab, is never touched. Matching tabs sort lexicographically
 * in chronological order (fixed-width, zero-padded) with no Date parsing
 * needed; the oldest excess tabs (beyond `keep`, from the front) are returned.
 */
export function selectTabsToDelete(existingTitles: readonly string[], prefix: string, keep: number): string[] {
  const re = new RegExp(`^${escapeRegExp(prefix)} \\d{4}-\\d{2}-\\d{2} \\d{2}-\\d{2}$`)
  const matching = [...existingTitles].filter((t) => re.test(t)).sort()
  if (matching.length <= keep) return []
  return matching.slice(0, matching.length - keep)
}
