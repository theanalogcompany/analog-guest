// TAC-386. The venue-hours arithmetic behind "check back in a few hours".
//
// Every instant is written as a UTC literal with the venue-local wall clock in a
// comment beside it, because the bugs this is guarding against are all
// off-by-one-timezone and a fixture that says `PT` in its own name proves
// nothing. Le Mil's is the real venue: America/Los_Angeles, 7:00 AM - 3:00 PM
// every day, with the EN DASH (U+2013) its stored hours actually use.

import { describe, expect, it } from 'vitest'

import {
  computeInquiryFollowupDueAt,
  INQUIRY_FOLLOWUP_DELAY_HOURS,
  nextOpeningInstant,
} from './inquiry-followup-timing'
import type { VenueInfo } from '@/lib/schemas'

const TZ = 'America/Los_Angeles'
const DELAY = INQUIRY_FOLLOWUP_DELAY_HOURS

/** Le Mil's real stored hours, en dash included. */
const LE_MILS: VenueInfo['hours'] = {
  monday: '7:00 AM – 3:00 PM',
  tuesday: '7:00 AM – 3:00 PM',
  wednesday: '7:00 AM – 3:00 PM',
  thursday: '7:00 AM – 3:00 PM',
  friday: '7:00 AM – 3:00 PM',
  saturday: '7:00 AM – 3:00 PM',
  sunday: '7:00 AM – 3:00 PM',
}

const HOURS = 60 * 60 * 1000

/** Meta's window: 24 hours from the guest's action. */
const windowFrom = (askedAt: Date) => new Date(askedAt.getTime() + 24 * HOURS)

function due(
  askedAt: Date,
  hours: VenueInfo['hours'] | null = LE_MILS,
  timezone: string | null = TZ,
  windowClosesAt = windowFrom(askedAt),
) {
  return computeInquiryFollowupDueAt({
    askedAt,
    timezone,
    hours,
    delayHours: DELAY,
    windowClosesAt,
  })
}

describe('computeInquiryFollowupDueAt — the delay lands inside an open period', () => {
  it('sends delayHours after the question when the venue is still open', () => {
    // Mon 2026-09-28 11:00 PDT. +3h = 14:00 PDT, inside 7:00-15:00.
    const asked = new Date('2026-09-28T18:00:00Z')
    expect(due(asked)).toEqual({
      kind: 'due',
      dueAt: new Date('2026-09-28T21:00:00Z'), // Mon 14:00 PDT
    })
  })

  it('is exactly askedAt + delayHours, not a rounded hour', () => {
    // Mon 2026-09-28 09:17 PDT. +3h = 12:17 PDT, still open.
    const asked = new Date('2026-09-28T16:17:00Z')
    const result = due(asked)
    expect(result).toEqual({
      kind: 'due',
      dueAt: new Date('2026-09-28T19:17:00Z'),
    })
  })
})

describe('computeInquiryFollowupDueAt — the delay lands while closed', () => {
  // Ruled 2026-09-30 (option A): delayHours INTO the next open period, not at
  // the opening. At Le Mil's that is 10:00, not a 7:00 ping.
  it('rolls an afternoon question to the next opening plus the delay', () => {
    // Mon 2026-09-28 14:00 PDT. +3h = 17:00 PDT, shut (closes 15:00).
    const asked = new Date('2026-09-28T21:00:00Z')
    expect(due(asked)).toEqual({
      kind: 'due',
      dueAt: new Date('2026-09-29T17:00:00Z'), // Tue 10:00 PDT
    })
  })

  it('rolls a late-evening question to the next morning, still inside the window', () => {
    // Mon 2026-09-28 20:00 PDT. +3h = 23:00 PDT, shut.
    const asked = new Date('2026-09-29T03:00:00Z')
    expect(due(asked)).toEqual({
      kind: 'due',
      dueAt: new Date('2026-09-29T17:00:00Z'), // Tue 10:00 PDT
    })
  })

  it('uses the SAME day when the question lands before opening', () => {
    // Mon 2026-09-28 02:00 PDT. +3h = 05:00 PDT, before the 7:00 opening, so
    // the next opening is TODAY at 7:00 rather than tomorrow's.
    const asked = new Date('2026-09-28T09:00:00Z')
    expect(due(asked)).toEqual({
      kind: 'due',
      dueAt: new Date('2026-09-28T17:00:00Z'), // Mon 10:00 PDT
    })
  })

  it('steps over days the venue positively states it is shut', () => {
    // Sat 2026-10-03 08:00 PDT with Sun and Mon shut. +3h = 11:00, open, so
    // force the closed branch with an evening question instead.
    const asked = new Date('2026-10-04T02:00:00Z') // Sat 19:00 PDT
    const hours = { ...LE_MILS, sunday: 'Closed', monday: 'Closed' }
    // Window would shut Sun 19:00, so widen it to isolate the day walk.
    const result = due(asked, hours, TZ, new Date('2026-10-10T00:00:00Z'))
    expect(result).toEqual({
      kind: 'due',
      dueAt: new Date('2026-10-06T17:00:00Z'), // Tue 10:00 PDT
    })
  })

  it('reads the opening on the correct side of a DST change', () => {
    // Sat 2026-10-31 20:00 PDT (UTC-7). +3h = 23:00, shut. The next opening is
    // Sun 2026-11-01 07:00, and the clocks go back that morning, so it is
    // 07:00 PST (UTC-8) = 15:00Z, not 14:00Z. +3h = 18:00Z.
    const asked = new Date('2026-11-01T03:00:00Z')
    expect(due(asked)).toEqual({
      kind: 'due',
      dueAt: new Date('2026-11-01T18:00:00Z'), // Sun 10:00 PST
    })
  })

  it('falls back to the opening itself when the open period is shorter than the delay', () => {
    // Sat 19:00 PDT, and Sunday is a 2-hour morning. 09:00 + 3h would be 12:00,
    // an hour after the 11:00 close, so the opening is the only moment inside
    // the period.
    const asked = new Date('2026-10-04T02:00:00Z') // Sat 19:00 PDT
    const hours = { ...LE_MILS, sunday: '9:00 AM – 11:00 AM' }
    expect(due(asked, hours)).toEqual({
      kind: 'due',
      dueAt: new Date('2026-10-04T16:00:00Z'), // Sun 09:00 PDT
    })
  })

  it('handles an overnight range, whose close is on the next local day', () => {
    // A bar: 5:00 PM - 2:00 AM every day. A question at 14:00 PDT gives a
    // candidate of 17:00, which IS open (the range starts at 17:00), so ask at
    // 10:00 instead: +3h = 13:00, shut, next opening 17:00 today, +3h = 20:00.
    const asked = new Date('2026-09-28T17:00:00Z') // Mon 10:00 PDT
    const overnight: VenueInfo['hours'] = {
      monday: '5:00 PM – 2:00 AM',
      tuesday: '5:00 PM – 2:00 AM',
      wednesday: '5:00 PM – 2:00 AM',
      thursday: '5:00 PM – 2:00 AM',
      friday: '5:00 PM – 2:00 AM',
      saturday: '5:00 PM – 2:00 AM',
      sunday: '5:00 PM – 2:00 AM',
    }
    expect(due(asked, overnight)).toEqual({
      kind: 'due',
      dueAt: new Date('2026-09-29T03:00:00Z'), // Mon 20:00 PDT
    })
  })
})

describe('computeInquiryFollowupDueAt — skips', () => {
  it('skips when the send would land past Metas 24-hour window', () => {
    // Sat 2026-10-03 13:00 PDT, Sun and Mon shut. The next opening is Tue, so
    // the send would be Tue 10:00 while the window shut Sun 13:00.
    const asked = new Date('2026-10-03T20:00:00Z')
    const hours = { ...LE_MILS, sunday: 'Closed', monday: 'Closed' }
    expect(due(asked, hours)).toEqual({ kind: 'skip', reason: 'past_window' })
  })

  it('skips on a null timezone', () => {
    const asked = new Date('2026-09-28T18:00:00Z')
    expect(due(asked, LE_MILS, null)).toEqual({
      kind: 'skip',
      reason: 'hours_unreadable',
    })
  })

  it('skips on null hours', () => {
    const asked = new Date('2026-09-28T18:00:00Z')
    expect(due(asked, null)).toEqual({
      kind: 'skip',
      reason: 'hours_unreadable',
    })
  })

  it('skips on an unusable timezone string', () => {
    // The plausible Studio typo commitment-expiry.ts records: present is not
    // usable.
    const asked = new Date('2026-09-28T18:00:00Z')
    expect(due(asked, LE_MILS, 'America/Los_Angles')).toEqual({
      kind: 'skip',
      reason: 'hours_unreadable',
    })
  })

  it("skips when today's hours are blank, rather than reading blank as open", () => {
    const asked = new Date('2026-09-28T18:00:00Z')
    const hours = { ...LE_MILS, monday: undefined }
    expect(due(asked, hours)).toEqual({
      kind: 'skip',
      reason: 'hours_unreadable',
    })
  })

  it('skips when a LATER day in the walk is blank, rather than stepping over it', () => {
    // Mon 19:00 PDT, so the walk needs Tuesday, and nobody has said what
    // Tuesday is. Stepping over it to Wednesday would assert Tuesday is shut,
    // which classifyDay's governing rule forbids.
    const asked = new Date('2026-09-29T02:00:00Z')
    const hours = { ...LE_MILS, tuesday: undefined }
    expect(due(asked, hours, TZ, new Date('2026-10-10T00:00:00Z'))).toEqual({
      kind: 'skip',
      reason: 'hours_unreadable',
    })
  })

  it('skips when the venue states it is shut every day', () => {
    const asked = new Date('2026-09-28T18:00:00Z')
    const shut: VenueInfo['hours'] = {
      monday: 'Closed',
      tuesday: 'Closed',
      wednesday: 'Closed',
      thursday: 'Closed',
      friday: 'Closed',
      saturday: 'Closed',
      sunday: 'Closed',
    }
    expect(due(asked, shut, TZ, new Date('2026-10-10T00:00:00Z'))).toEqual({
      kind: 'skip',
      reason: 'hours_unreadable',
    })
  })
})

describe('computeInquiryFollowupDueAt — the window boundary', () => {
  // The skip is `>`, so a send landing exactly ON the stored close is allowed.
  // That boundary is the gate's own, and INSTAGRAM_WINDOW_MARGIN_MS is what
  // actually keeps a send clear of Meta's edge; this pins which side of its own
  // comparison this function sits on so a later change to it has to be
  // deliberate.
  it('allows a send landing exactly on windowClosesAt', () => {
    const asked = new Date('2026-09-28T18:00:00Z') // Mon 11:00 PDT
    const exact = new Date('2026-09-28T21:00:00Z') // the due moment itself
    expect(due(asked, LE_MILS, TZ, exact)).toEqual({
      kind: 'due',
      dueAt: exact,
    })
  })

  it('skips a send one millisecond past windowClosesAt', () => {
    const asked = new Date('2026-09-28T18:00:00Z')
    const tooEarly = new Date('2026-09-28T20:59:59.999Z')
    expect(due(asked, LE_MILS, TZ, tooEarly)).toEqual({
      kind: 'skip',
      reason: 'past_window',
    })
  })
})

describe('nextOpeningInstant', () => {
  it('returns the same days opening when the shop has not opened yet', () => {
    // Mon 05:00 PDT, opens 07:00.
    const from = new Date('2026-09-28T12:00:00Z')
    expect(nextOpeningInstant(LE_MILS, TZ, from)).toEqual(
      new Date('2026-09-28T14:00:00Z'),
    )
  })

  it('returns tomorrows opening once todays has passed', () => {
    // Mon 08:00 PDT: today's 07:00 is behind us.
    const from = new Date('2026-09-28T15:00:00Z')
    expect(nextOpeningInstant(LE_MILS, TZ, from)).toEqual(
      new Date('2026-09-29T14:00:00Z'),
    )
  })

  it('walks across a month boundary', () => {
    // Wed 2026-09-30 20:00 PDT, so the answer is in October and
    // venueLocalInstant has to carry `day + 1` past the end of the month.
    const from = new Date('2026-10-01T03:00:00Z')
    expect(nextOpeningInstant(LE_MILS, TZ, from)).toEqual(
      new Date('2026-10-01T14:00:00Z'), // Thu 2026-10-01 07:00 PDT
    )
  })

  it('returns null rather than looking more than a week ahead', () => {
    // Every day stated shut: there is no opening to find, and the walk must
    // terminate rather than run forever.
    const shut: VenueInfo['hours'] = {
      monday: 'Closed',
      tuesday: 'Closed',
      wednesday: 'Closed',
      thursday: 'Closed',
      friday: 'Closed',
      saturday: 'Closed',
      sunday: 'Closed',
    }
    expect(
      nextOpeningInstant(shut, TZ, new Date('2026-09-28T18:00:00Z')),
    ).toBeNull()
  })

  it('returns null on an unusable timezone', () => {
    expect(
      nextOpeningInstant(
        LE_MILS,
        'Not/AZone',
        new Date('2026-09-28T18:00:00Z'),
      ),
    ).toBeNull()
  })
})

describe('INQUIRY_FOLLOWUP_DELAY_HOURS', () => {
  // The approved value. Pinned so a change to it is a change to a test, which
  // is where a placeholder should be argued about.
  it('is 3 hours', () => {
    expect(INQUIRY_FOLLOWUP_DELAY_HOURS).toBe(3)
  })
})
