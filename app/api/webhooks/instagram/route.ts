// Server-only route. Meta calls this endpoint twice over an integration's life
// in two different ways: GET once to verify the callback URL when the webhook
// config is saved, then POST for every Instagram event delivery. We never call
// ourselves.
//
// POST verifies the delivery, logs its shape, and saves what it can (TAC-468):
// guest messages and icebreaker postbacks as inbound rows, the venue account's
// echoes as outbound rows, and read receipts matched to their row and logged.
// The rules for each are in lib/messaging/instagram/handle-events.ts. It has
// the Sendblue route's shape: save, answer 200, and hand a new guest message to
// the agent in the background. For Instagram that hand-off is switched off
// until outbound exists; see lib/messaging/instagram/agent-gate.ts.
//
// Also after the 200, and never before it (TAC-479): each guest with a saved
// message or icebreaker tap gets their Instagram handle and display name
// refreshed if it is due, via waitUntil beside the agent hand-off. It is a
// Graph API call plus database reads and writes, so it must never sit on
// Meta's delivery deadline (TAC-478). See
// lib/messaging/instagram/refresh-profile.ts.
//
// THREE deliberate divergences from the Sendblue and Square webhook routes,
// each of which would otherwise read as an inconsistency:
//
// 1. A delivery that fails signature verification gets 403, where Sendblue
//    and Square answer 401. The ticket (TAC-458) specified 403, it matches this
//    route's GET refusal, and Meta treats any non-2xx the same way. The refusal
//    is decided before anything from the body is logged, and it logs a reason,
//    never a digest: see lib/messaging/instagram/verify-webhook.ts for why no
//    digest may reach a log line.
//
// 2. Once a delivery has verified, POST returns 200 on EVERY path, including a
//    parse failure, a failed save and an unhandled throw. So does a throw while
//    reading the body, before verification, which logs nothing from the body.
//    Sendblue and Square reserve 5xx for unhandled throws so the provider
//    retries. Since TAC-468 this route saves, so a failed save does lose that
//    event. That is accepted (ruled 2026-09-18): Meta disables a subscription
//    after repeated non-2xx, and a failure that is not transient would keep
//    failing until the channel was switched off, with nothing here to alert
//    anyone. Sendblue loses messages the same way in practice: supabase-js
//    returns a network failure as `{ error }` rather than throwing, so its
//    route answers 200 on a failed insert too. A signature refusal is the one
//    non-2xx this route sends, and it is meant for forgeries: if GENUINE
//    deliveries start getting it, Meta will eventually disable the
//    subscription, so treat that as a revert signal, not something to debug
//    in place.
//
// 3. Nothing in the GET handler logs `request.url`. The other two routes log
//    it freely because their secrets travel in headers; here `hub.verify_token`
//    is in the QUERY STRING, so logging the URL would write META_VERIFY_TOKEN
//    into Vercel logs on every successful handshake. Do not add it back for
//    parity.

import { waitUntil } from '@vercel/functions'
// Aliased as in the Sendblue route: the agent's handleInbound is the
// orchestrator a saved guest message is handed to.
import { handleInbound as runInboundAgent } from '@/lib/agent'
import { createAdminClient } from '@/lib/db/admin'
// Imported by path, not through a barrel: lib/pos/square/ sets the
// no-sub-barrel precedent, and a barrel is the thing that lets a future
// vi.mock hand these tests a stubbed verifier when they need the real one.
import { captureInstagramScanUnattributed } from '@/lib/analytics/posthog'
import { agentMessageIdFor } from '@/lib/messaging/instagram/agent-gate'
import {
  logInstagramOutcome,
  processInstagramDelivery,
  scanUnattributedReason,
} from '@/lib/messaging/instagram/handle-events'
import {
  profileRefreshTargetFor,
  refreshInstagramProfile,
} from '@/lib/messaging/instagram/refresh-profile'
import { summarizeInstagramPayload } from '@/lib/messaging/instagram/summarize-payload'
import {
  verifyInstagramSignature,
  verifyMetaChallengeToken,
} from '@/lib/messaging/instagram/verify-webhook'

// The user-agent is logged on a refusal as a hint to whether it was a rejected
// Meta delivery (the revert signal in divergence 2) or a stranger's probe. A
// hint, not proof: Meta's user-agent is public and any caller can send it. It
// is caller-controlled, so it is capped like everything else this route logs
// from a request it has not yet trusted.
const MAX_USER_AGENT_LOGGED = 128

// The verification handshake MUST see each request. A cached GET would replay
// a stale challenge and Meta would reject the callback URL — the exact failure
// this route exists to prevent. Reading `request` already opts out under the
// current Next.js rules; this states it so a refactor can't quietly restore
// caching.
export const dynamic = 'force-dynamic'

/**
 * Meta's callback-URL verification handshake.
 *
 * Returns the raw `hub.challenge` as plain text with status 200 when the
 * handshake is good, and 403 with an empty body otherwise. The body must be
 * the challenge and nothing else — no JSON wrapper, no quotes, no trailing
 * newline — or Meta refuses to save the configuration.
 */
export async function GET(request: Request): Promise<Response> {
  // searchParams form-decodes, so a literal '+' in the challenge would arrive
  // as a space. Deliberate: every reference implementation decodes the same
  // way (Express `req.query` included), so matching them is safer than being
  // uniquely byte-exact. Meta's challenge is numeric in practice. Left
  // untested on purpose — a test here would pin behaviour we do not want to
  // promise if Meta ever changes the alphabet.
  const params = new URL(request.url).searchParams
  const mode = params.get('hub.mode')
  const token = params.get('hub.verify_token')
  const challenge = params.get('hub.challenge')

  const expected = process.env.META_VERIFY_TOKEN
  if (!expected) {
    // Misconfiguration, answered 403 rather than Square's 500-on-missing-env.
    // Square's missing var is a COMPUTE input, where failing loud is right.
    // This one is a COMPARISON gate, where failing closed is right. Meta
    // cannot tell the two apart anyway; the difference lives only in this log.
    console.error('instagram webhook: META_VERIFY_TOKEN not set; refusing verification', {
      event: 'instagram_verify_misconfigured',
    })
    return new Response(null, { status: 403 })
  }

  const tokenMatches = verifyMetaChallengeToken(token, expected)
  const hasChallenge = challenge !== null && challenge.length > 0

  if (mode !== 'subscribe' || !tokenMatches || !hasChallenge) {
    // Booleans only, never the values. `token` is the caller's guess at our
    // secret and `mode` is free text a stranger controls; neither belongs in
    // a log line.
    console.warn('instagram webhook: verification refused', {
      event: 'instagram_verify_refused',
      modeIsSubscribe: mode === 'subscribe',
      tokenMatches,
      hasChallenge,
    })
    return new Response(null, { status: 403 })
  }

  console.log('instagram webhook: verification succeeded', {
    event: 'instagram_verify_succeeded',
  })
  return new Response(challenge, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

/**
 * Instagram event delivery. Verifies, logs its shape, saves each event, and
 * acknowledges.
 *
 * 403 with an empty body when the signature does not verify, including when
 * INSTAGRAM_APP_SECRET is unset or empty. 200 on every other path: see divergence 2 in
 * the file header for why, including on a parse failure, a failed save and an
 * unhandled throw.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    // Misconfiguration is refused before the body is read, and logged at
    // error level under its own event, because it is the one refusal that
    // means GENUINE deliveries are failing: every one of them is refused
    // until the secret is set. The verifier refuses an empty secret too;
    // this check is here to say so loudly, not only to say no.
    const appSecret = process.env.INSTAGRAM_APP_SECRET
    if (!appSecret) {
      console.error('instagram webhook: INSTAGRAM_APP_SECRET not set; refusing every delivery', {
        event: 'instagram_signature_misconfigured',
      })
      return new Response(null, { status: 403 })
    }

    // Text, not .json(): the HMAC is over the exact bytes received, and
    // re-serialized JSON will not match.
    const rawBody = await request.text()

    // Nothing derived from the body is logged above this line, and a refusal
    // logs a reason, never a digest. The user-agent is the one request value
    // here, capped: a hint to whether a refusal was Meta's, since a probe can
    // send Meta's user-agent too.
    const signature = verifyInstagramSignature(rawBody, request.headers, appSecret)
    if (!signature.ok) {
      console.warn('instagram webhook: signature rejected', {
        event: 'instagram_signature_rejected',
        reason: signature.reason,
        userAgent: request.headers.get('user-agent')?.slice(0, MAX_USER_AGENT_LOGGED) ?? null,
      })
      return new Response(null, { status: 403 })
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      // V8's SyntaxError message ECHOES the first bytes of the body when the
      // opening token is unexpected ("Unexpected token 'o', \"oat milk a\"..."),
      // so logging it would break the no-guest-content guarantee on exactly
      // the path that claims to hold it. The body is not recoverable from the
      // logs: TAC-458 removed the raw-body capture, deliberately.
      console.warn('instagram webhook: invalid JSON; acknowledging anyway', {
        event: 'instagram_invalid_json',
        bodyLength: rawBody.length,
      })
      return new Response('OK', { status: 200 })
    }

    // Shape only. summarize-payload.ts and logInstagramOutcome are what hold
    // "no guest content in logs": they are the only things this route logs
    // about a payload.
    console.log('instagram webhook: event received', {
      event: 'instagram_event',
      ...summarizeInstagramPayload(parsed),
    })

    const supabase = createAdminClient()
    const outcomes = await processInstagramDelivery(parsed, supabase)
    // One profile refresh per guest per delivery, however many of their
    // messages it carries.
    const refreshing = new Set<string>()
    for (const outcome of outcomes) {
      logInstagramOutcome(outcome)
      // Always null while agent-gate.ts holds the gate shut (until TAC-469).
      const agentMessageId = agentMessageIdFor(outcome)
      if (agentMessageId !== null) waitUntil(runInboundAgent(agentMessageId))
      // Not behind the agent gate: storing who the guest is doesn't reply to
      // them. Handed to waitUntil, never awaited: awaiting it would put a Graph
      // call inside Meta's delivery deadline.
      const refreshTarget = profileRefreshTargetFor(outcome)
      if (refreshTarget !== null && !refreshing.has(refreshTarget.guestId)) {
        refreshing.add(refreshTarget.guestId)
        waitUntil(refreshInstagramProfile(supabase, refreshTarget))
      }
      // TAC-518: an inbound that looks like a scan and carries nothing to prove
      // it. Slack-relayed, because the referral is the only thing that tells us
      // a returning guest is at the counter, and before this its absence was
      // invisible. waitUntil, never awaited: analytics must not sit inside
      // Meta's delivery deadline.
      const unattributed = scanUnattributedReason(outcome)
      if (unattributed !== null && outcome.status === 'persisted') {
        waitUntil(
          captureInstagramScanUnattributed({
            venueId: outcome.venueId,
            guestId: outcome.guestId,
            messageId: outcome.messageId,
            reason: unattributed,
            referralSource: outcome.referralSource,
            guestCreated: outcome.guestCreated,
          }),
        )
      }
    }

    return new Response('OK', { status: 200 })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const stack = e instanceof Error ? e.stack : undefined
    console.error('instagram webhook: unexpected error; acknowledging anyway', {
      event: 'instagram_unexpected_error',
      error: message,
      stack,
    })
    return new Response('OK', { status: 200 })
  }
}
