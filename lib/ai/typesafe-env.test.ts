// Tests for the JEV_API_KEY shape validator. Synthetic env objects only,
// never process.env. Pins: each defect produces its own named problem, a valid
// key passes, and no problem string ever carries the key value itself - the
// validator's contract is that it names the var and the defect, not the material.
import { describe, expect, it } from 'vitest'
// Relative import — vitest doesn't pick up Next's `@/*` alias under our setup.
import { checkTypesafeEnv } from './typesafe-env'

const VALID_KEY = 'apikey_' + 'a'.repeat(60)

function problemsOf(env: Record<string, string | undefined>): string[] {
  const r = checkTypesafeEnv(env)
  expect(r.ok).toBe(false)
  return r.ok ? [] : r.problems
}

describe('checkTypesafeEnv — missing and empty', () => {
  it('reports a missing key as missing or empty, naming the var', () => {
    const problems = problemsOf({})
    expect(problems).toEqual(['JEV_API_KEY: missing or empty'])
  })

  it('reports an empty string the same way', () => {
    const problems = problemsOf({ JEV_API_KEY: '' })
    expect(problems).toEqual(['JEV_API_KEY: missing or empty'])
  })

  it('reports a whitespace-only value the same way, not as a shape defect', () => {
    const problems = problemsOf({ JEV_API_KEY: '   \n\t  ' })
    expect(problems).toEqual(['JEV_API_KEY: missing or empty'])
  })
})

describe('checkTypesafeEnv — shape defects, each named distinctly', () => {
  it('names a wrong prefix', () => {
    const problems = problemsOf({ JEV_API_KEY: 'sk_' + 'a'.repeat(60) })
    expect(problems).toEqual(['JEV_API_KEY: does not start with "apikey_"'])
  })

  it('names a too-short key', () => {
    // Right prefix, no whitespace, but under 40 chars total.
    const problems = problemsOf({ JEV_API_KEY: 'apikey_short' })
    expect(problems).toEqual(['JEV_API_KEY: shorter than 40 characters'])
  })

  it('names embedded whitespace', () => {
    const key = 'apikey_' + 'a'.repeat(30) + ' ' + 'a'.repeat(30)
    const problems = problemsOf({ JEV_API_KEY: key })
    expect(problems).toEqual(['JEV_API_KEY: contains whitespace'])
  })

  it('surfaces every defect at once, not just the first', () => {
    // Wrong prefix AND too short AND embedded whitespace.
    const problems = problemsOf({ JEV_API_KEY: 'bad key' })
    expect(problems).toEqual([
      'JEV_API_KEY: does not start with "apikey_"',
      'JEV_API_KEY: shorter than 40 characters',
      'JEV_API_KEY: contains whitespace',
    ])
  })
})

describe('checkTypesafeEnv — valid shapes', () => {
  it('accepts a well-shaped key', () => {
    expect(checkTypesafeEnv({ JEV_API_KEY: VALID_KEY })).toEqual({ ok: true })
  })

  it('accepts a valid key wrapped in stray whitespace (env values carry trailing newlines)', () => {
    expect(checkTypesafeEnv({ JEV_API_KEY: `  ${VALID_KEY}\n` })).toEqual({ ok: true })
  })
})

describe('checkTypesafeEnv — never leaks key material', () => {
  // Distinctive fragments that could only appear in a problem string if the
  // validator echoed the value back. One per failure mode that has a value.
  it.each([
    ['wrong prefix', 'ZQXJVK_DISTINCTIVE_SECRET_FRAGMENT_' + 'z'.repeat(40)],
    ['too short', 'apikey_ZQXJVKSECRET'],
    ['embedded whitespace', 'apikey_ZQXJVKSECRETHALF1 ZQXJVKSECRETHALF2aaaaaaaaaa'],
    ['all defects at once', 'ZQXJVK SECRET'],
  ])('problem strings for a %s key never contain the value', (_label, key) => {
    const r = checkTypesafeEnv({ JEV_API_KEY: key })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.problems.length).toBeGreaterThan(0)
    const joined = r.problems.join('')
    // Neither the whole value nor its distinctive core may appear.
    expect(joined).not.toContain(key)
    expect(joined).not.toContain('ZQXJVK')
  })
})
