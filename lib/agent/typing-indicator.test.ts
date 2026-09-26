// TAC-540: the channel switch for the typing indicator.
//
// The two things worth pinning here are the two the switch exists for: an
// Instagram conversation gets Meta's sender action, and NOTHING ELSE gets
// anything at all. Everything about WHEN the dots go on and off lives in
// handle-inbound and is tested there.

import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/admin', () => ({
  // Never reached: every test injects loadTarget. Present so importing this
  // module does not construct a real admin client.
  createAdminClient: () => {
    throw new Error('createAdminClient should not be called: deps are injected')
  },
}))
vi.mock('@/lib/analytics/posthog', () => ({
  captureInstagramSenderActionFailed: vi.fn(async () => undefined),
}))

import { captureInstagramSenderActionFailed } from '@/lib/analytics/posthog'
import { signalTyping, type TypingIndicatorDeps } from './typing-indicator'

const VENUE_ID = 'venue-1'
const GUEST_ID = 'guest-1'
const ACCOUNT_ID = '17841400000000001'
const IGSID = '1000000000000001'
const TOKEN = 'IGAAtesttoken-value'

function stubDeps(over: Partial<TypingIndicatorDeps> = {}) {
  const loadTarget = vi.fn(async () => ({
    ok: true as const,
    target: { accountId: ACCOUNT_ID, recipientId: IGSID, token: TOKEN, tokenSource: 'env' as const },
  }))
  const sendAction = vi.fn(async () => ({ ok: true as const }))
  return { deps: { loadTarget, sendAction, ...over }, loadTarget, sendAction }
}

describe('branch by channel, do not converge', () => {
  /**
   * AC 4, from this side. Sendblue's typing already fires inside
   * scheduleAndSend at send time; wiring it here too would give a text guest
   * two typing beats per reply and put a provider call on a path that never
   * had one.
   *
   * Asserted as "no call of any kind", not "no Instagram call": the failure
   * this guards is convergence in either direction.
   */
  it('sends nothing at all on a text conversation', async () => {
    const { deps, loadTarget, sendAction } = stubDeps()
    const result = await signalTyping(
      { venueId: VENUE_ID, guestId: GUEST_ID, channel: 'text' },
      'on',
      deps,
    )
    expect(result).toEqual({ status: 'not_applicable', channel: 'text' })
    expect(loadTarget).not.toHaveBeenCalled()
    expect(sendAction).not.toHaveBeenCalled()
  })

  /**
   * Null means "we cannot tell which conversation this is", never Instagram.
   * handle-inbound stops a null-channel run before classifying, so reaching
   * here is a caller bug — refused rather than trusted away.
   */
  it('sends nothing when the channel is unresolved', async () => {
    const { deps, sendAction } = stubDeps()
    const result = await signalTyping(
      { venueId: VENUE_ID, guestId: GUEST_ID, channel: null },
      'on',
      deps,
    )
    expect(result).toEqual({ status: 'not_applicable', channel: null })
    expect(sendAction).not.toHaveBeenCalled()
  })

  it.each([
    ['on', 'typing_on'],
    ['off', 'typing_off'],
  ] as const)('maps %s to %s on an Instagram conversation', async (signal, action) => {
    const { deps, loadTarget, sendAction } = stubDeps()
    const result = await signalTyping(
      { venueId: VENUE_ID, guestId: GUEST_ID, channel: 'instagram' },
      signal,
      deps,
    )

    expect(result).toEqual({ status: 'sent' })
    // WHICH venue and guest, per token-stub.ts's own warning: a stub that
    // ignored its arguments would let the call site pass the wrong id.
    expect(loadTarget).toHaveBeenCalledWith({ venueId: VENUE_ID, guestId: GUEST_ID })
    expect(sendAction).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      recipientId: IGSID,
      token: TOKEN,
      action,
    })
  })
})

describe('fails open', () => {
  it('returns a value when there is no send target, and sends nothing', async () => {
    const { deps, sendAction } = stubDeps({
      loadTarget: vi.fn(async () => ({ ok: false as const, problem: 'token_missing' as const })),
    })
    const result = await signalTyping(
      { venueId: VENUE_ID, guestId: GUEST_ID, channel: 'instagram' },
      'on',
      deps,
    )
    expect(result).toEqual({ status: 'no_send_target', problem: 'token_missing' })
    expect(sendAction).not.toHaveBeenCalled()
  })

  it('captures a failed action rather than throwing', async () => {
    const { deps } = stubDeps({
      sendAction: vi.fn(async () => ({
        ok: false as const,
        kind: 'rate_limited' as const,
        failure: null as never,
      })),
    })
    const result = await signalTyping(
      { venueId: VENUE_ID, guestId: GUEST_ID, channel: 'instagram' },
      'off',
      deps,
    )
    expect(result).toEqual({ status: 'send_failed', kind: 'rate_limited' })
    expect(captureInstagramSenderActionFailed).toHaveBeenCalledWith({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      action: 'typing_off',
      kind: 'rate_limited',
    })
  })

  it('never throws, even when a dep does', async () => {
    const { deps } = stubDeps({
      sendAction: vi.fn(async () => {
        throw new Error('socket hang up')
      }),
    })
    const result = await signalTyping(
      { venueId: VENUE_ID, guestId: GUEST_ID, channel: 'instagram' },
      'on',
      deps,
    )
    expect(result).toEqual({ status: 'send_failed', kind: 'unexpected_throw' })
  })

  it('never writes the scoped ID or the token to the console', async () => {
    const logged: unknown[] = []
    const spies = (['log', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(...args)
      }),
    )
    try {
      const { deps } = stubDeps({
        sendAction: vi.fn(async () => ({
          ok: false as const,
          kind: 'graph_error' as const,
          failure: null as never,
        })),
      })
      await signalTyping({ venueId: VENUE_ID, guestId: GUEST_ID, channel: 'instagram' }, 'on', deps)
      const rendered = JSON.stringify(logged)
      expect(rendered).not.toContain(IGSID)
      expect(rendered).not.toContain(TOKEN)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})
