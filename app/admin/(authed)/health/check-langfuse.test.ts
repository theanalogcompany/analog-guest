import { describe, expect, it } from 'vitest'
import { checkLangfuse } from './check-langfuse'

// Pure function over its `env` argument; no module-level mocking needed.
// Each test passes a synthetic env object directly.

describe('checkLangfuse — Active', () => {
  it('reports Active when keys + BASE_URL are set and host is known', () => {
    const row = checkLangfuse({
      LANGFUSE_PUBLIC_KEY: 'pk-lf-12345abc',
      LANGFUSE_SECRET_KEY: 'sk-lf-secret',
      LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
    })
    expect(row.tone).toBe('good')
    expect(row.detail).toContain('Active')
    expect(row.detail).toContain('https://us.cloud.langfuse.com')
    expect(row.detail).toContain('pk-lf-12') // 8-char key prefix
  })

  it('treats LANGFUSE_HOST alone as a valid host (legacy alias)', () => {
    const row = checkLangfuse({
      LANGFUSE_PUBLIC_KEY: 'pk-lf-eu-12',
      LANGFUSE_SECRET_KEY: 'sk-lf-eu',
      LANGFUSE_HOST: 'https://cloud.langfuse.com',
    })
    expect(row.tone).toBe('good')
    expect(row.detail).toContain('https://cloud.langfuse.com')
  })
})

describe('checkLangfuse — Disabled', () => {
  it('reports Disabled when LANGFUSE_ENABLED=false even with full keys', () => {
    // Explicit operator intent dominates over "missing key" misconfigurations.
    const row = checkLangfuse({
      LANGFUSE_PUBLIC_KEY: 'pk',
      LANGFUSE_SECRET_KEY: 'sk',
      LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
      LANGFUSE_ENABLED: 'false',
    })
    expect(row.tone).toBe('neutral')
    expect(row.detail).toContain('Disabled')
    expect(row.detail).toContain('LANGFUSE_ENABLED')
  })
})

describe('checkLangfuse — Misconfigured', () => {
  it('flags missing public key when secret + host are set', () => {
    const row = checkLangfuse({
      LANGFUSE_SECRET_KEY: 'sk',
      LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
    })
    expect(row.tone).toBe('bad')
    expect(row.detail).toContain('Misconfigured')
    expect(row.detail).toContain('LANGFUSE_PUBLIC_KEY')
  })

  it('flags missing secret key when public + host are set', () => {
    const row = checkLangfuse({
      LANGFUSE_PUBLIC_KEY: 'pk',
      LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
    })
    expect(row.tone).toBe('bad')
    expect(row.detail).toContain('LANGFUSE_SECRET_KEY')
  })

  it('flags missing host when both keys are set', () => {
    const row = checkLangfuse({
      LANGFUSE_PUBLIC_KEY: 'pk',
      LANGFUSE_SECRET_KEY: 'sk',
    })
    expect(row.tone).toBe('bad')
    expect(row.detail).toContain('LANGFUSE_BASE_URL (or LANGFUSE_HOST)')
  })

  it('flags unrecognized host', () => {
    const row = checkLangfuse({
      LANGFUSE_PUBLIC_KEY: 'pk',
      LANGFUSE_SECRET_KEY: 'sk',
      LANGFUSE_BASE_URL: 'https://made-up-region.langfuse.com',
    })
    expect(row.tone).toBe('bad')
    expect(row.detail).toContain('unrecognized host')
    expect(row.detail).toContain('https://made-up-region.langfuse.com')
  })
})

describe('checkLangfuse — Not configured', () => {
  it('reports Not configured when no LANGFUSE_* vars are set', () => {
    const row = checkLangfuse({})
    expect(row.tone).toBe('neutral')
    expect(row.detail).toContain('Not configured')
    expect(row.detail).toContain('local dev')
  })

  it('treats whitespace-only values as unset (Not configured)', () => {
    const row = checkLangfuse({
      LANGFUSE_PUBLIC_KEY: '   ',
      LANGFUSE_SECRET_KEY: '',
      LANGFUSE_BASE_URL: '   ',
    })
    expect(row.tone).toBe('neutral')
    expect(row.detail).toContain('Not configured')
  })
})
