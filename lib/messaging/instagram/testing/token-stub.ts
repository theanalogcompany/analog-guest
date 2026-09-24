// TAC-516: stand-ins for the per-venue token resolver.
//
// The resolver reads the database, so every test that used to hand
// `loadInstagramSendTarget` a `() => 'token'` needs an async equivalent. These
// keep the token OUT of the query recorder's script, so a test still asserts
// on the queries the loader itself sends rather than on the credential read.

import { vi } from 'vitest'

import type { ResolveInstagramTokenResult, InstagramTokenSource } from '../credentials-store'
import type { ResolveInstagramTokenFn } from '../send-target'

/**
 * A recording stub. It RECORDS ITS ARGUMENTS on purpose (found in code
 * review): the resolver's whole job is to answer for a particular VENUE, and
 * a stub that ignores what it was asked lets a call site pass the guest id
 * instead and still pass every test — with the per-venue token feature
 * silently inert and falling back to the shared env var for every venue. Two
 * mutants survived the whole suite that way.
 *
 * So a test that exercises a call site must assert WHICH venue was asked
 * about, not merely that a token came back.
 */
export type RecordingResolveToken = ReturnType<typeof vi.fn> & ResolveInstagramTokenFn

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
): RecordingResolveToken {
  return vi.fn(
    async (): Promise<ResolveInstagramTokenResult> => ({
      ok: true,
      resolved: token === null ? null : { token, source, expiresAt: null },
    }),
  ) as RecordingResolveToken
}

/** The credential read failed, or its ciphertext could not be decrypted. */
export function failResolveToken(error: string): RecordingResolveToken {
  return vi.fn(async (): Promise<ResolveInstagramTokenResult> => ({ ok: false, error })) as RecordingResolveToken
}
