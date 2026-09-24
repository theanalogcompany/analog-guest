// GET /api/instagram/callback — TAC-516. The redirect URL registered with
// Meta, and the thing Meta's business-login setup step 4 will not save
// without.
//
// PUBLIC, because Meta redirects a browser here. It is not unauthenticated in
// the sense that matters: the signed, single-use `state` is the authentication,
// and it ties the callback to the venue and operator that started the flow.
//
// RENDERS HTML AT EVERY BRANCH, never JSON. A person is looking at this in a
// browser, and the Contract says so. It never shows a token, an account id,
// Meta's error message, or the state — the failure page takes a fixed reason
// from a closed union, which is what makes that guarantee structural rather
// than a habit.
//
// WHY THE ORDER OF WRITES IS WHAT IT IS. There is no transaction across
// PostgREST, so the credential and `venues.instagram_account_id` cannot move
// together. The conflict check runs FIRST and writes nothing on a refusal
// (ruled 2026-09-23, question 1: refuse, leave the original venue connected).
// Then the credential, then the venue pointer:
//
//   - If the credential write fails, nothing has moved. Clean.
//   - If the VENUE write fails on a FIRST connect, the venue still has no
//     account id, so loadInstagramSendTarget refuses with
//     `venue_has_no_instagram_account` and no message is sent with a
//     mismatched pair. Also clean.
//   - If the venue write fails on a RECONNECT TO A DIFFERENT ACCOUNT, the
//     venue keeps pointing at the old account while holding the new token,
//     and Meta rejects with code 190. That window is real and is not
//     engineered away; it is loud rather than silent, and a second attempt
//     fixes it. Stated here so it is a known cost rather than a surprise.
//
// The webhook subscription is deliberately NOT fatal — see below.

import { randomUUID } from 'node:crypto'

import { captureInstagramConnectSubscribeFailed } from '@/lib/analytics/posthog'
import { createAdminClient } from '@/lib/db/admin'
import { upsertInstagramCredential } from '@/lib/messaging/instagram/credentials-store'
import {
  exchangeForLongLivedToken,
  exchangeInstagramCode,
  fetchConnectedAccount,
  subscribeInstagramWebhooks,
} from '@/lib/messaging/instagram/oauth-exchange'
import { claimInstagramOAuthState } from '@/lib/messaging/instagram/oauth-state-store'
import {
  deriveInstagramStateSigningKey,
  verifyInstagramOAuthState,
} from '@/lib/messaging/instagram/oauth-state'

import {
  INSTAGRAM_CALLBACK_FAILURE_STATUS,
  instagramCallbackFailurePage,
  instagramCallbackSuccessPage,
  type InstagramCallbackFailure,
} from './page-html'

export const dynamic = 'force-dynamic'

/** Migration 048's global unique constraint on venues.instagram_account_id. */
const VENUE_ACCOUNT_UNIQUE_CONSTRAINT = 'venues_instagram_account_id_key'

function html(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function fail(reason: InstagramCallbackFailure): Response {
  return html(instagramCallbackFailurePage(reason), INSTAGRAM_CALLBACK_FAILURE_STATUS[reason])
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')

  // Meta sends `error=access_denied` when the operator declines. That is not
  // a fault, and it renders the same plain page as a missing parameter.
  if (!code || !state) return fail('missing_parameters')

  const appId = process.env.INSTAGRAM_APP_ID
  const appSecret = process.env.INSTAGRAM_APP_SECRET
  const redirectUri = process.env.INSTAGRAM_OAUTH_REDIRECT_URL
  const encryptionKey = process.env.INSTAGRAM_TOKEN_ENC_KEY
  if (!appId || !appSecret || !redirectUri || !encryptionKey) {
    console.error('[instagram callback] not configured', {
      event: 'instagram_callback_misconfigured',
      hasAppId: Boolean(appId),
      hasAppSecret: Boolean(appSecret),
      hasRedirectUri: Boolean(redirectUri),
      hasEncryptionKey: Boolean(encryptionKey),
    })
    return fail('not_configured')
  }

  const now = new Date()

  // 1. The signature. Cheap, no database read, and it refuses a tampered or
  //    malformed state before anything else happens.
  const verified = verifyInstagramOAuthState(state, deriveInstagramStateSigningKey(encryptionKey), now)
  if (!verified.ok) {
    console.warn('[instagram callback] state refused', {
      event: 'instagram_callback_state_refused',
      // The CATEGORY only. Never the state value itself.
      reason: verified.reason,
    })
    return fail(verified.reason === 'expired' ? 'state_expired' : 'state_invalid')
  }

  const supabase = createAdminClient()

  // 2. The claim. THIS is what refuses a replay: the signature above verifies
  //    a second presentation just as happily, because nothing about a signed
  //    value changes between presentations.
  const claim = await claimInstagramOAuthState(supabase, verified.payload.nonce, now)
  if (!claim.ok) {
    if (claim.reason === 'error') {
      console.error('[instagram callback] could not claim the state', {
        event: 'instagram_callback_claim_failed',
        error: claim.error,
      })
      return fail('storage_failed')
    }
    return fail('state_already_used')
  }

  // 3. Belt and braces. The signed payload and the stored row are written in
  //    the same moment from the same values, so a disagreement means
  //    something is wrong in a way worth refusing over rather than resolving.
  if (claim.venueId !== verified.payload.venueId || claim.operatorId !== verified.payload.operatorId) {
    console.error('[instagram callback] signed state disagrees with the issued row', {
      event: 'instagram_callback_state_mismatch',
      venueId: claim.venueId,
    })
    return fail('state_invalid')
  }
  const venueId = claim.venueId

  // 4. Code -> short-lived -> long-lived.
  const short = await exchangeInstagramCode({ code, redirectUri, appId, appSecret }, fetch)
  if (!short.ok) {
    console.error('[instagram callback] code exchange failed', {
      event: 'instagram_callback_exchange_failed',
      step: 'code',
      venueId,
      failure: short.failure,
    })
    return fail('exchange_failed')
  }

  const long = await exchangeForLongLivedToken(
    { shortLivedToken: short.value.token, appSecret, now },
    fetch,
  )
  if (!long.ok) {
    console.error('[instagram callback] long-lived exchange failed', {
      event: 'instagram_callback_exchange_failed',
      step: 'long_lived',
      venueId,
      failure: long.failure,
    })
    return fail('exchange_failed')
  }

  // 5. Who the token belongs to. `user_id`, not the app-scoped `id`.
  const account = await fetchConnectedAccount(long.value.token, fetch)
  if (!account.ok) {
    console.error('[instagram callback] could not read the connected account', {
      event: 'instagram_callback_exchange_failed',
      step: 'account',
      venueId,
      failure: account.failure,
    })
    return fail('exchange_failed')
  }
  const accountId = account.value.userId

  // 6. THE CROSS-VENUE REFUSAL (ruled 2026-09-23, question 1). An account
  //    already connected to a DIFFERENT venue is refused, and that venue is
  //    left exactly as it was. Nothing has been written at this point, which
  //    is what makes "leave the original connected" true rather than a
  //    best-effort undo. The same venue reconnecting proceeds.
  const existing = await supabase
    .from('venues')
    .select('id')
    .eq('instagram_account_id', accountId)
    .maybeSingle()
  if (existing.error) {
    console.error('[instagram callback] could not check for an existing connection', {
      event: 'instagram_callback_conflict_check_failed',
      venueId,
      error: existing.error.message,
    })
    return fail('storage_failed')
  }
  if (existing.data && existing.data.id !== venueId) {
    console.warn('[instagram callback] refused: account already connected to another venue', {
      event: 'instagram_callback_account_taken',
      venueId,
      heldByVenueId: existing.data.id,
    })
    return fail('account_already_connected')
  }

  // 7. Store the credential, then point the venue at the account. See the
  //    ordering note in this file's header.
  const stored = await upsertInstagramCredential(supabase, {
    venueId,
    accessToken: long.value.token,
    tokenExpiresAt: long.value.expiresAt,
    instagramUsername: account.value.username,
    connectedByOperatorId: claim.operatorId,
    now,
  })
  if (!stored.ok) {
    console.error('[instagram callback] could not store the credential', {
      event: 'instagram_callback_storage_failed',
      venueId,
      error: stored.error,
    })
    return fail('storage_failed')
  }

  const pointed = await supabase
    .from('venues')
    .update({ instagram_account_id: accountId })
    .eq('id', venueId)
  if (pointed.error) {
    // A 23505 here is the conflict check losing a race: another venue took
    // this account between the check and the write. Same refusal, because the
    // outcome for the operator is the same and the constraint is the
    // authority. Other failures are storage failures.
    const isConflict =
      pointed.error.code === '23505' || pointed.error.message.includes(VENUE_ACCOUNT_UNIQUE_CONSTRAINT)

    // COMPENSATE, so both failure pages tell the truth. Both say "Nothing was
    // changed", and until code review that was FALSE here: the credential at
    // step 7 is already written. Leaving it produced a venue holding a
    // credential its pointer does not match — which the operator endpoint
    // reported as `connected` while every send refused with
    // `venue_has_no_instagram_account` and every inbound was skipped as
    // `venue_not_found`. Told nothing changed and shown connected, an
    // operator has no reason to retry.
    //
    // Deleting rather than deactivating: this credential was never usable, so
    // there is nothing to keep a record of, and a reconnect writes a fresh
    // row anyway.
    const undo = await supabase.from('instagram_credentials').delete().eq('venue_id', venueId)
    console.error('[instagram callback] could not point the venue at the account', {
      event: isConflict ? 'instagram_callback_account_taken' : 'instagram_callback_storage_failed',
      venueId,
      error: pointed.error.message,
      // If the compensation ALSO failed the venue is in the state described
      // above, and that is worth seeing rather than inferring.
      credentialRolledBack: !undo.error,
    })
    return fail(isConflict ? 'account_already_connected' : 'storage_failed')
  }

  // 8. Subscribe the account to our webhooks. NOT FATAL, deliberately: the
  //    credential and the pointer are already stored, so the connection is
  //    real and recoverable by reconnecting. But an unsubscribed account
  //    looks connected and never delivers a message, which is the one place
  //    in this flow where "Meta returned 200" and "it works" come apart, so
  //    it gets its own alert rather than sharing the connect failure event.
  const subscribed = await subscribeInstagramWebhooks(
    { accountId, token: long.value.token },
    fetch,
  )
  if (!subscribed.ok) {
    await captureInstagramConnectSubscribeFailed({
      venueId,
      failureReason: subscribed.failure.reason,
      graphCode: subscribed.failure.reason === 'graph_error' ? subscribed.failure.code : null,
    })
  }

  console.log('[instagram callback] venue connected', {
    event: 'instagram_callback_connected',
    venueId,
    // The handle is shown to operators anyway. The token and the account id
    // are not logged.
    username: account.value.username,
    subscribed: subscribed.ok,
    // A correlation id for this connect, so the success line and the
    // subscribe alert can be tied together without sharing anything secret.
    connectId: randomUUID(),
  })

  return html(instagramCallbackSuccessPage(account.value.username), 200)
}
