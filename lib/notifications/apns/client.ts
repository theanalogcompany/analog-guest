// APNs HTTP/2 client (TAC-207). Wraps node:http2 with a one-shot
// sendApnsRequest call shaped like RAGResult<ApnsResponse>: ok=true on a
// successful response (any status), ok=false on transport-level failure
// (JWT sign error, connection error, timeout). The 200/410/4xx distinction
// is carried on the ok=true side via the status field — the caller decides
// what each status means (200 = success, 410 = null the token, etc.).
//
// New pattern in the codebase — no prior http2 client to reuse. Kept thin
// on purpose: one function, no client object, no connection pool. APNs
// sessions are short-lived per request for pilot scope. If push volume
// climbs enough that the TLS handshake becomes a bottleneck we can pool;
// not before.
//
// Mock seam: tests mock 'node:http2' via vi.mock at module level. The
// jwt module is mocked separately so client tests don't need real keys.

import { connect, constants as http2Constants, type SecureClientSessionOptions } from 'node:http2'

import { getApnsJwt } from './jwt'

const PROD_HOST = 'https://api.push.apple.com'
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com'
const REQUEST_TIMEOUT_MS = 5_000

export interface ApnsRequestPayload {
  /** Hex-encoded device token from the operator's iOS app. */
  deviceToken: string
  /** JSON-serializable APNs payload (aps + custom data fields). */
  body: Record<string, unknown>
}

export interface ApnsResponse {
  status: number
  /** APNs surfaces error details under "reason" in the JSON body. Null on 200. */
  reason: string | null
}

export type ApnsClientResult =
  | { ok: true; response: ApnsResponse }
  | {
      ok: false
      error: 'jwt_failed' | 'connection_failed' | 'request_failed' | 'timeout' | 'env_missing'
      detail: string
    }

function selectHost(): { host: string; ok: true } | { ok: false; detail: string } {
  const env = process.env.APNS_ENV
  if (env === 'production') return { ok: true, host: PROD_HOST }
  if (env === 'sandbox') return { ok: true, host: SANDBOX_HOST }
  return { ok: false, detail: `APNS_ENV must be 'production' or 'sandbox'; got ${env ?? 'unset'}` }
}

/**
 * Sends a single APNs push. Resolves either to a transport-success
 * (status carried on the response) or a transport-failure (error code).
 * Never throws.
 *
 * options.connectOptions is a test seam — production callers omit it.
 */
export async function sendApnsRequest(
  payload: ApnsRequestPayload,
  options: { connectOptions?: SecureClientSessionOptions } = {},
): Promise<ApnsClientResult> {
  const bundleId = process.env.APNS_BUNDLE_ID
  if (!bundleId) {
    return { ok: false, error: 'env_missing', detail: 'APNS_BUNDLE_ID' }
  }

  const hostResult = selectHost()
  if (!hostResult.ok) {
    return { ok: false, error: 'env_missing', detail: hostResult.detail }
  }

  const jwt = await getApnsJwt()
  if (!jwt.ok) {
    return { ok: false, error: 'jwt_failed', detail: `${jwt.error}: ${jwt.detail}` }
  }

  return new Promise<ApnsClientResult>((resolve) => {
    let settled = false
    const settle = (r: ApnsClientResult) => {
      if (settled) return
      settled = true
      // Close session after each request — pilot scope, no pooling yet.
      try {
        session.close()
      } catch {
        // session may already be closed/destroyed; ignore.
      }
      resolve(r)
    }

    const session = connect(hostResult.host, options.connectOptions)

    session.once('error', (e) => {
      settle({
        ok: false,
        error: 'connection_failed',
        detail: e instanceof Error ? e.message : String(e),
      })
    })

    // Defensive: socketError can fire before/after the session 'error'
    // depending on which layer failed first.
    session.once('socketError', (e) => {
      settle({
        ok: false,
        error: 'connection_failed',
        detail: e instanceof Error ? e.message : String(e),
      })
    })

    let stream
    try {
      stream = session.request({
        [http2Constants.HTTP2_HEADER_METHOD]: 'POST',
        [http2Constants.HTTP2_HEADER_PATH]: `/3/device/${payload.deviceToken}`,
        [http2Constants.HTTP2_HEADER_SCHEME]: 'https',
        authorization: `bearer ${jwt.token}`,
        'apns-topic': bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      })
    } catch (e) {
      settle({
        ok: false,
        error: 'request_failed',
        detail: e instanceof Error ? e.message : String(e),
      })
      return
    }

    const timeout = setTimeout(() => {
      stream.close()
      settle({ ok: false, error: 'timeout', detail: `no response in ${REQUEST_TIMEOUT_MS}ms` })
    }, REQUEST_TIMEOUT_MS)

    let status = 0
    const bodyChunks: Buffer[] = []

    stream.once('response', (headers) => {
      const s = headers[http2Constants.HTTP2_HEADER_STATUS]
      status = typeof s === 'number' ? s : Number(s ?? 0)
    })
    stream.on('data', (chunk: Buffer | string) => {
      bodyChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    })
    stream.once('error', (e) => {
      clearTimeout(timeout)
      settle({
        ok: false,
        error: 'request_failed',
        detail: e instanceof Error ? e.message : String(e),
      })
    })
    stream.once('end', () => {
      clearTimeout(timeout)
      let reason: string | null = null
      if (status !== 200 && bodyChunks.length > 0) {
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(bodyChunks).toString('utf8'))
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            'reason' in parsed &&
            typeof (parsed as { reason: unknown }).reason === 'string'
          ) {
            reason = (parsed as { reason: string }).reason
          }
        } catch {
          // non-JSON body; leave reason null.
        }
      }
      settle({ ok: true, response: { status, reason } })
    })

    stream.end(JSON.stringify(payload.body))
  })
}
