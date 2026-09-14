import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OBLIGATION_TYPES } from '@/lib/guests/commitment-expiry'
import type { VenueCommitmentRow } from '../../_lib/load-venue-commitments'
import {
  classifyKind,
  displayRank,
  formatAge,
  formatExpiry,
  isEscalated,
  isUntimed,
  sortForDisplay,
} from './commitment-display'

const NOW = new Date('2026-09-14T12:00:00.000Z')

const row = (overrides: Partial<VenueCommitmentRow> = {}): VenueCommitmentRow => ({
  id: 'c1',
  type: 'comp',
  status: 'open',
  description: 'replacement matcha',
  code: 'Q4X9',
  guestLabel: 'Liam Chen · +15555550142',
  createdAt: '2026-09-08T12:00:00.000Z',
  expiresAt: '2026-11-07T12:00:00.000Z',
  escalatedAt: null,
  expectedArrival: null,
  arrivalSignal: null,
  ...overrides,
})

describe('classifyKind', () => {
  it.each([...OBLIGATION_TYPES])('treats %s as an obligation', (type) => {
    expect(classifyKind(row({ type }))).toBe('obligation')
  })

  it('treats a recommendation as a recommendation', () => {
    expect(classifyKind(row({ type: 'recommendation' }))).toBe('recommendation')
  })

  // SOURCE-LEVEL, because a local ['comp','hold','discount'] array renders
  // identically to the shared set right up until a fifth commitment type is
  // added. OBLIGATION_TYPES is TAC-341's ALLOWLIST, deliberately shaped so a
  // new type defaults to being left alone; a local copy would silently opt
  // this page out of that decision. Same technique as TAC-366's
  // filterByRelevance import assertion.
  it('delegates the obligation set to lib/guests/commitment-expiry', () => {
    const src = readFileSync(join(__dirname, 'commitment-display.ts'), 'utf-8')
    expect(src).toContain("from '@/lib/guests/commitment-expiry'")
    expect(src).toContain('isObligationType')
    // Scoped to classifyKind's own body, because formatExpiry also calls
    // isObligationType — a file-wide toContain would stay green while
    // classifyKind hand-rolled the set.
    const fn = src.slice(src.indexOf('export function classifyKind'))
    const body = fn.slice(0, fn.indexOf('\n}') + 2)
    expect(body).toContain('isObligationType')
    // No hand-rolled copy, in any spelling: an array literal in any order, or
    // an || chain of equality checks.
    expect(body).not.toMatch(/'(comp|hold|discount)'/)
  })
})

describe('isEscalated', () => {
  it('is false with no escalation stamp', () => {
    expect(isEscalated(row())).toBe(false)
  })
  it('is true once escalated_at is set', () => {
    expect(isEscalated(row({ escalatedAt: '2026-09-13T09:00:00.000Z' }))).toBe(true)
  })
})

describe('isUntimed', () => {
  // The whole point of the page. Both columns null means the row cannot match
  // the arrival cron and cannot reach the operator heads-up queue.
  it('is true only when BOTH arrival columns are null', () => {
    expect(isUntimed(row({ expectedArrival: null, arrivalSignal: null }))).toBe(true)
  })

  // Negative cases are the load-bearing half: loosening the predicate to an OR
  // would label a perfectly scheduled commitment as invisible, which is a
  // false alarm on the one signal this page adds.
  it('is false when either arrival column is populated', () => {
    expect(
      isUntimed(row({ expectedArrival: '2026-09-15T09:00:00.000Z', arrivalSignal: null })),
    ).toBe(false)
    expect(isUntimed(row({ expectedArrival: null, arrivalSignal: 'imminent' }))).toBe(false)
    expect(
      isUntimed(row({ expectedArrival: '2026-09-15T09:00:00.000Z', arrivalSignal: 'scheduled' })),
    ).toBe(false)
  })
})

describe('sortForDisplay', () => {
  // Named for displayRank, which is what it exercises — sortForDisplay has its
  // own cases below. Previously filed under a sortForDisplay name it never
  // called.
  it('displayRank orders escalated obligations, then obligations, then recommendations', () => {
    expect(displayRank(row({ escalatedAt: '2026-09-13T09:00:00.000Z' }))).toBeLessThan(
      displayRank(row()),
    )
    expect(displayRank(row())).toBeLessThan(displayRank(row({ type: 'recommendation' })))
  })

  it('puts an escalated comp first even when it is the newest row', () => {
    const oldRecommendation = row({
      id: 'rec',
      type: 'recommendation',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const plainComp = row({ id: 'comp', createdAt: '2026-02-01T00:00:00.000Z' })
    const escalated = row({
      id: 'esc',
      createdAt: '2026-09-13T00:00:00.000Z',
      escalatedAt: '2026-09-13T18:00:00.000Z',
    })

    expect(sortForDisplay([oldRecommendation, plainComp, escalated]).map((r) => r.id)).toEqual([
      'esc',
      'comp',
      'rec',
    ])
  })

  it('sorts oldest-first within a band', () => {
    const older = row({ id: 'older', createdAt: '2026-09-01T00:00:00.000Z' })
    const newer = row({ id: 'newer', createdAt: '2026-09-10T00:00:00.000Z' })
    expect(sortForDisplay([newer, older]).map((r) => r.id)).toEqual(['older', 'newer'])
  })

  // The input is a loader result other callers read; sorting it in place would
  // reorder it under them.
  it('does not mutate its input', () => {
    const input = [row({ id: 'b', type: 'recommendation' }), row({ id: 'a' })]
    const before = input.map((r) => r.id)
    sortForDisplay(input)
    expect(input.map((r) => r.id)).toEqual(before)
  })
})

describe('formatAge', () => {
  it('renders whole days, with singular and plural', () => {
    expect(formatAge('2026-09-14T01:00:00.000Z', NOW)).toBe('today')
    expect(formatAge('2026-09-13T11:00:00.000Z', NOW)).toBe('1 day ago')
    expect(formatAge('2026-09-08T12:00:00.000Z', NOW)).toBe('6 days ago')
  })

  it('renders unparseable input as itself rather than as Invalid Date', () => {
    expect(formatAge('not a date', NOW)).toBe('not a date')
  })

  // Reachable on the real page: escalated_at is written by a cron whose clock
  // is not this render's clock, so a stamp a few seconds ahead is possible.
  // "in the future" is the honest answer; "0 days ago" would not be.
  it('says so rather than counting backwards when the timestamp is ahead of now', () => {
    expect(formatAge('2026-09-20T12:00:00.000Z', NOW)).toBe('in the future')
  })

  // Pins the deliberate non-reuse. formatTimeDelta is the agent's PROMPT
  // vocabulary; importing it would make a prompt-wording change silently
  // restyle this page and a display tweak here an agent-runtime change, which
  // TAC-381 forbids. Fails if someone "de-duplicates" the two.
  it('does not import the agent prompt serializer', () => {
    const src = readFileSync(join(__dirname, 'commitment-display.ts'), 'utf-8')
    expect(src).not.toContain('@/lib/ai/prompts/serializers')
    // Bans the CALL, not the word: the source names formatTimeDelta in prose
    // to explain why it is deliberately not reused, and a bare substring check
    // would fail on the very comment that records the decision.
    expect(src).not.toMatch(/\bformatTimeDelta\s*\(/)
  })
})

describe('formatExpiry', () => {
  it('counts down to a real horizon', () => {
    expect(formatExpiry(row({ expiresAt: '2026-09-14T18:00:00.000Z' }), NOW)).toBe(
      'expires today',
    )
    expect(formatExpiry(row({ expiresAt: '2026-09-15T12:00:00.000Z' }), NOW)).toBe(
      'expires in 1 day',
    )
    expect(formatExpiry(row({ expiresAt: '2026-11-07T12:00:00.000Z' }), NOW)).toBe(
      'expires in 54 days',
    )
  })

  it('says past due rather than a negative count', () => {
    expect(formatExpiry(row({ expiresAt: '2026-09-01T12:00:00.000Z' }), NOW)).toBe('past due')
  })

  it('renders an unparseable horizon as itself rather than as Invalid Date', () => {
    expect(formatExpiry(row({ expiresAt: 'not a date' }), NOW)).toBe('not a date')
  })

  // A null horizon means two different things and the page says which, rather
  // than rendering a blank that reads as missing data. A recommendation never
  // has one by design (TAC-341 scoped expiry to obligations, TAC-380 owns
  // recommendations); an obligation without one is a pre-TAC-341 row awaiting
  // the hand-applied backfill.
  it('distinguishes a recommendation with no horizon from an obligation missing one', () => {
    expect(formatExpiry(row({ type: 'recommendation', expiresAt: null }), NOW)).toBe('no horizon')
    expect(formatExpiry(row({ type: 'comp', expiresAt: null }), NOW)).toBe('no horizon set')
  })
})
