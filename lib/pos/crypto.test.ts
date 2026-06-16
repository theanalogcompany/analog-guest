import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { decryptToken, encryptToken } from './crypto'

const PREV = process.env.POS_TOKEN_ENC_KEY

beforeAll(() => {
  process.env.POS_TOKEN_ENC_KEY = Buffer.alloc(32, 7).toString('base64')
})
afterAll(() => {
  process.env.POS_TOKEN_ENC_KEY = PREV
})

describe('token crypto', () => {
  it('round-trips and does not leak plaintext', () => {
    const enc = encryptToken('sq0atp-secret-token')
    expect(enc).not.toContain('sq0atp-secret-token')
    expect(decryptToken(enc)).toBe('sq0atp-secret-token')
  })

  it('uses a fresh IV each time (ciphertext differs)', () => {
    expect(encryptToken('same')).not.toBe(encryptToken('same'))
  })

  it('throws on a malformed payload', () => {
    expect(() => decryptToken('not-valid')).toThrow(/malformed/)
  })

  it('fails authentication on tampered ciphertext', () => {
    const parts = encryptToken('x').split('.')
    parts[2] = Buffer.from('tampered').toString('base64')
    expect(() => decryptToken(parts.join('.'))).toThrow()
  })
})
