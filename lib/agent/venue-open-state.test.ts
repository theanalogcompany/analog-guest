// TAC-363: tests for the shared open/closed derivation.
//
// The load-bearing one is `matches buildAiRuntime's own expression` — see its
// own comment. The rest pin the contract this module adds on top of
// resolveOpenState, which is thin by design: which fields it reads, and that
// `unknown` is never folded in with `closed`.

import { describe, expect, it } from 'vitest'
import { resolveOpenState } from '@/lib/schemas'
import type { VenueInfo } from '@/lib/schemas'
import {
  isVenueClosed,
  resolveVenueOpenState,
  type VenueOpenStateInput,
} from './venue-open-state'

// Le Mil's real shape: one free-text range per weekday, en dash, 7am to 3pm.
const LE_MILS_HOURS: VenueInfo['hours'] = {
  monday: '7:00 AM – 3:00 PM',
  tuesday: '7:00 AM – 3:00 PM',
  wednesday: '7:00 AM – 3:00 PM',
  thursday: '7:00 AM – 3:00 PM',
  friday: '7:00 AM – 3:00 PM',
  saturday: '7:00 AM – 3:00 PM',
  sunday: '7:00 AM – 3:00 PM',
}

function venue(
  hours: VenueInfo['hours'],
  timezone = 'America/Los_Angeles',
): VenueOpenStateInput {
  return { venueInfo: { hours }, timezone }
}

// 2026-09-22 is a Tuesday. 17:00Z is 10:00 Pacific (inside 7-3), 08:00Z is
// 01:00 Pacific (the hour the 2026-09-14 incident landed in).
const DURING_SERVICE = new Date('2026-09-22T17:00:00Z')
const ONE_AM_PACIFIC = new Date('2026-09-22T08:00:00Z')

describe('resolveVenueOpenState', () => {
  it('reads open during service hours on the venue clock', () => {
    expect(resolveVenueOpenState(venue(LE_MILS_HOURS), DURING_SERVICE).state).toBe('open')
  })

  it('reads closed at 1am, the hour the incident landed in', () => {
    expect(resolveVenueOpenState(venue(LE_MILS_HOURS), ONE_AM_PACIFIC).state).toBe('closed')
  })

  it('resolves the verdict against the VENUE timezone, not the host clock', () => {
    // Same instant, two venues. 17:00Z is inside service in Los Angeles and
    // long past it in London. A helper that read the process timezone, or that
    // ignored the field, cannot produce two different answers here.
    const instant = DURING_SERVICE
    expect(resolveVenueOpenState(venue(LE_MILS_HOURS, 'America/Los_Angeles'), instant).state).toBe(
      'open',
    )
    expect(resolveVenueOpenState(venue(LE_MILS_HOURS, 'Europe/London'), instant).state).toBe(
      'closed',
    )
  })

  it('reads unknown when the timezone is not a real zone', () => {
    // `America/Los_Angles` is the plausible Studio typo TAC-341 documents.
    // It must not silently resolve against UTC.
    expect(resolveVenueOpenState(venue(LE_MILS_HOURS, 'America/Los_Angles'), ONE_AM_PACIFIC)).toEqual(
      { state: 'unknown' },
    )
  })

  it('reads unknown when the day has no hours recorded', () => {
    // Absence is not a closure: parse-venue-spec drops rows whose label it does
    // not recognise ("Sat & Sun", "Weekends"), so a missing key means nobody
    // said at least as often as it means shut.
    expect(resolveVenueOpenState(venue({}), DURING_SERVICE)).toEqual({ state: 'unknown' })
  })

  it('reads unknown on an ambiguous descending range rather than guessing overnight', () => {
    // "7-3" is a cafe writing 7am to 3pm in shorthand. Reading it as an
    // overnight range reports OPEN at 7:57pm, which is the exact minute of the
    // TAC-301 incident.
    const shorthand = { ...LE_MILS_HOURS, tuesday: '7-3' }
    expect(resolveVenueOpenState(venue(shorthand), new Date('2026-09-23T02:57:00Z')).state).toBe(
      'unknown',
    )
  })
})

describe('isVenueClosed', () => {
  it('is true only for a positive closed verdict', () => {
    expect(isVenueClosed(venue(LE_MILS_HOURS), ONE_AM_PACIFIC)).toBe(true)
  })

  it('is FALSE for unknown, not true', () => {
    // Ruling 2(a), 2026-09-21: unknown hours behave as open. This is the
    // assertion that fails if anyone rewrites the predicate as `!== 'open'`,
    // which reads as a harmless tidy and inverts the ruling at every venue
    // whose hours nobody has filled in.
    expect(isVenueClosed(venue({}), ONE_AM_PACIFIC)).toBe(false)
    expect(isVenueClosed(venue(LE_MILS_HOURS, 'America/Los_Angles'), ONE_AM_PACIFIC)).toBe(false)
  })

  it('is false during service', () => {
    expect(isVenueClosed(venue(LE_MILS_HOURS), DURING_SERVICE)).toBe(false)
  })
})

describe('equivalence with the expression it replaced', () => {
  // buildAiRuntime used to inline `timezoneSubstituted ? {state:'unknown'} :
  // resolveOpenState(hours, timezone, now)`, where `timezone` had already been
  // swapped for FALLBACK_TIMEZONE when the venue's own failed an
  // `Intl.DateTimeFormat` probe. This module drops the flag and passes the
  // venue's real timezone straight through.
  //
  // The two are equal because the same bad zone that trips the probe also makes
  // `venueLocalNow` throw, and resolveOpenState maps that to `unknown`. That is
  // an argument about two functions in a file this one does not own, so it is
  // pinned here rather than left as prose: if venue-hours.ts ever starts
  // tolerating a zone that isValidTimezone rejects, this fails instead of the
  // prompt quietly gaining a confidently wrong Status line.
  function isValidTimezone(tz: string): boolean {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
      return true
    } catch {
      return false
    }
  }

  function oldExpression(hours: VenueInfo['hours'], tz: string, now: Date) {
    const substituted = !isValidTimezone(tz)
    const effective = substituted ? 'America/Los_Angeles' : tz
    return substituted ? { state: 'unknown' } : resolveOpenState(hours, effective, now)
  }

  const zones = ['America/Los_Angeles', 'Europe/London', 'Pacific/Auckland', 'America/Los_Angles', '']
  const hourSets: Array<VenueInfo['hours']> = [
    LE_MILS_HOURS,
    {},
    { ...LE_MILS_HOURS, tuesday: 'Closed – Closed' },
    { ...LE_MILS_HOURS, tuesday: '5:00 PM – 2:00 AM' },
    { ...LE_MILS_HOURS, tuesday: '7-3' },
  ]
  const instants = [DURING_SERVICE, ONE_AM_PACIFIC, new Date('2026-09-23T02:57:00Z')]

  it('matches buildAiRuntime’s own expression across zones, hour shapes and instants', () => {
    for (const tz of zones) {
      for (const hours of hourSets) {
        for (const now of instants) {
          expect(resolveVenueOpenState(venue(hours, tz), now)).toEqual(
            oldExpression(hours, tz, now),
          )
        }
      }
    }
  })
})
