// The two Graph reads, against a fetch the test controls. Response bodies
// follow Meta's documented shapes (the User Profile API page, and Graph's
// standard error object); none has been captured from Meta yet, so the first
// live fetch in device QA is what confirms them.

import { describe, expect, it, vi } from 'vitest'

import {
  fetchInstagramProfile,
  fetchTokenAccountId,
  GRAPH_CODE_TOKEN_REJECTED,
  INSTAGRAM_GRAPH_BASE_URL,
  isTokenRejected,
} from './fetch-profile'

const TOKEN = 'IGAAtesttoken-value'
// Both widths seen in production. Nothing may assume one.
const IGSID_16 = '1000000000000001'
const IGSID_15 = '100000000000001'

type Call = { url: string; init: RequestInit }

function respondWith(status: number, body: unknown) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  })
  return { fetchImpl, calls }
}

function throwing(error: unknown) {
  const fetchImpl = vi.fn(async () => {
    throw error
  })
  return { fetchImpl }
}

// A Graph error as Meta formats it. The message names the object, here the
// guest's scoped ID, which is why it must never leave the module.
function graphError(code: number, subcode: number | null, igsid = IGSID_16) {
  return {
    error: {
      message: `Unsupported get request. Object with ID '${igsid}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
      type: code === GRAPH_CODE_TOKEN_REJECTED ? 'OAuthException' : 'IGApiException',
      code,
      ...(subcode === null ? {} : { error_subcode: subcode }),
      fbtrace_id: 'AbCdEf123',
    },
  }
}

describe('fetchInstagramProfile', () => {
  it('asks for the handle and display name only, with the token in the header and not the URL', async () => {
    const { fetchImpl, calls } = respondWith(200, { username: 'maya.oakland', name: 'Maya' })
    const result = await fetchInstagramProfile(IGSID_16, TOKEN, fetchImpl)

    expect(result).toEqual({ ok: true, value: { username: 'maya.oakland', name: 'Maya' } })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${INSTAGRAM_GRAPH_BASE_URL}/${IGSID_16}?fields=username,name`)
    expect(calls[0]?.url).not.toContain(TOKEN)
    expect(calls[0]?.init.headers).toEqual({ authorization: `Bearer ${TOKEN}` })
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('takes a 15-digit scoped ID as it comes', async () => {
    const { fetchImpl, calls } = respondWith(200, { username: 'short.id' })
    const result = await fetchInstagramProfile(IGSID_15, TOKEN, fetchImpl)

    expect(result).toEqual({ ok: true, value: { username: 'short.id', name: null } })
    expect(calls[0]?.url).toBe(`${INSTAGRAM_GRAPH_BASE_URL}/${IGSID_15}?fields=username,name`)
  })

  it('encodes the scoped ID into the path rather than trusting it', async () => {
    const { fetchImpl, calls } = respondWith(200, { username: 'x' })
    await fetchInstagramProfile('1/../me?x=', TOKEN, fetchImpl)
    expect(calls[0]?.url).toBe(`${INSTAGRAM_GRAPH_BASE_URL}/1%2F..%2Fme%3Fx%3D?fields=username,name`)
  })

  // Absent must always be NULL, never '', so a reader's `??` works (TAC-473).
  it.each<[string, unknown]>([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['blank', '   '],
    ['not a string', 42],
  ])('reads a %s display name as null', async (_label, name) => {
    const { fetchImpl } = respondWith(200, { username: 'maya.oakland', name })
    expect(await fetchInstagramProfile(IGSID_16, TOKEN, fetchImpl)).toEqual({
      ok: true,
      value: { username: 'maya.oakland', name: null },
    })
  })

  it('trims the handle and the name', async () => {
    const { fetchImpl } = respondWith(200, { username: ' maya.oakland ', name: ' Maya ' })
    expect(await fetchInstagramProfile(IGSID_16, TOKEN, fetchImpl)).toEqual({
      ok: true,
      value: { username: 'maya.oakland', name: 'Maya' },
    })
  })

  it.each<[string, unknown]>([
    ['no username', { name: 'Maya' }],
    ['a blank username', { username: '  ', name: 'Maya' }],
    ['a body that is not an object', ['maya']],
  ])('refuses a 200 with %s rather than store it', async (_label, body) => {
    const { fetchImpl } = respondWith(200, body)
    expect(await fetchInstagramProfile(IGSID_16, TOKEN, fetchImpl)).toEqual({
      ok: false,
      failure: { reason: 'malformed_response', httpStatus: 200 },
    })
  })

  it('reports a Graph error by its codes and never carries Meta\'s message', async () => {
    const { fetchImpl } = respondWith(400, graphError(100, 33))
    const result = await fetchInstagramProfile(IGSID_16, TOKEN, fetchImpl)

    expect(result).toEqual({
      ok: false,
      failure: {
        reason: 'graph_error',
        httpStatus: 400,
        code: 100,
        subcode: 33,
        type: 'IGApiException',
        fbtraceId: 'AbCdEf123',
      },
    })
    const text = JSON.stringify(result)
    expect(text).not.toContain(IGSID_16)
    expect(text).not.toContain('Unsupported get request')
  })

  it('marks an expired or invalid token as a token rejection, and nothing else as one', async () => {
    const expired = await fetchInstagramProfile(IGSID_16, TOKEN, respondWith(400, graphError(190, 463)).fetchImpl)
    const refused = await fetchInstagramProfile(IGSID_16, TOKEN, respondWith(400, graphError(100, 33)).fetchImpl)

    expect(!expired.ok && isTokenRejected(expired.failure)).toBe(true)
    expect(!refused.ok && isTokenRejected(refused.failure)).toBe(false)
  })

  it('reads a Graph error on a 200 as a failure', async () => {
    const { fetchImpl } = respondWith(200, graphError(10, null))
    expect(await fetchInstagramProfile(IGSID_16, TOKEN, fetchImpl)).toMatchObject({
      ok: false,
      failure: { reason: 'graph_error', httpStatus: 200, code: 10 },
    })
  })

  it('reads a non-JSON error page as a malformed response', async () => {
    const { fetchImpl } = respondWith(502, '<html>Bad Gateway</html>')
    expect(await fetchInstagramProfile(IGSID_16, TOKEN, fetchImpl)).toEqual({
      ok: false,
      failure: { reason: 'malformed_response', httpStatus: 502 },
    })
  })

  it('reports a timeout as a timeout', async () => {
    const { fetchImpl } = throwing(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    expect(await fetchInstagramProfile(IGSID_16, TOKEN, fetchImpl)).toEqual({ ok: false, failure: { reason: 'timeout' } })
  })

  it('reports a network failure by name and cause code, without its message', async () => {
    const error = new TypeError(`fetch failed for ${IGSID_16}`, { cause: { code: 'ECONNRESET' } })
    const result = await fetchInstagramProfile(IGSID_16, TOKEN, throwing(error).fetchImpl)

    expect(result).toEqual({ ok: false, failure: { reason: 'network', errorName: 'TypeError', causeCode: 'ECONNRESET' } })
    expect(JSON.stringify(result)).not.toContain(IGSID_16)
  })
})

describe('fetchTokenAccountId', () => {
  it('asks /me for user_id, with the token in the header and not the URL', async () => {
    const { fetchImpl, calls } = respondWith(200, { user_id: '17841400000000001', id: '9999' })
    const result = await fetchTokenAccountId(TOKEN, fetchImpl)

    // user_id, NOT id: id is app-scoped and matches nothing we store.
    expect(result).toEqual({ ok: true, value: '17841400000000001' })
    expect(calls[0]?.url).toBe(`${INSTAGRAM_GRAPH_BASE_URL}/me?fields=user_id`)
    expect(calls[0]?.url).not.toContain(TOKEN)
    expect(calls[0]?.init.headers).toEqual({ authorization: `Bearer ${TOKEN}` })
  })

  // 17 digits is past what a JSON number holds exactly, so a numeric user_id
  // could be off by a few and compare unequal while naming the same account.
  it.each<[string, unknown]>([
    ['a numeric user_id', { user_id: 17841400000000001 }],
    ['no user_id', { id: '9999' }],
  ])('refuses %s', async (_label, body) => {
    expect(await fetchTokenAccountId(TOKEN, respondWith(200, body).fetchImpl)).toEqual({
      ok: false,
      failure: { reason: 'malformed_response', httpStatus: 200 },
    })
  })

  it('reports a rejected token', async () => {
    const result = await fetchTokenAccountId(TOKEN, respondWith(400, graphError(190, 460)).fetchImpl)
    expect(!result.ok && isTokenRejected(result.failure)).toBe(true)
  })
})
