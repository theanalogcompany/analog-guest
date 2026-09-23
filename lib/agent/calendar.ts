// TAC-522: the short calendar rendered into `## Right now`, so placing a
// stored date is a LOOKUP rather than arithmetic.
//
// ITS OWN MODULE, and not for tidiness. `stages.ts` constructs a Voyage client
// at module load, so a test importing it dies at collection with a `voyageai`
// ESM directory-import error and the file reports "no tests" while a full run
// still prints green. That is the split CLAUDE.md prescribes under "Module
// split for testability", and it is the only reason this pure function does
// not live beside computeToday.

/**
 * TAC-522: how many days the calendar covers, today included. Ten reaches a
 * week and a bit, which is the horizon "this Friday" and "next Tuesday" cover.
 * Measured cost is well under 1% of a real prompt; the number is pinned by a
 * test so changing it is deliberate.
 */
export const CALENDAR_DAYS = 10

/**
 * TAC-522: the next CALENDAR_DAYS days, today first, as weekday/month-day
 * pairs.
 *
 * Month-day words ("Sep 25") rather than ISO, because the calendar exists to
 * remove a conversion step and operators write "September 25, 2026" in their
 * notes, not "2026-09-25". With this form the lookup is close to a string
 * match; with ISO the model would have to map the month name onto a number
 * first, and an extra step is what failed.
 *
 * Forward only. A date that has already gone by is therefore NOT in here, and
 * recognising one is a comparison against `isoDate` rather than a lookup. That
 * limit is deliberate and recorded on TAC-522 rather than pre-empted by
 * widening the window backwards, which costs tokens on every turn.
 */
export function computeCalendar(
  timezone: string,
  now: Date,
): ReadonlyArray<{ weekday: string; monthDay: string }> {
  // CALENDAR ARITHMETIC, NOT INSTANT ARITHMETIC, and the difference is a real
  // bug rather than a theoretical one. Adding 24h to the instant and
  // formatting in the venue's zone SKIPS A DAY across a spring-forward
  // transition: at 2027-03-13 23:30 in Los Angeles the window came out
  // "Sat Mar 13, Mon Mar 15, …" with Sunday the 14th missing entirely
  // (demonstrated, not reasoned about — an earlier version of this function
  // shipped that arithmetic with a comment claiming it was safe).
  //
  // So the venue-local calendar date is resolved ONCE, and every later day is
  // pure date arithmetic on those parts. `Date.UTC` rolls months and years
  // over for us, and formatting in UTC means no zone can shift the result:
  // these are date-only labels and never instants.
  const localIso = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const [year, month, day] = localIso.split('-').map(Number)

  const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' })
  const monthDayFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  })

  const out: Array<{ weekday: string; monthDay: string }> = []
  for (let i = 0; i < CALENDAR_DAYS; i += 1) {
    const d = new Date(Date.UTC(year, month - 1, day + i))
    out.push({ weekday: weekdayFmt.format(d), monthDay: monthDayFmt.format(d) })
  }
  return out
}
