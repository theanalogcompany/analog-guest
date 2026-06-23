// GET /api/pos/square/connect?venue=<venueId>
// Starts the Square OAuth flow for a venue: redirects the owner to Square's
// authorization page with a signed state. The callback completes the link.
//
// MVP note: this initiator is not auth-gated. The signed state binds the
// venue and the callback validates it, but production should gate /connect
// behind admin/operator auth so only staff can start a link (follow-up).

import { resolveSquareEnv } from '@/lib/pos/square/client'
import { buildSquareAuthorizeUrl } from '@/lib/pos/square/oauth'
import { signOAuthState } from '@/lib/pos/square/oauth-state'

export async function GET(request: Request): Promise<Response> {
  const venueId = new URL(request.url).searchParams.get('venue')
  if (!venueId) {
    return new Response('Missing ?venue', { status: 400 })
  }

  const applicationId = process.env.SQUARE_APPLICATION_ID
  const stateSecret = process.env.POS_TOKEN_ENC_KEY
  if (!applicationId || !stateSecret) {
    console.error('square connect: SQUARE_APPLICATION_ID / POS_TOKEN_ENC_KEY not set')
    return new Response('Server misconfigured', { status: 500 })
  }

  const authorizeUrl = buildSquareAuthorizeUrl({
    env: resolveSquareEnv(process.env.SQUARE_ENV),
    applicationId,
    state: signOAuthState(venueId, stateSecret),
    redirectUrl: process.env.SQUARE_OAUTH_REDIRECT_URL,
  })
  return Response.redirect(authorizeUrl, 302)
}
