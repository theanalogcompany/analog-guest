import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const jwtMock = vi.fn()
vi.mock('./jwt', () => ({
  getApnsJwt: () => jwtMock(),
}))

class FakeStream extends EventEmitter {
  closed = false
  ended = false
  endPayload: string | null = null
  close = vi.fn(() => {
    this.closed = true
  })
  end = vi.fn((payload?: string) => {
    this.ended = true
    this.endPayload = payload ?? null
  })
}

class FakeSession extends EventEmitter {
  lastStream: FakeStream | null = null
  requestHeaders: Record<string, string | number> = {}
  close = vi.fn()

  request(headers: Record<string, string | number>): FakeStream {
    this.requestHeaders = headers
    const stream = new FakeStream()
    this.lastStream = stream
    return stream
  }
}

const lastSession: { value: FakeSession | null } = { value: null }
const connectMock = vi.fn((host: string): FakeSession => {
  void host
  const s = new FakeSession()
  lastSession.value = s
  return s
})

vi.mock('node:http2', () => ({
  connect: (host: string) => connectMock(host),
  constants: {
    HTTP2_HEADER_METHOD: ':method',
    HTTP2_HEADER_PATH: ':path',
    HTTP2_HEADER_SCHEME: ':scheme',
    HTTP2_HEADER_STATUS: ':status',
  },
}))

// Import AFTER mocks are set up so the module resolves to the stubs.
import { sendApnsRequest } from './client'

const SAVED_ENV: Record<string, string | undefined> = {}

beforeEach(() => {
  SAVED_ENV.APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID
  SAVED_ENV.APNS_ENV = process.env.APNS_ENV
  process.env.APNS_BUNDLE_ID = 'company.theanalog.operator'
  process.env.APNS_ENV = 'production'
  jwtMock.mockReset()
  jwtMock.mockResolvedValue({ ok: true, token: 'test.jwt.token' })
  connectMock.mockClear()
  lastSession.value = null
})

afterEach(() => {
  process.env.APNS_BUNDLE_ID = SAVED_ENV.APNS_BUNDLE_ID
  process.env.APNS_ENV = SAVED_ENV.APNS_ENV
})

describe('sendApnsRequest', () => {
  it('selects the production host when APNS_ENV=production', async () => {
    const promise = sendApnsRequest({
      deviceToken: 'abc123',
      body: { aps: { alert: { title: 't', body: 'b' } } },
    })
    // Drive the fake stream to completion.
    await Promise.resolve()
    const session = lastSession.value!
    const stream = session.lastStream!
    stream.emit('response', { ':status': 200 })
    stream.emit('end')
    const result = await promise

    expect(connectMock).toHaveBeenCalledWith('https://api.push.apple.com')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.response.status).toBe(200)
    expect(result.response.reason).toBeNull()
  })

  it('selects the sandbox host when APNS_ENV=sandbox', async () => {
    process.env.APNS_ENV = 'sandbox'
    const promise = sendApnsRequest({
      deviceToken: 'abc123',
      body: { aps: {} },
    })
    await Promise.resolve()
    const session = lastSession.value!
    const stream = session.lastStream!
    stream.emit('response', { ':status': 200 })
    stream.emit('end')
    await promise
    expect(connectMock).toHaveBeenCalledWith('https://api.sandbox.push.apple.com')
  })

  it('returns env_missing when APNS_ENV is neither production nor sandbox', async () => {
    delete process.env.APNS_ENV
    const r = await sendApnsRequest({ deviceToken: 'x', body: {} })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('env_missing')
  })

  it('returns env_missing when APNS_BUNDLE_ID is unset', async () => {
    delete process.env.APNS_BUNDLE_ID
    const r = await sendApnsRequest({ deviceToken: 'x', body: {} })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('env_missing')
    expect(r.detail).toContain('APNS_BUNDLE_ID')
  })

  it('threads JWT failures through as ok=false / error=jwt_failed', async () => {
    jwtMock.mockResolvedValueOnce({
      ok: false,
      error: 'env_missing',
      detail: 'APNS_AUTH_KEY',
    })
    const r = await sendApnsRequest({ deviceToken: 'x', body: {} })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('jwt_failed')
  })

  it('sends authorization, apns-topic, apns-push-type, apns-priority on every request', async () => {
    const promise = sendApnsRequest({
      deviceToken: 'devicetoken123',
      body: { aps: { alert: 'hi' } },
    })
    await Promise.resolve()
    const session = lastSession.value!
    expect(session.requestHeaders[':method']).toBe('POST')
    expect(session.requestHeaders[':path']).toBe('/3/device/devicetoken123')
    expect(session.requestHeaders.authorization).toBe('bearer test.jwt.token')
    expect(session.requestHeaders['apns-topic']).toBe('company.theanalog.operator')
    expect(session.requestHeaders['apns-push-type']).toBe('alert')
    expect(session.requestHeaders['apns-priority']).toBe('10')
    expect(session.requestHeaders['content-type']).toBe('application/json')

    const stream = session.lastStream!
    stream.emit('response', { ':status': 200 })
    stream.emit('end')
    await promise
  })

  it('writes the JSON-serialized body to the stream', async () => {
    const body = { aps: { alert: { title: 'T', body: 'B' }, badge: 3 }, draftId: 'd' }
    const promise = sendApnsRequest({ deviceToken: 'tok', body })
    await Promise.resolve()
    const session = lastSession.value!
    const stream = session.lastStream!
    expect(stream.ended).toBe(true)
    expect(stream.endPayload).toBe(JSON.stringify(body))
    stream.emit('response', { ':status': 200 })
    stream.emit('end')
    await promise
  })

  it('parses APNs error responses and surfaces reason on 410 Gone', async () => {
    const promise = sendApnsRequest({ deviceToken: 'expired-tok', body: { aps: {} } })
    await Promise.resolve()
    const session = lastSession.value!
    const stream = session.lastStream!
    stream.emit('response', { ':status': 410 })
    stream.emit('data', Buffer.from(JSON.stringify({ reason: 'Unregistered' })))
    stream.emit('end')

    const r = await promise
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.response.status).toBe(410)
    expect(r.response.reason).toBe('Unregistered')
  })

  it('returns connection_failed on session error', async () => {
    const promise = sendApnsRequest({ deviceToken: 't', body: {} })
    await Promise.resolve()
    const session = lastSession.value!
    session.emit('error', new Error('ECONNRESET'))
    const r = await promise
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('connection_failed')
    expect(r.detail).toContain('ECONNRESET')
  })

  it('returns request_failed on stream error', async () => {
    const promise = sendApnsRequest({ deviceToken: 't', body: {} })
    await Promise.resolve()
    const session = lastSession.value!
    const stream = session.lastStream!
    stream.emit('error', new Error('stream broke'))
    const r = await promise
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('request_failed')
  })

  it('handles non-JSON error bodies without throwing', async () => {
    const promise = sendApnsRequest({ deviceToken: 't', body: {} })
    await Promise.resolve()
    const session = lastSession.value!
    const stream = session.lastStream!
    stream.emit('response', { ':status': 500 })
    stream.emit('data', Buffer.from('Internal Server Error'))
    stream.emit('end')
    const r = await promise
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.response.status).toBe(500)
    expect(r.response.reason).toBeNull()
  })

  it('closes the session after a successful response', async () => {
    const promise = sendApnsRequest({ deviceToken: 't', body: {} })
    await Promise.resolve()
    const session = lastSession.value!
    const stream = session.lastStream!
    stream.emit('response', { ':status': 200 })
    stream.emit('end')
    await promise
    expect(session.close).toHaveBeenCalled()
  })
})
