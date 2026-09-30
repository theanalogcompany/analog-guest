// TAC-386: when to check that our answer worked out.
//
// Pure. No DB client, no SDK init at module load, so vitest loads it unmocked
// (root CLAUDE.md, "Module split for testability").
//
// NO SECOND HOURS PARSER. Everything here COMPOSES what already exists:
//
//   resolveOpenState, venueLocalMinutes   lib/schemas/venue-hours.ts (TAC-301)
//   venueLocalDate, venueLocalInstant,
//   DAY_KEYS                             lib/guests/commitment-expiry.ts (TAC-341)
//
// The one thing none of them supplies is the next opening as a REAL INSTANT.
// `venue-hours.ts` has a `findNextOpening`, but it is private and returns a
// DISPLAY LABEL ("tomorrow", "7:00 AM") for the `## Right now` prompt block, not
// a timestamp anything can schedule against. So `nextOpeningInstant` below walks
// the week the way TAC-341's `deriveHoldExpiry` does and converts through
// `venueLocalInstant`, which is the primitive TAC-341 built for exactly this
// "venue-local wall clock to UTC" job.
//
// TIMING, ruled 2026-09-30 (option A), and the two rulings it reconciles:
//
//   about `delayHours` after the question; if that lands while the venue is
//   open, that is the moment. If it lands while CLOSED, roll to `delayHours`
//   INTO the next open period, not to the opening itself.
//
// Ruling 3 of 2026-09-17 said "move it to the next opening", which reads as AT
// the opening; the 2026-09-30 restatement said "a few hours into the next open
// period". The later one governs, and at Le Mil's (7:00 AM - 3:00 PM) it is the
// difference between a 7am ping and a 10am one.
//
// TWO DIRECTIONS THAT LOOK LIKE OVERSIGHTS AND ARE NOT:
//
// 1. `unknown` hours never schedule (ruling 4: hours unreadable, don't send).
//    This is the OPPOSITE of `lib/agent/venue-open-state.ts`'s house rule, where
//    `unknown` behaves as open, because that module serves callers deciding
//    whether to hold a reply a guest is waiting for and this one decides whether
//    to start an unprompted conversation. Ruling 4 is explicit for this path.
//
// 2. An `unknown` DAY inside the walk stops it, rather than being stepped over.
//    Stepping over Tuesday to reach Wednesday would assert the venue is shut on
//    Tuesday, and `classifyDay`'s own governing rule is that absence is not a
//    closure: a missing day means nobody said. A positively STATED closure is
//    different and the walk does step over it.

import {
  DAY_KEYS,
  venueLocalDate,
  venueLocalInstant,
} from '@/lib/guests/commitment-expiry'
import type { VenueInfo } from '@/lib/schemas'
import {
  classifyDay,
  resolveOpenState,
  venueLocalMinutes,
} from '@/lib/schemas/venue-hours'

/**
 * Hours between the guest's question and the check-in.
 *
 * A PLACEHOLDER, approved as one (2026-09-30), in the posture of
 * `COMP_ESCALATION_DAYS` and `HOLD_ESCALATION_LEAD_MINUTES` in
 * commitment-expiry.ts: a judgment nobody has measured yet, named so the next
 * person knows it is a guess rather than a finding. What would move it is real
 * volume showing follow-ups landing while the guest is still in the shop, or so
 * late the errand is forgotten.
 */
export const INQUIRY_FOLLOWUP_DELAY_HOURS = 3

/** How far the walk looks for the next opening before giving up. */
const MAX_WALK_DAYS = 7

const MS_PER_HOUR = 60 * 60 * 1000
const MINUTES_PER_DAY = 24 * 60

export interface InquiryFollowupTimingInput {
  /**
   * When the guest asked, on META'S clock (`messages.provider_sent_at`), not
   * our webhook's receive time. The two were 1.8s and 2.3s apart in production
   * and a redelivery can land far later (TAC-479).
   */
  askedAt: Date
  /** `venues.timezone`. Null when it could not be read. */
  timezone: string | null
  /** `venue_configs.venue_info.hours`. Null when it could not be read. */
  hours: VenueInfo['hours'] | null
  delayHours: number
  /**
   * When Instagram's 24-hour reply window shuts for this guest: `askedAt` plus
   * `INSTAGRAM_WINDOW_MS`. Passed in rather than derived here, so this module
   * holds no second copy of Meta's deadline and needs no import from the
   * Instagram arm (`window-import-guard.test.ts`).
   */
  windowClosesAt: Date
}

export type InquiryFollowupTiming =
  | { kind: 'due'; dueAt: Date }
  | {
      kind: 'skip'
      /**
       * `hours_unreadable` — the clock or the hours could not be positively
       * understood, so nothing is armed at all and there is no stale row to
       * find later.
       *
       * `past_window` — the send would land after Meta's window shuts. Ruled
       * 2026-09-30: skip it rather than arm something that can only fail.
       */
      reason: 'hours_unreadable' | 'past_window'
    }

/**
 * The next instant the venue opens, strictly after `from`, or null when the
 * hours stop being readable before one is found.
 *
 * Exported for its own tests: the multi-day walk and the overnight range are
 * where this is most likely to be wrong, and they are hard to reach through
 * `computeInquiryFollowupDueAt` alone.
 */
export function nextOpeningInstant(
  hours: VenueInfo['hours'],
  timezone: string,
  from: Date,
): Date | null {
  const local = venueLocalDate(timezone, from)
  const fromMinutes = venueLocalMinutes(timezone, from)
  if (local === null || fromMinutes === null) return null

  for (let offset = 0; offset <= MAX_WALK_DAYS; offset += 1) {
    const dayIndex = (local.dayIndex + offset) % 7
    const day = classifyDay(hours[DAY_KEYS[dayIndex]])

    // Nobody said what this day's hours are. Stepping over it would assert a
    // closure; see the module header.
    if (day.kind === 'unknown') return null
    // Positively stated as shut. Step over it.
    if (day.kind === 'closed') continue

    // Today, but the shop has already opened: this day's opening is behind us.
    if (offset === 0 && day.range.openMin <= fromMinutes) continue

    const opening = venueLocalInstant(
      timezone,
      local.year,
      local.month,
      local.day + offset,
      day.range.openMin,
    )
    if (opening === null) return null
    // A DST spring-forward can move a wall-clock opening onto an instant that
    // is not strictly after `from` even though its calendar day is later. Keep
    // walking rather than return a moment already past.
    if (opening.getTime() <= from.getTime()) continue
    return opening
  }

  return null
}

/**
 * When the follow-up for a question asked at `askedAt` should go out, or why it
 * should never be armed.
 *
 * Called twice on different instants and for different purposes: once by the
 * scheduler, to decide whether to write a row and with what `due_at`, and again
 * by the processor immediately before dispatch, because a venue's hours can be
 * edited between arming and firing and a send has to be inside hours we can
 * still read.
 */
export function computeInquiryFollowupDueAt(
  input: InquiryFollowupTimingInput,
): InquiryFollowupTiming {
  const { askedAt, timezone, hours, delayHours, windowClosesAt } = input

  if (timezone === null || hours === null) {
    return { kind: 'skip', reason: 'hours_unreadable' }
  }

  const candidate = new Date(askedAt.getTime() + delayHours * MS_PER_HOUR)
  const state = resolveOpenState(hours, timezone, candidate)

  let dueAt: Date
  if (state.state === 'unknown') {
    return { kind: 'skip', reason: 'hours_unreadable' }
  } else if (state.state === 'open') {
    dueAt = candidate
  } else {
    const opening = nextOpeningInstant(hours, timezone, candidate)
    if (opening === null) return { kind: 'skip', reason: 'hours_unreadable' }
    // `delayHours` INTO the next open period, not at the opening.
    const intoOpenPeriod = new Date(
      opening.getTime() + delayHours * MS_PER_HOUR,
    )
    // Unless that overshoots the close, in which case the opening itself is the
    // best moment inside the period. A venue with a shorter open period than
    // the delay (a 2-hour Sunday, say) would otherwise be pushed past its own
    // closing time, which is the one thing every ruling here agrees must not
    // happen.
    dueAt = closesBefore(hours, timezone, opening, intoOpenPeriod)
      ? opening
      : intoOpenPeriod
  }

  // Ruled 2026-09-30: never send more than 24 hours after the guest's last
  // inbound, and skip rather than arm something that can only fail.
  if (dueAt.getTime() > windowClosesAt.getTime()) {
    return { kind: 'skip', reason: 'past_window' }
  }

  return { kind: 'due', dueAt }
}

/**
 * Would `at` fall after the open period that begins at `opening` has closed?
 *
 * Read off the opening day's own range rather than by calling
 * `resolveOpenState(at)`, because that answers "is it open at `at`" and would
 * say `closed` for an `at` that lands in the NEXT day's gap just as readily as
 * for one past today's close, which are different situations.
 */
function closesBefore(
  hours: VenueInfo['hours'],
  timezone: string,
  opening: Date,
  at: Date,
): boolean {
  const local = venueLocalDate(timezone, opening)
  if (local === null) return false
  const day = classifyDay(hours[DAY_KEYS[local.dayIndex]])
  if (day.kind !== 'range') return false

  // An overnight range (5pm - 2am) closes on the NEXT local day; without the
  // offset this would read the close as 22 hours early. Same correction
  // deriveHoldExpiry makes.
  const closeAt = venueLocalInstant(
    timezone,
    local.year,
    local.month,
    local.day + (day.range.overnight ? 1 : 0),
    day.range.closeMin % MINUTES_PER_DAY,
  )
  if (closeAt === null) return false
  return at.getTime() >= closeAt.getTime()
}
