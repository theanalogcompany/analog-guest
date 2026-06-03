import { describe, expect, it } from 'vitest'
import type { EligibleMechanic } from '@/lib/recognition'
import { FOLLOWUP_RULES_DEFAULT, type FollowupRules } from '@/lib/schemas'
import {
  dedupKeyForReason,
  detectColdLapsedReason,
  detectPerkUnlockReason,
  detectPostVisitReason,
  type MessagingCadence,
} from './detectors'

const NOW = new Date('2026-06-04T17:00:00Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000)
const SEED_CADENCE: MessagingCadence = { day_1: true, day_3: false, day_7: true, day_14: true }

describe('detectPostVisitReason', () => {
  it('returns null when lastVisitAt is null', () => {
    expect(detectPostVisitReason(null, SEED_CADENCE, NOW)).toBeNull()
  })

  it('returns null when elapsed < 1 day', () => {
    expect(detectPostVisitReason(daysAgo(0.5), SEED_CADENCE, NOW)).toBeNull()
  })

  it('returns day_1 at exactly 1 day elapsed', () => {
    expect(detectPostVisitReason(daysAgo(1), SEED_CADENCE, NOW)).toBe('post_visit_day_1')
  })

  it('returns the highest enabled tier crossed (day_7 over day_1 at 8d)', () => {
    expect(detectPostVisitReason(daysAgo(8), SEED_CADENCE, NOW)).toBe('post_visit_day_7')
  })

  it('skips disabled tiers (day_3 disabled in seed → day_1 returns at 3d)', () => {
    expect(detectPostVisitReason(daysAgo(3), SEED_CADENCE, NOW)).toBe('post_visit_day_1')
  })

  it('returns day_14 at 14d', () => {
    expect(detectPostVisitReason(daysAgo(14), SEED_CADENCE, NOW)).toBe('post_visit_day_14')
  })

  it('returns day_14 at 100d (highest tier sticks for old visits)', () => {
    expect(detectPostVisitReason(daysAgo(100), SEED_CADENCE, NOW)).toBe('post_visit_day_14')
  })

  it('returns null when ALL tiers disabled', () => {
    expect(
      detectPostVisitReason(daysAgo(30), { day_1: false, day_3: false, day_7: false, day_14: false }, NOW),
    ).toBeNull()
  })

  it('treats missing keys as disabled', () => {
    expect(detectPostVisitReason(daysAgo(30), {}, NOW)).toBeNull()
  })
})

describe('detectColdLapsedReason', () => {
  const rules = FOLLOWUP_RULES_DEFAULT

  it('returns null when lastVisitAt is null', () => {
    expect(detectColdLapsedReason(null, 'regular', rules, NOW)).toBeNull()
  })

  it('returns null when elapsed < absence_window_days', () => {
    expect(detectColdLapsedReason(daysAgo(20), 'regular', rules, NOW)).toBeNull()
  })

  it('returns cold_lapsed at exactly absence_window_days (21 by default)', () => {
    expect(detectColdLapsedReason(daysAgo(rules.absence_window_days), 'regular', rules, NOW)).toBe(
      'cold_lapsed',
    )
  })

  it('returns null when guest is in a state NOT in lapsed_eligible_states', () => {
    // 'new' is excluded by default — we don't try to re-engage someone who
    // never engaged in the first place.
    expect(detectColdLapsedReason(daysAgo(40), 'new', rules, NOW)).toBeNull()
    expect(detectColdLapsedReason(daysAgo(40), 'returning', rules, NOW)).toBeNull()
  })

  it('returns cold_lapsed for raving_fan when elapsed crosses the window', () => {
    expect(detectColdLapsedReason(daysAgo(40), 'raving_fan', rules, NOW)).toBe('cold_lapsed')
  })

  it('honors custom lapsed_eligible_states', () => {
    const customRules: FollowupRules = { ...rules, lapsed_eligible_states: ['returning'] }
    expect(detectColdLapsedReason(daysAgo(30), 'returning', customRules, NOW)).toBe('cold_lapsed')
    expect(detectColdLapsedReason(daysAgo(30), 'regular', customRules, NOW)).toBeNull()
  })
})

describe('detectPerkUnlockReason', () => {
  const mechanic = (overrides: Partial<EligibleMechanic> = {}): EligibleMechanic => ({
    id: 'mech-1',
    type: 'perk',
    name: 'The Joey',
    description: 'small black coffee',
    qualification: 'regulars who keep coming back',
    rewardDescription: 'free Joey on us',
    minState: 'regular',
    requiresOperatorApproval: false,
    ...overrides,
  })

  it('returns null when no eligible mechanics', () => {
    expect(
      detectPerkUnlockReason({
        currentState: 'regular',
        eligibleMechanics: [],
        announcedMechanicIds: new Set(),
        rules: FOLLOWUP_RULES_DEFAULT,
      }),
    ).toBeNull()
  })

  it('returns the first eligible mechanic not yet announced', () => {
    const m = mechanic()
    expect(
      detectPerkUnlockReason({
        currentState: 'regular',
        eligibleMechanics: [m],
        announcedMechanicIds: new Set(),
        rules: FOLLOWUP_RULES_DEFAULT,
      }),
    ).toEqual({ reason: 'perk_unlock', mechanic: m })
  })

  it('skips a mechanic already announced (in announcedMechanicIds)', () => {
    const m = mechanic()
    expect(
      detectPerkUnlockReason({
        currentState: 'regular',
        eligibleMechanics: [m],
        announcedMechanicIds: new Set([m.id]),
        rules: FOLLOWUP_RULES_DEFAULT,
      }),
    ).toBeNull()
  })

  it('picks the next un-announced mechanic when the first is already announced', () => {
    const m1 = mechanic({ id: 'mech-1', name: 'The Joey' })
    const m2 = mechanic({ id: 'mech-2', name: 'Pastry on us' })
    expect(
      detectPerkUnlockReason({
        currentState: 'regular',
        eligibleMechanics: [m1, m2],
        announcedMechanicIds: new Set(['mech-1']),
        rules: FOLLOWUP_RULES_DEFAULT,
      }),
    ).toEqual({ reason: 'perk_unlock', mechanic: m2 })
  })

  it('returns null when perk_unlock_enabled is false', () => {
    expect(
      detectPerkUnlockReason({
        currentState: 'regular',
        eligibleMechanics: [mechanic()],
        announcedMechanicIds: new Set(),
        rules: { ...FOLLOWUP_RULES_DEFAULT, perk_unlock_enabled: false },
      }),
    ).toBeNull()
  })

  it('defensively re-checks minState (paranoid no-op for normal flow)', () => {
    // filterEligibleMechanics upstream should already have filtered, but
    // if it didn't, the detector won't return a mechanic the guest can't
    // actually unlock.
    expect(
      detectPerkUnlockReason({
        currentState: 'new',
        eligibleMechanics: [mechanic({ minState: 'raving_fan' })],
        announcedMechanicIds: new Set(),
        rules: FOLLOWUP_RULES_DEFAULT,
      }),
    ).toBeNull()
  })
})

describe('dedupKeyForReason', () => {
  const lvAt = new Date('2026-05-25T18:00:00Z')

  it('builds day_N keys with last_visit_at iso', () => {
    expect(dedupKeyForReason('post_visit_day_1', { lastVisitAt: lvAt })).toBe(
      `day_1:${lvAt.toISOString()}`,
    )
    expect(dedupKeyForReason('post_visit_day_3', { lastVisitAt: lvAt })).toBe(
      `day_3:${lvAt.toISOString()}`,
    )
    expect(dedupKeyForReason('post_visit_day_7', { lastVisitAt: lvAt })).toBe(
      `day_7:${lvAt.toISOString()}`,
    )
    expect(dedupKeyForReason('post_visit_day_14', { lastVisitAt: lvAt })).toBe(
      `day_14:${lvAt.toISOString()}`,
    )
  })

  it('builds cold key with last_visit_at iso', () => {
    expect(dedupKeyForReason('cold_lapsed', { lastVisitAt: lvAt })).toBe(
      `cold:${lvAt.toISOString()}`,
    )
  })

  it('builds perk key with mechanic_id', () => {
    expect(dedupKeyForReason('perk_unlock', { mechanicId: 'mech-1' })).toBe('perk:mech-1')
  })

  it('throws on missing lastVisitAt for post_visit', () => {
    expect(() => dedupKeyForReason('post_visit_day_7', {})).toThrow(/lastVisitAt/)
  })

  it('throws on missing lastVisitAt for cold_lapsed', () => {
    expect(() => dedupKeyForReason('cold_lapsed', {})).toThrow(/lastVisitAt/)
  })

  it('throws on missing mechanicId for perk_unlock', () => {
    expect(() => dedupKeyForReason('perk_unlock', {})).toThrow(/mechanicId/)
  })

  it('re-arms on a new visit (different lastVisitAt → different key)', () => {
    const newLvAt = new Date('2026-06-01T00:00:00Z')
    expect(dedupKeyForReason('cold_lapsed', { lastVisitAt: lvAt })).not.toBe(
      dedupKeyForReason('cold_lapsed', { lastVisitAt: newLvAt }),
    )
  })
})
