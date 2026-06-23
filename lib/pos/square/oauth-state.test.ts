import { describe, expect, it } from 'vitest'

import { signOAuthState, verifyOAuthState } from './oauth-state'

const SECRET = 's3cr3t-key'

describe('OAuth state signing', () => {
  it('round-trips the venue id', () => {
    expect(verifyOAuthState(signOAuthState('venue-1', SECRET), SECRET)).toBe('venue-1')
  })

  it('rejects a tampered venue payload', () => {
    const [, sig] = signOAuthState('venue-1', SECRET).split('.')
    const forged = `${Buffer.from('venue-2', 'utf8').toString('base64url')}.${sig}`
    expect(verifyOAuthState(forged, SECRET)).toBeNull()
  })

  it('rejects a different signing secret', () => {
    expect(verifyOAuthState(signOAuthState('v', SECRET), 'other-secret')).toBeNull()
  })

  it('rejects malformed state', () => {
    expect(verifyOAuthState('no-dot', SECRET)).toBeNull()
    expect(verifyOAuthState('a.b.c', SECRET)).toBeNull()
  })
})
