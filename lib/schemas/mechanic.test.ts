// Destructuring-to-omit a field for a "missing required field" fixture
// leaves an intentionally-unused binding.
/* eslint-disable @typescript-eslint/no-unused-vars */

import { describe, expect, it } from 'vitest'
import { MechanicCreateSchema, MechanicFullSchema, MechanicPatchSchema } from './mechanic'

function fullMechanic(overrides: Partial<Parameters<typeof MechanicFullSchema.parse>[0]> = {}) {
  return {
    type: 'perk',
    name: 'The Joey',
    description: 'A free drink for regulars',
    qualification: 'Any regular guest',
    rewardDescription: 'One free drink of choice',
    minState: 'regular',
    redemptionPolicy: 'one_time',
    redemptionWindowDays: null,
    requiresOperatorApproval: false,
    triggerType: 'guest_initiated_request',
    expirationRule: 'valid on next visit only',
    ...overrides,
  }
}

describe('MechanicFullSchema — redemption pairing', () => {
  it('accepts one_time with a null window', () => {
    expect(MechanicFullSchema.safeParse(fullMechanic()).success).toBe(true)
  })

  it('accepts renewable with a positive window', () => {
    const result = MechanicFullSchema.safeParse(
      fullMechanic({ redemptionPolicy: 'renewable', redemptionWindowDays: 30 }),
    )
    expect(result.success).toBe(true)
  })

  it('rejects renewable with a null window', () => {
    const result = MechanicFullSchema.safeParse(
      fullMechanic({ redemptionPolicy: 'renewable', redemptionWindowDays: null }),
    )
    expect(result.success).toBe(false)
  })

  it('rejects one_time with a non-null window', () => {
    const result = MechanicFullSchema.safeParse(
      fullMechanic({ redemptionPolicy: 'one_time', redemptionWindowDays: 30 }),
    )
    expect(result.success).toBe(false)
  })

  it('rejects a non-canonical guest state', () => {
    const result = MechanicFullSchema.safeParse(fullMechanic({ minState: 'vip' }))
    expect(result.success).toBe(false)
  })

  it('rejects a non-canonical trigger type', () => {
    const result = MechanicFullSchema.safeParse(fullMechanic({ triggerType: 'owner_gifted' }))
    expect(result.success).toBe(false)
  })

  it('does not accept redemption as a field at all — not exposed per §2', () => {
    const withRedemption = { ...fullMechanic(), redemption: { type: 'manual_owner_action_at_venue' } }
    const parsed = MechanicFullSchema.parse(withRedemption)
    expect(parsed).not.toHaveProperty('redemption')
  })
})

describe('MechanicPatchSchema — partial, no cross-field check', () => {
  it('accepts an empty object (no-op patch)', () => {
    expect(MechanicPatchSchema.safeParse({}).success).toBe(true)
  })

  it('accepts a single field without the redemption pairing constraint firing', () => {
    // A tags-only-style partial patch shouldn't need to know about the
    // sibling field — cross-field validation happens after merge, against
    // MechanicFullSchema, not here.
    const result = MechanicPatchSchema.safeParse({ redemptionPolicy: 'renewable' })
    expect(result.success).toBe(true)
  })

  it('rejects an empty-string description (still per-field constrained)', () => {
    const result = MechanicPatchSchema.safeParse({ description: '' })
    expect(result.success).toBe(false)
  })

  it('accepts an explicit null to clear a nullable field', () => {
    const result = MechanicPatchSchema.safeParse({ description: null })
    expect(result.success).toBe(true)
  })
})

describe('MechanicCreateSchema — every field required', () => {
  it('rejects a mechanic missing requiresOperatorApproval', () => {
    const { requiresOperatorApproval: _drop, ...incomplete } = fullMechanic()
    const result = MechanicCreateSchema.safeParse(incomplete)
    expect(result.success).toBe(false)
  })

  it('accepts a fully-parameterized mechanic', () => {
    expect(MechanicCreateSchema.safeParse(fullMechanic()).success).toBe(true)
  })
})
