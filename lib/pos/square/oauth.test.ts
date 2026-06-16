import { describe, expect, it } from 'vitest'

import { buildSquareAuthorizeUrl, SQUARE_OAUTH_SCOPES } from './oauth'

describe('buildSquareAuthorizeUrl', () => {
  it('targets the sandbox host and carries client_id, scopes, state', () => {
    const u = buildSquareAuthorizeUrl({ env: 'sandbox', applicationId: 'app_1', state: 'st_1' })
    expect(u).toContain('connect.squareupsandbox.com/oauth2/authorize')
    const url = new URL(u)
    expect(url.searchParams.get('client_id')).toBe('app_1')
    expect(url.searchParams.get('state')).toBe('st_1')
    expect(url.searchParams.get('scope')).toBe(SQUARE_OAUTH_SCOPES.join(' '))
    expect(url.searchParams.get('session')).toBe('false')
  })

  it('targets the production host for production', () => {
    expect(buildSquareAuthorizeUrl({ env: 'production', applicationId: 'a', state: 's' })).toContain(
      'connect.squareup.com/oauth2/authorize',
    )
  })

  it('includes redirect_uri only when provided', () => {
    const withRedirect = new URL(
      buildSquareAuthorizeUrl({ env: 'sandbox', applicationId: 'a', state: 's', redirectUrl: 'https://x/cb' }),
    )
    expect(withRedirect.searchParams.get('redirect_uri')).toBe('https://x/cb')
    const without = new URL(buildSquareAuthorizeUrl({ env: 'sandbox', applicationId: 'a', state: 's' }))
    expect(without.searchParams.has('redirect_uri')).toBe(false)
  })

  it('uses read-only scopes only', () => {
    expect(SQUARE_OAUTH_SCOPES.every((s) => s.endsWith('_READ'))).toBe(true)
  })
})
