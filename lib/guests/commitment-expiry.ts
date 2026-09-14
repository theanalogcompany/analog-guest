import { classifyDay } from '@/lib/schemas/venue-hours'
import type { CommitmentType } from '@/lib/schemas/guest-commitment'
import type { VenueInfo } from '@/lib/schemas/venue-info'

/**
 * TAC-341: when does an obligation stop being owed, and when does a human
 * need to hear about it.
 *
 * Pure. Imports two schema modules for their types and one pure interpreter
 * (classifyDay) — no DB client, no SDK init at module load, so vitest can
 * load it unmocked. Deliberately NOT exported from a barrel: the horizons
 * here are the single derivation site and an extra import path is an extra
 * way for a second one to appear.
 *
 * THE GOVERNING RULE: every obligation gets a horizon at creation, and the
 * horizon is derived here and nowhere else. TAC-318 had to write a 25-line
 * comment explaining why it does NOT set expires_at on the upgrade path,
 * precisely so this file could own it. Do not add a second derivation.
 */

// ===== Scope =====

/**
 * The types this ticket governs. An obligation is something the venue OWES a
 * guest: a free drink, a held pastry, a price break.
 *
 * `recommendation` is deliberately absent, and this set is the single place
 * that fact is expressed. It is an ALLOWLIST rather than a
 * `!== 'recommendation'` exclusion on purpose: a fifth commitment type added
 * later defaults to being left alone rather than silently inheriting the comp
 * horizon from a negation nobody revisited. A recommendation promises
 * nothing and owes nothing, so an expiry for one was always arbitrary — it is
 * an intention, and TAC-380 owns it.
 */
export const OBLIGATION_TYPES: ReadonlySet<CommitmentType> = new Set([
  'comp',
  'hold',
  'discount',
])

export function isObligationType(type: CommitmentType): boolean {
  return OBLIGATION_TYPES.has(type)
}

// ===== Horizons =====

/**
 * How long a comp or discount stays owed. Sixty days.
 *
 * REVISED 2026-09-14, down from two years, and the reasoning inverted rather
 * than merely tightened — so do not read this as the old constant with a
 * smaller number. At two years expiry was DECORATIVE: escalation at 7 days
 * was the entire live mechanism and the horizon existed only so the row had a
 * terminal state to reach eventually. At 60 days expiry actually fires — a
 * comp offered in September is gone by mid-November.
 *
 * That is a deliberate change to the promise, not a tuning pass. It is
 * defensible for a café, where an unclaimed free drink two months on is
 * unlikely to ever be claimed, and it makes the 7-day escalation
 * proportionate: an eighth of the obligation's life rather than noise against
 * 730 days.
 *
 * The superseded docstring argued that long was the SAFE direction, because
 * too-short refuses a guest at the counter for a drink the venue promised.
 * That risk is real and is now accepted rather than dismissed — 60 days is
 * the window in which the venue considers the promise live.
 *
 * Set by Jaipal, still not measured. Same caveat as COMP_ESCALATION_DAYS.
 */
export const COMP_EXPIRY_DAYS = 60

/**
 * How long a comp or discount may sit open before a human is told about it.
 *
 * PLACEHOLDER, NOT A MEASUREMENT. Seven days is a proposed default set by
 * Jaipal on 2026-09-13; there is no comp volume in production to derive it
 * from (the fleet has had exactly one open comp, since 2026-09-08). It is
 * written here as a named constant with this docstring specifically because
 * a bare `7` reads as calibrated to the next person — the way
 * KNOWLEDGE_RELEVANCE_FLOOR = 0.5 read as calibrated for months before
 * TAC-358 measured it and found the distributions inverted.
 *
 * Revisit once Le Mil's has generated real comp volume. Changing it is a
 * one-line edit; the thing to preserve is that it stays labelled.
 */
export const COMP_ESCALATION_DAYS = 7

/**
 * How long before close a still-unclaimed hold is surfaced.
 *
 * PLACEHOLDER, same status as COMP_ESCALATION_DAYS — two hours is a guess at
 * "enough time for someone to do something about it before close". The
 * product reasoning behind escalating holds early is real (an unclaimed hold
 * is a physical item under the counter that someone has to deal with); the
 * specific number is not.
 */
export const HOLD_ESCALATION_LEAD_MINUTES = 120

/**
 * The fallback close time for a hold whose venue hours we could not read:
 * 23:59 venue-local on the day it was created.
 *
 * Ruled 2026-09-13. Both obvious alternatives are wrong for a physical item —
 * failing open means the hold never expires and sits in the ledger forever,
 * failing closed means it expires at the moment of creation and the guest is
 * refused an item that is literally on the shelf. 23:59 still expires it
 * day-of, which is what a hold means, and the paired escalation puts a human
 * on it rather than trusting the guess.
 *
 * NOTE this is the opposite call from TAC-377, where an unreadable clock
 * makes the precision guard go inert. There the cost of being wrong is a
 * slightly wrong timestamp on a visit record. Here it is a pastry nobody
 * claims. The two tickets disagree deliberately.
 */
const FALLBACK_CLOSE_MINUTES = 23 * 60 + 59

/**
 * Floor for the degenerate case where even 23:59 has already passed — a hold
 * created in the last minute of the venue's local day. One hour, so the row
 * never lands in the pathological state of expiring before it exists.
 */
const MINIMUM_HOLD_WINDOW_MS = 60 * 60 * 1000

// Mirrors the private DAY_KEYS in lib/schemas/venue-hours.ts. Restated rather
// than exported from there because that module's copy is `satisfies
// ReadonlyArray<keyof VenueInfo['hours']>` and widening its export surface to
// serve one caller is the change more likely to go wrong later; the ordering
// (Sunday-first, matching Date.getUTCDay) is locked by a test here.
const DAY_KEYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const satisfies ReadonlyArray<keyof VenueInfo['hours']>

// ===== Venue-local time =====

/**
 * The venue-local calendar date and weekday for an instant.
 *
 * Returns null on an unusable timezone — the caller treats that as "we could
 * not read the clock" and takes the same fallback as unreadable hours.
 */
export function venueLocalDate(
  timezone: string,
  instant: Date,
): { year: number; month: number; day: number; dayIndex: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant)

    const get = (t: string) => parts.find((p) => p.type === t)?.value
    const weekday = get('weekday')?.toLowerCase()
    const year = Number(get('year'))
    const month = Number(get('month'))
    const day = Number(get('day'))
    if (weekday === undefined) return null
    const dayIndex = DAY_KEYS.indexOf(weekday as (typeof DAY_KEYS)[number])
    if (dayIndex === -1) return null
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
      return null
    }
    return { year, month, day, dayIndex }
  } catch {
    return null
  }
}

/**
 * What UTC offset, in milliseconds, does `timezone` have at `instant`?
 * Positive east of UTC. Null if the zone is unusable.
 */
function offsetMsAt(timezone: string, instant: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(instant)

    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
    const year = get('year')
    const month = get('month')
    const day = get('day')
    // en-US hour12:false renders midnight as "24" in some ICU versions — the
    // same quirk venueLocalNow guards against in venue-hours.ts.
    const hour = get('hour') % 24
    const minute = get('minute')
    const second = get('second')
    if ([year, month, day, hour, minute, second].some((n) => !Number.isInteger(n))) {
      return null
    }
    const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second)
    return asIfUtc - instant.getTime()
  } catch {
    return null
  }
}

/**
 * Convert a venue-local wall-clock reading to the UTC instant it names.
 *
 * THIS IS THE NEW LOGIC IN THIS TICKET and it is worth knowing why nothing
 * existing covers it: `venueLocalNow` in venue-hours.ts goes the OTHER
 * direction (instant → local wall clock) and is private besides. "What UTC
 * moment is 3pm on Saturday in Los Angeles" had no answer in this repo.
 *
 * Two passes, and the second is not optional. The offset has to be sampled at
 * some instant, but the instant is what we are solving for — so pass one
 * samples at the naive guess and pass two re-samples at the corrected result.
 * A single pass is wrong for any local time on the far side of a DST
 * transition from the guess, which for a close-of-day derivation means the
 * transition weekend silently produces a horizon an hour off.
 *
 * `day` may overflow its month (day 32, day 0); Date.UTC normalizes, which is
 * what makes the overnight-range branch a plain `day + 1`.
 *
 * On a spring-forward gap the named wall clock does not exist; the result
 * lands on the adjacent real instant rather than failing. Acceptable — the
 * times this is called with are closing times and 23:59, and being an hour
 * off once a year on a horizon measured in hours is not worth a branch.
 */
export function venueLocalInstant(
  timezone: string,
  year: number,
  month: number,
  day: number,
  minutes: number,
): Date | null {
  const targetWallAsUtc = Date.UTC(
    year,
    month - 1,
    day,
    Math.floor(minutes / 60),
    minutes % 60,
  )
  const firstOffset = offsetMsAt(timezone, new Date(targetWallAsUtc))
  if (firstOffset === null) return null
  const firstPass = new Date(targetWallAsUtc - firstOffset)
  const secondOffset = offsetMsAt(timezone, firstPass)
  if (secondOffset === null) return null
  return new Date(targetWallAsUtc - secondOffset)
}

// ===== Derivation =====

export interface DeriveExpiryInput {
  type: CommitmentType
  createdAt: Date
  /** `venues.timezone`. Null when it could not be loaded. */
  timezone: string | null
  /** `venue_configs.venue_info.hours`. Null when it could not be loaded. */
  hours: VenueInfo['hours'] | null
}

export interface DeriveExpiryResult {
  /** Null for a recommendation — no horizon, by scope. */
  expiresAt: Date | null
  /**
   * True when the horizon is a guess rather than a reading: the hours were
   * unreadable, the venue is recorded as closed that day, the timezone was
   * missing, or the computed close had already passed. The caller stamps
   * escalated_at at creation in that case, because creation is the only
   * moment at which we know the derivation was a fallback — the cron reading
   * the row later cannot tell a 23:59 guess from a venue that genuinely
   * closes at midnight.
   */
  escalateImmediately: boolean
}

/**
 * The horizon for one commitment. Pure; the caller loads the venue facts.
 */
export function deriveExpiresAt(input: DeriveExpiryInput): DeriveExpiryResult {
  const { type, createdAt, timezone, hours } = input

  if (!isObligationType(type)) {
    return { expiresAt: null, escalateImmediately: false }
  }

  if (type === 'comp' || type === 'discount') {
    const expiresAt = new Date(createdAt)
    expiresAt.setUTCDate(expiresAt.getUTCDate() + COMP_EXPIRY_DAYS)
    return { expiresAt, escalateImmediately: false }
  }

  return deriveHoldExpiry(createdAt, timezone, hours)
}

/**
 * A hold expires at close on the day it was set aside.
 *
 * Every branch that could not positively read a closing time resolves to
 * 23:59 local plus escalation — the same "never claim what you did not
 * understand" posture venue-hours.ts takes, pointed at a different outcome.
 * A stated `closed` on the creation day is folded in with `unknown`
 * deliberately (ruled 2026-09-14): someone set a physical item aside at a
 * venue the config says was shut, so the config is what is wrong, and the
 * item is still real.
 */
function deriveHoldExpiry(
  createdAt: Date,
  timezone: string | null,
  hours: VenueInfo['hours'] | null,
): DeriveExpiryResult {
  // No timezone means no venue-local day to close at. Degrade to UTC for the
  // day boundary rather than inventing one, and escalate — a human reading
  // the alert can fix the venue record.
  // ONE usability check, and `readable` hangs off it. An earlier version
  // tested `timezone !== null` here while separately falling back to UTC for
  // the arithmetic — so a garbage-but-present zone ("America/Los_Angles", a
  // plausible Studio typo) resolved a confident close time against UTC and
  // did NOT escalate, landing up to 14 hours early in the direction that
  // refuses a guest an item physically on the shelf. Present is not usable.
  const zoneUsable = timezone !== null && venueLocalDate(timezone, createdAt) !== null
  const usableZone = zoneUsable ? (timezone as string) : 'UTC'
  const local = venueLocalDate(usableZone, createdAt)
  if (local === null) {
    // Even UTC failed to format, which should be impossible. Take the floor
    // rather than returning a null horizon the expiry scan would never see.
    return {
      expiresAt: new Date(createdAt.getTime() + MINIMUM_HOLD_WINDOW_MS),
      escalateImmediately: true,
    }
  }

  const today = classifyDay(hours?.[DAY_KEYS[local.dayIndex]])
  const readable = zoneUsable && today.kind === 'range'

  const closeMinutes = readable ? today.range.closeMin : FALLBACK_CLOSE_MINUTES
  // An overnight range (5pm - 2am) closes on the NEXT local day. Without this
  // the hold would expire ~22 hours early, at 2am of the morning it began.
  const dayOffset = readable && today.range.overnight ? 1 : 0

  const computed = venueLocalInstant(
    usableZone,
    local.year,
    local.month,
    local.day + dayOffset,
    closeMinutes,
  )

  if (computed !== null && computed.getTime() > createdAt.getTime()) {
    return { expiresAt: computed, escalateImmediately: !readable }
  }

  // Close has already passed (a hold set aside after hours), or the instant
  // could not be built. Try 23:59 of the same local day, then the floor.
  const endOfDay = venueLocalInstant(
    usableZone,
    local.year,
    local.month,
    local.day,
    FALLBACK_CLOSE_MINUTES,
  )
  if (endOfDay !== null && endOfDay.getTime() > createdAt.getTime()) {
    return { expiresAt: endOfDay, escalateImmediately: true }
  }
  return {
    expiresAt: new Date(createdAt.getTime() + MINIMUM_HOLD_WINDOW_MS),
    escalateImmediately: true,
  }
}

// ===== Escalation timing =====

export interface EscalationDueInput {
  type: CommitmentType
  createdAt: Date
  expiresAt: Date | null
}

/**
 * When should a human first hear about this obligation? Null when never.
 *
 * Comps and discounts escalate on AGE — they are abstract, and the signal is
 * that nobody has resolved it in a week. Holds escalate on PROXIMITY TO
 * EXPIRY — they are a physical item, and the signal is that close is coming
 * and it is still on the shelf. The two are different questions, which is why
 * this is a switch rather than one horizon-relative formula.
 */
export function escalationDueAt(input: EscalationDueInput): Date | null {
  const { type, createdAt, expiresAt } = input
  if (!isObligationType(type)) return null

  if (type === 'hold') {
    if (expiresAt === null) return null
    return new Date(expiresAt.getTime() - HOLD_ESCALATION_LEAD_MINUTES * 60 * 1000)
  }

  const due = new Date(createdAt)
  due.setUTCDate(due.getUTCDate() + COMP_ESCALATION_DAYS)
  return due
}
