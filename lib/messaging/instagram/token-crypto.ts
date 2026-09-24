// App-layer encryption for a venue's Instagram access token at rest
// (instagram_credentials.access_token_enc, TAC-516). AES-256-GCM with
// INSTAGRAM_TOKEN_ENC_KEY, a base64 32-byte key. Stored format:
// "<ivB64>.<tagB64>.<ciphertextB64>".
//
// DELIBERATE DUPLICATION of lib/pos/crypto.ts. Same algorithm, same stored
// format, different env var and different domain. Extracting a shared module
// would mean refactoring Square's working credential path from inside a
// hard-stop auth-and-credentials ticket, and a new lib/crypto/ module
// directory needs asking first (CLAUDE.md, "File path conventions"). Both
// files carry a pointer at the other, which is this repo's convention for
// duplication that is real rather than accidental — cf. markCancelled and
// cancelCommitmentForGuest. Revisit if a third consumer ever appears.
//
// THE KEY IS READ LAZILY, per call, never at module load. CI defines none of
// the Meta vars, so a module-load throw would crash tsc, vitest and next build
// on every future PR — CLAUDE.md, "Module-load vs first-call", which
// explicitly supersedes the older parse-at-boot guidance for this repo. It is
// parsed and length-checked on every use instead, so a malformed key fails
// loudly at the call site naming the specific defect, rather than silently
// producing garbage that only fails when Meta rejects the token weeks later.
//
// Nothing here logs, returns or embeds the key or the plaintext. A thrown
// message names the variable and the byte count it decoded to, never a value.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32

/** The env var holding the base64 32-byte key. Named once. */
export const INSTAGRAM_TOKEN_ENC_KEY_VAR = 'INSTAGRAM_TOKEN_ENC_KEY'

function getKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env[INSTAGRAM_TOKEN_ENC_KEY_VAR]
  if (!raw || raw.trim() === '') {
    throw new Error(`Missing env var: ${INSTAGRAM_TOKEN_ENC_KEY_VAR}`)
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${INSTAGRAM_TOKEN_ENC_KEY_VAR} must decode to ${KEY_BYTES} bytes (got ${key.length}); generate with: openssl rand -base64 32`,
    )
  }
  return key
}

/**
 * First-call guard: checks the key's SHAPE without encrypting anything and
 * without ever returning key material.
 *
 * THERE IS NO /admin/health ROW FOR THIS, deliberately. A shape check can
 * see a missing or mis-sized key and cannot see a key that is the wrong 32
 * bytes, which is the failure that actually strands a venue's credential —
 * so a green row would assert more than it checked. CLAUDE.md makes the same
 * call for the Meta secrets. The callers below are the detection.
 *
 * Deliberately returns the DEFECT, not the value: "missing" and "wrong
 * length" have different fixes and a caller that only learns "bad key"
 * cannot say which.
 */
export function checkInstagramTokenEncKey(
  env: NodeJS.ProcessEnv = process.env,
): { ok: true } | { ok: false; problem: 'missing' | 'wrong_length'; detail: string } {
  const raw = env[INSTAGRAM_TOKEN_ENC_KEY_VAR]
  if (!raw || raw.trim() === '') {
    return { ok: false, problem: 'missing', detail: `${INSTAGRAM_TOKEN_ENC_KEY_VAR} is not set` }
  }
  const length = Buffer.from(raw, 'base64').length
  if (length !== KEY_BYTES) {
    return {
      ok: false,
      problem: 'wrong_length',
      detail: `${INSTAGRAM_TOKEN_ENC_KEY_VAR} decodes to ${length} bytes, expected ${KEY_BYTES}`,
    }
  }
  return { ok: true }
}

export function encryptInstagramToken(plaintext: string, env?: NodeJS.ProcessEnv): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, getKey(env), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`
}

export function decryptInstagramToken(encoded: string, env?: NodeJS.ProcessEnv): string {
  const parts = encoded.split('.')
  if (parts.length !== 3) throw new Error('malformed encrypted Instagram token')
  const [ivB64, tagB64, ctB64] = parts
  const decipher = createDecipheriv(ALGO, getKey(env), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}
