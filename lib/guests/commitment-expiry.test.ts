import { describe, expect, it } from 'vitest'

import type { VenueInfo } from '@/lib/schemas/venue-info'
import {
  COMP_ESCALATION_DAYS,
  COMP_EXPIRY_YEARS,
  HOLD_ESCALATION_LEAD_MINUTES,
  OBLIGATION_TYPES,
  deriveExpiresAt,
  escalationDueAt,
  isObligationType,
  venueLocalDate,
  venueLocalInstant,
} from './commitment-expiry'

const LA = 'America/Los_Angeles'

/** Every day identical, so a test that isn't about weekday routing can ignore it. */
function everyDay(range: string): VenueInfo['hours'] {
  return {
    sunday: range,
    monday: range,
    tuesday: range,
    wednesday: range,
    thursday: range,
    friday: range,
    saturday: range,
  }
}

// ===== Scope: the regression check for the 2026-09-14 cut =====

describe('OBLIGATION_TYPES', () => {
  it('covers exactly comp, hold and discount', () => {
    expect([...OBLIGATION_TYPES].sort()).toEqual(['comp', 'discount', 'hold'])
  })

  // The load-bearing one. A recommendation promises nothing and owes nothing;
  // TAC-380 owns it. This fails the moment someone "tidies" the allowlist into
  // a !== 'recommendation' exclusion and then adds a fifth type.
  it('excludes recommendation', () => {
    expect(isObligationType('recommendation')).toBe(false)
    expect(OBLIGATION_TYPES.has('recommendation')).toBe(false)
  })

  it('includes all three obligations', () => {
    expect(isObligationType('comp')).toBe(true)
    expect(isObligationType('hold')).toBe(true)
    expect(isObligationType('discount')).toBe(true)
  })
})

// ===== Constants pinned by value =====

describe('horizon constants', () => {
  // Pinned deliberately: these are judgment calls, not calibrations, and a
  // future change to either should have to delete a test that says so.
  it('pins the comp horizon at 2 years and the escalation window at 7 days', () => {
    expect(COMP_EXPIRY_YEARS).toBe(2)
    expect(COMP_ESCALATION_DAYS).toBe(7)
  })

  it('pins the hold escalation lead at 120 minutes', () => {
    expect(HOLD_ESCALATION_LEAD_MINUTES).toBe(120)
  })
})

// ===== Venue-local wall clock -> UTC =====

describe('venueLocalInstant', () => {
  it('resolves a standard-time local wall clock', () => {
    // 15:00 on 2026-01-10 in Los Angeles is PST (UTC-8).
    const r = venueLocalInstant(LA, 2026, 1, 10, 15 * 60)
    expect(r?.toISOString()).toBe('2026-01-10T23:00:00.000Z')
  })

  it('resolves a daylight-time local wall clock', () => {
    // Same wall clock in July is PDT (UTC-7) — one hour earlier in UTC.
    const r = venueLocalInstant(LA, 2026, 7, 10, 15 * 60)
    expect(r?.toISOString()).toBe('2026-07-10T22:00:00.000Z')
  })

  it('resolves 23:59 on the spring-forward day', () => {
    // 2026-03-08 is the US spring-forward date; by 23:59 the zone is PDT.
    const r = venueLocalInstant(LA, 2026, 3, 8, 23 * 60 + 59)
    expect(r?.toISOString()).toBe('2026-03-09T06:59:00.000Z')
  })

  // THE TEST THAT JUSTIFIES THE SECOND PASS. Auckland is UTC+12/+13, so the
  // naive guess instant lands on the far side of the DST transition from the
  // target. A single-pass implementation returns 2026-09-26T12:00Z, which is
  // midnight local — an hour off, silently. Deleting the re-sample in
  // venueLocalInstant fails exactly this test and nothing else.
  it('re-samples the offset so a transition between guess and target cannot skew it', () => {
    const r = venueLocalInstant('Pacific/Auckland', 2026, 9, 27, 60)
    expect(r?.toISOString()).toBe('2026-09-26T13:00:00.000Z')
  })

  it('round-trips through venueLocalDate across a DST boundary', () => {
    for (const [y, m, d] of [
      [2026, 3, 8],
      [2026, 11, 1],
      [2026, 7, 10],
    ] as const) {
      const instant = venueLocalInstant(LA, y, m, d, 23 * 60 + 59)
      expect(instant).not.toBeNull()
      const back = venueLocalDate(LA, instant as Date)
      expect(back).toEqual(expect.objectContaining({ year: y, month: m, day: d }))
    }
  })

  it('normalizes a day that overflows its month', () => {
    // The overnight branch adds a day by passing day + 1; January 32nd must
    // land on February 1st rather than producing an invalid date.
    const r = venueLocalInstant(LA, 2026, 1, 32, 2 * 60)
    const back = venueLocalDate(LA, r as Date)
    expect(back).toEqual(expect.objectContaining({ year: 2026, month: 2, day: 1 }))
  })

  it('returns null on an unusable timezone', () => {
    expect(venueLocalInstant('Not/AZone', 2026, 1, 10, 600)).toBeNull()
  })
})

describe('venueLocalDate', () => {
  it('reports the venue-local weekday, not the UTC one', () => {
    // 2026-07-11T02:00Z is still Friday the 10th in Los Angeles.
    const r = venueLocalDate(LA, new Date('2026-07-11T02:00:00Z'))
    expect(r).toEqual({ year: 2026, month: 7, day: 10, dayIndex: 5 })
  })

  // The DAY_KEYS ordering claim in commitment-expiry.ts said it was "locked
  // by a test here" while only Friday was actually pinned. Seven assertions
  // make the claim true: a rotated or Monday-first copy of that array would
  // mis-route every hold's hours lookup.
  it('maps all seven weekdays to the hours-key order', () => {
    const expected = [
      ['2026-07-05', 0], // Sunday
      ['2026-07-06', 1],
      ['2026-07-07', 2],
      ['2026-07-08', 3],
      ['2026-07-09', 4],
      ['2026-07-10', 5],
      ['2026-07-11', 6], // Saturday
    ] as const
    for (const [day, index] of expected) {
      // Noon UTC is mid-morning in LA — same calendar day in both zones.
      const r = venueLocalDate(LA, new Date(`${day}T18:00:00Z`))
      expect(r?.dayIndex).toBe(index)
    }
  })

  it('returns null on an unusable timezone', () => {
    expect(venueLocalDate('Not/AZone', new Date())).toBeNull()
  })
})

// ===== Horizons =====

describe('deriveExpiresAt — recommendations', () => {
  // The scope cut, asserted at the derivation layer.
  it('gives a recommendation no horizon and no escalation', () => {
    const r = deriveExpiresAt({
      type: 'recommendation',
      createdAt: new Date('2026-09-13T18:00:00Z'),
      timezone: LA,
      hours: everyDay('7:00 AM – 3:00 PM'),
    })
    expect(r.expiresAt).toBeNull()
    expect(r.escalateImmediately).toBe(false)
  })
})

describe('deriveExpiresAt — comp and discount', () => {
  it('gives a comp two years from creation', () => {
    const r = deriveExpiresAt({
      type: 'comp',
      createdAt: new Date('2026-09-08T18:00:00Z'),
      timezone: LA,
      hours: everyDay('7:00 AM – 3:00 PM'),
    })
    expect(r.expiresAt?.toISOString()).toBe('2028-09-08T18:00:00.000Z')
    expect(r.escalateImmediately).toBe(false)
  })

  it('treats a discount exactly as a comp', () => {
    const createdAt = new Date('2026-09-08T18:00:00Z')
    const comp = deriveExpiresAt({ type: 'comp', createdAt, timezone: null, hours: null })
    const discount = deriveExpiresAt({
      type: 'discount',
      createdAt,
      timezone: null,
      hours: null,
    })
    expect(discount.expiresAt?.toISOString()).toBe(comp.expiresAt?.toISOString())
  })

  it('needs no venue clock at all for a comp', () => {
    const r = deriveExpiresAt({
      type: 'comp',
      createdAt: new Date('2026-09-08T18:00:00Z'),
      timezone: null,
      hours: null,
    })
    // Missing venue facts must not push a comp onto the fallback path — the
    // caller skips the venue load entirely for non-hold types.
    expect(r.expiresAt?.toISOString()).toBe('2028-09-08T18:00:00.000Z')
    expect(r.escalateImmediately).toBe(false)
  })
})

describe('deriveExpiresAt — holds', () => {
  it('expires at venue close on the day it was created', () => {
    // 2026-07-10 11:00 PDT, venue closes 15:00 PDT -> 22:00Z same day.
    const r = deriveExpiresAt({
      type: 'hold',
      createdAt: new Date('2026-07-10T18:00:00Z'),
      timezone: LA,
      hours: everyDay('7:00 AM – 3:00 PM'),
    })
    expect(r.expiresAt?.toISOString()).toBe('2026-07-10T22:00:00.000Z')
    expect(r.escalateImmediately).toBe(false)
  })

  it('reads the hours for the venue-local weekday', () => {
    // Only Friday is set; the instant is Friday in LA. Any other day key
    // would fall through to the 23:59 fallback and flip escalateImmediately.
    const r = deriveExpiresAt({
      type: 'hold',
      createdAt: new Date('2026-07-10T18:00:00Z'),
      timezone: LA,
      hours: { friday: '7:00 AM – 3:00 PM' },
    })
    expect(r.expiresAt?.toISOString()).toBe('2026-07-10T22:00:00.000Z')
    expect(r.escalateImmediately).toBe(false)
  })

  it('carries an overnight range into the next local day', () => {
    // 5pm-2am: close is 2am TOMORROW. Without the overnight offset this would
    // resolve to 2am the same morning — before the hold existed — and the
    // degenerate-case branch would silently paper over it with 23:59.
    const r = deriveExpiresAt({
      type: 'hold',
      createdAt: new Date('2026-07-11T02:00:00Z'), // Fri 19:00 PDT
      timezone: LA,
      hours: everyDay('5:00 PM – 2:00 AM'),
    })
    expect(r.expiresAt?.toISOString()).toBe('2026-07-11T09:00:00.000Z') // Sat 02:00 PDT
    expect(r.escalateImmediately).toBe(false)
  })

  it('falls back to 23:59 venue-local and escalates when hours are unreadable', () => {
    const r = deriveExpiresAt({
      type: 'hold',
      createdAt: new Date('2026-07-10T18:00:00Z'),
      timezone: LA,
      hours: everyDay('whenever we feel like it'),
    })
    expect(r.expiresAt?.toISOString()).toBe('2026-07-11T06:59:00.000Z') // 23:59 PDT
    expect(r.escalateImmediately).toBe(true)
  })

  it('falls back to 23:59 venue-local and escalates when the day key is absent', () => {
    const r = deriveExpiresAt({
      type: 'hold',
      createdAt: new Date('2026-07-10T18:00:00Z'),
      timezone: LA,
      hours: { monday: '7:00 AM – 3:00 PM' },
    })
    expect(r.expiresAt?.toISOString()).toBe('2026-07-11T06:59:00.000Z')
    expect(r.escalateImmediately).toBe(true)
  })

  // Q2, ruled 2026-09-14. A stated closure is treated as unknown rather than
  // as a zero-length window: someone physically set an item aside at a venue
  // the config says was shut, so the config is what's wrong and the item is
  // still real.
  it('treats a stated closure on the creation day as unknown, not as closed', () => {
    const r = deriveExpiresAt({
      type: 'hold',
      createdAt: new Date('2026-07-10T18:00:00Z'),
      timezone: LA,
      hours: everyDay('Closed'),
    })
    expect(r.expiresAt?.toISOString()).toBe('2026-07-11T06:59:00.000Z')
    expect(r.escalateImmediately).toBe(true)
  })

  it('falls back and escalates when the timezone is missing', () => {
    const r = deriveExpiresAt({
      type: 'hold',
      createdAt: new Date('2026-07-10T18:00:00Z'),
      timezone: null,
      hours: everyDay('7:00 AM – 3:00 PM'),
    })
    expect(r.escalateImmediately).toBe(true)
    // Degrades to a UTC day boundary rather than inventing a venue-local one.
    expect(r.expiresAt?.toISOString()).toBe('2026-07-10T23:59:00.000Z')
  })

  // A GARBAGE-BUT-PRESENT timezone is the realistic case — "America/Los_Angles"
  // is a plausible hand-typo in Studio — and it is strictly more dangerous
  // than a missing one, because a non-null string reads as configured.
  //
  // The morning createdAt is load-bearing. An earlier version of this test
  // used 18:00Z, which is AFTER the UTC-computed close of 15:00Z, so it took
  // the already-passed branch and went green while the bug was live. At
  // 14:00Z the UTC-computed close is still in the future, which is the only
  // way to observe whether the zone was actually validated.
  it.each(['Not/AZone', 'America/Los_Angles', 'Mars/Phobos'])(
    'falls back and escalates on the unusable timezone %s',
    (timezone) => {
      const r = deriveExpiresAt({
        type: 'hold',
        createdAt: new Date('2026-07-10T14:00:00Z'),
        timezone,
        hours: everyDay('7:00 AM – 3:00 PM'),
      })
      expect(r.escalateImmediately).toBe(true)
      // Not merely non-null: a readable-hours path against a UTC-substituted
      // clock would return 15:00Z here, seven hours early, silently.
      expect(r.expiresAt?.toISOString()).toBe('2026-07-10T23:59:00.000Z')
    },
  )

  it('never expires a hold at or before the moment it was created', () => {
    // 19:00 PDT at a venue that closed at 15:00 — close has already passed.
    const createdAt = new Date('2026-07-11T02:00:00Z')
    const r = deriveExpiresAt({
      type: 'hold',
      createdAt,
      timezone: LA,
      hours: everyDay('7:00 AM – 3:00 PM'),
    })
    expect(r.expiresAt).not.toBeNull()
    expect((r.expiresAt as Date).getTime()).toBeGreaterThan(createdAt.getTime())
    expect(r.escalateImmediately).toBe(true)
  })

  it('takes the one-hour floor when even 23:59 has already passed', () => {
    // 23:59:30 venue-local: the end-of-day fallback is in the past too.
    const createdAt = new Date('2026-07-11T06:59:30Z')
    const r = deriveExpiresAt({
      type: 'hold',
      createdAt,
      timezone: LA,
      hours: everyDay('Closed'),
    })
    expect(r.expiresAt?.toISOString()).toBe('2026-07-11T07:59:30.000Z')
    expect(r.escalateImmediately).toBe(true)
  })
})

// ===== Escalation timing =====

describe('escalationDueAt', () => {
  it('escalates a comp on age, seven days after creation', () => {
    const r = escalationDueAt({
      type: 'comp',
      createdAt: new Date('2026-09-08T18:00:00Z'),
      expiresAt: new Date('2028-09-08T18:00:00Z'),
    })
    expect(r?.toISOString()).toBe('2026-09-15T18:00:00.000Z')
  })

  it('escalates a discount on the same schedule as a comp', () => {
    const createdAt = new Date('2026-09-08T18:00:00Z')
    const expiresAt = new Date('2028-09-08T18:00:00Z')
    expect(escalationDueAt({ type: 'discount', createdAt, expiresAt })?.toISOString()).toBe(
      escalationDueAt({ type: 'comp', createdAt, expiresAt })?.toISOString(),
    )
  })

  // Holds escalate on PROXIMITY, not age — a hold set aside this morning and
  // a hold set aside at noon both matter at the same moment, which is when
  // close is coming and the item is still on the shelf.
  it('escalates a hold two hours before it expires, not by age', () => {
    const r = escalationDueAt({
      type: 'hold',
      createdAt: new Date('2026-07-10T15:00:00Z'),
      expiresAt: new Date('2026-07-10T22:00:00Z'),
    })
    expect(r?.toISOString()).toBe('2026-07-10T20:00:00.000Z')
  })

  it('has nothing to say about a hold with no horizon', () => {
    expect(
      escalationDueAt({ type: 'hold', createdAt: new Date(), expiresAt: null }),
    ).toBeNull()
  })

  it('never escalates a recommendation', () => {
    expect(
      escalationDueAt({
        type: 'recommendation',
        createdAt: new Date('2026-09-08T18:00:00Z'),
        expiresAt: new Date('2028-09-08T18:00:00Z'),
      }),
    ).toBeNull()
  })
})
