import { createHmac, timingSafeEqual } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { verifyInstagramSignature, verifyMetaChallengeToken } from './verify-webhook'

// The real timingSafeEqual, wrapped so a test can see that it is what decides
// the comparison. Nothing else about node:crypto changes.
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto')
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) }
})

const SECRET = 'test-app-secret'
const BODY = '{"object":"instagram","entry":[{"id":"17841400000000000","time":1,"messaging":[]}]}'

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

function headersWith(signature: string): Headers {
  return new Headers({ 'x-hub-signature-256': signature })
}

afterEach(() => {
  vi.mocked(timingSafeEqual).mockClear()
})

describe('verifyInstagramSignature', () => {
  it('accepts a correctly signed delivery', () => {
    const result = verifyInstagramSignature(BODY, headersWith(`sha256=${sign(BODY, SECRET)}`), SECRET)
    expect(result).toEqual({ ok: true })
  })

  it('rejects a tampered body as a mismatch', () => {
    const result = verifyInstagramSignature(`${BODY} `, headersWith(`sha256=${sign(BODY, SECRET)}`), SECRET)
    expect(result).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('rejects the wrong app secret as a mismatch', () => {
    const result = verifyInstagramSignature(BODY, headersWith(`sha256=${sign(BODY, SECRET)}`), 'other-secret')
    expect(result).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('rejects a missing header', () => {
    expect(verifyInstagramSignature(BODY, new Headers(), SECRET)).toEqual({
      ok: false,
      reason: 'missing_header',
    })
  })

  // The natural mistake is sending the bare hex digest. Meta does not, but an
  // endpoint anyone can reach sees whatever anyone sends it.
  it('rejects a header with no sha256= prefix as malformed', () => {
    const result = verifyInstagramSignature(BODY, headersWith(sign(BODY, SECRET)), SECRET)
    expect(result).toEqual({ ok: false, reason: 'malformed_header' })
  })

  it('rejects a sha256= prefix with an empty digest as malformed', () => {
    expect(verifyInstagramSignature(BODY, headersWith('sha256='), SECRET)).toEqual({
      ok: false,
      reason: 'malformed_header',
    })
  })

  // timingSafeEqual throws on a length mismatch, so the length guard is what
  // keeps these a refusal rather than an exception.
  it('rejects a short digest without throwing', () => {
    expect(verifyInstagramSignature(BODY, headersWith('sha256=abc'), SECRET)).toEqual({
      ok: false,
      reason: 'mismatch',
    })
  })

  it('rejects an absurdly long digest without throwing', () => {
    const result = verifyInstagramSignature(BODY, headersWith(`sha256=${'a'.repeat(8000)}`), SECRET)
    expect(result).toEqual({ ok: false, reason: 'mismatch' })
  })

  // A correct digest with trailing bytes must not match. Nothing here trims or
  // truncates, and this is the test that keeps it that way: any "tidy" that
  // cut the received value to digest length would turn this into a forgery
  // that passes.
  it('never matches a correct digest with bytes appended', () => {
    const result = verifyInstagramSignature(BODY, headersWith(`sha256=${sign(BODY, SECRET)}extra`), SECRET)
    expect(result).toEqual({ ok: false, reason: 'mismatch' })
  })

  // THE trap this helper guards. HMAC accepts an empty key, and a signature
  // keyed with one is computable by anyone. So a forger who signs with '' must
  // never pass against an empty or unset secret, whatever the caller does.
  // The route refuses an unset secret before calling this; this test is what
  // holds the guard for every caller, including that one if its check is ever
  // removed.
  it('never verifies against an empty or unset secret, even a body signed with an empty key', () => {
    const forged = headersWith(`sha256=${sign(BODY, '')}`)
    expect(verifyInstagramSignature(BODY, forged, '')).toEqual({ ok: false, reason: 'secret_unset' })
    expect(verifyInstagramSignature(BODY, forged, undefined)).toEqual({
      ok: false,
      reason: 'secret_unset',
    })
  })

  // A timing-safe comparison can't be observed from its result, only from what
  // makes the decision. A plain `===` or Buffer.equals would pass every other
  // test in this file.
  it('decides a well-formed signature with timingSafeEqual', () => {
    const digest = sign(BODY, SECRET)

    verifyInstagramSignature(BODY, headersWith(`sha256=${digest}`), SECRET)
    expect(timingSafeEqual).toHaveBeenCalledTimes(1)
    const [received, computed] = vi.mocked(timingSafeEqual).mock.calls[0] ?? []
    expect(Buffer.from(received as Uint8Array).toString()).toBe(digest)
    expect(Buffer.from(computed as Uint8Array).toString()).toBe(digest)

    vi.mocked(timingSafeEqual).mockClear()
    const forgery = 'f'.repeat(digest.length)
    expect(verifyInstagramSignature(BODY, headersWith(`sha256=${forgery}`), SECRET)).toEqual({
      ok: false,
      reason: 'mismatch',
    })
    expect(timingSafeEqual).toHaveBeenCalledTimes(1)
  })

  // Once the route trusts the signature, our digest of a stranger's body is a
  // valid signature for that body. The result carries a reason and nothing
  // else, so no caller can log it by accident. Checked on every outcome,
  // because a digest handed back only on a miss is exactly the oracle.
  it('never returns a digest, on any outcome', () => {
    const digest = sign(BODY, SECRET)
    const forgedBody = `${BODY} `
    const digestOfForgedBody = sign(forgedBody, SECRET)

    const outcomes = [
      verifyInstagramSignature(BODY, headersWith(`sha256=${digest}`), SECRET),
      verifyInstagramSignature(forgedBody, headersWith(`sha256=${digest}`), SECRET),
      verifyInstagramSignature(forgedBody, new Headers(), SECRET),
      verifyInstagramSignature(forgedBody, headersWith('sha256=abc'), SECRET),
    ]

    for (const outcome of outcomes) {
      expect(Object.keys(outcome).sort()).toEqual('reason' in outcome ? ['ok', 'reason'] : ['ok'])
      const serialized = JSON.stringify(outcome)
      expect(serialized).not.toContain(digest)
      expect(serialized).not.toContain(digestOfForgedBody)
    }
  })
})

describe('verifyMetaChallengeToken', () => {
  it('accepts an exact match', () => {
    expect(verifyMetaChallengeToken('shared-token', 'shared-token')).toBe(true)
  })

  it('rejects a different token of the same length', () => {
    expect(verifyMetaChallengeToken('shared-tokes', 'shared-token')).toBe(false)
  })

  it('rejects a length mismatch without throwing', () => {
    expect(verifyMetaChallengeToken('short', 'shared-token')).toBe(false)
  })

  it('rejects a null received token', () => {
    expect(verifyMetaChallengeToken(null, 'shared-token')).toBe(false)
  })

  // The load-bearing case. The natural spelling of this comparison coalesces
  // both sides to '' when unset, and '' === '' verifies a handshake against a
  // token nobody configured. All three shapes must be false.
  it('never verifies against an unset or empty expected token', () => {
    expect(verifyMetaChallengeToken('', '')).toBe(false)
    expect(verifyMetaChallengeToken(null, undefined)).toBe(false)
    expect(verifyMetaChallengeToken('anything', undefined)).toBe(false)
    expect(verifyMetaChallengeToken('anything', '')).toBe(false)
  })

  it('rejects an empty received token against a real expected token', () => {
    expect(verifyMetaChallengeToken('', 'shared-token')).toBe(false)
  })
})
