import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  INSTAGRAM_TOKEN_ENC_KEY_VAR,
  checkInstagramTokenEncKey,
  decryptInstagramToken,
  encryptInstagramToken,
} from './token-crypto'

const PREV = process.env.INSTAGRAM_TOKEN_ENC_KEY
const GOOD_KEY = Buffer.alloc(32, 7).toString('base64')

beforeAll(() => {
  process.env.INSTAGRAM_TOKEN_ENC_KEY = GOOD_KEY
})
afterAll(() => {
  process.env.INSTAGRAM_TOKEN_ENC_KEY = PREV
})

// A token shaped like Meta's: long, opaque, and the one thing that must never
// appear in a log, a page or an error message (TAC-516 AC).
const TOKEN = 'IGAAR1exampleZAexampleTOKENvalue0000000000000000'

describe('instagram token crypto', () => {
  it('round-trips and never embeds the plaintext', () => {
    const enc = encryptInstagramToken(TOKEN)
    expect(enc).not.toContain(TOKEN)
    expect(decryptInstagramToken(enc)).toBe(TOKEN)
  })

  it('uses a fresh IV each time, so the same token encrypts differently', () => {
    expect(encryptInstagramToken(TOKEN)).not.toBe(encryptInstagramToken(TOKEN))
  })

  it('throws on a malformed payload', () => {
    expect(() => decryptInstagramToken('not-valid')).toThrow(/malformed/)
    expect(() => decryptInstagramToken('a.b')).toThrow(/malformed/)
  })

  // GCM's whole point: a modified ciphertext fails authentication rather than
  // decrypting to something plausible.
  it('fails authentication on tampered ciphertext', () => {
    const parts = encryptInstagramToken(TOKEN).split('.')
    parts[2] = Buffer.from('tampered').toString('base64')
    expect(() => decryptInstagramToken(parts.join('.'))).toThrow()
  })

  it('fails authentication on a tampered auth tag', () => {
    const parts = encryptInstagramToken(TOKEN).split('.')
    parts[1] = Buffer.alloc(16, 1).toString('base64')
    expect(() => decryptInstagramToken(parts.join('.'))).toThrow()
  })

  // A key of the wrong length must fail loudly here, not decrypt to garbage
  // that only surfaces when Meta rejects the token weeks later.
  it('names the defect when the key is missing or the wrong length', () => {
    expect(() => encryptInstagramToken(TOKEN, {} as unknown as NodeJS.ProcessEnv)).toThrow(
      new RegExp(`Missing env var: ${INSTAGRAM_TOKEN_ENC_KEY_VAR}`),
    )
    expect(() =>
      encryptInstagramToken(TOKEN, { INSTAGRAM_TOKEN_ENC_KEY: '   ' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/Missing env var/)
    expect(() =>
      encryptInstagramToken(TOKEN, {
        INSTAGRAM_TOKEN_ENC_KEY: Buffer.alloc(16, 1).toString('base64'),
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/must decode to 32 bytes \(got 16\)/)
  })

  // The error is allowed to name the variable and the byte count. It must
  // never carry the value, which is the whole reason it is checked here.
  it('never puts key material in a thrown message', () => {
    const secret = Buffer.alloc(16, 9).toString('base64')
    try {
      encryptInstagramToken(TOKEN, { INSTAGRAM_TOKEN_ENC_KEY: secret } as unknown as NodeJS.ProcessEnv)
      throw new Error('expected a throw')
    } catch (err) {
      expect((err as Error).message).not.toContain(secret)
    }
  })

  describe('checkInstagramTokenEncKey', () => {
    it('passes a well-formed key', () => {
      expect(checkInstagramTokenEncKey({ INSTAGRAM_TOKEN_ENC_KEY: GOOD_KEY } as unknown as NodeJS.ProcessEnv)).toEqual({
        ok: true,
      })
    })

    // "missing" and "wrong length" have different fixes, so they are
    // different problems rather than one "bad key".
    it('distinguishes missing from wrong length', () => {
      expect(checkInstagramTokenEncKey({} as unknown as NodeJS.ProcessEnv)).toMatchObject({
        ok: false,
        problem: 'missing',
      })
      expect(
        checkInstagramTokenEncKey({ INSTAGRAM_TOKEN_ENC_KEY: '' } as unknown as NodeJS.ProcessEnv),
      ).toMatchObject({ ok: false, problem: 'missing' })
      expect(
        checkInstagramTokenEncKey({
          INSTAGRAM_TOKEN_ENC_KEY: Buffer.alloc(8, 1).toString('base64'),
        } as unknown as NodeJS.ProcessEnv),
      ).toMatchObject({ ok: false, problem: 'wrong_length' })
    })

    it('never returns key material in the detail', () => {
      const secret = Buffer.alloc(8, 3).toString('base64')
      const result = checkInstagramTokenEncKey({
        INSTAGRAM_TOKEN_ENC_KEY: secret,
      } as unknown as NodeJS.ProcessEnv)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.detail).not.toContain(secret)
    })
  })
})
