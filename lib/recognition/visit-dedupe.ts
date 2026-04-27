import { formatInTimeZone } from 'date-fns-tz'

/**
 * Internal: dedupe a list of ISO timestamps to one entry per local calendar
 * day in the given timezone. Returns a sorted ascending list of Date objects,
 * each set to midnight UTC of the local YYYY-MM-DD.
 *
 * Pure function — no I/O. Used by load-signals to count visits and to compute
 * inter-visit interval variance for the recognition consistency multiplier.
 */
export function dedupeVisitsByLocalDate(
  occurredAtIso: string[],
  timezone: string,
): Date[] {
  const localDateSet = new Set<string>()
  for (const iso of occurredAtIso) {
    localDateSet.add(formatInTimeZone(iso, timezone, 'yyyy-MM-dd'))
  }
  return Array.from(localDateSet)
    .sort()
    .map((d) => new Date(d))
}