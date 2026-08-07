import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// send.ts now imports APPROVAL_TRIGGERS from @/lib/agent/stages (so the label
// map is keyed on the source of truth rather than re-listed literals), which
// transitively loads the Voyage SDK — its ESM build trips vitest's
// directory-import resolver at module load. Same dodge as
// lib/tunables/manifest.test.ts; nothing here instantiates a Voyage client.
vi.mock('voyageai', () => ({
  VoyageAIClient: class {},
}))

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

// Supabase admin mock. Each `.from(table)` returns a per-table thenable
// builder so the helper can call .select / .eq / .in / .not / .update freely.
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

// Import AFTER mocks are set.
import {
  buildPushBody,
  sendDraftFlaggedPush,
  shouldSendDraftFlaggedPush,
} from './send'

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

const baseInput = {
  agentRunId: 'run-1',
  venueId: 'venue-1',
  guestId: 'guest-1',
  guestFirstName: 'Alex',
  draftId: 'draft-1',
  primaryTrigger: 'model_flagged',
}

describe('shouldSendDraftFlaggedPush', () => {
  it('returns true for model_flagged, comp_regex_backstop, fidelity_below_auto_send_floor', () => {
    expect(shouldSendDraftFlaggedPush('model_flagged')).toBe(true)
    expect(shouldSendDraftFlaggedPush('comp_regex_backstop')).toBe(true)
    expect(shouldSendDraftFlaggedPush('fidelity_below_auto_send_floor')).toBe(true)
  })

  it('returns false for previous_pending_held (regen of already-pushed draft)', () => {
    expect(shouldSendDraftFlaggedPush('previous_pending_held')).toBe(false)
  })

  // INVERTED. This assertion previously read:
  //
  //   it('returns false for unknown triggers (future-add safety)', ...)
  //     expect(shouldSendDraftFlaggedPush('something_new')).toBe(false)
  //
  // It was labelled "future-add safety" but encoded the exact opposite: an
  // allow-list that DROPS anything it doesn't recognize. When ff653be added
  // commitment_type_gated and 0c1515c added hold_all_outbound, both were
  // "unknown triggers" and both were silently discarded — with this test
  // green, asserting the behavior as intended. The suite did not merely miss
  // the regression; it locked it in.
  //
  // Fail-open is the correct default: a push the operator can dismiss beats a
  // queued draft they are never told about. Exhaustiveness now lives in
  // push-policy.ts's `satisfies Record<ApprovalTrigger, PushDecision>`, which
  // fails tsc rather than deferring to a runtime default.
  it('returns true for unknown triggers (fail-open — see push-policy.ts)', () => {
    expect(shouldSendDraftFlaggedPush('something_new')).toBe(true)
  })

  it('pushes the two triggers that regressed (commitment_type_gated, hold_all_outbound)', () => {
    expect(shouldSendDraftFlaggedPush('commitment_type_gated')).toBe(true)
    expect(shouldSendDraftFlaggedPush('hold_all_outbound')).toBe(true)
  })
})

describe('buildPushBody', () => {
  it('uses first name + context for known triggers', () => {
    expect(buildPushBody('Alex', 'model_flagged')).toBe('Reply to Alex — needs review')
    expect(buildPushBody('Alex', 'comp_regex_backstop')).toBe('Reply to Alex — comp request')
    expect(buildPushBody('Alex', 'fidelity_below_auto_send_floor')).toBe(
      'Reply to Alex — low fidelity',
    )
  })

  it('falls back to "a guest" when first name is null / empty / whitespace', () => {
    expect(buildPushBody(null, 'model_flagged')).toBe('Reply to a guest — needs review')
    expect(buildPushBody('', 'model_flagged')).toBe('Reply to a guest — needs review')
    expect(buildPushBody('   ', 'model_flagged')).toBe('Reply to a guest — needs review')
  })

  it('drops context dash for triggers without a mapping (defensive fallback)', () => {
    expect(buildPushBody('Alex', 'previous_pending_held')).toBe('Reply to Alex')
    expect(buildPushBody(null, 'previous_pending_held')).toBe('Reply to a guest')
  })

  it('truncates the name when the assembled body exceeds 40 chars', () => {
    const body = buildPushBody('Christopherbartholomew', 'comp_regex_backstop')
    expect(body.length).toBeLessThanOrEqual(40)
    expect(body.startsWith('Reply to ')).toBe(true)
    expect(body.endsWith('— comp request')).toBe(true)
  })
})

function firstCallProps<T>(mock: { mock: { calls: T[][] } }): T {
  const calls = mock.mock.calls
  if (calls.length === 0) throw new Error('mock was not called')
  const args = calls[0]
  if (args === undefined || args.length === 0) {
    throw new Error('first call had no args')
  }
  return args[0] as T
}

describe('sendDraftFlaggedPush', () => {
  it('skips entirely when primaryTrigger is filtered out', async () => {
    await sendDraftFlaggedPush({ ...baseInput, primaryTrigger: 'previous_pending_held' })
    expect(fromMock).not.toHaveBeenCalled()
    expect(sendApnsRequestMock).not.toHaveBeenCalled()
    expect(capturePushSentMock).not.toHaveBeenCalled()
  })

  it('no-ops silently when no operators have a registered token for the venue', async () => {
    queue('operator_venues', { data: [], error: null })
    await sendDraftFlaggedPush(baseInput)
    expect(sendApnsRequestMock).not.toHaveBeenCalled()
    expect(capturePushSentMock).not.toHaveBeenCalled()
  })

  // The 200 path previously logged only the badge, so a UAT run could not
  // tell "APNs accepted it" from "we never reached APNs" without waiting on
  // PostHog. Status/reason/apnsId must be on EVERY response line.
  it('logs status, reason and apnsId on a 200 — not just on failures', async () => {
    queue('operator_venues', {
      data: [{ operator: { id: 'op-1', apns_device_token: 'tok-1' } }],
      error: null,
    })
    queue('operator_venues', { data: [{ venue_id: 'venue-1' }], error: null })
    queue('messages', { count: 3, error: null })
    sendApnsRequestMock.mockResolvedValueOnce({
      ok: true,
      response: { status: 200, reason: null, apnsId: 'A1B2C3D4-0000-1111-2222-333344445555' },
    })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await sendDraftFlaggedPush(baseInput)
      const responseLine = logSpy.mock.calls.find((c) => c[0] === '[apns] apns response')
      expect(responseLine, 'expected an [apns] apns response log on the 200 path').toBeDefined()
      expect(responseLine?.[1]).toMatchObject({
        status: 200,
        reason: null,
        apnsId: 'A1B2C3D4-0000-1111-2222-333344445555',
        operatorId: 'op-1',
      })
    } finally {
      logSpy.mockRestore()
    }
  })

  it('sends a push with the contracted payload shape on 200', async () => {
    queue('operator_venues', {
      data: [{ operator: { id: 'op-1', apns_device_token: 'tok-1' } }],
      error: null,
    })
    queue('operator_venues', { data: [{ venue_id: 'venue-1' }], error: null })
    queue('messages', { count: 3, error: null })

    sendApnsRequestMock.mockResolvedValueOnce({
      ok: true,
      response: { status: 200, reason: null, apnsId: null },
    })

    await sendDraftFlaggedPush(baseInput)

    expect(sendApnsRequestMock).toHaveBeenCalledTimes(1)
    const arg = sendApnsRequestMock.mock.calls[0]?.[0]
    expect(arg).toBeDefined()
    if (!arg) return
    expect(arg.deviceToken).toBe('tok-1')
    expect(arg.body).toEqual({
      aps: {
        alert: { title: 'New draft to review', body: 'Reply to Alex — needs review' },
        badge: 3,
        sound: 'default',
      },
      draftId: 'draft-1',
      guestId: 'guest-1',
      operatorId: 'op-1',
    })

    expect(capturePushSentMock).toHaveBeenCalledTimes(1)
    const props = firstCallProps(capturePushSentMock)
    expect(props).toMatchObject({
      ok: true,
      status: 200,
      operatorId: 'op-1',
      badge: 3,
      error: null,
      errorDetail: null,
    })
  })

  it('asserts the payload contains NO message-content fields (privacy invariant)', async () => {
    queue('operator_venues', {
      data: [{ operator: { id: 'op-1', apns_device_token: 'tok-1' } }],
      error: null,
    })
    queue('operator_venues', { data: [{ venue_id: 'venue-1' }], error: null })
    queue('messages', { count: 1, error: null })
    sendApnsRequestMock.mockResolvedValueOnce({
      ok: true,
      response: { status: 200, reason: null, apnsId: null },
    })

    await sendDraftFlaggedPush(baseInput)

    const arg = sendApnsRequestMock.mock.calls[0]?.[0]
    expect(arg).toBeDefined()
    if (!arg) return
    const serialized = JSON.stringify(arg.body)
    const forbiddenKeys = ['inboundBody', 'generatedBody', 'message', 'draftBody']
    for (const key of forbiddenKeys) {
      expect(serialized.toLowerCase()).not.toContain(`"${key.toLowerCase()}":`)
    }
    const aps = arg.body.aps as { alert: { title: string; body: string } }
    expect(aps.alert.title).toBe('New draft to review')
    expect(aps.alert.body.length).toBeLessThanOrEqual(40)
  })

  it('on 410 Gone nulls the operator token and fires push.token_invalid + push.sent ok=false', async () => {
    queue('operator_venues', {
      data: [{ operator: { id: 'op-1', apns_device_token: 'tok-expired' } }],
      error: null,
    })
    queue('operator_venues', { data: [{ venue_id: 'venue-1' }], error: null })
    queue('messages', { count: 2, error: null })
    queue('operators', { data: null, error: null }) // the nulling UPDATE

    sendApnsRequestMock.mockResolvedValueOnce({
      ok: true,
      response: { status: 410, reason: 'Unregistered', apnsId: null },
    })

    await sendDraftFlaggedPush(baseInput)

    expect(fromMock).toHaveBeenCalledWith('operators')

    expect(capturePushTokenInvalidMock).toHaveBeenCalledTimes(1)
    const invalidProps = firstCallProps(capturePushTokenInvalidMock)
    expect(invalidProps).toMatchObject({
      operatorId: 'op-1',
      status: 410,
      reason: 'Unregistered',
    })

    expect(capturePushSentMock).toHaveBeenCalledTimes(1)
    const sentProps = firstCallProps(capturePushSentMock)
    expect(sentProps).toMatchObject({ ok: false, status: 410 })
  })

  it("on 400 BadDeviceToken also nulls the token (Apple's second way of saying \"token dead\")", async () => {
    queue('operator_venues', {
      data: [{ operator: { id: 'op-1', apns_device_token: 'tok-bad' } }],
      error: null,
    })
    queue('operator_venues', { data: [{ venue_id: 'venue-1' }], error: null })
    queue('messages', { count: 0, error: null })
    queue('operators', { data: null, error: null })

    sendApnsRequestMock.mockResolvedValueOnce({
      ok: true,
      response: { status: 400, reason: 'BadDeviceToken', apnsId: null },
    })

    await sendDraftFlaggedPush(baseInput)

    expect(capturePushTokenInvalidMock).toHaveBeenCalledTimes(1)
    const props = firstCallProps(capturePushTokenInvalidMock)
    expect(props.status).toBe(400)
    expect(props.reason).toBe('BadDeviceToken')
  })

  it('does NOT null the token on 400 with a different reason (e.g. PayloadEmpty)', async () => {
    queue('operator_venues', {
      data: [{ operator: { id: 'op-1', apns_device_token: 'tok-1' } }],
      error: null,
    })
    queue('operator_venues', { data: [{ venue_id: 'venue-1' }], error: null })
    queue('messages', { count: 1, error: null })

    sendApnsRequestMock.mockResolvedValueOnce({
      ok: true,
      response: { status: 400, reason: 'PayloadEmpty', apnsId: null },
    })

    await sendDraftFlaggedPush(baseInput)

    expect(capturePushTokenInvalidMock).not.toHaveBeenCalled()
    expect(capturePushSentMock).toHaveBeenCalledTimes(1)
    expect(firstCallProps(capturePushSentMock)).toMatchObject({ ok: false, status: 400 })
  })

  it('on transport failure fires push.sent ok=false with status=null', async () => {
    queue('operator_venues', {
      data: [{ operator: { id: 'op-1', apns_device_token: 'tok-1' } }],
      error: null,
    })
    queue('operator_venues', { data: [{ venue_id: 'venue-1' }], error: null })
    queue('messages', { count: 1, error: null })

    sendApnsRequestMock.mockResolvedValueOnce({
      ok: false,
      error: 'connection_failed',
      detail: 'ECONNRESET',
    })

    await sendDraftFlaggedPush(baseInput)

    expect(capturePushTokenInvalidMock).not.toHaveBeenCalled()
    expect(capturePushSentMock).toHaveBeenCalledTimes(1)
    const props = firstCallProps(capturePushSentMock)
    expect(props).toMatchObject({
      ok: false,
      status: null,
      error: 'connection_failed',
      errorDetail: 'ECONNRESET',
    })
  })

  it('fans out across multiple operators registered for the same venue', async () => {
    queue('operator_venues', {
      data: [
        { operator: { id: 'op-1', apns_device_token: 'tok-1' } },
        { operator: { id: 'op-2', apns_device_token: 'tok-2' } },
      ],
      error: null,
    })
    queue('operator_venues', { data: [{ venue_id: 'venue-1' }], error: null })
    queue('messages', { count: 1, error: null })
    queue('operator_venues', { data: [{ venue_id: 'venue-1' }], error: null })
    queue('messages', { count: 1, error: null })

    sendApnsRequestMock
      .mockResolvedValueOnce({ ok: true, response: { status: 200, reason: null, apnsId: null } })
      .mockResolvedValueOnce({ ok: true, response: { status: 200, reason: null, apnsId: null } })

    await sendDraftFlaggedPush(baseInput)

    expect(sendApnsRequestMock).toHaveBeenCalledTimes(2)
    expect(capturePushSentMock).toHaveBeenCalledTimes(2)
    const operatorIds = capturePushSentMock.mock.calls
      .map((c) => c[0]?.operatorId)
      .filter((x): x is string => Boolean(x))
    expect(new Set(operatorIds)).toEqual(new Set(['op-1', 'op-2']))
  })
})
