// TAC-516: stand-ins for the per-venue token resolver.
//
// The resolver reads the database, so every test that used to hand
// `loadInstagramSendTarget` a `() => 'token'` needs an async equivalent. These
// keep the token OUT of the query recorder's script, so a test still asserts
// on the queries the loader itself sends rather than on the credential read.

import type { ResolveInstagramTokenResult, InstagramTokenSource } from '../credentials-store'
import type { ResolveInstagramTokenFn } from '../send-target'

/**
 * Resolves to `token`, or to nothing when it is null (the venue has no
 * credential and no env var).
 *
 * `source` defaults to 'env' so an existing test that only cares that a token
 * arrives keeps describing the pre-TAC-516 world: no credential row, env
 * fallback. Pass 'venue' where the venue's own credential is the subject.
 */
export function stubResolveToken(
  token: string | null,
  source: InstagramTokenSource = 'env',
): ResolveInstagramTokenFn {
  return async (): Promise<ResolveInstagramTokenResult> => ({
    ok: true,
    resolved: token === null ? null : { token, source, expiresAt: null },
  })
}

/** The credential read failed, or its ciphertext could not be decrypted. */
export function failResolveToken(error: string): ResolveInstagramTokenFn {
  return async (): Promise<ResolveInstagramTokenResult> => ({ ok: false, error })
}
