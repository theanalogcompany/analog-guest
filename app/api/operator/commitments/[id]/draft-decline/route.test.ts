// Integration tests for POST /api/operator/commitments/[id]/draft-decline
// (TAC-299, cross-repo sibling TAC-298).
//
// Asserts Contract-literal body shapes:
//   401 → {error: 'unauthorized'}    (NOT err.message)
//   404 → {error: 'not_found'}       (invalid uuid OR doesn't exist OR out-of-allowlist)
//   409 → {error: 'invalid_state'}   (commitment exists but is not pending_ack)
//   422 → {error: 'refused'}         (voice fidelity below send floor)
//   500 → {error: 'internal_error'}  (DB load error OR empty description guard)
//   502 → {error: 'internal_error'}  (pipeline failed inside handleOperatorDecline)
//   200 → {messageId: string}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const verifyMock = vi.fn()
vi.mock('@/lib/auth/verify-jwt', () => ({
  verifyOperatorRequest: (...args: unknown[]) => verifyMock(...args),
}))

const handleDeclineMock = vi.fn()
vi.mock('@/lib/agent', () => ({
  handleOperatorDecline: (...args: unknown[]) => handleDeclineMock(...args),
}))

const markCancelledMock = vi.fn()
vi.mock('@/lib/guests/commitments', () => ({
  markCancelled: (...args: unknown[]) => markCancelledMock(...args),
}))

const capturePostHogMock = vi.fn<(...args: unknown[]) => Promise<void>>()
vi.mock('@/lib/analytics/posthog', () => ({
  captureOperatorDraftDeclineInitiated: (...args: unknown[]) =>
    capturePostHogMock(...args),
}))

const loadMock = vi.fn<() => Promise<{ data: unknown; error: unknown }>>()
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          in: () => ({
            maybeSingle: () => loadMock(),
          }),
        }),
      }),
    }),
  }),
}))

import { POST } from './route'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
const COMMITMENT_ID = '11111111-1111-4111-8111-111111111111'
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222'
const VENUE_A = '00000000-0000-0000-0000-00000000000a'
const GUEST_ID = '33333333-3333-4333-8333-333333333333'
const OP_ID = 'op-1'

function makeRequest(): Request {
  return new Request(
    `https://example.test/api/operator/commitments/${COMMITMENT_ID}/draft-decline`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer fake-jwt' },
    },
  )
}

function params(id = COMMITMENT_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: COMMITMENT_ID,
    venue_id: VENUE_A,
    guest_id: GUEST_ID,
    status: 'pending_ack',
    description: 'olive cake',
    type: 'hold',
    created_at: '2026-05-29T09:55:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  verifyMock.mockReset()
  verifyMock.mockResolvedValue({ operatorId: OP_ID, allowedVenueIds: [VENUE_A] })
  handleDeclineMock.mockReset()
  markCancelledMock.mockReset()
  markCancelledMock.mockResolvedValue({
    ok: true,
    data: { transitioned: true, row: makeRow({ status: 'cancelled' }) },
  })
  capturePostHogMock.mockReset()
  capturePostHogMock.mockResolvedValue(undefined)
  loadMock.mockReset()
  loadMock.mockResolvedValue({ data: makeRow(), error: null })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/operator/commitments/[id]/draft-decline', () => {
  describe('401', () => {
    it("returns {error: 'unauthorized'} on AuthError (sanitized — no err.message leak)", async () => {
      const { AuthError } = await import('@/lib/auth/types')
      verifyMock.mockRejectedValueOnce(
        new AuthError(401, 'invalid or expired token: JWT expired'),
      )
      const res = await POST(makeRequest(), params(VALID_UUID))
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthorized' })
      expect(handleDeclineMock).not.toHaveBeenCalled()
      expect(markCancelledMock).not.toHaveBeenCalled()
    })
  })

  describe('404', () => {
    it("returns 404 not_found on non-UUID params.id (doesn't surface 400)", async () => {
      const res = await POST(makeRequest(), params('not-a-uuid'))
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
      expect(handleDeclineMock).not.toHaveBeenCalled()
    })

    it("returns 404 not_found when commitment doesn't exist OR is out-of-allowlist (uniform)", async () => {
      loadMock.mockResolvedValueOnce({ data: null, error: null })
      const res = await POST(makeRequest(), params())
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
      expect(handleDeclineMock).not.toHaveBeenCalled()
    })

    it("returns 404 not_found when allowedVenueIds is empty (short-circuit)", async () => {
      verifyMock.mockResolvedValueOnce({ operatorId: OP_ID, allowedVenueIds: [] })
      const res = await POST(makeRequest(), params())
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
      expect(loadMock).not.toHaveBeenCalled()
      expect(handleDeclineMock).not.toHaveBeenCalled()
    })
  })

  describe('409', () => {
    it.each([
      'open',
      'cancelled',
      'acknowledged',
      'expired',
      'redeemed',
    ])("returns {error: 'invalid_state'} when commitment status is %s", async (status) => {
      loadMock.mockResolvedValueOnce({ data: makeRow({ status }), error: null })
      const res = await POST(makeRequest(), params())
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'invalid_state' })
      expect(handleDeclineMock).not.toHaveBeenCalled()
    })
  })

  describe('500', () => {
    it("returns {error: 'internal_error'} when commitment load errors", async () => {
      loadMock.mockResolvedValueOnce({ data: null, error: { message: 'connection lost' } })
      const res = await POST(makeRequest(), params())
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'internal_error' })
      expect(handleDeclineMock).not.toHaveBeenCalled()
    })

    it("returns 500 when commitment has empty description (defensive guard)", async () => {
      loadMock.mockResolvedValueOnce({ data: makeRow({ description: '' }), error: null })
      const res = await POST(makeRequest(), params())
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'internal_error' })
      expect(handleDeclineMock).not.toHaveBeenCalled()
    })
  })

  describe('422', () => {
    it("returns {error: 'refused'} when handleOperatorDecline reports refused (low fidelity)", async () => {
      handleDeclineMock.mockResolvedValueOnce({
        status: 'refused',
        reason: 'low_fidelity',
        attemptScores: [0.32, 0.35, 0.38],
      })
      const res = await POST(makeRequest(), params())
      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ error: 'refused' })
      // Refused → don't mark cancelled (commitment still pending_ack;
      // operator can swipe-left again if they want a retry).
      expect(markCancelledMock).not.toHaveBeenCalled()
    })
  })

  describe('502', () => {
    it("returns {error: 'internal_error'} when handleOperatorDecline returns failed", async () => {
      handleDeclineMock.mockResolvedValueOnce({
        status: 'failed',
        stage: 'persist',
        error: 'db connection lost',
      })
      const res = await POST(makeRequest(), params())
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: 'internal_error' })
    })

    it("returns 502 on an unexpected pipeline status (defensive)", async () => {
      handleDeclineMock.mockResolvedValueOnce({ status: 'sent', outboundMessageId: MESSAGE_ID })
      const res = await POST(makeRequest(), params())
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: 'internal_error' })
    })
  })

  describe('200 (happy path)', () => {
    beforeEach(() => {
      handleDeclineMock.mockResolvedValue({
        status: 'queued',
        outboundMessageId: MESSAGE_ID,
        triggers: ['operator_decline_initiated'],
        primaryTrigger: 'operator_decline_initiated',
      })
    })

    it("returns 200 {messageId} per Contract on the happy path", async () => {
      const res = await POST(makeRequest(), params())
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ messageId: MESSAGE_ID })
    })

    it("invokes handleOperatorDecline AFTER load + before markCancelled", async () => {
      const callOrder: string[] = []
      handleDeclineMock.mockImplementationOnce(async () => {
        callOrder.push('handleOperatorDecline')
        return {
          status: 'queued',
          outboundMessageId: MESSAGE_ID,
          triggers: ['operator_decline_initiated'],
          primaryTrigger: 'operator_decline_initiated',
        }
      })
      markCancelledMock.mockImplementationOnce(async () => {
        callOrder.push('markCancelled')
        return { ok: true, data: { transitioned: true, row: makeRow({ status: 'cancelled' }) } }
      })
      const res = await POST(makeRequest(), params())
      expect(res.status).toBe(200)
      expect(callOrder).toEqual(['handleOperatorDecline', 'markCancelled'])
    })

    it("threads commitment description into handleOperatorDecline", async () => {
      loadMock.mockResolvedValueOnce({
        data: makeRow({ description: 'oat milk olive cake' }),
        error: null,
      })
      await POST(makeRequest(), params())
      expect(handleDeclineMock).toHaveBeenCalledOnce()
      const callArg = handleDeclineMock.mock.calls[0][0] as {
        commitmentDescription: string
        venueId: string
        guestId: string
        commitmentId: string
      }
      expect(callArg.commitmentDescription).toBe('oat milk olive cake')
      expect(callArg.venueId).toBe(VENUE_A)
      expect(callArg.guestId).toBe(GUEST_ID)
      expect(callArg.commitmentId).toBe(COMMITMENT_ID)
    })

    it("returns 200 when markCancelled CAS lost (transitioned=false) — race accepted", async () => {
      markCancelledMock.mockResolvedValueOnce({
        ok: true,
        data: { transitioned: false, row: null },
      })
      const res = await POST(makeRequest(), params())
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ messageId: MESSAGE_ID })
      // PostHog event records the race-loss for observability
      expect(capturePostHogMock).toHaveBeenCalledOnce()
      const props = capturePostHogMock.mock.calls[0][0] as {
        commitmentCancellationRaceLost: boolean
      }
      expect(props.commitmentCancellationRaceLost).toBe(true)
    })

    it("returns 200 when markCancelled errored (DB write failure) — recovery-secondary, draft persisted", async () => {
      markCancelledMock.mockResolvedValueOnce({
        ok: false,
        error: 'connection lost',
        errorCode: 'db_write_failed',
      })
      const res = await POST(makeRequest(), params())
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ messageId: MESSAGE_ID })
      const props = capturePostHogMock.mock.calls[0][0] as {
        commitmentCancellationRaceLost: boolean
      }
      expect(props.commitmentCancellationRaceLost).toBe(true)
    })

    it("fires PostHog event exactly once with full metadata", async () => {
      await POST(makeRequest(), params())
      expect(capturePostHogMock).toHaveBeenCalledOnce()
      const props = capturePostHogMock.mock.calls[0][0] as {
        venueId: string
        guestId: string
        commitmentId: string
        messageId: string
        operatorId: string
        type: string
        timeToActionMs: number
        commitmentCancellationRaceLost: boolean
      }
      expect(props.venueId).toBe(VENUE_A)
      expect(props.guestId).toBe(GUEST_ID)
      expect(props.commitmentId).toBe(COMMITMENT_ID)
      expect(props.messageId).toBe(MESSAGE_ID)
      expect(props.operatorId).toBe(OP_ID)
      expect(props.type).toBe('hold')
      expect(props.timeToActionMs).toBeGreaterThanOrEqual(0)
      expect(props.commitmentCancellationRaceLost).toBe(false)
    })
  })
})
