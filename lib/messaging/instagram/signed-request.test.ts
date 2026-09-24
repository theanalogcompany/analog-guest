// TAC-516: Meta's signed_request parser.
//
// The ORDER of the two halves is the trap this file exists to pin. Meta puts
// the SIGNATURE first; our own OAuth state puts the payload first. Swapping
// them verifies nothing while looking entirely reasonable.

import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { parseSignedRequest } from './signed-request'

const SECRET = 'app-secret-value'
const ACCOUNT_ID = '17841479626987104'

function makeSigned(payload: unknown, secret = SECRET): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret).update(payloadB64).digest('base64url')
  // Signature FIRST. Meta's order.
  return `${signature}.${payloadB64}`
}

describe('parseSignedRequest', () => {
  it('reads the account id from a genuine signed request', () => {
    const signed = makeSigned({ user_id: ACCOUNT_ID, algorithm: 'HMAC-SHA256', issued_at: 1790000000 })
    expect(parseSignedRequest(signed, SECRET)).toEqual({
      ok: true,
      payload: { userId: ACCOUNT_ID, issuedAt: 1790000000 },
    })
  })

  it('accepts a numeric user_id as a string', () => {
    const signed = makeSigned({ user_id: 17841479626987104 })
    expect(parseSignedRequest(signed, SECRET)).toMatchObject({
      ok: true,
      payload: { userId: '17841479626987104' },
    })
  })

  it('accepts a request with no issued_at', () => {
    expect(parseSignedRequest(makeSigned({ user_id: ACCOUNT_ID }), SECRET)).toEqual({
      ok: true,
      payload: { userId: ACCOUNT_ID, issuedAt: null },
    })
  })

  // THE ORDER TRAP. A payload-first value is well-formed and signed; it just
  // is not Meta's format, and reading it as one verifies nothing.
  it('refuses a payload-first value, which is our own state format, not Meta\'s', () => {
    const payloadB64 = Buffer.from(JSON.stringify({ user_id: ACCOUNT_ID }), 'utf8').toString('base64url')
    const signature = createHmac('sha256', SECRET).update(payloadB64).digest('base64url')
    expect(parseSignedRequest(`${payloadB64}.${signature}`, SECRET)).toEqual({
      ok: false,
      reason: 'mismatch',
    })
  })

  it('refuses a signature made with a different secret', () => {
    const signed = makeSigned({ user_id: ACCOUNT_ID }, 'some-other-secret')
    expect(parseSignedRequest(signed, SECRET)).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('refuses a tampered payload', () => {
    const signed = makeSigned({ user_id: ACCOUNT_ID })
    const [signature] = signed.split('.')
    const forged = Buffer.from(JSON.stringify({ user_id: 'someone-else' }), 'utf8').toString('base64url')
    expect(parseSignedRequest(`${signature}.${forged}`, SECRET)).toEqual({
      ok: false,
      reason: 'mismatch',
    })
  })

  // HMAC accepts an empty key and produces a digest anyone can compute, so a
  // caller passing '' would otherwise verify a forgery. Refused HERE as well
  // as at the route, so removing either guard still fails closed.
  it('refuses an empty secret rather than verifying a forgery', () => {
    const forged = makeSigned({ user_id: ACCOUNT_ID }, '')
    expect(parseSignedRequest(forged, '')).toEqual({ ok: false, reason: 'secret_unset' })
  })

  it.each([
    ['empty', ''],
    ['no separator', 'abcdef'],
    ['three parts', 'a.b.c'],
    ['empty signature half', '.payload'],
    ['empty payload half', 'signature.'],
  ])('refuses a %s value as malformed', (_label, raw) => {
    expect(parseSignedRequest(raw, SECRET)).toEqual({ ok: false, reason: 'malformed' })
  })

  // Signed by Meta but not the documented shape. Distinct from `mismatch`
  // because the fix is different: one is a forgery or a rotated secret, the
  // other is Meta changing its payload.
  it.each([
    ['not json', 'not-json'],
    ['a json array', JSON.stringify([1])],
    ['no user_id', JSON.stringify({ algorithm: 'HMAC-SHA256' })],
    ['a blank user_id', JSON.stringify({ user_id: '' })],
  ])('reports a verified but %s payload as unreadable', (_label, raw) => {
    const payloadB64 = Buffer.from(raw, 'utf8').toString('base64url')
    const signature = createHmac('sha256', SECRET).update(payloadB64).digest('base64url')
    expect(parseSignedRequest(`${signature}.${payloadB64}`, SECRET)).toEqual({
      ok: false,
      reason: 'unreadable_payload',
    })
  })

  // Our digest of a payload is a valid signature for it until the secret
  // rotates. A result that carried one would hand out a forgery to anyone who
  // could read a log line.
  it('never returns the computed digest or the secret', () => {
    const signed = makeSigned({ user_id: ACCOUNT_ID }, 'wrong-secret')
    const result = parseSignedRequest(signed, SECRET)
    const expectedDigest = createHmac('sha256', SECRET)
      .update(signed.split('.')[1])
      .digest('base64url')
    const rendered = JSON.stringify(result)
    expect(rendered).not.toContain(expectedDigest)
    expect(rendered).not.toContain(SECRET)
  })
})
