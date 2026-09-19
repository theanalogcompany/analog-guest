import { describe, expect, it } from 'vitest'

import { callsNamed, queryRecorder } from './testing/query-recorder'
import {
  INSTAGRAM_WINDOW_MARGIN_MS,
  INSTAGRAM_WINDOW_MS,
  instagramWindowState,
  loadLastGuestActionAt,
} from './window'

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const GUEST_ACTION = new Date('2026-09-19T10:00:00.000Z')
const META_CLOSE = new Date(GUEST_ACTION.getTime() + 24 * HOUR)

describe('the constants', () => {
  it('is a 24-hour window with a 5-minute margin', () => {
    expect(INSTAGRAM_WINDOW_MS).toBe(24 * HOUR)
    // Pinned so a change to the margin is a decision, not a drift. The
    // reasoning is on the constant.
    expect(INSTAGRAM_WINDOW_MARGIN_MS).toBe(5 * MINUTE)
  })
})

describe('instagramWindowState', () => {
  it('is open straight after the guest writes', () => {
    const state = instagramWindowState(GUEST_ACTION, new Date(GUEST_ACTION.getTime() + 20 * 1000))
    expect(state).toEqual({ open: true, closesAt: META_CLOSE, remainingMs: 24 * HOUR - 20 * 1000 })
  })

  it('is open one millisecond before the margin', () => {
    const now = new Date(META_CLOSE.getTime() - INSTAGRAM_WINDOW_MARGIN_MS - 1)
    expect(instagramWindowState(GUEST_ACTION, now).open).toBe(true)
  })

  it('closes AT the margin, before Meta does', () => {
    const now = new Date(META_CLOSE.getTime() - INSTAGRAM_WINDOW_MARGIN_MS)
    expect(instagramWindowState(GUEST_ACTION, now)).toEqual({
      open: false,
      reason: 'closed',
      closesAt: META_CLOSE,
      remainingMs: INSTAGRAM_WINDOW_MARGIN_MS,
    })
  })

  it("stays closed after Meta's window has closed, with a negative remainder", () => {
    const now = new Date(META_CLOSE.getTime() + HOUR)
    expect(instagramWindowState(GUEST_ACTION, now)).toMatchObject({ open: false, reason: 'closed', remainingMs: -HOUR })
  })

  it('reopens on a newer guest action', () => {
    const now = new Date(GUEST_ACTION.getTime() + 30 * HOUR)
    expect(instagramWindowState(GUEST_ACTION, now).open).toBe(false)
    const newer = new Date(now.getTime() - 10 * MINUTE)
    expect(instagramWindowState(newer, now).open).toBe(true)
  })

  it('is closed when the guest has never acted', () => {
    expect(instagramWindowState(null, GUEST_ACTION)).toEqual({
      open: false,
      reason: 'no_guest_action',
      closesAt: null,
      remainingMs: null,
    })
  })
})

describe('loadLastGuestActionAt', () => {
  it("reads Meta's time of the newest Instagram inbound row, and nothing else", async () => {
    const { client, queries } = queryRecorder({
      messages: [{ data: { provider_sent_at: '2026-09-19T10:00:00.000+00:00' }, error: null }],
    })
    const result = await loadLastGuestActionAt(client, 'venue-1', 'guest-1')
    expect(result).toEqual({ ok: true, value: GUEST_ACTION })

    const [query] = queries
    expect(query!.table).toBe('messages')
    expect(callsNamed(query!, 'select')).toEqual([['provider_sent_at']])
    expect(callsNamed(query!, 'eq')).toEqual([
      ['venue_id', 'venue-1'],
      ['guest_id', 'guest-1'],
      ['direction', 'inbound'],
      ['channel', 'instagram'],
    ])
    // Rows saved without Meta's time are skipped, not read as "no action".
    expect(callsNamed(query!, 'not')).toEqual([['provider_sent_at', 'is', null]])
    expect(callsNamed(query!, 'order')).toEqual([['provider_sent_at', { ascending: false }]])
    expect(callsNamed(query!, 'limit')).toEqual([[1]])
  })

  it('never reads created_at, which is our clock and can lag by a redelivery', async () => {
    const { client, queries } = queryRecorder({ messages: [{ data: null, error: null }] })
    await loadLastGuestActionAt(client, 'venue-1', 'guest-1')
    expect(JSON.stringify(queries[0]!.calls)).not.toContain('created_at')
  })

  it('returns null when no Instagram inbound row has a Meta time', async () => {
    const { client } = queryRecorder({ messages: [{ data: null, error: null }] })
    expect(await loadLastGuestActionAt(client, 'venue-1', 'guest-1')).toEqual({ ok: true, value: null })
  })

  it('returns an error, not null, when the read fails', async () => {
    const { client } = queryRecorder({ messages: [{ data: null, error: { message: 'boom' } }] })
    expect(await loadLastGuestActionAt(client, 'venue-1', 'guest-1')).toEqual({ ok: false, error: 'boom' })
  })
})
