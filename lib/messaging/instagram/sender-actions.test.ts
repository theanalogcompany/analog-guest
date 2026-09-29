// TAC-540: the sender-action transport, against a fetch the test controls.
//
// Shapes follow Meta's documented request and error bodies; none has been
// captured from a real sender action yet, which is what the device QA on the
// ticket is for. What these tests CAN settle is the request we build and the
// values we let out — the two things a live call would not tell us anyway.

import { describe, expect, it, vi } from 'vitest'

import { INSTAGRAM_GRAPH_BASE_URL, type FetchLike } from './graph'
import { INSTAGRAM_SEND_TIMEOUT_MS } from './send'
import {
  INSTAGRAM_SENDER_ACTIONS,
  INSTAGRAM_SENDER_ACTION_TIMEOUT_MS,
  sendInstagramSenderAction,
  type InstagramSenderAction,
} from './sender-actions'

const TOKEN = 'IGAAtesttoken-value'
const ACCOUNT_ID = '17841400000000001'
const IGSID = '1000000000000001'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fetchReturning(response: Response) {
  return vi.fn<FetchLike>(async () => response)
}

function send(action: InstagramSenderAction, fetchImpl: FetchLike) {
  return sendInstagramSenderAction({
    accountId: ACCOUNT_ID,
    recipientId: IGSID,
    action,
    token: TOKEN,
    fetchImpl,
  })
}

describe('the request we build', () => {
  /**
   * Meta's Limitations section: "Requests to display sender actions ... should
   * only include the sender_action parameter and the recipient object. All
   * other Send API properties, such as text and templates, should be sent in a
   * separate request."
   *
   * `toEqual` on the whole parsed body, never `toMatchObject`: a partial match
   * passes while a `message` key rides along, which is the exact thing the
   * documented limitation forbids.
   */
  it.each(INSTAGRAM_SENDER_ACTIONS)(
    'sends %s with recipient and sender_action and NOTHING else',
    async (action) => {
      const fetchImpl = fetchReturning(jsonResponse({ recipient_id: IGSID }))
      const result = await send(action, fetchImpl)

      expect(result).toEqual({ ok: true })
      const [, init] = fetchImpl.mock.calls[0]!
      expect(JSON.parse(init.body as string)).toEqual({
        recipient: { id: IGSID },
        sender_action: action,
      })
    },
  )

  it('posts to the venue account on graph.instagram.com, the same path a text send uses', async () => {
    const fetchImpl = fetchReturning(jsonResponse({ recipient_id: IGSID }))
    await send('mark_seen', fetchImpl)

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(`${INSTAGRAM_GRAPH_BASE_URL}/${ACCOUNT_ID}/messages`)
    expect(url.startsWith('https://graph.instagram.com/')).toBe(true)
    expect(init.method).toBe('POST')
  })

  /**
   * graph.ts's rule. A URL ends up in error messages and request logs; a
   * header does not. Asserted on the URL rather than on the header alone,
   * because the failure being guarded is the token MOVING, not the header
   * going missing.
   */
  it('puts the token in the Authorization header and never in the URL', async () => {
    const fetchImpl = fetchReturning(jsonResponse({ recipient_id: IGSID }))
    await send('typing_on', fetchImpl)

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).not.toContain(TOKEN)
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${TOKEN}`,
    )
  })

  /**
   * Shorter than the send's 10s. A send waits longer because its outcome is
   * ambiguous and Meta may have delivered it; nothing reads this result, so
   * waiting longer buys nothing and costs a slow turn.
   *
   * The constant's VALUE, and that it is actually PASSED. Asserting only
   * `signal instanceof AbortSignal` would hold with the `timeoutMs` option
   * deleted, because graphRequest falls back to its own default — which is
   * also 5s today, so the two are indistinguishable by behaviour. Pinning
   * the argument is what makes the wiring survive the graph default moving.
   */
  it('passes its own timeout to graphRequest, shorter than a send', async () => {
    expect(INSTAGRAM_SENDER_ACTION_TIMEOUT_MS).toBe(5_000)
    expect(INSTAGRAM_SENDER_ACTION_TIMEOUT_MS).toBeLessThan(
      INSTAGRAM_SEND_TIMEOUT_MS,
    )
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    try {
      const fetchImpl = fetchReturning(jsonResponse({ recipient_id: IGSID }))
      await send('mark_seen', fetchImpl)
      expect(timeoutSpy).toHaveBeenCalledWith(
        INSTAGRAM_SENDER_ACTION_TIMEOUT_MS,
      )
      expect(fetchImpl.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal)
    } finally {
      timeoutSpy.mockRestore()
    }
  })
})

describe('failures are values, never throws', () => {
  it('classifies a rejected token, so a log line can name the cause', async () => {
    const fetchImpl = fetchReturning(
      jsonResponse({ error: { code: 190, message: 'expired' } }, 401),
    )
    const result = await send('typing_on', fetchImpl)
    expect(result).toEqual({
      ok: false,
      kind: 'token_rejected',
      failure: {
        reason: 'graph_error',
        httpStatus: 401,
        code: 190,
        subcode: null,
        type: null,
        fbtraceId: null,
      },
    })
  })

  it('classifies a closed window', async () => {
    const fetchImpl = fetchReturning(
      jsonResponse(
        {
          error: {
            code: 10,
            error_subcode: 2534022,
            message: 'outside window',
          },
        },
        400,
      ),
    )
    const result = await send('typing_on', fetchImpl)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.kind).toBe('window_closed')
  })

  it('returns a value when the network fails', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new Error('socket hang up')
    })
    const result = await send('typing_off', fetchImpl)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.kind).toBe('network')
  })

  it('returns a value when the request times out', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => {
      const e = new Error('timed out')
      e.name = 'TimeoutError'
      throw e
    })
    const result = await send('typing_on', fetchImpl)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.kind).toBe('timeout')
  })

  /**
   * graph.ts drops Meta's error MESSAGE because it quotes the object it failed
   * on — here a guest's scoped ID. Asserted on the whole returned value rather
   * than on the absence of one string: a `toEqual` fails if the message
   * reappears under any key at all.
   */
  it("never carries Meta's error message out, because it quotes the scoped ID", async () => {
    const fetchImpl = fetchReturning(
      jsonResponse(
        {
          error: {
            code: 100,
            message: `Object with ID '${IGSID}' does not exist`,
            fbtrace_id: 'Ax1',
          },
        },
        400,
      ),
    )
    const result = await send('mark_seen', fetchImpl)

    expect(result).toEqual({
      ok: false,
      kind: 'graph_error',
      failure: {
        reason: 'graph_error',
        httpStatus: 400,
        code: 100,
        subcode: null,
        type: null,
        fbtraceId: 'Ax1',
      },
    })
    expect(JSON.stringify(result)).not.toContain(IGSID)
  })

  /**
   * The deliberate divergence from sendInstagramText, which treats a 200
   * without a `message_id` as a failure. A send needs the mid to save a row
   * and reconcile the echo; an action has nothing to match to anything, so
   * reading the body further would invent a failure mode.
   */
  it('treats a 200 with an empty body as sent, unlike a text send', async () => {
    const fetchImpl = fetchReturning(jsonResponse({}))
    expect(await send('mark_seen', fetchImpl)).toEqual({ ok: true })
  })
})
