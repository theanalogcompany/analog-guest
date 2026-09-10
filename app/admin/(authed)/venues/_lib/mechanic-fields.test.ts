import { describe, expect, it } from 'vitest'
import { findMissingMechanicFields, parseMechanicTriggerType } from './mechanic-fields'

describe('parseMechanicTriggerType', () => {
  it('reads .type off a well-formed trigger object', () => {
    expect(parseMechanicTriggerType({ type: 'manual_invite' })).toBe('manual_invite')
  })

  it('returns null for null trigger', () => {
    expect(parseMechanicTriggerType(null)).toBeNull()
  })

  it('returns null for a non-object trigger', () => {
    expect(parseMechanicTriggerType('manual_invite')).toBeNull()
  })

  it('returns null when .type is missing', () => {
    expect(parseMechanicTriggerType({})).toBeNull()
  })

  it('returns null when .type is not a string', () => {
    expect(parseMechanicTriggerType({ type: 42 })).toBeNull()
  })

  it('returns null when .type is an empty string', () => {
    expect(parseMechanicTriggerType({ type: '' })).toBeNull()
  })
})

describe('findMissingMechanicFields', () => {
  const full = () => ({
    description: 'A free drink',
    qualification: 'Any raving_fan guest',
    rewardDescription: 'One free drink of choice',
    redemptionPolicy: 'one_time',
    redemptionWindowDays: null,
  })

  it('returns no gaps for a fully-parameterized one_time mechanic', () => {
    expect(findMissingMechanicFields(full())).toEqual([])
  })

  it('flags null description, qualification, reward_description', () => {
    const missing = findMissingMechanicFields({
      ...full(),
      description: null,
      qualification: null,
      rewardDescription: null,
    })
    expect(missing).toEqual(
      expect.arrayContaining(['description', 'qualification', 'reward_description']),
    )
    expect(missing).toHaveLength(3)
  })

  it('flags an empty-string field the same as null', () => {
    expect(findMissingMechanicFields({ ...full(), description: '   ' })).toContain('description')
  })

  it('flags a renewable mechanic with a null redemption_window_days', () => {
    const missing = findMissingMechanicFields({
      ...full(),
      redemptionPolicy: 'renewable',
      redemptionWindowDays: null,
    })
    expect(missing).toContain('redemption_window_days')
  })

  it('does not flag redemption_window_days for a one_time mechanic even when null', () => {
    const missing = findMissingMechanicFields({
      ...full(),
      redemptionPolicy: 'one_time',
      redemptionWindowDays: null,
    })
    expect(missing).not.toContain('redemption_window_days')
  })

  it('does not flag a renewable mechanic that has a redemption_window_days', () => {
    const missing = findMissingMechanicFields({
      ...full(),
      redemptionPolicy: 'renewable',
      redemptionWindowDays: 30,
    })
    expect(missing).not.toContain('redemption_window_days')
  })
})
