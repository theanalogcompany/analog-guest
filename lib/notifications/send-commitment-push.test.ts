import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  PushSentProps,
  PushTokenInvalidProps,
} from '@/lib/analytics/posthog'
import type { ApnsClientResult, ApnsRequestPayload } from './apns/client'

const sendApnsRequestMock = vi.fn<
  (payload: ApnsRequestPayload) => Promise<ApnsClientResult>
>()
vi.mock('./apns/client', () => ({
  sendApnsRequest: (payload: ApnsRequestPayload) => sendApnsRequestMock(payload),
}))

const capturePushSentMock = vi.fn<(props: PushSentProps) => Promise<void>>()
const capturePushTokenInvalidMock = vi.fn<
  (props: PushTokenInvalidProps) => Promise<void>
>()
vi.mock('@/lib/analytics/posthog', () => ({
  capturePushSent: (props: PushSentProps) => capturePushSentMock(props),
  capturePushTokenInvalid: (props: PushTokenInvalidProps) =>
    capturePushTokenInvalidMock(props),
}))

// Per-table mocked Supabase query builder. Mirrors send.test.ts shape.
type Q = {
  select: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  in: ReturnType<typeof vi.fn>
  not: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  then: (resolve: (value: unknown) => unknown) => unknown
}
function makeQuery(result: unknown): Q {
  const q = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    not: vi.fn(),
    update: vi.fn(),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(result).then(resolve),
  }
  q.select.mockReturnValue(q)
  q.eq.mockReturnValue(q)
  q.in.mockReturnValue(q)
  q.not.mockReturnValue(q)
  q.update.mockReturnValue(q)
  return q
}
const queriesByTable: Record<string, Q[]> = {}
const fromMock = vi.fn((table: string) => {
  const queue = queriesByTable[table]
  if (!queue || queue.length === 0) {
    throw new Error(`No mocked query queued for table ${table}`)
  }
  return queue.shift()!
})
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({ from: fromMock }),
}))

// Imported AFTER mocks
import {
  buildArrivalContext,
  buildCommitmentPushBody,
  sendCommitmentArrivalPush,
} from './send-commitment-push'

beforeEach(() => {
  sendApnsRequestMock.mockReset()
  capturePushSentMock.mockReset()
  capturePushSentMock.mockResolvedValue(undefined)
  capturePushTokenInvalidMock.mockReset()
  capturePushTokenInvalidMock.mockResolvedValue(undefined)
  fromMock.mockClear()
  for (const k of Object.keys(queriesByTable)) delete queriesByTable[k]
})

afterEach(() => {
  vi.clearAllMocks()
})

function queue(table: string, result: unknown): void {
  if (!queriesByTable[table]) queriesByTable[table] = []
  queriesByTable[table].push(makeQuery(result))
}

describe('buildArrivalContext', () => {
  it('returns "now" for imminent regardless of expectedArrival', () => {
    expect(buildArrivalContext('imminent', null, 'America/Los_Angeles')).toBe('now')
    expect(
      buildArrivalContext('imminent', '2026-05-29T09:00:00Z', 'America/Los_Angeles'),
    ).toBe('now')
  })

  it('buckets scheduled morning correctly', () => {
    // 09:00 UTC = 02:00 LA on a non-DST date — wait, let's use a clearer one.
    // 16:00 UTC = 09:00 LA → morning.
    expect(
      buildArrivalContext('scheduled', '2026-05-29T16:00:00Z', 'America/Los_Angeles'),
    ).toBe('this morning')
  })

  it('buckets scheduled afternoon correctly', () => {
    // 21:00 UTC = 14:00 LA → afternoon.
    expect(
      buildArrivalContext('scheduled', '2026-05-29T21:00:00Z', 'America/Los_Angeles'),
    ).toBe('this afternoon')
  })

  it('buckets scheduled evening correctly', () => {
    // 02:00 UTC next day = 19:00 LA → evening.
    expect(
      buildArrivalContext('scheduled', '2026-05-30T02:00:00Z', 'America/Los_Angeles'),
    ).toBe('this evening')
  })

  it('falls back to "soon" on missing or malformed expectedArrival', () => {
    expect(buildArrivalContext('scheduled', null, 'America/Los_Angeles')).toBe('soon')
    expect(buildArrivalContext('scheduled', 'not-a-date', 'America/Los_Angeles')).toBe(
      'soon',
    )
  })
})

describe('buildCommitmentPushBody', () => {
  it('renders comp with description and code', () => {
    expect(buildCommitmentPushBody('Jaipal', 'comp', '7K2P', 'now', 'oat latte')).toBe(
      'Jaipal arriving now, comp for oat latte, code 7K2P',
    )
  })

  it('renders hold with description and code', () => {
    expect(
      buildCommitmentPushBody('Sarah', 'hold', 'X3MN', 'this morning', 'almond croissant'),
    ).toBe('Sarah arriving this morning, hold for almond croissant, code X3MN')
  })

  it('renders recommendation without code', () => {
    expect(
      buildCommitmentPushBody('Alex', 'recommendation', null, 'now', 'blossom tonic'),
    ).toBe('Alex arriving now, ready for blossom tonic')
  })

  // TAC-532. A recommendation carries no code, so before this the only thing
  // in the body was the name, the context and 'ready'. Two recommendations for
  // one guest pushed identically, which is this ticket's collision on the
  // arrival surface.
  it('tells two same-type commitments for one guest apart', () => {
    const a = buildCommitmentPushBody('Alex', 'recommendation', null, 'now', 'blossom tonic')
    const b = buildCommitmentPushBody('Alex', 'recommendation', null, 'now', 'pink panther')
    expect(a).not.toBe(b)
  })

  it('omits the for-clause entirely when there is no description', () => {
    expect(buildCommitmentPushBody('Jaipal', 'comp', '7K2P', 'now', '')).toBe(
      'Jaipal arriving now, comp, code 7K2P',
    )
    expect(buildCommitmentPushBody('Jaipal', 'comp', '7K2P', 'now', '   ')).toBe(
      'Jaipal arriving now, comp, code 7K2P',
    )
  })

  it('carries no em dash or en dash, including from the description', () => {
    const out = buildCommitmentPushBody('Jaipal', 'comp', '7K2P', 'now', 'oat latte \u2014 large')
    expect(out).not.toMatch(/[\u2013\u2014]/)
  })

  it('falls back to "a guest" when firstName is null', () => {
    expect(buildCommitmentPushBody(null, 'comp', '9XYZ', 'now', 'oat latte')).toBe(
      'a guest arriving now, comp for oat latte, code 9XYZ',
    )
  })

  it('trims the DESCRIPTION first, keeping name, type and code intact', () => {
    const longDescription =
      'a very long description of the drink that the venue has promised this guest and then some more words'
    const out = buildCommitmentPushBody('Jaipal', 'comp', '7K2P', 'this afternoon', longDescription)
    expect(out.length).toBeLessThanOrEqual(120)
    expect(out.startsWith('Jaipal arriving this afternoon, comp for ')).toBe(true)
    expect(out).toContain('code 7K2P')
    // Cut at a word boundary, so the kept text is a prefix of the original.
    const shown = out.slice('Jaipal arriving this afternoon, comp for '.length, out.indexOf(', code'))
    expect(longDescription.startsWith(shown)).toBe(true)
    // startsWith alone is satisfied by a MID-WORD cut, because that is also a
    // prefix. This is the assertion that actually pins the word boundary, and
    // it mirrors send.test.ts. Without it, replacing sanitizeDescription's last
    // two lines with `return cut.trim()` passes all 20 tests.
    expect(longDescription[shown.length]).toBe(' ')
  })

  // The fixture is sized so `room` is POSITIVE but under MIN_DESCRIPTION_CHARS.
  // An earlier version used a 75-char name, which gives room = -1, where every
  // threshold >= 0 produces the same output and the constant the test is named
  // for is invisible to it: setting MIN_DESCRIPTION_CHARS = 0 passed all 20
  // tests. 'Bartholomew' x 6 is 66 characters, which gives room = 4, and at
  // that width sanitizeDescription('oat latte', 4) returns 'oat' - exactly the
  // useless fragment the constant exists to prevent.
  it('drops the description rather than render a useless fragment of it', () => {
    const longName = 'Bartholomew'.repeat(6)
    expect(longName.length).toBe(66)
    const out = buildCommitmentPushBody(longName, 'discount', '7K2P', 'this afternoon', 'oat latte')
    expect(out).not.toContain(' for ')
    expect(out).not.toContain('oat')
    expect(out).toContain('discount, code 7K2P')
  })

  // Kept as a separate case: room < 0, where there is no space for a
  // description at any threshold.
  it('drops the description when there is no room at all', () => {
    const longName = 'VeryLongFirstNameWayBeyondTheReasonableBudgetForAPushNotificationBodyIndeed'
    const out = buildCommitmentPushBody(longName, 'comp', '7K2P', 'this afternoon', 'oat latte')
    expect(out).not.toContain(' for ')
    expect(out).toContain('comp, code 7K2P')
  })

  it('truncates an over-long firstName instead of dropping the type/code', () => {
    const longName = 'VeryLongFirstName'.repeat(12)
    const out = buildCommitmentPushBody(longName, 'comp', '7K2P', 'this afternoon', '')
    expect(out.length).toBeLessThanOrEqual(120)
    expect(out).toContain('comp, code 7K2P')
  })
})

describe('sendCommitmentArrivalPush — privacy invariant + payload shape', () => {
  function queueLoadRecipients(operatorIds: string[]): void {
    queue(
      'operator_venues',
      operatorIds.length === 0
        ? { data: [], error: null }
        : {
            data: operatorIds.map((id) => ({
              operator: { id, apns_device_token: `tok-${id}` },
            })),
            error: null,
          },
    )
  }
  function queueBadge(operatorId: string, drafts: number, commitments: number): void {
    // operator_venues lookup
    queue('operator_venues', {
      data: [{ venue_id: 'venue-1' }],
      error: null,
    })
    // messages count
    queue('messages', { count: drafts, error: null })
    // guest_commitments count
    queue('guest_commitments', { count: commitments, error: null })
  }

  const baseInput = {
    commitmentId: 'commitment-1',
    venueId: 'venue-1',
    guestId: 'guest-1',
    guestFirstName: 'Jaipal',
    type: 'comp' as const,
    description: 'oat latte',
    code: '7K2P',
    expectedArrival: '2026-05-29T09:00:00Z',
    arrivalSignal: 'imminent' as const,
    venueTimezone: 'America/Los_Angeles',
  }

  // REVERSED by TAC-532, ruled 2026-09-23. This test asserted the description
  // never appeared in the payload, and that is exactly what made two
  // same-type commitments for one guest push identically. The description is
  // agent or operator chosen text about our OWN commitment, not the guest's
  // words, so it does not carry the lock-screen concern that gates quoting on
  // the draft push. Kept and reversed rather than deleted, so the record shows
  // it was once the other way.
  it('carries the description, and still no guest message', async () => {
    queueLoadRecipients(['op-1'])
    queueBadge('op-1', 0, 1)
    sendApnsRequestMock.mockResolvedValue({
      ok: true,
      response: { status: 200, reason: null, apnsId: null, raw: '' },
    } as unknown as ApnsClientResult)

    await sendCommitmentArrivalPush(baseInput)

    expect(sendApnsRequestMock).toHaveBeenCalledOnce()
    const call = sendApnsRequestMock.mock.calls[0][0]
    const payload = call.body as {
      aps: { alert: { title: string; body: string }; badge: number; sound: string }
      commitmentId: string
      guestId: string
      operatorId: string
    }
    expect(payload).toHaveProperty('commitmentId', 'commitment-1')
    expect(payload).toHaveProperty('guestId', 'guest-1')
    expect(payload).toHaveProperty('operatorId', 'op-1')
    expect(payload.aps.sound).toBe('default')
    expect(payload.aps.badge).toBe(1)
    expect(payload.aps.alert.title).toBe('Guest arriving')
    expect(payload.aps.alert.body).toBe('Jaipal arriving now, comp for oat latte, code 7K2P')
    // What stays true, and the honest way to say it: the guest's own message has
    // no PARAMETER on this function, so no call can put it here. That is a
    // property of the signature, checked by tsc, not something an assertion on
    // the payload can establish - a key-name regex here would be the same
    // decoration SR-3 removed from send.test.ts, so it is not repeated.
  })

  it('fires PostHog with surface=commitment_arrival', async () => {
    queueLoadRecipients(['op-1'])
    queueBadge('op-1', 0, 1)
    sendApnsRequestMock.mockResolvedValue({
      ok: true,
      response: { status: 200, reason: null, apnsId: null, raw: '' },
    } as unknown as ApnsClientResult)

    await sendCommitmentArrivalPush(baseInput)

    expect(capturePushSentMock).toHaveBeenCalledOnce()
    const props = capturePushSentMock.mock.calls[0][0]
    expect(props.surface).toBe('commitment_arrival')
    expect(props.primaryTrigger).toBe('commitment_arrival')
    expect(props.ok).toBe(true)
    expect(props.draftId).toBe('commitment-1')
  })

  it('skips fanout when no operator has a token for the venue', async () => {
    queueLoadRecipients([])
    await sendCommitmentArrivalPush(baseInput)
    expect(sendApnsRequestMock).not.toHaveBeenCalled()
    expect(capturePushSentMock).not.toHaveBeenCalled()
  })

  it('nulls token + fires push.token_invalid on 410 Gone', async () => {
    queueLoadRecipients(['op-1'])
    queueBadge('op-1', 0, 1)
    sendApnsRequestMock.mockResolvedValue({
      ok: true,
      response: { status: 410, reason: 'Unregistered', apnsId: null, raw: '' },
    } as unknown as ApnsClientResult)
    // operator-token null UPDATE
    queue('operators', { error: null })

    await sendCommitmentArrivalPush(baseInput)
    expect(capturePushTokenInvalidMock).toHaveBeenCalledOnce()
    const props = capturePushTokenInvalidMock.mock.calls[0][0]
    expect(props.surface).toBe('commitment_arrival')
    expect(props.status).toBe(410)
  })

  it('badge sums pending drafts + pending_ack commitments', async () => {
    queueLoadRecipients(['op-1'])
    queueBadge('op-1', 3, 2) // drafts=3, commitments=2 → badge=5
    sendApnsRequestMock.mockResolvedValue({
      ok: true,
      response: { status: 200, reason: null, apnsId: null, raw: '' },
    } as unknown as ApnsClientResult)
    await sendCommitmentArrivalPush(baseInput)
    const call = sendApnsRequestMock.mock.calls[0][0]
    const payload = call.body as { aps: { badge: number } }
    expect(payload.aps.badge).toBe(5)
  })
})
