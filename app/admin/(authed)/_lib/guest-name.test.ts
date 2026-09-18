import { describe, expect, it } from 'vitest'

import { formatGuestPhone, guestDisplayName, guestNameWithPhone, NO_PHONE_LABEL } from './guest-name'

const PHONE = '+15555550142'

describe('guestDisplayName', () => {
  it('prefers the name', () => {
    expect(guestDisplayName({ firstName: 'Liam', lastName: 'Chen', phoneNumber: PHONE })).toBe(
      'Liam Chen',
    )
  })

  it('falls back to the phone when both names are absent', () => {
    expect(guestDisplayName({ firstName: null, lastName: null, phoneNumber: PHONE })).toBe(PHONE)
  })

  // TAC-467: an Instagram guest has no phone.
  it('falls back to the label when there is no name and no phone', () => {
    expect(guestDisplayName({ firstName: null, lastName: null, phoneNumber: null })).toBe(
      NO_PHONE_LABEL,
    )
  })

  it('never returns an empty string', () => {
    expect(guestDisplayName({ firstName: '', lastName: '', phoneNumber: null })).toBe(
      NO_PHONE_LABEL,
    )
  })
})

describe('guestNameWithPhone', () => {
  it('joins name and phone', () => {
    expect(guestNameWithPhone({ firstName: 'Liam', lastName: null, phoneNumber: PHONE })).toBe(
      `Liam · ${PHONE}`,
    )
  })

  it('shows the phone alone when both names are absent', () => {
    expect(guestNameWithPhone({ firstName: null, lastName: null, phoneNumber: PHONE })).toBe(PHONE)
  })

  // TAC-467. A template joining name and phone renders the literal text
  // "null" after the dot when the phone is null.
  it('shows the name alone when there is no phone', () => {
    const label = guestNameWithPhone({ firstName: 'Liam', lastName: null, phoneNumber: null })
    expect(label).toBe('Liam')
    expect(label).not.toContain('null')
  })

  it('falls back to the label when there is no name and no phone', () => {
    expect(guestNameWithPhone({ firstName: null, lastName: null, phoneNumber: null })).toBe(
      NO_PHONE_LABEL,
    )
  })
})

describe('formatGuestPhone', () => {
  it('spaces a US number', () => {
    expect(formatGuestPhone('+17869530853')).toBe('+1 786 953 0853')
  })

  it('returns anything else unchanged', () => {
    expect(formatGuestPhone('+442071838750')).toBe('+442071838750')
  })

  // TAC-467. This was `phone.match(...)` inside guest-context.tsx, which threw
  // on null and took the Command Center conversation panel down with it.
  it('returns the label for a guest with no phone instead of throwing', () => {
    expect(formatGuestPhone(null)).toBe(NO_PHONE_LABEL)
  })
})
