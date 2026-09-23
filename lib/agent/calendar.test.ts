import { describe, expect, it } from 'vitest'

import { CALENDAR_DAYS, computeCalendar } from './calendar'

const LA = 'America/Los_Angeles'

function labels(tz: string, iso: string): string[] {
  return computeCalendar(tz, new Date(iso)).map((d) => `${d.weekday} ${d.monthDay}`)
}

describe('computeCalendar (TAC-522)', () => {
  it('returns exactly CALENDAR_DAYS entries', () => {
    expect(computeCalendar(LA, new Date('2026-09-22T20:00:00Z'))).toHaveLength(CALENDAR_DAYS)
  })

  // Pinned so changing the window is a deliberate act with a measurement
  // behind it, not a drive-by edit. The cost was measured against a real
  // prompt at this length.
  it('covers 10 days', () => {
    expect(CALENDAR_DAYS).toBe(10)
  })

  it('starts at today in the venue timezone, not UTC', () => {
    // 2026-09-23T02:00Z is still 2026-09-22 (Tuesday) in Los Angeles.
    expect(labels(LA, '2026-09-23T02:00:00Z')[0]).toBe('Tue Sep 22')
    // The same instant is already Wednesday the 23rd in London.
    expect(labels('Europe/London', '2026-09-23T02:00:00Z')[0]).toBe('Wed Sep 23')
  })

  it('advances one calendar day per entry', () => {
    expect(labels(LA, '2026-09-22T20:00:00Z').slice(0, 4)).toEqual([
      'Tue Sep 22',
      'Wed Sep 23',
      'Thu Sep 24',
      'Fri Sep 25',
    ])
  })

  // NAMED REGRESSION, and it is the reason this function does calendar
  // arithmetic rather than instant arithmetic.
  //
  // The first version added 24 hours to the instant and formatted in the
  // venue's zone, under a comment asserting that was DST-safe. It was not: at
  // 23:30 on the evening before a spring-forward transition the window came
  // out "Sat Mar 13, Mon Mar 15, ..." with Sunday the 14th MISSING ENTIRELY.
  // A guest asking that night about a March 14 event would have hit the
  // rule's out-of-window branch and been told the plain date instead of the
  // weekday — degraded rather than wrong, but only by luck of the wording.
  //
  // US spring-forward is 2027-03-14. 2027-03-14T07:30Z is 23:30 on the 13th
  // in Los Angeles, which is the instant that broke it.
  it('does not skip a day across spring-forward, from late the evening before', () => {
    const out = labels(LA, '2027-03-14T07:30:00Z')
    expect(out.slice(0, 4)).toEqual(['Sat Mar 13', 'Sun Mar 14', 'Mon Mar 15', 'Tue Mar 16'])
    expect(out).toContain('Sun Mar 14')
  })

  it('does not repeat a day across fall-back, from late the evening before', () => {
    // US fall-back is 2026-11-01. 2026-11-01T06:30Z is 23:30 on Oct 31 in LA.
    const out = labels(LA, '2026-11-01T06:30:00Z')
    expect(out.slice(0, 4)).toEqual(['Sat Oct 31', 'Sun Nov 1', 'Mon Nov 2', 'Tue Nov 3'])
    expect(new Set(out).size).toBe(out.length)
  })

  it('rolls over a month boundary', () => {
    expect(labels(LA, '2026-09-29T20:00:00Z').slice(0, 3)).toEqual([
      'Tue Sep 29',
      'Wed Sep 30',
      'Thu Oct 1',
    ])
  })

  it('rolls over a year boundary', () => {
    expect(labels(LA, '2026-12-30T20:00:00Z').slice(0, 3)).toEqual([
      'Wed Dec 30',
      'Thu Dec 31',
      'Fri Jan 1',
    ])
  })

  it('rolls over a leap day', () => {
    expect(labels(LA, '2028-02-27T20:00:00Z').slice(0, 4)).toEqual([
      'Sun Feb 27',
      'Mon Feb 28',
      'Tue Feb 29',
      'Wed Mar 1',
    ])
  })

  // The labels are the surface the lookup matches against, and they were
  // chosen to match how operators write dates in venue notes ("September 25,
  // 2026"). A switch to ISO or to full weekday names would silently make the
  // lookup a two-step conversion again, which is what failed.
  it('uses short weekday and month-day words, never ISO', () => {
    const [first] = computeCalendar(LA, new Date('2026-09-22T20:00:00Z'))
    expect(first.weekday).toBe('Tue')
    expect(first.monthDay).toBe('Sep 22')
    expect(first.monthDay).not.toMatch(/\d{4}/)
    expect(`${first.weekday} ${first.monthDay}`).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('never carries a year, which R36 tells the model not to say', () => {
    for (const d of computeCalendar(LA, new Date('2026-12-28T20:00:00Z'))) {
      expect(`${d.weekday} ${d.monthDay}`).not.toMatch(/\b(19|20)\d{2}\b/)
    }
  })
})
