// Checks for when a guest-reported visit is stamped: resolveOccurredAt in
// lib/agent/extract-reported-order.ts. See README.md in this directory.
//
// NOT A TEST SUITE AND NOT IN CI. Run by hand. It makes no model call and no
// database call: resolveOccurredAt is pure given a context and a clock.
//
// Every expected instant below is written out longhand as a UTC literal, worked
// out from the venue's offset by hand (America/Los_Angeles on 2026-10-06 is
// UTC-7), rather than computed with the helpers the code under check uses. A
// check that derives its expectation from venueLocalInstant agrees with the
// code by construction.

import assert from 'node:assert/strict'

import { resolveOccurredAt } from '@/lib/agent/extract-reported-order'
import type { RuntimeContext } from '@/lib/agent/types'

const LA = 'America/Los_Angeles'

// The only fields resolveOccurredAt and its helpers read. Hours are left
// empty, which resolveOpenState reads as `unknown`, and unknown resolves to
// `pinned` on the two branches that ask.
function context(overrides: {
  timezone?: string
  createdVia?: string
  createdAt?: string
}): RuntimeContext {
  return {
    venue: {
      timezone: overrides.timezone ?? LA,
      venueInfo: { hours: {} },
    },
    guest: {
      createdVia: overrides.createdVia ?? 'instagram_dm',
      createdAt: new Date(overrides.createdAt ?? '2026-09-01T18:00:00.000Z'),
    },
  } as unknown as RuntimeContext
}

const lines: string[] = []
let failed = 0

function check(name: string, run: () => void) {
  try {
    run()
    lines.push(`ok   ${name}`)
  } catch (e) {
    failed += 1
    lines.push(`FAIL ${name}\n       ${e instanceof Error ? e.message : e}`)
  }
}

function expectStamp(
  actual: { occurredAt: Date; precision: string },
  iso: string,
  precision: string,
) {
  assert.equal(actual.occurredAt.toISOString(), iso)
  assert.equal(actual.precision, precision)
}

// 2:39pm in Los Angeles, the Oct 6 phone-test message.
const AFTERNOON = new Date('2026-10-06T21:39:00.000Z')
// 9:15am in Los Angeles: venue-local noon is still ahead.
const MORNING = new Date('2026-10-06T16:15:00.000Z')
// 12:05am in Los Angeles on Oct 6.
const JUST_PAST_MIDNIGHT = new Date('2026-10-06T07:05:00.000Z')

check('a same-day report in the afternoon is stamped at the message', () => {
  expectStamp(
    resolveOccurredAt(
      'specific_past_day',
      '2026-10-06',
      context({}),
      AFTERNOON,
    ),
    '2026-10-06T21:39:00.000Z',
    'approximate',
  )
})

check('a same-day report before noon is not stamped in the future', () => {
  expectStamp(
    resolveOccurredAt('specific_past_day', '2026-10-06', context({}), MORNING),
    '2026-10-06T16:15:00.000Z',
    'approximate',
  )
})

check("yesterday keeps that day's venue-local noon", () => {
  expectStamp(
    resolveOccurredAt(
      'specific_past_day',
      '2026-10-05',
      context({}),
      AFTERNOON,
    ),
    '2026-10-05T19:00:00.000Z',
    'approximate',
  )
})

check('yesterday keeps noon just after local midnight', () => {
  expectStamp(
    resolveOccurredAt(
      'specific_past_day',
      '2026-10-05',
      context({}),
      JUST_PAST_MIDNIGHT,
    ),
    '2026-10-05T19:00:00.000Z',
    'approximate',
  )
})

check('a date resolved to tomorrow is clamped to the message', () => {
  expectStamp(
    resolveOccurredAt(
      'specific_past_day',
      '2026-10-07',
      context({}),
      AFTERNOON,
    ),
    '2026-10-06T21:39:00.000Z',
    'approximate',
  )
})

check('a malformed date falls back to the message', () => {
  expectStamp(
    resolveOccurredAt('specific_past_day', 'yesterday', context({}), AFTERNOON),
    '2026-10-06T21:39:00.000Z',
    'approximate',
  )
})

check('an unreadable timezone falls back to the message', () => {
  expectStamp(
    resolveOccurredAt(
      'specific_past_day',
      '2026-10-05',
      context({ timezone: 'Not/AZone' }),
      AFTERNOON,
    ),
    '2026-10-06T21:39:00.000Z',
    'approximate',
  )
})

check('a present-tense report is unchanged', () => {
  expectStamp(
    resolveOccurredAt('present', '', context({}), AFTERNOON),
    '2026-10-06T21:39:00.000Z',
    'pinned',
  )
})

check("a scan-day guest's same-day report is still pinned", () => {
  expectStamp(
    resolveOccurredAt(
      'specific_past_day',
      '2026-10-06',
      // Enrolled by scanning at 1:10pm in Los Angeles the same day.
      context({ createdVia: 'qr_scan', createdAt: '2026-10-06T20:10:00.000Z' }),
      AFTERNOON,
    ),
    '2026-10-06T21:39:00.000Z',
    'pinned',
  )
})

check("a scan-day guest's report about yesterday keeps noon", () => {
  expectStamp(
    resolveOccurredAt(
      'specific_past_day',
      '2026-10-05',
      context({ createdVia: 'qr_scan', createdAt: '2026-10-06T20:10:00.000Z' }),
      AFTERNOON,
    ),
    '2026-10-05T19:00:00.000Z',
    'approximate',
  )
})

console.log(lines.join('\n'))
console.log(
  failed > 0
    ? `HARNESS FAILED: ${failed} of ${lines.length} checks`
    : `all ${lines.length} checks passed`,
)
process.exit(failed > 0 ? 1 : 0)
