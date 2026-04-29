import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type EligibilityCandidate,
  filterEligibleMechanics,
  isRedemptionActive,
  type RedemptionRecord,
} from './eligibility'

const NOW = new Date('2026-04-29T12:00:00Z')
const DAY_MS = 24 * 60 * 60 * 1000

const candidate = (overrides: Partial<EligibilityCandidate> = {}): EligibilityCandidate => ({
  id: 'mech-1',
  type: 'perk',
  name: 'The Joey',
  description: null,
  qualification: null,
  rewardDescription: null,
  minState: null,
  redemptionPolicy: 'one_time',
  redemptionWindowDays: null,
  ...overrides,
})

const redemption = (
  overrides: Partial<RedemptionRecord> = {},
): RedemptionRecord => ({
  mechanicId: 'mech-1',
  createdAt: new Date('2026-04-01T12:00:00Z'),
  ...overrides,
})

describe('isRedemptionActive', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns false when no redemptions exist for the mechanic', () => {
    expect(isRedemptionActive([], candidate(), NOW)).toBe(false)
  })

  it('returns false when redemptions exist for a different mechanic', () => {
    const other = redemption({ mechanicId: 'mech-2' })
    expect(isRedemptionActive([other], candidate({ id: 'mech-1' }), NOW)).toBe(false)
  })

  it('one_time: any redemption blocks forever', () => {
    expect(isRedemptionActive([redemption()], candidate({ redemptionPolicy: 'one_time' }), NOW)).toBe(true)
  })

  it('one_time: multiple redemptions also block', () => {
    const r1 = redemption({ createdAt: new Date('2025-01-01T00:00:00Z') })
    const r2 = redemption({ createdAt: new Date('2026-04-01T00:00:00Z') })
    expect(isRedemptionActive([r1, r2], candidate({ redemptionPolicy: 'one_time' }), NOW)).toBe(true)
  })

  it('renewable: returns true when last redemption is inside the window', () => {
    const inside = redemption({ createdAt: new Date(NOW.getTime() - 5 * DAY_MS) })
    const mech = candidate({ redemptionPolicy: 'renewable', redemptionWindowDays: 30 })
    expect(isRedemptionActive([inside], mech, NOW)).toBe(true)
  })

  it('renewable: returns false when last redemption is outside the window', () => {
    const outside = redemption({ createdAt: new Date(NOW.getTime() - 31 * DAY_MS) })
    const mech = candidate({ redemptionPolicy: 'renewable', redemptionWindowDays: 30 })
    expect(isRedemptionActive([outside], mech, NOW)).toBe(false)
  })

  it('renewable: uses the most-recent redemption when multiple exist', () => {
    const old = redemption({ createdAt: new Date(NOW.getTime() - 60 * DAY_MS) })
    const recent = redemption({ createdAt: new Date(NOW.getTime() - 5 * DAY_MS) })
    const mech = candidate({ redemptionPolicy: 'renewable', redemptionWindowDays: 30 })
    expect(isRedemptionActive([old, recent], mech, NOW)).toBe(true)
  })

  it('renewable with null window logs and treats as blocked (defensive)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mech = candidate({ redemptionPolicy: 'renewable', redemptionWindowDays: null })
    expect(isRedemptionActive([redemption()], mech, NOW)).toBe(true)
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0][0]).toContain('mech-1')
  })
})

describe('filterEligibleMechanics', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns empty array for empty mechanics input', () => {
    expect(filterEligibleMechanics([], [], 'regular', NOW)).toEqual([])
  })

  it('drops mechanics whose min_state exceeds current state', () => {
    const mech = candidate({ id: 'gated', minState: 'regular' })
    const out = filterEligibleMechanics([mech], [], 'new', NOW)
    expect(out).toEqual([])
  })

  it('drops mechanics with an active one_time redemption even if state qualifies', () => {
    const mech = candidate({ id: 'used', minState: null, redemptionPolicy: 'one_time' })
    const r = redemption({ mechanicId: 'used' })
    const out = filterEligibleMechanics([mech], [r], 'regular', NOW)
    expect(out).toEqual([])
  })

  it('keeps mechanics that pass both state and redemption checks', () => {
    const mech = candidate({ id: 'ok', minState: 'returning' })
    const out = filterEligibleMechanics([mech], [], 'regular', NOW)
    expect(out.map((m) => m.id)).toEqual(['ok'])
  })

  it('keeps ungated mechanics with no redemption history', () => {
    const mech = candidate({ id: 'free', minState: null })
    const out = filterEligibleMechanics([mech], [], 'new', NOW)
    expect(out.map((m) => m.id)).toEqual(['free'])
  })

  it('preserves original order when filtering a mixed list', () => {
    const stateBlocked = candidate({ id: 'state-blocked', minState: 'regular' })
    const redemptionBlocked = candidate({
      id: 'redemption-blocked',
      minState: null,
      redemptionPolicy: 'one_time',
    })
    const eligibleGated = candidate({ id: 'eligible-gated', minState: 'returning' })
    const eligibleUngated = candidate({ id: 'eligible-ungated', minState: null })
    const r = redemption({ mechanicId: 'redemption-blocked' })

    const out = filterEligibleMechanics(
      [stateBlocked, redemptionBlocked, eligibleGated, eligibleUngated],
      [r],
      'returning',
      NOW,
    )
    expect(out.map((m) => m.id)).toEqual(['eligible-gated', 'eligible-ungated'])
  })

  it('exposes minState in the EligibleMechanic shape', () => {
    const mech = candidate({ id: 'm1', minState: 'regular' })
    const [out] = filterEligibleMechanics([mech], [], 'regular', NOW)
    expect(out.minState).toBe('regular')
  })
})