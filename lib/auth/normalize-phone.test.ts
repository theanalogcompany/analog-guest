import { describe, expect, it } from 'vitest'

import { authUserPhoneToE164 } from './normalize-phone'

describe('authUserPhoneToE164', () => {
  it('prepends + to a digits-only Supabase phone', () => {
    expect(authUserPhoneToE164('18777804236')).toBe('+18777804236')
  })

  it('returns null for null input', () => {
    expect(authUserPhoneToE164(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(authUserPhoneToE164(undefined)).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(authUserPhoneToE164('')).toBeNull()
  })

  it('returns null for whitespace-only input', () => {
    expect(authUserPhoneToE164('   ')).toBeNull()
  })

  it('is idempotent — returns a +-prefixed value unchanged', () => {
    expect(authUserPhoneToE164('+18777804236')).toBe('+18777804236')
  })

  it('trims surrounding whitespace before applying the +', () => {
    expect(authUserPhoneToE164('  18777804236  ')).toBe('+18777804236')
  })
})
