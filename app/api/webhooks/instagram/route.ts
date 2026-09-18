// Server-only route. Meta calls this endpoint twice over an integration's life
// in two different ways: GET once to verify the callback URL when the webhook
// config is saved, then POST for every Instagram event delivery. We never call
// ourselves.
//
// TAC-445 is transport plumbing ONLY: no persistence, no agent invocation, no
// IGSID-to-guest identity, no outbound path. It exists to unblock the Meta
// dashboard save (which rejects a callback URL nothing answers) and to let us
// observe real payload shapes before writing handling logic on assumptions.
//
// THREE deliberate divergences from the Sendblue and Square webhook routes,
// each of which would otherwise read as an inconsistency:
//
// 1. The signature is computed and logged but NOT enforced. A mismatch still
//    returns 200. Enforcement lands with the real handler once we've confirmed
//    the digest matches on live traffic. The consequence to keep in mind while
//    this ships: the endpoint is effectively unauthenticated, so anything it
//    logs is something a stranger can write.
//
// 2. POST returns 200 on EVERY path, including a parse failure and including
//    an unhandled throw. Sendblue and Square reserve 5xx for unhandled throws
//    so the provider retries transient infra failures; that trade doesn't
//    apply here, because a stub that persists nothing has no transient
//    failure worth retrying, while Meta disables the subscription after
//    repeated non-2xx. Retrying buys nothing and costs the integration.
//
// 3. Nothing in the GET handler logs `request.url`. The other two routes log
//    it freely because their secrets travel in headers; here `hub.verify_token`
//    is in the QUERY STRING, so logging the URL would write META_VERIFY_TOKEN
//    into Vercel logs on every successful handshake. Do not add it back for
//    parity.

// Imported by path, not through a barrel: lib/pos/square/ sets the
// no-sub-barrel precedent, and a barrel is the thing that lets a future
// vi.mock hand these tests a stubbed verifier when they need the real one.
import { summarizeInstagramPayload } from '@/lib/messaging/instagram/summarize-payload'
import {
  checkInstagramSignature,
  verifyMetaChallengeToken,
} from '@/lib/messaging/instagram/verify-webhook'

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
 * Instagram event delivery. Logs and acknowledges; handles nothing.
 *
 * Always 200. See divergence 2 in the file header for why, including on a
 * parse failure and an unhandled throw.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    // Text, not .json(): the HMAC is over the exact bytes received, and
    // re-serialized JSON will not match.
    const rawBody = await request.text()

    // Signature scaffold. Computed and logged, never enforced (divergence 1).
    // The digest is not a secret — that is what an HMAC is for — but the app
    // secret that keys it never appears here.
    const appSecret = process.env.INSTAGRAM_APP_SECRET
    if (!appSecret) {
      console.error('instagram webhook: INSTAGRAM_APP_SECRET not set; signature not computed', {
        event: 'instagram_signature_unavailable',
      })
    } else {
      const signature = checkInstagramSignature(rawBody, request.headers, appSecret)
      console.log('instagram webhook: signature check', {
        event: 'instagram_signature_check',
        matched: signature.matched,
        computed: signature.computed,
        received: signature.received,
        enforced: false,
      })
    }

    // Flag-gated raw-body capture, mirroring SENDBLUE_LOG_RAW_INBOUND.
    // LEAKS PII (guest DM content, IGSIDs); default OFF. Only set it during a
    // deliberate, time-bounded capture window and unset it immediately after.
    // See .env.local.example for the discipline note.
    //
    // The RAW STRING, deliberately, not a re-serialized parse: it is the only
    // form that captures unknown keys with full fidelity, which is the whole
    // reason this stub exists. It also fires BEFORE the parse, so a malformed
    // payload is captured too — those are the interesting ones.
    if (process.env.INSTAGRAM_LOG_RAW_INBOUND === 'true') {
      console.log('instagram webhook: raw inbound (PII)', {
        event: 'instagram_raw_inbound',
        raw: rawBody,
      })
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      // V8's SyntaxError message ECHOES the first bytes of the body when the
      // opening token is unexpected ("Unexpected token 'o', \"oat milk a\"..."),
      // so logging it would break the no-guest-content guarantee on exactly
      // the path that claims to hold it. The body is still recoverable when
      // it matters: turn INSTAGRAM_LOG_RAW_INBOUND on, which captures
      // malformed payloads too, by design.
      console.warn('instagram webhook: invalid JSON; acknowledging anyway', {
        event: 'instagram_invalid_json',
        bodyLength: rawBody.length,
      })
      return new Response('OK', { status: 200 })
    }

    // Shape only. summarize-payload.ts is what holds "no guest content in
    // logs" when the raw-capture flag is off, which is the steady state.
    console.log('instagram webhook: event received', {
      event: 'instagram_event',
      ...summarizeInstagramPayload(parsed),
    })

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
