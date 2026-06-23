// Square OAuth — how a venue connects its Square account (the answer to the
// founder's "how do we connect to their Square" question). One Square app;
// each venue authorizes it once. Read-only scopes (we never write to Square /
// never process payments). Unlisted app — no Marketplace listing needed for the
// pilot; we send each venue the /connect link.

import type { PosResult } from '../types'
import type { SquareEnv } from './client'

// Read-only scopes — least privilege.
export const SQUARE_OAUTH_SCOPES = [
  'PAYMENTS_READ',
  'ORDERS_READ',
  'ITEMS_READ',
  'INVENTORY_READ',
  'MERCHANT_PROFILE_READ',
] as const

const OAUTH_BASE: Record<SquareEnv, string> = {
  sandbox: 'https://connect.squareupsandbox.com',
  production: 'https://connect.squareup.com',
}

/**
 * Build the Square authorization URL the venue owner is sent to. `state` is an
 * opaque, signed value (see the connect route) that round-trips to the callback
 * so we know which venue is connecting and that the request originated with us.
 */
export function buildSquareAuthorizeUrl(opts: {
  env: SquareEnv
  applicationId: string
  state: string
  redirectUrl?: string
}): string {
  const params = new URLSearchParams({
    client_id: opts.applicationId,
    scope: SQUARE_OAUTH_SCOPES.join(' '),
    session: 'false',
    state: opts.state,
  })
  if (opts.redirectUrl) params.set('redirect_uri', opts.redirectUrl)
  return `${OAUTH_BASE[opts.env]}/oauth2/authorize?${params.toString()}`
}

export type SquareOAuthTokens = {
  accessToken: string
  refreshToken: string | null
  merchantId: string | null
  expiresAt: string | null
}

/**
 * Exchange an authorization code for a merchant's tokens. I/O — returns a
 * PosResult rather than throwing.
 */
export async function exchangeSquareOAuthCode(opts: {
  env: SquareEnv
  applicationId: string
  applicationSecret: string
  code: string
  redirectUrl?: string
}): Promise<PosResult<SquareOAuthTokens>> {
  try {
    const res = await fetch(`${OAUTH_BASE[opts.env]}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Square-Version': '2025-01-23' },
      body: JSON.stringify({
        client_id: opts.applicationId,
        client_secret: opts.applicationSecret,
        code: opts.code,
        grant_type: 'authorization_code',
        ...(opts.redirectUrl ? { redirect_uri: opts.redirectUrl } : {}),
      }),
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const detail =
        body && typeof body === 'object' && 'message' in body
          ? String((body as { message: unknown }).message)
          : `status ${res.status}`
      return { ok: false, error: `Square OAuth exchange failed: ${detail}`, errorCode: 'oauth_exchange_failed' }
    }
    const b = (body ?? {}) as Record<string, unknown>
    const accessToken = typeof b.access_token === 'string' ? b.access_token : null
    if (!accessToken) {
      return { ok: false, error: 'Square OAuth response missing access_token', errorCode: 'oauth_no_token' }
    }
    return {
      ok: true,
      data: {
        accessToken,
        refreshToken: typeof b.refresh_token === 'string' ? b.refresh_token : null,
        merchantId: typeof b.merchant_id === 'string' ? b.merchant_id : null,
        expiresAt: typeof b.expires_at === 'string' ? b.expires_at : null,
      },
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      errorCode: 'oauth_exchange_failed',
    }
  }
}
