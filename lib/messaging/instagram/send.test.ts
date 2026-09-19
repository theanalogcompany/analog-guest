// The Send API transport, against a fetch the test controls. Response and
// error bodies follow Meta's documented shapes; none has been captured from a
// real send yet. The transport smoke test after merge is what confirms them,
// including whether message_id is the same string the echo carries as its mid.

import { describe, expect, it, vi } from 'vitest'

import { INSTAGRAM_GRAPH_BASE_URL, type FetchLike } from './graph'
import {
  INSTAGRAM_MAX_TEXT_BYTES,
  INSTAGRAM_SEND_TIMEOUT_MS,
  classifySendFailure,
  fitsInstagramTextCap,
  instagramTextBytes,
  sendInstagramText,
  sendOutcomeUnknown,
} from './send'

const TOKEN = 'IGAAtesttoken-value'
const ACCOUNT_ID = '17841400000000001'
const IGSID = '1000000000000001'
const MID = 'aWdfZAG1faXRlbToxOklHTWVzc2FnZAUlEOjE3ODQxNDAwMDAwMDAwMDAx'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function fetchReturning(response: Response) {
  return vi.fn<FetchLike>(async () => response)
}

function send(text: string, fetchImpl: FetchLike) {
  return sendInstagramText({ accountId: ACCOUNT_ID, recipientId: IGSID, text, token: TOKEN, fetchImpl })
}

// One four-byte UTF-8 character that JavaScript counts as two code units.
const FOUR_BYTE_EMOJI = '\u{1F600}'

describe('the 1000-byte cap', () => {
  it('counts bytes, not characters', () => {
    const text = FOUR_BYTE_EMOJI.repeat(251)
    expect(text.length).toBe(502)
    expect(instagramTextBytes(text)).toBe(1004)
    expect(fitsInstagramTextCap(text)).toBe(false)
  })

  it('sends 250 four-byte emoji, which is exactly 1000 bytes', async () => {
    const fetchImpl = fetchReturning(jsonResponse({ recipient_id: IGSID, message_id: MID }))
    const result = await send(FOUR_BYTE_EMOJI.repeat(250), fetchImpl)
    expect(result).toEqual({ ok: true, mid: MID })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refuses 251 four-byte emoji before any network call, though .length is only 502', async () => {
    const fetchImpl = fetchReturning(jsonResponse({ message_id: MID }))
    const result = await send(FOUR_BYTE_EMOJI.repeat(251), fetchImpl)
    expect(result).toEqual({ ok: false, kind: 'over_byte_cap', failure: null })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends 1000 ASCII bytes and refuses 1001', async () => {
    const fetchImpl = fetchReturning(jsonResponse({ message_id: MID }))
    expect(INSTAGRAM_MAX_TEXT_BYTES).toBe(1000)
    expect((await send('a'.repeat(1000), fetchImpl)).ok).toBe(true)
    expect(await send('a'.repeat(1001), fetchImpl)).toMatchObject({ ok: false, kind: 'over_byte_cap' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('never truncates: the text Meta receives is the text passed in, whole', async () => {
    const fetchImpl = fetchReturning(jsonResponse({ message_id: MID }))
    const text = `${'b'.repeat(990)} end`
    await send(text, fetchImpl)
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1].body))
    expect(body.message.text).toBe(text)
  })
})

describe('the request', () => {
  it('posts to the venue account, never to `me`, with the token only in the header', async () => {
    const fetchImpl = fetchReturning(jsonResponse({ recipient_id: IGSID, message_id: MID }))
    await send('Open until 3', fetchImpl)

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(`${INSTAGRAM_GRAPH_BASE_URL}/${ACCOUNT_ID}/messages`)
    expect(url).not.toContain(TOKEN)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    })
    expect(JSON.parse(String(init.body))).toEqual({
      recipient: { id: IGSID },
      message: { text: 'Open until 3' },
    })
  })

  it('uses the longer send timeout, because a timed-out send may have gone out', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    await send('hi', fetchReturning(jsonResponse({ message_id: MID })))
    expect(timeout).toHaveBeenCalledWith(INSTAGRAM_SEND_TIMEOUT_MS)
    timeout.mockRestore()
  })

  it('refuses empty or whitespace text before any network call', async () => {
    const fetchImpl = fetchReturning(jsonResponse({ message_id: MID }))
    expect(await send('', fetchImpl)).toEqual({ ok: false, kind: 'empty_text', failure: null })
    expect(await send('   ', fetchImpl)).toEqual({ ok: false, kind: 'empty_text', failure: null })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('the response', () => {
  it('returns the mid from message_id', async () => {
    const result = await send('hi', fetchReturning(jsonResponse({ recipient_id: IGSID, message_id: MID })))
    expect(result).toEqual({ ok: true, mid: MID })
  })

  it('treats a 200 with no message_id as a failure whose outcome is unknown', async () => {
    const result = await send('hi', fetchReturning(jsonResponse({ recipient_id: IGSID })))
    expect(result).toMatchObject({ ok: false, kind: 'malformed_response' })
    expect(sendOutcomeUnknown('malformed_response')).toBe(true)
  })
})

function metaError(code: number, subcode?: number, status = 400): Response {
  return jsonResponse(
    {
      error: {
        message: `(#${code}) This message is sent outside of allowed window. IGSID ${IGSID}`,
        type: 'IGApiException',
        code,
        ...(subcode !== undefined ? { error_subcode: subcode } : {}),
        fbtrace_id: 'AbCdEf',
      },
    },
    status,
  )
}

describe('failure kinds', () => {
  it.each([
    [10, 2534022, 'window_closed'],
    [10, 1234, 'graph_error'],
    [190, undefined, 'token_rejected'],
    [4, undefined, 'rate_limited'],
    [17, undefined, 'rate_limited'],
    [32, undefined, 'rate_limited'],
    [613, undefined, 'rate_limited'],
    [551, 1545041, 'recipient_unavailable'],
    [100, undefined, 'graph_error'],
  ] as const)('code %s subcode %s is %s', async (code, subcode, kind) => {
    const result = await send('hi', fetchReturning(metaError(code, subcode)))
    expect(result).toMatchObject({ ok: false, kind })
  })

  it("never carries Meta's error message, which quotes the guest's scoped ID", async () => {
    const result = await send('hi', fetchReturning(metaError(10, 2534022)))
    const rendered = JSON.stringify(result)
    expect(rendered).not.toContain('outside of allowed window')
    expect(rendered).not.toContain(IGSID)
    expect(result).toEqual({
      ok: false,
      kind: 'window_closed',
      failure: {
        reason: 'graph_error',
        httpStatus: 400,
        code: 10,
        subcode: 2534022,
        type: 'IGApiException',
        fbtraceId: 'AbCdEf',
      },
    })
  })

  it('reports a timeout as a failure whose outcome is unknown', async () => {
    const timeoutError = Object.assign(new Error('aborted'), { name: 'TimeoutError' })
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw timeoutError
    })
    const result = await send('hi', fetchImpl)
    expect(result).toEqual({ ok: false, kind: 'timeout', failure: { reason: 'timeout' } })
    expect(sendOutcomeUnknown('timeout')).toBe(true)
  })

  it('knows every other kind did not send', () => {
    for (const kind of [
      'empty_text',
      'over_byte_cap',
      'window_closed',
      'token_rejected',
      'rate_limited',
      'recipient_unavailable',
      'graph_error',
    ] as const) {
      expect(sendOutcomeUnknown(kind)).toBe(false)
    }
    expect(sendOutcomeUnknown('network')).toBe(true)
  })

  it('classifies a network failure', () => {
    expect(classifySendFailure({ reason: 'network', errorName: 'TypeError', causeCode: 'ECONNRESET' })).toBe('network')
  })
})
