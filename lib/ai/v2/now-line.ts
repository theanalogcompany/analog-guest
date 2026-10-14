// `{now_line}` for v2's HOUSE NOTES: what time it is where the venue is.
//
// Why this exists at all (v2.20.0). The owner's hand-written prompt opened
// with a typed `#Time 10AM Oct 13, 2026.` line, and the frame it was written
// with tells the model to use the current time when it matters. Nothing in any
// v2 prompt carried one: `renderVenueProfile` has `renderRightNow`, but that
// only filters DATED `currentContext` notes, and a briefed venue does not
// render the profile at all. So the instruction pointed at a fact the prompt
// did not contain.
//
// Why it is not a literal and not in template.ts, same two reasons as
// `replyLengthClause`: the template is the global default row, and that file
// has no imports because a client component reads from it.
//
// THE WEEKDAY IS IN IT DELIBERATELY. The owner's line had only the date, and
// the question this has to survive is "are you open right now" - at Le Mil's
// weekday hours (7am-3pm) and weekend hours (8am-4pm) differ, so a date with
// no day asks the model to do calendar arithmetic it has no reason to get
// right.
//
// VENUE-LOCAL, NEVER SERVER TIME. The server runs in UTC, so a server clock
// would tell a San Francisco cafe it is late evening all morning.
//
// Returns '' on a timezone this runtime cannot use, and compose.ts renders the
// honest fallback for that. Fails to NOTHING rather than to a guess, which is
// the opposite direction from most of the section inputs and deliberately so:
// a less specific prompt costs a vaguer answer about time, while a wrong clock
// is a confident wrong answer about whether the venue is open.

/**
 * One sentence, e.g. `Monday 13 October 2026, 10:04am, venue local time.`
 *
 * @param timezone an IANA zone from `venues.timezone`
 */
export function venueNowLine(timezone: string, now: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).formatToParts(now)
    const at = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((p) => p.type === type)?.value ?? ''
    const weekday = at('weekday')
    const day = at('day')
    const month = at('month')
    const year = at('year')
    const hour = at('hour')
    const minute = at('minute')
    // An unusable zone usually throws, but a partial render would silently
    // produce ", 2026, :04am" - so every field the sentence names is required.
    if (
      weekday === '' ||
      day === '' ||
      month === '' ||
      year === '' ||
      hour === '' ||
      minute === ''
    )
      return ''
    // en-GB gives "am"/"pm" already; ICU has used thin spaces and "a.m." in
    // other locales, which is why the meridiem is written here rather than
    // read out of the parts.
    const meridiem = at('dayPeriod').toLowerCase().startsWith('p') ? 'pm' : 'am'
    return `${weekday} ${day} ${month} ${year}, ${hour}:${minute}${meridiem}, venue local time.`
  } catch {
    return ''
  }
}
