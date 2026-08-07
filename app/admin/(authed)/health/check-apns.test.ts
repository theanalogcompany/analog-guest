import { describe, expect, it } from 'vitest'

import { checkApns } from './check-apns'

const VALID_PEM = [
  '-----BEGIN PRIVATE KEY-----',
  'MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgFILLERFILLERFILL',
  '-----END PRIVATE KEY-----',
].join('\n')

const VALID_ENV = {
  APNS_AUTH_KEY: VALID_PEM,
  APNS_KEY_ID: 'S4PR9KNPKA',
  APNS_TEAM_ID: 'W4J9A9K9YX',
  APNS_BUNDLE_ID: 'company.theanalog.operator',
  APNS_ENV: 'production',
}

describe('checkApns', () => {
  it('is neutral when nothing is configured (local dev / no-op)', () => {
    const row = checkApns({})
    expect(row.tone).toBe('neutral')
    expect(row.detail).toContain('Not configured')
  })

  it('is good and names the production host when fully configured', () => {
    const row = checkApns(VALID_ENV)
    expect(row.tone).toBe('good')
    expect(row.detail).toContain('api.push.apple.com')
    expect(row.detail).toContain('TestFlight / App Store')
    expect(row.detail).toContain('S4PR9KNPKA')
    expect(row.detail).toContain('company.theanalog.operator')
    // Honest about what it cannot prove.
    expect(row.detail).toContain('delivery unconfirmed')
  })

  it('names the sandbox host and the build kind it expects', () => {
    const row = checkApns({ ...VALID_ENV, APNS_ENV: 'sandbox' })
    expect(row.tone).toBe('good')
    expect(row.detail).toContain('api.sandbox.push.apple.com')
    expect(row.detail).toContain('Xcode dev')
  })

  it('is bad and specific when a var is partially configured', () => {
    const row = checkApns({ ...VALID_ENV, APNS_KEY_ID: undefined })
    expect(row.tone).toBe('bad')
    expect(row.detail).toContain('Misconfigured')
    expect(row.detail).toContain('APNS_KEY_ID: not set')
  })

  it('surfaces EVERY problem at once, not just the first', () => {
    const row = checkApns({
      ...VALID_ENV,
      APNS_AUTH_KEY: VALID_PEM.replace('-----END PRIVATE KEY-----', ''),
      APNS_ENV: 'prod',
    })
    expect(row.tone).toBe('bad')
    expect(row.detail).toContain('APNS_AUTH_KEY')
    expect(row.detail).toContain('APNS_ENV')
  })

  it('never renders key material', () => {
    const secretish = 'SUPERSECRETKEYBODY1234567890'
    const row = checkApns({ ...VALID_ENV, APNS_AUTH_KEY: secretish })
    expect(row.detail).not.toContain(secretish)
  })
})
