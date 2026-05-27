// APNs token-auth JWT signer (TAC-207). Apple's HTTP/2 push API accepts an
// ES256 JWT as the bearer credential; tokens are valid for up to ~1 hour.
// Refreshing every 50min keeps us comfortably inside the window without
// burning a fresh sign on every send.
//
// Three required env vars:
//   APNS_AUTH_KEY  — PEM-encoded ECDSA P-256 private key (.p8 contents,
//                    pasted from 1Password into Vercel as a multi-line value).
//   APNS_KEY_ID    — 10-char key identifier (S4PR9KNPKA for the analog team).
//   APNS_TEAM_ID   — 10-char Apple team identifier (W4J9A9K9YX).
//
// Errors-as-values: callers expect ApnsJwtResult and route on `.ok`. Never
// throws — env-missing failures return ok:false with a short error code so
// the orchestrator can degrade cleanly (no push, but the queue still works).

import { importPKCS8, SignJWT } from 'jose'

const ALG = 'ES256'
const JWT_REFRESH_AFTER_MS = 50 * 60 * 1000

export interface ApnsJwtResult {
  ok: true
  token: string
}

export interface ApnsJwtError {
  ok: false
  error: 'env_missing' | 'key_parse_failed' | 'sign_failed'
  detail: string
}

interface CachedJwt {
  token: string
  signedAtMs: number
  keyId: string
  teamId: string
}

let cached: CachedJwt | null = null

/**
 * Test-only: clear the cached token so a subsequent getApnsJwt() call
 * re-signs from env vars. Not exported from the package barrel.
 */
export function _resetApnsJwtCacheForTests(): void {
  cached = null
}

/**
 * Returns a valid APNs JWT, signing a fresh one if the cache is empty or
 * stale (>50min old). Pure-ish — the only side effect is the module-level
 * cache.
 *
 * Cache invalidates on env-var change (key id or team id rotation) so a
 * `vercel env pull` + redeploy cycle picks up the new credentials without a
 * stale-token tail.
 */
export async function getApnsJwt(
  nowMs: number = Date.now(),
): Promise<ApnsJwtResult | ApnsJwtError> {
  const authKey = process.env.APNS_AUTH_KEY
  const keyId = process.env.APNS_KEY_ID
  const teamId = process.env.APNS_TEAM_ID
  if (!authKey || !keyId || !teamId) {
    return {
      ok: false,
      error: 'env_missing',
      detail: 'APNS_AUTH_KEY / APNS_KEY_ID / APNS_TEAM_ID',
    }
  }

  if (
    cached &&
    cached.keyId === keyId &&
    cached.teamId === teamId &&
    nowMs - cached.signedAtMs < JWT_REFRESH_AFTER_MS
  ) {
    return { ok: true, token: cached.token }
  }

  let privateKey
  try {
    privateKey = await importPKCS8(authKey, ALG)
  } catch (e) {
    return {
      ok: false,
      error: 'key_parse_failed',
      detail: e instanceof Error ? e.message : String(e),
    }
  }

  let token: string
  try {
    token = await new SignJWT({})
      .setProtectedHeader({ alg: ALG, kid: keyId })
      .setIssuer(teamId)
      .setIssuedAt(Math.floor(nowMs / 1000))
      .sign(privateKey)
  } catch (e) {
    return {
      ok: false,
      error: 'sign_failed',
      detail: e instanceof Error ? e.message : String(e),
    }
  }

  cached = { token, signedAtMs: nowMs, keyId, teamId }
  return { ok: true, token }
}
