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
  it('renders comp with code', () => {
    expect(buildCommitmentPushBody('Jaipal', 'comp', '7K2P', 'now')).toBe(
      'Jaipal arriving now — comp, code 7K2P',
    )
  })

  it('renders hold with code', () => {
    expect(buildCommitmentPushBody('Sarah', 'hold', 'X3MN', 'this morning')).toBe(
      'Sarah arriving this morning — hold, code X3MN',
    )
  })

  it('renders recommendation without code', () => {
    expect(buildCommitmentPushBody('Alex', 'recommendation', null, 'now')).toBe(
      'Alex arriving now — ready',
    )
  })

  it('falls back to "a guest" when firstName is null', () => {
    expect(buildCommitmentPushBody(null, 'comp', '9XYZ', 'now')).toBe(
      'a guest arriving now — comp, code 9XYZ',
    )
  })

  it('truncates an over-long firstName instead of dropping the type/code', () => {
    // Budget is 80. Force the over-budget case by stacking a long name
    // against the longest context label so the assembled body crosses the
    // line. The type/code segment must survive intact.
    const longName = 'VeryLongFirstNameWayBeyondTheReasonableBudgetForAPushNotificationBody'
    const out = buildCommitmentPushBody(longName, 'comp', '7K2P', 'this afternoon')
    expect(out.length).toBeLessThanOrEqual(80)
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
    code: '7K2P',
    expectedArrival: '2026-05-29T09:00:00Z',
    arrivalSignal: 'imminent' as const,
    venueTimezone: 'America/Los_Angeles',
  }

  it('sends a content-free payload — body never contains the description', async () => {
    queueLoadRecipients(['op-1'])
    queueBadge('op-1', 0, 1)
    sendApnsRequestMock.mockResolvedValue({
      ok: true,
      response: { status: 200, reason: null, raw: '' },
    } as unknown as ApnsClientResult)

    // Notably: input doesn't include description at all — the function never
    // accepts it. This test asserts the contract.
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
    expect(payload.aps.alert.body).toBe('Jaipal arriving now — comp, code 7K2P')
    // Privacy invariant: no description should ever appear in the body.
    expect(payload.aps.alert.body).not.toMatch(/latte|oat|croissant|description/i)
    expect(JSON.stringify(payload)).not.toMatch(/oat latte|description/i)
  })

  it('fires PostHog with surface=commitment_arrival', async () => {
    queueLoadRecipients(['op-1'])
    queueBadge('op-1', 0, 1)
    sendApnsRequestMock.mockResolvedValue({
      ok: true,
      response: { status: 200, reason: null, raw: '' },
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
      response: { status: 410, reason: 'Unregistered', raw: '' },
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
      response: { status: 200, reason: null, raw: '' },
    } as unknown as ApnsClientResult)
    await sendCommitmentArrivalPush(baseInput)
    const call = sendApnsRequestMock.mock.calls[0][0]
    const payload = call.body as { aps: { badge: number } }
    expect(payload.aps.badge).toBe(5)
  })
})
