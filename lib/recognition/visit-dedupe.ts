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

/**
 * The visit days that count toward recognition: today's own day counts only
 * when the guest has an EARLIER visit day in the list.
 *
 * Ruled 2026-10-07 after the counter phone test: the visit that is happening
 * must never make a guest "returning". Without this, one visit dated today
 * scored recency 100 x 0.25 = 25, which is the `returning` threshold on its
 * own, so a guest's enrolment scan made them `returning` on their first
 * message and they were welcomed back. With an earlier day on file today
 * counts as before, so a regular who is in today loses nothing.
 *
 * "EARLIER" MEANS EARLIER IN THE LIST, and the list is the 90-day window. A
 * guest last in 95 days ago who is in today counts zero and reads `new` for
 * the day, where they read `returning` before. That follows from the rule as
 * ruled, which was about first-timers; nobody has ruled on the lapsed guest.
 *
 * `visitDates` is dedupeVisitsByLocalDate's output (midnight UTC of the local
 * day), so the ISO date of each entry IS its local day key. Pure.
 */
export function visitDaysThatCount(
  visitDates: Date[],
  todayLocalDate: string,
): Date[] {
  const hasEarlierDay = visitDates.some(
    (d) => d.toISOString().slice(0, 10) < todayLocalDate,
  )
  return hasEarlierDay ? visitDates : []
}
