import { describe, expect, it, vi } from 'vitest'

// Hoisted Supabase mock — loadFormula reads venue_configs.relationship_strength_formula.
// Returning '{}' triggers the "use defaults" branch in compute-strength.ts.
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { relationship_strength_formula: {} },
            error: null,
          }),
        }),
      }),
    }),
  }),
}))

// Stub loadSignals so we can drive computeRelationshipStrength without a real DB.
vi.mock('./load-signals', () => ({
  loadSignals: vi.fn(),
}))

import { computeRelationshipStrength } from './compute-strength'
import { loadSignals } from './load-signals'
import { DEFAULT_FORMULA, type RawSignals } from './types'

const loadSignalsMock = vi.mocked(loadSignals)

function rawAt(state: 'low' | 'mid' | 'high'): RawSignals {
  // Three handpicked profiles spanning the score range. Numbers chosen so each
  // signal contributes a non-zero, distinguishable amount.
  const presets: Record<typeof state, RawSignals> = {
    low: {
      visitsLast90Days: 1,
      daysSinceLastVisit: 45,
      totalSpentLast90Days: 30,
      outboundMessageCount: 4,
      repliedMessageCount: 1,
      engagementEventsByType: { first_visit: 1 },
      uniqueMenuItemsOrdered: 1,
      totalMenuItems: 20,
      referralsMade: 0,
      referralsConverted: 0,
      distanceMiles: 3,
      visitDateList: [new Date('2026-04-15')],
    },
    mid: {
      visitsLast90Days: 6,
      daysSinceLastVisit: 5,
      totalSpentLast90Days: 150,
      outboundMessageCount: 10,
      repliedMessageCount: 6,
      engagementEventsByType: { first_visit: 1, perk_unlocked: 2, mechanic_redeemed: 1 },
      uniqueMenuItemsOrdered: 6,
      totalMenuItems: 20,
      referralsMade: 1,
      referralsConverted: 0,
      distanceMiles: 8,
      visitDateList: [
        new Date('2026-02-10'),
        new Date('2026-02-25'),
        new Date('2026-03-15'),
        new Date('2026-03-30'),
        new Date('2026-04-15'),
        new Date('2026-04-25'),
      ],
    },
    high: {
      visitsLast90Days: 14,
      daysSinceLastVisit: 1,
      totalSpentLast90Days: 320,
      outboundMessageCount: 20,
      repliedMessageCount: 18,
      engagementEventsByType: {
        first_visit: 1,
        perk_unlocked: 4,
        perk_redeemed: 4,
        mechanic_redeemed: 4,
        event_attended: 2,
        merch_redeemed: 2,
        milestone_reached: 2,
      },
      uniqueMenuItemsOrdered: 18,
      totalMenuItems: 20,
      referralsMade: 3,
      referralsConverted: 1,
      distanceMiles: 12,
      visitDateList: Array.from(
        { length: 14 },
        (_, i) => new Date(2026, 1, 1 + i * 7),
      ),
    },
  }
  return presets[state]
}

describe('computeRelationshipStrength — weights + contributions surfacing', () => {
  it('returns weights matching the venue formula (defaults here)', async () => {
    loadSignalsMock.mockResolvedValueOnce({ ok: true, data: rawAt('mid') })
    const result = await computeRelationshipStrength({ guestId: 'g', venueId: 'v' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.weights).toEqual(DEFAULT_FORMULA.weights)
  })

  it('contributions[k] equals signals[k] * weights[k] for every signal', async () => {
    loadSignalsMock.mockResolvedValueOnce({ ok: true, data: rawAt('mid') })
    const result = await computeRelationshipStrength({ guestId: 'g', venueId: 'v' })
    if (!result.ok) throw new Error('expected ok')
    const { signals, weights, contributions } = result.data
    for (const key of [
      'recency',
      'visitFrequency',
      'engagementEvents',
      'moneySpent',
      'responseRate',
      'percentMenuExplored',
      'referrals',
    ] as const) {
      expect(contributions[key]).toBeCloseTo(signals[key] * weights[key], 10)
    }
  })

  it('sum of contributions rounds to the returned score', async () => {
    for (const profile of ['low', 'mid', 'high'] as const) {
      loadSignalsMock.mockResolvedValueOnce({ ok: true, data: rawAt(profile) })
      const result = await computeRelationshipStrength({ guestId: 'g', venueId: 'v' })
      if (!result.ok) throw new Error('expected ok')
      const sum = Object.values(result.data.contributions).reduce((a, b) => a + b, 0)
      expect(result.data.score).toBe(Math.round(sum))
    }
  })
})
