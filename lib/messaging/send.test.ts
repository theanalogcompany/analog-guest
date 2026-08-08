import { beforeEach, describe, expect, it, vi } from 'vitest'

// The content guard is the universal backstop that stops a blank message
// reaching a guest — every send path funnels through sendMessage
// (scheduleAndSend, dispatchOperatorOutbound). It existed before TAC-309 but
// had NEVER FIRED in production, because an empty body was unreachable until
// knowledge-gap cards started persisting blank on purpose. An unfired guard
// is an unproven one, so it gets coverage here in the ticket that makes it
// load-bearing.

const sendblueSendMessageMock = vi.fn()
const getVenueMessagingNumberMock = vi.fn()

vi.mock('./sendblue-client', () => ({
  sendblueSendMessage: (...a: unknown[]) => sendblueSendMessageMock(...a),
}))
vi.mock('./venue-lookup', () => ({
  getVenueMessagingNumber: (...a: unknown[]) => getVenueMessagingNumberMock(...a),
}))

import { sendMessage } from './send'

const VENUE = 'venue-1'
const TO = '+15555550123'

beforeEach(() => {
  vi.clearAllMocks()
  getVenueMessagingNumberMock.mockResolvedValue({ ok: true, data: '+15555559999' })
  sendblueSendMessageMock.mockResolvedValue({
    ok: true,
    data: { providerMessageId: 'p-1', status: 'QUEUED' },
  })
})

describe('sendMessage — content guard (TAC-309)', () => {
  it('sends a normal body', async () => {
    const r = await sendMessage({ venueId: VENUE, to: TO, body: 'yeah, oat and almond' })
    expect(r.ok).toBe(true)
    expect(sendblueSendMessageMock).toHaveBeenCalledTimes(1)
  })

  it('refuses an empty body and never reaches the provider', async () => {
    const r = await sendMessage({ venueId: VENUE, to: TO, body: '' })
    expect(r).toMatchObject({ ok: false, error: 'message_must_have_content' })
    expect(sendblueSendMessageMock).not.toHaveBeenCalled()
  })

  // The TAC-309 widening. The pre-existing check was `body === ''`, so a lone
  // space passed it and shipped a visibly blank text to the guest.
  it.each([' ', '   ', '\n', '\t', ' \n\t '])(
    'refuses whitespace-only body %j',
    async (body) => {
      const r = await sendMessage({ venueId: VENUE, to: TO, body })
      expect(r).toMatchObject({ ok: false, error: 'message_must_have_content' })
      expect(sendblueSendMessageMock).not.toHaveBeenCalled()
    },
  )

  // A blank knowledge-gap card is exactly the shape this now has to stop.
  it('refuses the blank body a knowledge-gap card persists with', async () => {
    const r = await sendMessage({ venueId: VENUE, to: TO, body: '' })
    expect(r.ok).toBe(false)
    expect(sendblueSendMessageMock).not.toHaveBeenCalled()
  })

  // Media-only messages are legitimately body-less — the guard must not
  // widen into them.
  it('allows an empty body when media is attached', async () => {
    const r = await sendMessage({
      venueId: VENUE,
      to: TO,
      body: '',
      mediaUrls: ['https://example.com/a.jpg'],
    })
    expect(r.ok).toBe(true)
    expect(sendblueSendMessageMock).toHaveBeenCalledTimes(1)
  })

  it('does not trim the body it actually sends', async () => {
    await sendMessage({ venueId: VENUE, to: TO, body: '  spaced out  ' })
    expect(sendblueSendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ content: '  spaced out  ' }),
    )
  })
})
