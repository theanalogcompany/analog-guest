import { generateKeyPairSync } from 'node:crypto'
import { decodeProtectedHeader, decodeJwt } from 'jose'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { _resetApnsJwtCacheForTests, getApnsJwt } from './jwt'

let testKeyPem: string
const TEST_KEY_ID = 'TESTKEYID0'
const TEST_TEAM_ID = 'TESTTEAM00'
const SAVED_ENV: Record<string, string | undefined> = {}

beforeAll(() => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  testKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
})

beforeEach(() => {
  SAVED_ENV.APNS_AUTH_KEY = process.env.APNS_AUTH_KEY
  SAVED_ENV.APNS_KEY_ID = process.env.APNS_KEY_ID
  SAVED_ENV.APNS_TEAM_ID = process.env.APNS_TEAM_ID
  process.env.APNS_AUTH_KEY = testKeyPem
  process.env.APNS_KEY_ID = TEST_KEY_ID
  process.env.APNS_TEAM_ID = TEST_TEAM_ID
  _resetApnsJwtCacheForTests()
})

afterEach(() => {
  process.env.APNS_AUTH_KEY = SAVED_ENV.APNS_AUTH_KEY
  process.env.APNS_KEY_ID = SAVED_ENV.APNS_KEY_ID
  process.env.APNS_TEAM_ID = SAVED_ENV.APNS_TEAM_ID
  _resetApnsJwtCacheForTests()
})

describe('getApnsJwt', () => {
  it('signs a JWT with ES256 / kid header and team-id issuer', async () => {
    const r = await getApnsJwt(1_700_000_000_000)
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const header = decodeProtectedHeader(r.token)
    expect(header.alg).toBe('ES256')
    expect(header.kid).toBe(TEST_KEY_ID)

    const payload = decodeJwt(r.token)
    expect(payload.iss).toBe(TEST_TEAM_ID)
    expect(payload.iat).toBe(1_700_000_000)
  })

  it('reuses the cached token when called again within the 50-minute window', async () => {
    const t0 = 1_700_000_000_000
    const r1 = await getApnsJwt(t0)
    const r2 = await getApnsJwt(t0 + 10 * 60 * 1000) // +10min
    expect(r1.ok && r2.ok).toBe(true)
    if (!r1.ok || !r2.ok) return
    expect(r2.token).toBe(r1.token)
  })

  it('re-signs after the 50-minute refresh window elapses', async () => {
    const t0 = 1_700_000_000_000
    const r1 = await getApnsJwt(t0)
    const r2 = await getApnsJwt(t0 + 51 * 60 * 1000) // +51min
    expect(r1.ok && r2.ok).toBe(true)
    if (!r1.ok || !r2.ok) return
    expect(r2.token).not.toBe(r1.token)

    const payload2 = decodeJwt(r2.token)
    expect(payload2.iat).toBe(Math.floor((t0 + 51 * 60 * 1000) / 1000))
  })

  it('re-signs when APNS_KEY_ID rotates even within the refresh window', async () => {
    const t0 = 1_700_000_000_000
    const r1 = await getApnsJwt(t0)
    expect(r1.ok).toBe(true)
    if (!r1.ok) return

    process.env.APNS_KEY_ID = 'ROTATED123'
    const r2 = await getApnsJwt(t0 + 5 * 60 * 1000) // +5min, still inside window
    expect(r2.ok).toBe(true)
    if (!r2.ok) return

    expect(r2.token).not.toBe(r1.token)
    const header = decodeProtectedHeader(r2.token)
    expect(header.kid).toBe('ROTATED123')
  })

  it('returns env_missing when any of the three vars is absent', async () => {
    delete process.env.APNS_KEY_ID
    const r = await getApnsJwt()
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('env_missing')
  })

  it('returns key_parse_failed when APNS_AUTH_KEY is not a valid PKCS#8 PEM', async () => {
    process.env.APNS_AUTH_KEY = 'not-a-key'
    const r = await getApnsJwt()
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('key_parse_failed')
  })
})
