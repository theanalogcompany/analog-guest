// TAC-473: the one-hour Instagram reply-window warning push.
//
// This file exists because the module's header claimed the privacy invariant
// was "asserted in the tests" and there was no test file at all — the
// unenforced-claim pattern CLAUDE.md names, written by hand into a ticket that
// cites it. Shaped after send.test.ts and send-commitment-push.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendApnsRequestMock = vi.fn()
vi.mock('./apns/client', () => ({
  sendApnsRequest: (...args: unknown[]) => sendApnsRequestMock(...args),
}))

const loadPushRecipientsMock = vi.fn()
const countOperatorBadgeMock = vi.fn()
const clearOperatorPushTokenMock = vi.fn()
vi.mock('./recipients', () => ({
  loadPushRecipients: (...args: unknown[]) => loadPushRecipientsMock(...args),
  countOperatorBadge: (...args: unknown[]) => countOperatorBadgeMock(...args),
  clearOperatorPushToken: (...args: unknown[]) => clearOperatorPushTokenMock(...args),
}))

const capturePushSentMock = vi.fn()
const capturePushTokenInvalidMock = vi.fn()
vi.mock('@/lib/analytics/posthog', () => ({
  capturePushSent: (...args: unknown[]) => capturePushSentMock(...args),
  capturePushTokenInvalid: (...args: unknown[]) => capturePushTokenInvalidMock(...args),
}))

import {
  buildInstagramWindowPushBody,
  sendInstagramWindowWarningPush,
} from './send-instagram-window-push'

const INPUT = {
  draftId: 'draft-1',
  venueId: 'venue-1',
  guestId: 'guest-1',
  guestFirstName: 'Ana',
  remainingMs: 42 * 60_000,
}

beforeEach(() => {
  vi.clearAllMocks()
  loadPushRecipientsMock.mockResolvedValue([{ id: 'op-1', apnsDeviceToken: 'tok-1' }])
  countOperatorBadgeMock.mockResolvedValue(3)
  sendApnsRequestMock.mockResolvedValue({ ok: true, response: { status: 200, reason: null, apnsId: 'a-1' } })
})

describe('buildInstagramWindowPushBody', () => {
  it('names the guest and the minutes left', () => {
    expect(buildInstagramWindowPushBody('Ana', 42 * 60_000)).toBe(
      'Ana has 42m left to reply on Instagram',
    )
  })

  it('rounds DOWN, so it never promises more time than there is', () => {
    // 42m59s is 42 minutes left, not 43.
    expect(buildInstagramWindowPushBody('Ana', 42 * 60_000 + 59_000)).toContain('42m')
  })

  it('switches to whole hours at an hour or more', () => {
    expect(buildInstagramWindowPushBody('Ana', 60 * 60_000)).toContain('1h')
    expect(buildInstagramWindowPushBody('Ana', 59 * 60_000)).toContain('59m')
  })

  it('never reports negative time', () => {
    expect(buildInstagramWindowPushBody('Ana', -5000)).toContain('0m')
  })

  it('says "A guest" when there is no name', () => {
    // An Instagram guest may have no first name at all until TAC-479's refresh
    // lands, so this is the common case rather than an edge.
    expect(buildInstagramWindowPushBody(null, 42 * 60_000)).toBe(
      'A guest has 42m left to reply on Instagram',
    )
    expect(buildInstagramWindowPushBody('   ', 42 * 60_000)).toBe(
      'A guest has 42m left to reply on Instagram',
    )
  })

  it('truncates a long name rather than the suffix, so the time is never cut off', () => {
    const body = buildInstagramWindowPushBody('A'.repeat(300), 42 * 60_000)
    expect(body.length).toBeLessThanOrEqual(110)
    expect(body).toContain('42m left to reply on Instagram')
  })

  it('carries no em dash, the REVIEW_REASON_LABELS rule', () => {
    // Read fast on a phone mid-shift, where an em dash is a pause to parse.
    for (const ms of [0, 30 * 60_000, 3 * 60 * 60_000]) {
      expect(buildInstagramWindowPushBody('Ana', ms)).not.toContain('—')
      expect(buildInstagramWindowPushBody(null, ms)).not.toContain('—')
    }
  })
})

describe('sendInstagramWindowWarningPush', () => {
  it('sends to every allowlisted operator with the badge and the body', async () => {
    loadPushRecipientsMock.mockResolvedValue([
      { id: 'op-1', apnsDeviceToken: 'tok-1' },
      { id: 'op-2', apnsDeviceToken: 'tok-2' },
    ])
    await sendInstagramWindowWarningPush(INPUT)
    expect(sendApnsRequestMock).toHaveBeenCalledTimes(2)
    expect(sendApnsRequestMock.mock.calls[0]![0]).toMatchObject({
      deviceToken: 'tok-1',
      body: {
        aps: {
          alert: { title: 'Instagram window closing', body: 'Ana has 42m left to reply on Instagram' },
          badge: 3,
          sound: 'default',
        },
        draftId: 'draft-1',
        guestId: 'guest-1',
        operatorId: 'op-1',
      },
    })
  })

  // THE PRIVACY INVARIANT the header claims. Pinned as an exact key set, not a
  // partial match: a partial match passes while a field creeps in, which is the
  // only way this can go wrong.
  it('carries no message body, no handle and no scoped id', async () => {
    await sendInstagramWindowWarningPush(INPUT)
    const payload = sendApnsRequestMock.mock.calls[0]![0].body as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['aps', 'draftId', 'guestId', 'operatorId'])
    const serialised = JSON.stringify(payload)
    expect(serialised).not.toMatch(/instagram_scoped_id|igsid/i)
    // The first name is permitted; nothing else about the guest is.
    expect(serialised).not.toContain('@')
  })

  it('uses the drafts-plus-commitments badge, not the drafts-only count', async () => {
    await sendInstagramWindowWarningPush(INPUT)
    expect(countOperatorBadgeMock).toHaveBeenCalledWith('op-1')
  })

  it('does nothing when no operator is allowlisted for the venue', async () => {
    loadPushRecipientsMock.mockResolvedValue([])
    await sendInstagramWindowWarningPush(INPUT)
    expect(sendApnsRequestMock).not.toHaveBeenCalled()
    expect(capturePushSentMock).not.toHaveBeenCalled()
  })

  it('tags both captures with its own surface, so the three push surfaces stay separable', async () => {
    await sendInstagramWindowWarningPush(INPUT)
    expect(capturePushSentMock).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'instagram_window_warning', ok: true, badge: 3 }),
    )
  })

  it('clears a token APNs reports as gone (410)', async () => {
    sendApnsRequestMock.mockResolvedValue({
      ok: true,
      response: { status: 410, reason: 'Unregistered', apnsId: 'a-1' },
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await sendInstagramWindowWarningPush(INPUT)
    expect(clearOperatorPushTokenMock).toHaveBeenCalledWith('op-1', expect.any(Object))
    expect(capturePushTokenInvalidMock).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'instagram_window_warning' }),
    )
  })

  it('clears a token APNs reports as malformed (400 BadDeviceToken) and nothing else at 400', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    sendApnsRequestMock.mockResolvedValue({
      ok: true,
      response: { status: 400, reason: 'BadDeviceToken', apnsId: 'a-1' },
    })
    await sendInstagramWindowWarningPush(INPUT)
    expect(clearOperatorPushTokenMock).toHaveBeenCalledTimes(1)

    clearOperatorPushTokenMock.mockClear()
    sendApnsRequestMock.mockResolvedValue({
      ok: true,
      response: { status: 400, reason: 'PayloadTooLarge', apnsId: 'a-1' },
    })
    await sendInstagramWindowWarningPush(INPUT)
    expect(clearOperatorPushTokenMock).not.toHaveBeenCalled()
  })

  it('records a transport failure and keeps going to the next operator', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    loadPushRecipientsMock.mockResolvedValue([
      { id: 'op-1', apnsDeviceToken: 'tok-1' },
      { id: 'op-2', apnsDeviceToken: 'tok-2' },
    ])
    sendApnsRequestMock
      .mockResolvedValueOnce({ ok: false, error: 'timeout', detail: 'no response' })
      .mockResolvedValueOnce({ ok: true, response: { status: 200, reason: null, apnsId: 'a-2' } })
    await sendInstagramWindowWarningPush(INPUT)
    expect(sendApnsRequestMock).toHaveBeenCalledTimes(2)
    expect(capturePushSentMock).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: 'timeout', status: null }),
    )
  })

  it('never throws, because it runs inside a cron tick', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    loadPushRecipientsMock.mockRejectedValue(new Error('db gone'))
    await expect(sendInstagramWindowWarningPush(INPUT)).resolves.toBeUndefined()
  })
})
