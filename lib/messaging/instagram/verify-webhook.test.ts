import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { checkInstagramSignature, verifyMetaChallengeToken } from './verify-webhook'

const SECRET = 'test-app-secret'
const BODY = '{"object":"instagram","entry":[{"id":"17841400000000000","time":1,"messaging":[]}]}'

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

function headersWith(signature: string): Headers {
  return new Headers({ 'x-hub-signature-256': signature })
}

describe('checkInstagramSignature', () => {
  it('accepts a correctly signed delivery', () => {
    const digest = sign(BODY, SECRET)
    const result = checkInstagramSignature(BODY, headersWith(`sha256=${digest}`), SECRET)
    expect(result.matched).toBe(true)
    expect(result.received).toBe(digest)
    expect(result.computed).toBe(digest)
  })

  it('rejects a tampered body', () => {
    const digest = sign(BODY, SECRET)
    const result = checkInstagramSignature(`${BODY} `, headersWith(`sha256=${digest}`), SECRET)
    expect(result.matched).toBe(false)
  })

  it('rejects the wrong app secret', () => {
    const digest = sign(BODY, SECRET)
    const result = checkInstagramSignature(BODY, headersWith(`sha256=${digest}`), 'other-secret')
    expect(result.matched).toBe(false)
  })

  it('rejects a missing header without throwing', () => {
    const result = checkInstagramSignature(BODY, new Headers(), SECRET)
    expect(result.matched).toBe(false)
    expect(result.received).toBeNull()
  })

  // The natural mistake is sending the bare hex digest. Meta does not, but an
  // unauthenticated endpoint sees whatever anyone sends it.
  it('rejects a header with no sha256= prefix', () => {
    const digest = sign(BODY, SECRET)
    const result = checkInstagramSignature(BODY, headersWith(digest), SECRET)
    expect(result.matched).toBe(false)
    expect(result.received).toBeNull()
  })

  it('rejects a sha256= prefix with an empty digest', () => {
    const result = checkInstagramSignature(BODY, headersWith('sha256='), SECRET)
    expect(result.matched).toBe(false)
    expect(result.received).toBeNull()
  })

  // timingSafeEqual throws on a length mismatch, so the length guard is what
  // keeps this a report rather than an exception.
  it('rejects a short digest without throwing', () => {
    const result = checkInstagramSignature(BODY, headersWith('sha256=abc'), SECRET)
    expect(result.matched).toBe(false)
    expect(result.received).toBe('abc')
  })

  // Nothing authenticates this endpoint while the signature is unenforced, and
  // the header is bounded only by the platform's header limit, so an 8KB
  // signature is one request away from an 8KB log line.
  it('bounds an absurdly long received digest', () => {
    const result = checkInstagramSignature(BODY, headersWith(`sha256=${'a'.repeat(8000)}`), SECRET)
    expect(result.matched).toBe(false)
    expect(result.received).toHaveLength(result.computed.length)
  })

  // The security-relevant half of that bound. If the truncation were applied
  // BEFORE the comparison rather than only to the logged value, this forgery
  // would be cut down to exactly the right digest and match.
  it('never matches a digest that is only correct once truncated', () => {
    const digest = sign(BODY, SECRET)
    const result = checkInstagramSignature(BODY, headersWith(`sha256=${digest}extra`), SECRET)
    expect(result.matched).toBe(false)
  })

  // The route logs `computed` on the failure path too. If this returned an
  // empty string on a miss, the scaffold would be unable to answer the one
  // question it exists for: what digest did WE expect?
  it('returns the computed digest even when the check fails', () => {
    const expected = sign(BODY, SECRET)
    expect(checkInstagramSignature(BODY, new Headers(), SECRET).computed).toBe(expected)
    expect(checkInstagramSignature(BODY, headersWith('sha256=abc'), SECRET).computed).toBe(expected)
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
