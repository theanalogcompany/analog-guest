// Integration tests for POST /api/operator/commitments/[id]/acknowledge
// (TAC-297, cross-repo sibling TAC-298).
//
// Asserts Contract-literal body shapes:
//   401 → {error: 'unauthorized'}  (NOT err.message)
//   404 → {error: 'not_found'}     (invalid uuid OR doesn't exist OR out-of-allowlist)
//   409 → {error: 'already_acknowledged'} (CAS-loss with row visible)
//   500 → {error: 'internal_error'}
//   200 → {ok: true}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const verifyMock = vi.fn()
vi.mock('@/lib/auth/verify-jwt', () => ({
  verifyOperatorRequest: (...args: unknown[]) => verifyMock(...args),
}))

const markAcknowledgedMock = vi.fn()
vi.mock('@/lib/guests/commitments', () => ({
  markAcknowledged: (...args: unknown[]) => markAcknowledgedMock(...args),
}))

const capturePostHogMock = vi.fn<(...args: unknown[]) => Promise<void>>()
vi.mock('@/lib/analytics/posthog', () => ({
  captureOperatorCommitmentAcknowledged: (...args: unknown[]) =>
    capturePostHogMock(...args),
}))

const probeMock = vi.fn<() => Promise<{ data: unknown; error: unknown }>>()
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          in: () => ({
            maybeSingle: () => probeMock(),
          }),
        }),
      }),
    }),
  }),
}))

import { POST } from './route'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
const VENUE_A = '00000000-0000-0000-0000-00000000000a'
const OP_ID = 'op-1'

function makeRequest(): Request {
  return new Request(
    `https://example.test/api/operator/commitments/${VALID_UUID}/acknowledge`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer fake-jwt' },
    },
  )
}

function params(id = VALID_UUID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  verifyMock.mockReset()
  verifyMock.mockResolvedValue({ operatorId: OP_ID, allowedVenueIds: [VENUE_A] })
  markAcknowledgedMock.mockReset()
  capturePostHogMock.mockReset()
  capturePostHogMock.mockResolvedValue(undefined)
  probeMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/operator/commitments/[id]/acknowledge', () => {
  describe('401', () => {
    it("returns {error: 'unauthorized'} on AuthError (sanitized — no err.message leak)", async () => {
      const { AuthError } = await import('@/lib/auth/types')
      verifyMock.mockRejectedValueOnce(
        new AuthError(401, 'invalid or expired token: JWT expired'),
      )
      const res = await POST(makeRequest(), params())
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthorized' })
      expect(markAcknowledgedMock).not.toHaveBeenCalled()
    })
  })

  describe('404', () => {
    it("returns 404 not_found on non-UUID params.id (doesn't surface 400)", async () => {
      const res = await POST(makeRequest(), params('not-a-uuid'))
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
      expect(markAcknowledgedMock).not.toHaveBeenCalled()
    })

    it("returns 404 not_found when CAS lost AND probe finds no row (doesn't exist OR out-of-allowlist)", async () => {
      markAcknowledgedMock.mockResolvedValueOnce({
        ok: true,
        data: { transitioned: false, row: null },
      })
      probeMock.mockResolvedValueOnce({ data: null, error: null })
      const res = await POST(makeRequest(), params())
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
    })
  })

  describe('409', () => {
    it("returns {error: 'already_acknowledged'} when CAS lost but probe finds the row", async () => {
      markAcknowledgedMock.mockResolvedValueOnce({
        ok: true,
        data: { transitioned: false, row: null },
      })
      probeMock.mockResolvedValueOnce({ data: { id: VALID_UUID }, error: null })
      const res = await POST(makeRequest(), params())
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'already_acknowledged' })
    })
  })

  describe('500', () => {
    it("returns {error: 'internal_error'} when markAcknowledged returns a DB error", async () => {
      markAcknowledgedMock.mockResolvedValueOnce({
        ok: false,
        error: 'connection lost',
        errorCode: 'db_write_failed',
      })
      const res = await POST(makeRequest(), params())
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'internal_error' })
    })
  })

  describe('200', () => {
    it("returns {ok: true} on CAS win + fires PostHog with commitment metadata", async () => {
      const transitionedRow = {
        id: VALID_UUID,
        venue_id: VENUE_A,
        guest_id: 'guest-1',
        type: 'comp',
        description: 'oat latte',
        code: '7K2P',
        status: 'acknowledged',
        expected_arrival: null,
        arrival_signal: 'imminent',
        created_by: 'agent',
        expires_at: null,
        acknowledged_at: '2026-05-29T10:00:00Z',
        acknowledged_by: OP_ID,
        redeemed_at: null,
        source_message_id: null,
        created_at: '2026-05-29T09:55:00Z',
        updated_at: '2026-05-29T10:00:00Z',
      }
      markAcknowledgedMock.mockResolvedValueOnce({
        ok: true,
        data: { transitioned: true, row: transitionedRow },
      })
      const res = await POST(makeRequest(), params())
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(capturePostHogMock).toHaveBeenCalledOnce()
      const props = capturePostHogMock.mock.calls[0][0] as {
        commitmentId: string
        operatorId: string
        venueId: string
        type: string
      }
      expect(props.commitmentId).toBe(VALID_UUID)
      expect(props.operatorId).toBe(OP_ID)
      expect(props.venueId).toBe(VENUE_A)
      expect(props.type).toBe('comp')
    })
  })
})
