// App-layer encryption for POS credentials at rest (pos_credentials access /
// refresh tokens). AES-256-GCM with POS_TOKEN_ENC_KEY (a base64 32-byte key).
// Stored format: "<ivB64>.<tagB64>.<ciphertextB64>".
//
// Key is read lazily (per call) so importing this module never requires env —
// keeps it vitest-safe. The key is parsed + length-checked on every use so a
// malformed key fails loudly at the call site rather than producing garbage.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12

function getKey(): Buffer {
  const raw = process.env.POS_TOKEN_ENC_KEY
  if (!raw) throw new Error('Missing env var: POS_TOKEN_ENC_KEY')
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error(
      `POS_TOKEN_ENC_KEY must decode to 32 bytes (got ${key.length}); generate with: openssl rand -base64 32`,
    )
  }
  return key
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, getKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`
}

export function decryptToken(encoded: string): string {
  const parts = encoded.split('.')
  if (parts.length !== 3) throw new Error('malformed encrypted token')
  const [ivB64, tagB64, ctB64] = parts
  const decipher = createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}
