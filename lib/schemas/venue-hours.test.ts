import { describe, expect, it } from 'vitest'

import { classifyDay, formatMinutes, parseDayRange, resolveOpenState } from './venue-hours'
import type { VenueInfo } from './venue-info'

const TZ = 'America/Los_Angeles'

/** Le Mil's real shape: same range every day, en dash, 12-hour clock. */
const LE_MILS: VenueInfo['hours'] = {
  monday: '7:00 AM – 3:00 PM',
  tuesday: '7:00 AM – 3:00 PM',
  wednesday: '7:00 AM – 3:00 PM',
  thursday: '7:00 AM – 3:00 PM',
  friday: '7:00 AM – 3:00 PM',
  saturday: '7:00 AM – 3:00 PM',
  sunday: '7:00 AM – 3:00 PM',
}

/** Build a Date that lands on a known wall-clock time in TZ. */
function at(iso: string): Date {
  return new Date(iso)
}

describe('parseDayRange', () => {
  it('parses the canonical en-dash form the venue-spec parser writes', () => {
    expect(parseDayRange('7:00 AM – 3:00 PM')).toEqual({
      openMin: 7 * 60,
      closeMin: 15 * 60,
      overnight: false,
    })
  })

  it.each([
    ['hyphen', '7:00 AM - 3:00 PM'],
    ['em dash', '7:00 AM — 3:00 PM'],
    ['compact meridiem', '7am-3pm'],
    ['24-hour', '07:00-15:00'],
    ['the word to', '7:00 AM to 3:00 PM'],
  ])('parses the %s variant an operator might hand-type', (_label, value) => {
    expect(parseDayRange(value)).toEqual({ openMin: 420, closeMin: 900, overnight: false })
  })

  it('strips the trailing per-row note the venue-spec parser appends', () => {
    expect(parseDayRange('7:00 AM – 3:00 PM (kitchen closes at 2)')).toEqual({
      openMin: 420,
      closeMin: 900,
      overnight: false,
    })
  })

  it('flags a range that crosses midnight', () => {
    expect(parseDayRange('5:00 PM – 2:00 AM')).toEqual({
      openMin: 17 * 60,
      closeMin: 2 * 60,
      overnight: true,
    })
  })

  it('maps 12am to midnight and 12pm to noon', () => {
    expect(parseDayRange('12:00 AM – 12:00 PM')).toEqual({
      openMin: 0,
      closeMin: 720,
      overnight: false,
    })
  })

  // Each of these must return null rather than a guessed range. A wrong range
  // here becomes a confident "we're closed" to a guest standing in an open
  // venue, which is the expensive direction.
  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['explicit Closed', 'Closed'],
    ['prose', 'by appointment only'],
    ['one time only', '7:00 AM'],
    ['three parts', '7:00 AM – 11:00 AM – 3:00 PM'],
    ['garbage minutes', '7:99 AM – 3:00 PM'],
    ['hour 13 on a 12-hour clock', '13:00 PM – 3:00 PM'],
    ['hour 25', '25:00-26:00'],
    ['identical open and close', '7:00 AM – 7:00 AM'],
    ['explicit Closed on both sides', 'Closed – Closed'],
  ])('returns null for %s', (_label, value) => {
    expect(parseDayRange(value)).toBeNull()
  })

  // The BLOCKER this module shipped with before review. A descending pair with
  // no meridiem is a cafe writing 7am-3pm in shorthand far more often than a
  // bar open past midnight, but read naively it becomes an overnight range
  // that reports OPEN at 7:57pm — the exact minute of the incident. Ambiguous
  // means unknown; only a pair that said which half of the day it meant can
  // claim to cross midnight.
  describe('descending pairs require explicit half-of-day evidence', () => {
    it.each([
      ['bare hours', '7-3'],
      ['bare hours, nine to five', '9-5'],
      ['bare hours with minutes', '7:00-3:00'],
      ['meridiem on the open side only', '7am-3'],
      ['bare hours, ten to six', '10-6'],
      ['en dash, the canonical separator', '7 – 3'],
    ])('rejects %s', (_label, value) => {
      expect(parseDayRange(value)).toBeNull()
    })

    it.each([
      ['both meridiems', '5:00 PM – 2:00 AM'],
      ['unambiguous 24-hour', '17:00-02:00'],
      ['past-noon open, zero-padded close', '23:00-02:00'],
    ])('accepts %s as a genuine overnight range', (_label, value) => {
      expect(parseDayRange(value)?.overnight).toBe(true)
    })

    it('still accepts an ASCENDING bare-hour range, which is unambiguous', () => {
      // 7 to 3pm means the same thing under either reading, so no evidence
      // is required. Only descending pairs are ambiguous.
      expect(parseDayRange('7-3pm')).toEqual({ openMin: 420, closeMin: 900, overnight: false })
    })
  })
})

describe('classifyDay', () => {
  it('reads the canonical closed-day shape the venue-spec parser writes', () => {
    // parseHoursFromSection2 composes `${open} – ${close}` from two cells, so
    // a closed day arrives like this, not as a bare "Closed".
    expect(classifyDay('Closed – Closed')).toEqual({ kind: 'closed' })
  })

  it('reads a half-filled closed row', () => {
    expect(classifyDay('Closed – ')).toEqual({ kind: 'closed' })
  })

  it('reads a hand-typed bare Closed', () => {
    expect(classifyDay('Closed')).toEqual({ kind: 'closed' })
  })

  it('returns unknown for an ABSENT day rather than assuming a closure', () => {
    // Load-bearing. parse-venue-spec drops table rows it can't label ("Sat &
    // Sun", "Weekends") and the admin page writes undefined for a cleared
    // field, so absence means "nobody said" at least as often as "shut".
    expect(classifyDay(undefined)).toEqual({ kind: 'unknown' })
  })

  it('returns unknown for a whitespace-only value', () => {
    expect(classifyDay('   ')).toEqual({ kind: 'unknown' })
  })

  it('returns unknown for a dash placeholder, which is not a stated closure', () => {
    expect(classifyDay('—')).toEqual({ kind: 'unknown' })
    expect(classifyDay('— – —')).toEqual({ kind: 'unknown' })
  })

  it('returns a range for readable hours', () => {
    expect(classifyDay('7:00 AM – 3:00 PM')).toEqual({
      kind: 'range',
      range: { openMin: 420, closeMin: 900, overnight: false },
    })
  })
})

describe('formatMinutes', () => {
  it.each([
    [0, '12:00 AM'],
    [420, '7:00 AM'],
    [720, '12:00 PM'],
    [900, '3:00 PM'],
    [1439, '11:59 PM'],
  ])('renders %i as %s', (minutes, expected) => {
    expect(formatMinutes(minutes)).toBe(expected)
  })
})

describe('resolveOpenState', () => {
  it('reports open with the closing time during business hours', () => {
    // Friday 2026-09-11, 10:30 local.
    const state = resolveOpenState(LE_MILS, TZ, at('2026-09-11T17:30:00Z'))
    expect(state).toEqual({ state: 'open', closesAt: '3:00 PM' })
  })

  it('reports closed with the next opening after close', () => {
    // Friday 2026-09-11, 19:57 local — the exact shape of the UAT repro.
    const state = resolveOpenState(LE_MILS, TZ, at('2026-09-12T02:57:00Z'))
    expect(state).toEqual({
      state: 'closed',
      opensAt: { day: 'tomorrow', time: '7:00 AM' },
    })
  })

  it('reports closed with today as the next opening before the venue opens', () => {
    // Friday 2026-09-11, 05:30 local — closed, but opens later the same day.
    const state = resolveOpenState(LE_MILS, TZ, at('2026-09-11T12:30:00Z'))
    expect(state).toEqual({ state: 'closed', opensAt: { day: 'today', time: '7:00 AM' } })
  })

  it('treats the exact closing minute as closed', () => {
    // Friday 2026-09-11, 15:00 local exactly.
    const state = resolveOpenState(LE_MILS, TZ, at('2026-09-11T22:00:00Z'))
    expect(state.state).toBe('closed')
  })

  it('treats the exact opening minute as open', () => {
    // Friday 2026-09-11, 07:00 local exactly.
    const state = resolveOpenState(LE_MILS, TZ, at('2026-09-11T14:00:00Z'))
    expect(state).toEqual({ state: 'open', closesAt: '3:00 PM' })
  })

  it('evaluates in venue-local time, not server time', () => {
    // 2026-09-11T17:30:00Z is 10:30 in LA (open) and 03:30 in Berlin (closed).
    // Same instant, opposite answers — this is the TAC-293 timezone guarantee.
    const instant = at('2026-09-11T17:30:00Z')
    expect(resolveOpenState(LE_MILS, 'America/Los_Angeles', instant).state).toBe('open')
    expect(resolveOpenState(LE_MILS, 'Europe/Berlin', instant).state).toBe('closed')
  })

  describe('overnight ranges', () => {
    const BAR: VenueInfo['hours'] = {
      monday: '5:00 PM – 2:00 AM',
      tuesday: '5:00 PM – 2:00 AM',
      wednesday: '5:00 PM – 2:00 AM',
      thursday: '5:00 PM – 2:00 AM',
      friday: '5:00 PM – 2:00 AM',
      saturday: '5:00 PM – 2:00 AM',
      sunday: '5:00 PM – 2:00 AM',
    }

    it('is open late in the evening', () => {
      // Friday 23:00 local.
      expect(resolveOpenState(BAR, TZ, at('2026-09-12T06:00:00Z'))).toEqual({
        state: 'open',
        closesAt: '2:00 AM',
      })
    })

    it("is open after midnight, on yesterday's range", () => {
      // Saturday 01:00 local — inside Friday's overnight window.
      expect(resolveOpenState(BAR, TZ, at('2026-09-12T08:00:00Z'))).toEqual({
        state: 'open',
        closesAt: '2:00 AM',
      })
    })

    it('is closed in the dead hours between close and open', () => {
      // Saturday 10:00 local.
      expect(resolveOpenState(BAR, TZ, at('2026-09-12T17:00:00Z')).state).toBe('closed')
    })

    // REGRESSION GUARD. resolveOpenState inherits yesterday's overnight range
    // for the post-midnight half only. isWithin matches an overnight range on
    // BOTH halves, so without the explicit `minutes < closeMin` test this
    // reports OPEN at 8pm on a day the venue is shut, on the strength of
    // yesterday's window. Deleting that one condition leaves every other test
    // in this file green — which is precisely why this one exists.
    it("does not inherit yesterday's overnight range in the EVENING", () => {
      const closedSaturday: VenueInfo['hours'] = { ...BAR, saturday: 'Closed' }
      // Saturday 20:00 local: inside Friday's 5pm-2am window by the evening
      // half, but Saturday itself is closed.
      expect(resolveOpenState(closedSaturday, TZ, at('2026-09-13T03:00:00Z'))).toEqual({
        state: 'closed',
        opensAt: { day: 'tomorrow', time: '5:00 PM' },
      })
    })
  })

  describe('safe-direction failures', () => {
    it("returns unknown when today's entry is present but unparseable", () => {
      const hours: VenueInfo['hours'] = { ...LE_MILS, friday: 'ask us!' }
      // Friday 10:30 local.
      expect(resolveOpenState(hours, TZ, at('2026-09-11T17:30:00Z'))).toEqual({
        state: 'unknown',
      })
    })

    it('returns unknown when no day parses at all', () => {
      const hours: VenueInfo['hours'] = { notes: 'see instagram' }
      expect(resolveOpenState(hours, TZ, at('2026-09-11T17:30:00Z'))).toEqual({
        state: 'unknown',
      })
    })

    it('returns unknown for an empty hours object', () => {
      expect(resolveOpenState({}, TZ, at('2026-09-11T17:30:00Z'))).toEqual({ state: 'unknown' })
    })

    it('returns unknown rather than throwing on an invalid timezone', () => {
      expect(resolveOpenState(LE_MILS, 'Not/AZone', at('2026-09-11T17:30:00Z'))).toEqual({
        state: 'unknown',
      })
    })

    it('returns unknown for an ABSENT day even when every other day parses', () => {
      // Reversed during code review, deliberately. An earlier version read
      // absence as a closure, which would emit a confident "CLOSED right now,
      // do not tell the guest to come by" ALL DAY at an open venue whose
      // Friday row simply never made it into venue_info — and rows go missing
      // routinely (parse-venue-spec drops "Sat & Sun" style labels; the admin
      // page writes undefined for a cleared field). A real closure is stated,
      // not inferred: see the explicit-Closed test below.
      const missingFriday: VenueInfo['hours'] = { ...LE_MILS }
      delete missingFriday.friday
      expect(resolveOpenState(missingFriday, TZ, at('2026-09-11T17:30:00Z'))).toEqual({
        state: 'unknown',
      })
    })

    it('treats an explicit "Closed" day as closed, not as a parse failure', () => {
      const hours: VenueInfo['hours'] = { ...LE_MILS, friday: 'Closed' }
      const state = resolveOpenState(hours, TZ, at('2026-09-11T17:30:00Z'))
      expect(state).toEqual({ state: 'closed', opensAt: { day: 'tomorrow', time: '7:00 AM' } })
    })

    it('treats the venue-spec parser\'s own "Closed – Closed" shape as closed', () => {
      // The shape that actually reaches production for a closed day. Matching
      // only the hand-typed bare "Closed" left this unreadable, which was the
      // original excuse for treating absence as a closure.
      const hours: VenueInfo['hours'] = { ...LE_MILS, friday: 'Closed – Closed' }
      expect(resolveOpenState(hours, TZ, at('2026-09-11T17:30:00Z'))).toEqual({
        state: 'closed',
        opensAt: { day: 'tomorrow', time: '7:00 AM' },
      })
    })

    it('returns unknown for a whitespace-only day', () => {
      const hours: VenueInfo['hours'] = { ...LE_MILS, friday: '   ' }
      expect(resolveOpenState(hours, TZ, at('2026-09-11T17:30:00Z'))).toEqual({
        state: 'unknown',
      })
    })

    it('returns unknown for an ambiguous bare-hour range at the incident minute', () => {
      // End-to-end version of the BLOCKER: "7-3" must not render OPEN at
      // 19:57. Silence is correct here; a confident wrong OPEN is not.
      const shorthand: VenueInfo['hours'] = {
        monday: '7-3', tuesday: '7-3', wednesday: '7-3', thursday: '7-3',
        friday: '7-3', saturday: '7-3', sunday: '7-3',
      }
      expect(resolveOpenState(shorthand, TZ, at('2026-09-12T02:57:00Z'))).toEqual({
        state: 'unknown',
      })
    })

    it('reports closed with no opening claim when only today parses and it has passed', () => {
      // Friday 19:57 local, and Friday is the ONLY readable day. We know we're
      // closed; we do not know when we next open, so we say nothing about it
      // rather than inventing a time.
      const hours: VenueInfo['hours'] = { friday: '7:00 AM – 3:00 PM' }
      expect(resolveOpenState(hours, TZ, at('2026-09-12T02:57:00Z'))).toEqual({
        state: 'closed',
        opensAt: null,
      })
    })

    it('names the weekday when the next opening is more than a day out', () => {
      // Friday states a closure; the weekend is unstated; Monday parses. The
      // next opening is far enough out to be named by weekday rather than
      // "today" or "tomorrow".
      const hours: VenueInfo['hours'] = {
        friday: 'Closed',
        monday: '7:00 AM – 3:00 PM',
      }
      expect(resolveOpenState(hours, TZ, at('2026-09-12T02:57:00Z'))).toEqual({
        state: 'closed',
        opensAt: { day: 'Monday', time: '7:00 AM' },
      })
    })
  })
})
