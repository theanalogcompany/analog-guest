import { beforeEach, describe, expect, it, vi } from 'vitest'

// TAC-467: scheduleAndSend runs the read receipt and typing indicator before
// every reply, passing the guest's phone straight through. A guest who came in
// on Instagram has none, and both must refuse null by name before the venue
// lookup, the same way sendMessage does.

const sendblueMarkAsReadMock = vi.fn()
const sendblueSendTypingIndicatorMock = vi.fn()
const getVenueMessagingNumberMock = vi.fn()

vi.mock('./sendblue-client', () => ({
  sendblueMarkAsRead: (...a: unknown[]) => sendblueMarkAsReadMock(...a),
  sendblueSendTypingIndicator: (...a: unknown[]) => sendblueSendTypingIndicatorMock(...a),
  sendblueSendReaction: vi.fn(),
}))
vi.mock('./venue-lookup', () => ({
  getVenueMessagingNumber: (...a: unknown[]) => getVenueMessagingNumberMock(...a),
}))
vi.mock('@/lib/db/admin', () => ({ createAdminClient: vi.fn() }))

import { markAsRead, sendTypingIndicator } from './expressions'

const VENUE = 'venue-1'
const TO = '+15555550123'

beforeEach(() => {
  vi.clearAllMocks()
  getVenueMessagingNumberMock.mockResolvedValue({ ok: true, data: '+15555559999' })
  sendblueMarkAsReadMock.mockResolvedValue(undefined)
  sendblueSendTypingIndicatorMock.mockResolvedValue(undefined)
})

describe('sendTypingIndicator', () => {
  it('refuses a guest with no phone by name and never reaches the provider', async () => {
    const r = await sendTypingIndicator({ venueId: VENUE, to: null })
    expect(r).toEqual({ ok: false, error: 'recipient_has_no_phone_number' })
    expect(getVenueMessagingNumberMock).not.toHaveBeenCalled()
    expect(sendblueSendTypingIndicatorMock).not.toHaveBeenCalled()
  })

  it('sends for a guest with a phone', async () => {
    const r = await sendTypingIndicator({ venueId: VENUE, to: TO })
    expect(r).toEqual({ ok: true, data: undefined })
    expect(sendblueSendTypingIndicatorMock).toHaveBeenCalledWith({ from: '+15555559999', to: TO })
  })
})

describe('markAsRead', () => {
  it('refuses a guest with no phone by name and never reaches the provider', async () => {
    const r = await markAsRead({ venueId: VENUE, to: null, messageHandle: 'h-1' })
    expect(r).toEqual({ ok: false, error: 'recipient_has_no_phone_number' })
    expect(getVenueMessagingNumberMock).not.toHaveBeenCalled()
    expect(sendblueMarkAsReadMock).not.toHaveBeenCalled()
  })

  it('marks read for a guest with a phone', async () => {
    const r = await markAsRead({ venueId: VENUE, to: TO, messageHandle: 'h-1' })
    expect(r).toEqual({ ok: true, data: undefined })
    expect(sendblueMarkAsReadMock).toHaveBeenCalledWith({
      from: '+15555559999',
      to: TO,
      messageHandle: 'h-1',
    })
  })
})
