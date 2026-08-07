import { describe, expect, it } from 'vitest'

import { checkApnsEnv, REQUIRED_APNS_VARS } from './env'

// A structurally valid PKCS#8 PEM. NOT a real key — the body is filler; these
// tests only exercise shape validation, which never parses the key.
const VALID_PEM = [
  '-----BEGIN PRIVATE KEY-----',
  'MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgFILLERFILLERFILL',
  'ERFILLERFILLERFILLERFILLERFILLERoUQDQgAEFILLERFILLERFILLERFILLER',
  '-----END PRIVATE KEY-----',
].join('\n')

const VALID_ENV = {
  APNS_AUTH_KEY: VALID_PEM,
  APNS_KEY_ID: 'S4PR9KNPKA',
  APNS_TEAM_ID: 'W4J9A9K9YX',
  APNS_BUNDLE_ID: 'company.theanalog.operator',
  APNS_ENV: 'production',
}

function problemsFor(env: Record<string, string | undefined>): string[] {
  const result = checkApnsEnv(env)
  return result.ok ? [] : result.problems
}

describe('checkApnsEnv — happy path', () => {
  it('accepts a fully valid production env', () => {
    expect(checkApnsEnv(VALID_ENV)).toEqual({ ok: true })
  })

  it('accepts sandbox', () => {
    expect(checkApnsEnv({ ...VALID_ENV, APNS_ENV: 'sandbox' })).toEqual({ ok: true })
  })

  it('tolerates surrounding whitespace', () => {
    expect(
      checkApnsEnv({ ...VALID_ENV, APNS_KEY_ID: '  S4PR9KNPKA  ', APNS_ENV: ' production ' }),
    ).toEqual({ ok: true })
  })
})

describe('checkApnsEnv — missing vars', () => {
  it('reports every unset var, not just the first', () => {
    const problems = problemsFor({})
    expect(problems.length).toBeGreaterThanOrEqual(REQUIRED_APNS_VARS.length)
    for (const name of REQUIRED_APNS_VARS) {
      expect(problems.some((p) => p.startsWith(`${name}: not set`))).toBe(true)
    }
  })

  // The exact local-.env.local defect found during diagnosis.
  it('reports APNS_KEY_ID missing while the rest are present', () => {
    const problems = problemsFor({ ...VALID_ENV, APNS_KEY_ID: undefined })
    expect(problems).toEqual(['APNS_KEY_ID: not set'])
  })

  it('treats an empty string as not set', () => {
    expect(problemsFor({ ...VALID_ENV, APNS_TEAM_ID: '   ' })).toEqual([
      'APNS_TEAM_ID: not set',
    ])
  })
})

describe('checkApnsEnv — APNS_AUTH_KEY shape', () => {
  // The documented 2026-05-27 production incident.
  it('catches a truncated footer', () => {
    const truncated = VALID_PEM.replace('-----END PRIVATE KEY-----', '')
    const problems = problemsFor({ ...VALID_ENV, APNS_AUTH_KEY: truncated })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('missing the "-----END PRIVATE KEY-----" footer')
    expect(problems[0]).toContain('truncated on paste')
  })

  // The exact local .env.local defect found during diagnosis: bare base64.
  it('catches a bare base64 body with no PEM armor', () => {
    const bare = 'MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg'
    const problems = problemsFor({ ...VALID_ENV, APNS_AUTH_KEY: bare })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('missing both PEM armor lines')
  })

  it('catches a missing header when the footer survived', () => {
    const noHeader = VALID_PEM.replace('-----BEGIN PRIVATE KEY-----\n', '')
    expect(problemsFor({ ...VALID_ENV, APNS_AUTH_KEY: noHeader })[0]).toContain(
      'missing the "-----BEGIN PRIVATE KEY-----" header',
    )
  })

  it('catches literal backslash-n escapes', () => {
    const escaped = VALID_PEM.replace(/\n/g, '\\n')
    const problems = problemsFor({ ...VALID_ENV, APNS_AUTH_KEY: escaped })
    expect(problems.some((p) => p.includes('literal backslash-n escapes'))).toBe(true)
  })

  it('catches a quote-wrapped value', () => {
    const quoted = `"${VALID_PEM}"`
    const problems = problemsFor({ ...VALID_ENV, APNS_AUTH_KEY: quoted })
    expect(problems.some((p) => p.includes('wrapped in quote characters'))).toBe(true)
  })

  it('catches a SEC1 EC key (wrong format for importPKCS8)', () => {
    const sec1 = VALID_PEM
      .replace('-----BEGIN PRIVATE KEY-----', '-----BEGIN EC PRIVATE KEY-----')
      .replace('-----END PRIVATE KEY-----', '-----END EC PRIVATE KEY-----')
    const problems = problemsFor({ ...VALID_ENV, APNS_AUTH_KEY: sec1 })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('PKCS#8')
  })

  it('never echoes key material in a problem string', () => {
    const secretish = 'SUPERSECRETKEYBODY1234567890'
    const problems = problemsFor({ ...VALID_ENV, APNS_AUTH_KEY: secretish })
    expect(problems.join(' ')).not.toContain(secretish)
  })
})

describe('checkApnsEnv — identifiers and host selection', () => {
  it('rejects a key id that is not 10 characters', () => {
    expect(problemsFor({ ...VALID_ENV, APNS_KEY_ID: 'TOOSHORT' })[0]).toContain(
      'expected exactly 10 characters, got 8',
    )
  })

  it('rejects a team id that is not 10 characters', () => {
    expect(problemsFor({ ...VALID_ENV, APNS_TEAM_ID: 'W4J9A9K9YXEXTRA' })[0]).toContain(
      'expected exactly 10 characters',
    )
  })

  // The highest-probability second fault behind the fire-set bug: a TestFlight
  // build against the sandbox host returns 400 BadDeviceToken and delivers
  // nothing. The message must say so.
  it('rejects an unknown APNS_ENV and explains the delivery consequence', () => {
    const problems = problemsFor({ ...VALID_ENV, APNS_ENV: 'prod' })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("must be 'production' or 'sandbox'")
    expect(problems[0]).toContain('BadDeviceToken')
  })
})
