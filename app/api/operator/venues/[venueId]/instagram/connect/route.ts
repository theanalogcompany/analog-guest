// POST /api/operator/venues/[venueId]/instagram/connect — TAC-516, sibling
// TAC-517.
//
// Returns the URL the operator app opens so a venue can grant access to its
// own Instagram account. Nothing is connected here: this mints a single-use
// state and hands back a URL. The callback does the work.
//
// CONTRACT-BOUND, so auth is verified INLINE rather than through
// withOperatorAuth: the HOF forwards AuthError.message verbatim, and the
// Contract specifies fixed strings ({"error":"unauthorized"}). Same shape and
// same reason as the TAC-277 thread route and TAC-473's resolve-external.
//
// THE ALLOWLIST CHECK USES bearerAllowsVenue, NOT `ids.length > 0`. This is a
// BEARER route, where an empty venue scope means "allowlisted for nothing".
// The `length > 0` idiom belongs to the analog-admin COOKIE path, where empty
// deliberately means every venue; pasted onto bearer data it skips the filter
// and grants the fleet. That is TAC-530, which landed the day this ticket was
// planned, and this endpoint is exactly the shape it was filed about: a venue
// id in the path and an operator token in the header.
//
// 404, never 403, for a venue outside the allowlist — the existence-leak
// convention every other /api/operator/* route follows.

import { randomUUID } from 'node:crypto'

import { NextResponse } from 'next/server'

import { AuthError, verifyOperatorRequest } from '@/lib/auth'
import { bearerAllowsVenue, venueScopeDeniesAll } from '@/lib/auth/venue-scope'
import { createAdminClient } from '@/lib/db/admin'
import { INSTAGRAM_OAUTH_SCOPES } from '@/lib/messaging/instagram/oauth-exchange'
import {
  INSTAGRAM_OAUTH_STATE_TTL_MS,
  issueInstagramOAuthState,
} from '@/lib/messaging/instagram/oauth-state-store'
import {
  deriveInstagramStateSigningKey,
  signInstagramOAuthState,
} from '@/lib/messaging/instagram/oauth-state'

/** Canonical UUID regex, as the sibling operator routes. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Meta's approval screen. The Contract names this host literally. */
const INSTAGRAM_AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  ctx: { params: Promise<{ venueId: string }> },
): Promise<Response> {
  // ---- auth (inline, Contract-shaped body) ----
  let operator
  try {
    operator = await verifyOperatorRequest(request)
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    throw err
  }

  const { venueId } = await ctx.params
  // A non-UUID venue does not exist by definition. 404 keeps the wire surface
  // flat and never leaks which ids are real.
  if (!UUID_RE.test(venueId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // An operator with zero grants may act on nothing. Denied BEFORE any query,
  // so nothing is issued on behalf of a principal allowlisted for nothing.
  if (venueScopeDeniesAll(operator.venueScope)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (!bearerAllowsVenue(operator.venueScope, venueId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  // ---- configuration ----
  // Read at call time, never at module load: CI defines none of the Meta vars
  // (CLAUDE.md, "Module-load vs first-call").
  const appId = process.env.INSTAGRAM_APP_ID
  const redirectUri = process.env.INSTAGRAM_OAUTH_REDIRECT_URL
  const encryptionKey = process.env.INSTAGRAM_TOKEN_ENC_KEY
  if (!appId || !redirectUri || !encryptionKey) {
    // Names which variable, never any value.
    console.error('[operator] instagram connect is not configured', {
      event: 'instagram_connect_misconfigured',
      hasAppId: Boolean(appId),
      hasRedirectUri: Boolean(redirectUri),
      hasEncryptionKey: Boolean(encryptionKey),
    })
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }

  // ---- mint the state ----
  const now = new Date()
  const expiresAt = new Date(now.getTime() + INSTAGRAM_OAUTH_STATE_TTL_MS)
  const nonce = randomUUID()

  const supabase = createAdminClient()
  const issued = await issueInstagramOAuthState(supabase, {
    nonce,
    venueId,
    operatorId: operator.operatorId,
    expiresAt,
  })
  if (!issued.ok) {
    console.error('[operator] could not issue an instagram oauth state', {
      event: 'instagram_connect_state_not_issued',
      venueId,
      error: issued.error,
    })
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }

  const state = signInstagramOAuthState(
    { venueId, operatorId: operator.operatorId, nonce, expiresAtMs: expiresAt.getTime() },
    deriveInstagramStateSigningKey(encryptionKey),
  )

  const query = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: INSTAGRAM_OAUTH_SCOPES.join(','),
    state,
  })

  return NextResponse.json({
    authorizationUrl: `${INSTAGRAM_AUTHORIZE_URL}?${query.toString()}`,
    expiresAt: expiresAt.toISOString(),
  })
}
