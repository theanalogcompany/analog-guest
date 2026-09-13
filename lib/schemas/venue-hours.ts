import type { VenueInfo } from './venue-info'

/**
 * TAC-301: interpret `venue_info.hours` against the current venue-local moment
 * so the `## Right now` prompt block can state whether the venue is OPEN or
 * CLOSED, not just what time it is.
 *
 * Why this exists: the agent had both inputs already — the full weekly hours
 * (rendered by `venueInfoToProse`, system prompt) and the venue-local clock
 * (rendered by `formatRightNow`, user prompt) — and still confirmed an
 * imminent arrival at a venue that had been closed for five hours. Nothing in
 * the approval-trigger set keys on time, so that reply auto-sends. Asking the
 * model to bridge a free-text en-dashed range against a 24h clock across two
 * prompt sections, unprompted, mid-commitment, is the thing that failed. This
 * module does that join in code and hands the model the answer.
 *
 * Pure and dependency-free apart from the VenueInfo type, so it loads in
 * vitest with no SDK init. Sibling to venue-info.ts, which already hosts the
 * other pure interpreters of venue_info fields (classifyContextEntry,
 * filterActiveContext).
 *
 * THE GOVERNING RULE, and the one to preserve through any future edit:
 * never claim CLOSED on input this module did not positively understand.
 * Telling an open venue's guests it is closed is worse than the bug being
 * fixed — the original needs a specific arrival phrasing to surface, while a
 * bad "we're closed" fires on every turn at that venue. Every ambiguous branch
 * below resolves to 'unknown', which renders nothing at all.
 */

const DAY_KEYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const satisfies ReadonlyArray<keyof VenueInfo['hours']>

type DayKey = (typeof DAY_KEYS)[number]

/** Minutes since local midnight. */
export type DayRange = {
  openMin: number
  closeMin: number
  /** True when the range crosses midnight (e.g. 5:00 PM – 2:00 AM). */
  overnight: boolean
}

export type OpenState =
  | { state: 'open'; closesAt: string }
  | { state: 'closed'; opensAt: { day: string; time: string } | null }
  | { state: 'unknown' }

/**
 * Separators accepted between the two times. The canonical shape written by
 * `parseHoursFromSection2` (scripts/onboarding/parse-venue-spec.ts) is an EN
 * DASH with surrounding spaces; the others are here because the admin venue
 * page lets an operator retype this field by hand and a hyphen is what most
 * people reach for.
 */
const RANGE_SEPARATOR = /\s*[–—-]\s*|\s+to\s+/i

/** Trailing per-row note the venue-spec parser appends, e.g. "(kitchen closes 2)". */
const TRAILING_NOTE = /\s*\([^)]*\)\s*$/

const TIME_PATTERN = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i

/**
 * One parsed clock time. `explicit` records whether the input said WHICH HALF
 * OF THE DAY it meant — either by carrying a meridiem, or by being an
 * unambiguous 24-hour value (zero-padded, or past noon). A bare "3" is not
 * explicit: it could be 03:00 or 15:00.
 *
 * That distinction is load-bearing for descending pairs. See parseDayRange.
 */
type ParsedTime = { minutes: number; explicit: boolean }

/**
 * Parse one clock time to minutes since midnight. Returns null on anything it
 * cannot read with confidence.
 */
function parseTime(raw: string): ParsedTime | null {
  const trimmed = raw.trim()
  const match = TIME_PATTERN.exec(trimmed)
  if (!match) return null

  const hourRaw = Number(match[1])
  const minute = match[2] === undefined ? 0 : Number(match[2])
  const meridiem = match[3]?.toLowerCase()

  if (!Number.isInteger(hourRaw) || !Number.isInteger(minute)) return null
  if (minute > 59) return null

  let hour = hourRaw
  if (meridiem) {
    // 12-hour clock: 12am is 00:xx, 12pm is 12:xx.
    if (hour < 1 || hour > 12) return null
    if (meridiem === 'am') hour = hour === 12 ? 0 : hour
    else hour = hour === 12 ? 12 : hour + 12
  } else if (hour > 23) {
    return null
  }

  // Zero-padded ("07") or past noon ("17") can only be 24-hour. A bare
  // single-digit hour with no meridiem is ambiguous.
  const explicit =
    meridiem !== undefined || hourRaw > 12 || /^0\d/.test(match[1]) || hourRaw === 0

  return { minutes: hour * 60 + minute, explicit }
}

/**
 * Parse a single day's hours string into a minute range. Returns null for
 * anything unreadable OR ambiguous — see the descending-pair rule below.
 *
 * Closed-day markers ("Closed", "Closed – Closed", "—") also return null here;
 * classifyDay is what distinguishes a stated closure from a broken string.
 */
export function parseDayRange(value: string | undefined): DayRange | null {
  if (!value) return null

  const cleaned = value.replace(TRAILING_NOTE, '').trim()
  if (cleaned.length === 0) return null

  const parts = cleaned.split(RANGE_SEPARATOR)
  if (parts.length !== 2) return null

  const open = parseTime(parts[0])
  const close = parseTime(parts[1])
  if (open === null || close === null) return null

  // Equal open and close is not a range we can reason about (a 24h venue and a
  // typo look identical here). Stay silent rather than guess.
  if (open.minutes === close.minutes) return null

  if (close.minutes < open.minutes) {
    // A DESCENDING pair means one of two very different things, and getting it
    // wrong is the worst failure this module can produce:
    //
    //   "5:00 PM – 2:00 AM"  a bar, genuinely open past midnight
    //   "7-3"                a cafe writing 7am-3pm in shorthand
    //
    // Read naively, the second becomes an overnight range that reports OPEN at
    // 7:57pm — the exact minute of the incident this module exists to prevent,
    // now asserted confidently in the prompt rather than merely unstated. So
    // require both sides to have said which half of the day they meant before
    // believing a venue is open past midnight. "5:00 PM – 2:00 AM" and
    // "17:00-02:00" qualify; "7-3", "9-5" and "7am-3" do not and resolve to
    // unknown, which renders nothing.
    //
    // Ascending pairs need no such evidence: "7-3pm" and "07:00-15:00" mean
    // the same thing under either reading.
    if (!open.explicit || !close.explicit) return null
    return { openMin: open.minutes, closeMin: close.minutes, overnight: true }
  }

  return { openMin: open.minutes, closeMin: close.minutes, overnight: false }
}

/**
 * Shapes that positively state "we are shut this day", as opposed to shapes
 * this parser merely failed to read.
 *
 * The canonical one matters most: `parseHoursFromSection2` composes every day
 * as `${open} – ${close}` from two table cells, so a closed day arrives as
 * "Closed – Closed", not as the bare "Closed" a hand-edit produces. Matching
 * only the hand-edit shape left the pipeline's own closed day unreadable,
 * which was the entire reason an ABSENT key used to be treated as a closure:
 * a workaround for a gap that shouldn't have existed.
 *
 * Deliberately word-like only. A bare dash or "—" is NOT here: in a spec table
 * it reads as a placeholder ("nobody filled this in") at least as often as it
 * reads as a closure, and this module does not get to guess between those.
 * Those fall through to unknown, which renders nothing.
 */
const CLOSED_MARKER = /^(closed|closed all day|n\/a)$/i

function isClosedMarker(text: string): boolean {
  return CLOSED_MARKER.test(text.trim())
}

export type DayHours =
  | { kind: 'range'; range: DayRange }
  | { kind: 'closed' }
  | { kind: 'unknown' }

/**
 * Classify one day's raw value into a range, a stated closure, or unknown.
 *
 * ABSENCE IS NOT A CLOSURE. A missing key means nobody said, and nobody-said
 * has to render as silence: `parse-venue-spec.ts` drops any table row whose
 * label it doesn't recognize ("Sat & Sun", "Weekends"), and the admin venue
 * page writes `undefined` for a cleared field, so absence is at least as
 * likely to mean incomplete data as it is to mean shut. An earlier version of
 * this module read absence as a closure and would have emitted a confident
 * "CLOSED right now, do not tell the guest to come by" all day at a venue that
 * was open. A real closure now comes in through the marker above instead.
 */
export function classifyDay(value: string | undefined): DayHours {
  if (value === undefined) return { kind: 'unknown' }

  const cleaned = value.replace(TRAILING_NOTE, '').trim()
  if (cleaned.length === 0) return { kind: 'unknown' }

  const range = parseDayRange(value)
  if (range) return { kind: 'range', range }

  if (isClosedMarker(cleaned)) return { kind: 'closed' }

  // "Closed – Closed", and the half-filled "Closed – " the table can also
  // produce. At least one side must be a real marker; the other may be blank.
  const parts = cleaned.split(RANGE_SEPARATOR)
  if (
    parts.length === 2 &&
    parts.some((p) => isClosedMarker(p)) &&
    parts.every((p) => p.trim().length === 0 || isClosedMarker(p))
  ) {
    return { kind: 'closed' }
  }

  return { kind: 'unknown' }
}

function isWithin(range: DayRange, minutes: number): boolean {
  if (!range.overnight) return minutes >= range.openMin && minutes < range.closeMin
  // Crosses midnight: open from openMin to 23:59, then 00:00 to closeMin.
  return minutes >= range.openMin || minutes < range.closeMin
}

/** Render minutes-since-midnight back to the 12-hour form venues write. */
export function formatMinutes(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440
  const hour24 = Math.floor(normalized / 60)
  const minute = normalized % 60
  const meridiem = hour24 < 12 ? 'AM' : 'PM'
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12
  return `${hour12}:${String(minute).padStart(2, '0')} ${meridiem}`
}

function dayLabel(key: DayKey): string {
  return key[0].toUpperCase() + key.slice(1)
}

/**
 * Venue-local wall clock for `now`, as {dayIndex 0-6, minutesSinceMidnight}.
 * Uses the same Intl-with-explicit-timeZone approach as computeToday in
 * lib/agent/stages.ts — this is venue-local, never server time.
 */
function venueLocalNow(timezone: string, now: Date): { dayIndex: number; minutes: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now)

    const weekday = parts.find((p) => p.type === 'weekday')?.value?.toLowerCase()
    const hourPart = parts.find((p) => p.type === 'hour')?.value
    const minutePart = parts.find((p) => p.type === 'minute')?.value
    if (!weekday || hourPart === undefined || minutePart === undefined) return null

    const dayIndex = DAY_KEYS.indexOf(weekday as DayKey)
    if (dayIndex === -1) return null

    // en-US hour12:false renders midnight as "24" in some ICU versions.
    const hour = Number(hourPart) % 24
    const minute = Number(minutePart)
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null

    return { dayIndex, minutes: hour * 60 + minute }
  } catch {
    // Invalid timezone. buildAiRuntime validates before calling, so this is
    // belt-and-braces: stay silent rather than throw into the agent loop.
    return null
  }
}

/**
 * Find the next opening at or after the given day/minute, searching up to 7
 * days forward. Returns null when nothing in the week parses — which renders
 * as "closed" with no opening claim rather than an invented one.
 */
function findNextOpening(
  hours: VenueInfo['hours'],
  fromDayIndex: number,
  fromMinutes: number,
): { day: string; time: string } | null {
  for (let offset = 0; offset < 7; offset += 1) {
    const dayIndex = (fromDayIndex + offset) % 7
    const key = DAY_KEYS[dayIndex]
    const range = parseDayRange(hours[key])
    if (!range) continue

    // Today only counts if the opening is still ahead of us.
    if (offset === 0 && range.openMin <= fromMinutes) continue

    const label = offset === 0 ? 'today' : offset === 1 ? 'tomorrow' : dayLabel(key)
    return { day: label, time: formatMinutes(range.openMin) }
  }
  return null
}

/**
 * Resolve whether the venue is open at `now`, in venue-local time.
 *
 * Every branch that isn't a positive reading lands on 'unknown':
 * - Timezone this runtime can't use → unknown.
 * - Today's value missing, blank, or unreadable → unknown. Absence is not a
 *   closure; see classifyDay for why that distinction is load-bearing.
 * - Today positively states a range → open/closed by the clock.
 * - Today positively states a closure → closed, with the next opening if one
 *   is readable.
 */
export function resolveOpenState(
  hours: VenueInfo['hours'],
  timezone: string,
  now: Date,
): OpenState {
  const local = venueLocalNow(timezone, now)
  if (!local) return { state: 'unknown' }

  const todayKey = DAY_KEYS[local.dayIndex]
  const today = classifyDay(hours[todayKey])
  if (today.kind === 'unknown') return { state: 'unknown' }

  if (today.kind === 'range' && isWithin(today.range, local.minutes)) {
    return { state: 'open', closesAt: formatMinutes(today.range.closeMin) }
  }

  // Early morning can still fall inside YESTERDAY's overnight range — a venue
  // open 5pm-2am is open at 1am on the following calendar day.
  //
  // The `local.minutes < closeMin` test is the whole point and is NOT a
  // redundant restatement of isWithin: isWithin matches an overnight range on
  // BOTH halves, so without this we'd also report open at 8pm tonight on the
  // strength of yesterday's window, at a venue that is shut today. Only the
  // post-midnight half can be inherited from yesterday.
  const yesterdayKey = DAY_KEYS[(local.dayIndex + 6) % 7]
  const yesterday = classifyDay(hours[yesterdayKey])
  if (
    yesterday.kind === 'range' &&
    yesterday.range.overnight &&
    local.minutes < yesterday.range.closeMin
  ) {
    return { state: 'open', closesAt: formatMinutes(yesterday.range.closeMin) }
  }

  return { state: 'closed', opensAt: findNextOpening(hours, local.dayIndex, local.minutes) }
}
