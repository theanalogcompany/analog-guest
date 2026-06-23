// GET /api/pos/square/callback?code=...&state=...
// Square redirects here after the owner approves. Validates the signed state,
// exchanges the code for the merchant's tokens, fetches the merchant's first
// location (so transaction webhooks resolve by location), and stores the
// encrypted credential. This is a public URL (Square calls it) — security
// rests on the signed state + the one-time code.

import { createSquareClient, resolveSquareEnv } from '@/lib/pos/square/client'
import { upsertSquareCredential } from '@/lib/pos/credentials-store'
import { exchangeSquareOAuthCode, SQUARE_OAUTH_SCOPES } from '@/lib/pos/square/oauth'
import { verifyOAuthState } from '@/lib/pos/square/oauth-state'

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')

  // Owner declined or Square returned an error.
  if (!code || !state) {
    return new Response('Square connection cancelled or missing parameters.', { status: 400 })
  }

  const applicationId = process.env.SQUARE_APPLICATION_ID
  const applicationSecret = process.env.SQUARE_OAUTH_SECRET
  const stateSecret = process.env.POS_TOKEN_ENC_KEY
  if (!applicationId || !applicationSecret || !stateSecret) {
    console.error('square callback: SQUARE_APPLICATION_ID / SQUARE_OAUTH_SECRET / POS_TOKEN_ENC_KEY not set')
    return new Response('Server misconfigured', { status: 500 })
  }

  const venueId = verifyOAuthState(state, stateSecret)
  if (!venueId) {
    console.warn('square callback: invalid state')
    return new Response('Invalid or expired connection request.', { status: 401 })
  }

  const env = resolveSquareEnv(process.env.SQUARE_ENV)
  const tokens = await exchangeSquareOAuthCode({
    env,
    applicationId,
    applicationSecret,
    code,
    redirectUrl: process.env.SQUARE_OAUTH_REDIRECT_URL,
  })
  if (!tokens.ok) {
    console.error('square callback: token exchange failed', { venueId, error: tokens.error })
    return new Response('Could not complete Square connection. Please try again.', { status: 502 })
  }

  // Resolve the merchant's first location so payment webhooks (which carry a
  // location_id) resolve to this venue. MVP takes the first location.
  let locationId: string | null = null
  try {
    const client = createSquareClient(tokens.data.accessToken, env)
    const locations = await client.locations.list()
    locationId = locations.locations?.[0]?.id ?? null
  } catch (e) {
    console.warn('square callback: location fetch failed (storing without location)', {
      venueId,
      error: e instanceof Error ? e.message : String(e),
    })
  }

  const stored = await upsertSquareCredential({
    venueId,
    merchantId: tokens.data.merchantId,
    locationId,
    accessToken: tokens.data.accessToken,
    refreshToken: tokens.data.refreshToken,
    expiresAt: tokens.data.expiresAt,
    scopes: SQUARE_OAUTH_SCOPES,
  })
  if (!stored.ok) {
    console.error('square callback: credential store failed', { venueId, error: stored.error })
    return new Response('Connected to Square but could not save the link. Please contact support.', {
      status: 500,
    })
  }

  return new Response('Square connected successfully. You can close this window.', { status: 200 })
}
