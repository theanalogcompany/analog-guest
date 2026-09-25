// TAC-536's timing rules. Every constant here decides something guest-facing,
// so the boundaries are pinned rather than the middles.

import { describe, expect, it } from 'vitest'

import {
  isScanGreetingDue,
  isScanTooStale,
  scanCarryForwardAt,
  SCAN_CARRY_FORWARD_MS,
  SCAN_GREETING_CARRY_FORWARD_MS,
  SCAN_GREETING_DELAY_MS,
  SCAN_GREETING_MAX_AGE_MS,
  venueLocalDate,
} from './scan-arrival'

const MINUTE = 60 * 1000
const SCAN = new Date('2026-09-20T20:18:08.000Z')
const at = (ms: number) => new Date(SCAN.getTime() + ms)

describe('the constants', () => {
  // Pinned by value, not merely by relation. Both came from the ruling, and a
  // change to either is a change to what a guest experiences: five minutes is
  // how long the venue waits before speaking, fifteen is how late it may still
  // claim the guest is standing there.
  it('are the ruled values', () => {
    expect(SCAN_GREETING_DELAY_MS).toBe(5 * MINUTE)
    expect(SCAN_GREETING_MAX_AGE_MS).toBe(15 * MINUTE)
    expect(SCAN_GREETING_CARRY_FORWARD_MS).toBe(30 * MINUTE)
  })

  // Not a coincidence: "did they write instead of being greeted" and "were
  // they standing there when they wrote" are one question.
  it('use one window for the greeting delay and the at-counter carry-forward', () => {
    expect(SCAN_CARRY_FORWARD_MS).toBe(SCAN_GREETING_DELAY_MS)
  })

  // A stale bound below the delay would refuse every greeting the delay just
  // waited for, and the flow would silently never fire.
  it('leave a window between the delay and the staleness bound', () => {
    expect(SCAN_GREETING_MAX_AGE_MS).toBeGreaterThan(SCAN_GREETING_DELAY_MS)
  })
})

describe('isScanGreetingDue', () => {
  it.each<[string, number, boolean]>([
    ['one second after the scan', 1000, false],
    ['a second short of five minutes', 5 * MINUTE - 1000, false],
    ['exactly five minutes', 5 * MINUTE, true],
    ['eight minutes', 8 * MINUTE, true],
  ])('%s', (_label, offset, due) => {
    expect(isScanGreetingDue(SCAN, at(offset))).toBe(due)
  })
})

describe('isScanTooStale', () => {
  it.each<[string, number, boolean]>([
    ['five minutes', 5 * MINUTE, false],
    ['a second short of fifteen minutes', 15 * MINUTE - 1000, false],
    // Exactly at the bound is still inside it, so the due and stale predicates
    // can never both refuse the same instant.
    ['exactly fifteen minutes', 15 * MINUTE, false],
    ['a second past fifteen minutes', 15 * MINUTE + 1000, true],
    ['an hour', 60 * MINUTE, true],
  ])('%s', (_label, offset, stale) => {
    expect(isScanTooStale(SCAN, at(offset))).toBe(stale)
  })
})

describe('scanCarryForwardAt', () => {
  it('returns nothing when the guest has never scanned', () => {
    expect(
      scanCarryForwardAt({ lastScanAt: null, lastGreetingAt: null, inboundAt: at(MINUTE) }),
    ).toBeNull()
  })

  it.each<[string, number, boolean]>([
    ['two minutes after the scan', 2 * MINUTE, true],
    ['exactly five minutes after', 5 * MINUTE, true],
    ['a second past five minutes', 5 * MINUTE + 1000, false],
  ])('the scan anchor alone: %s', (_label, offset, carried) => {
    const result = scanCarryForwardAt({
      lastScanAt: SCAN,
      lastGreetingAt: null,
      inboundAt: at(offset),
    })
    expect(result === null ? null : result.getTime()).toBe(carried ? SCAN.getTime() : null)
  })

  // THE ACCEPTANCE CRITERION for the second anchor, and the scenario the
  // ruling named: a guest with prior messages is greeted at five minutes and
  // answers "an oat latte" at eight. Without the greeting anchor this turn is
  // outside the five-minute window and `understand_order` never arms, which
  // loses the order capture the whole flow exists for.
  it('carries a scan forward to a reply eight minutes later, through the greeting', () => {
    const result = scanCarryForwardAt({
      lastScanAt: SCAN,
      lastGreetingAt: at(5 * MINUTE),
      inboundAt: at(8 * MINUTE),
    })
    expect(result?.toISOString()).toBe(SCAN.toISOString())
  })

  it.each<[string, number, number, boolean]>([
    ['a reply 29 minutes after the greeting', 5 * MINUTE, 34 * MINUTE, true],
    ['a reply exactly 30 minutes after', 5 * MINUTE, 35 * MINUTE, true],
    ['a reply 31 minutes after', 5 * MINUTE, 36 * MINUTE, false],
  ])('the greeting anchor: %s', (_label, greetOffset, inboundOffset, carried) => {
    const result = scanCarryForwardAt({
      lastScanAt: SCAN,
      lastGreetingAt: at(greetOffset),
      inboundAt: at(inboundOffset),
    })
    expect(result === null ? null : result.getTime()).toBe(carried ? SCAN.getTime() : null)
  })

  // The anchor returned is the SCAN's time, never the greeting's:
  // visitConfirmedAt means when the visit was confirmed, and the scan is when
  // it was. The greeting is only our own evidence that it had been.
  it('returns the scan time even when the greeting is what carried it', () => {
    const result = scanCarryForwardAt({
      lastScanAt: SCAN,
      lastGreetingAt: at(5 * MINUTE),
      inboundAt: at(20 * MINUTE),
    })
    expect(result?.toISOString()).toBe(SCAN.toISOString())
  })

  // A greeting sent BEFORE the scan belongs to an older arrival, so it is not
  // evidence that this one is still current.
  it('ignores a greeting that predates the scan', () => {
    const result = scanCarryForwardAt({
      lastScanAt: SCAN,
      lastGreetingAt: at(-10 * MINUTE),
      inboundAt: at(10 * MINUTE),
    })
    expect(result).toBeNull()
  })

  // The Voices regen pins history to an old inbound while reading today's
  // rows, so an anchor later than the message being replayed is reachable.
  it('ignores a scan that happened after the inbound', () => {
    const result = scanCarryForwardAt({
      lastScanAt: SCAN,
      lastGreetingAt: null,
      inboundAt: at(-MINUTE),
    })
    expect(result).toBeNull()
  })
})

describe('venueLocalDate', () => {
  it('renders the venue day, not the UTC day', () => {
    // 02:30Z on the 21st is 19:30 on the 20th in Los Angeles. The repeat guard
    // keys on this, so a UTC day would end a venue's day mid-evening.
    const instant = new Date('2026-09-21T02:30:00.000Z')
    expect(venueLocalDate(instant, 'America/Los_Angeles')).toBe('2026-09-20')
    expect(venueLocalDate(instant, 'UTC')).toBe('2026-09-21')
  })

  it('returns null on a timezone this runtime cannot use', () => {
    expect(venueLocalDate(new Date(), 'America/Los_Angles')).toBeNull()
  })
})
