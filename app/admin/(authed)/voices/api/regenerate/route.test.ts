import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireVenueAdmin: vi.fn(),
}))
vi.mock('@/lib/voices', () => ({
  regenerateWithCritique: vi.fn(),
}))

import { requireVenueAdmin } from '@/lib/auth'
import { regenerateWithCritique } from '@/lib/voices'
import { POST } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const MSG_ID = '22222222-2222-4222-8222-222222222222'
const OP_ID = '33333333-3333-4333-8333-333333333333'

function buildRequest(body: unknown): Request {
  return new Request('http://test/admin/voices/api/regenerate', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.mocked(requireVenueAdmin).mockReset()
  vi.mocked(regenerateWithCritique).mockReset()
  vi.mocked(requireVenueAdmin).mockResolvedValue({
    ok: true,
    operatorId: OP_ID,
    venueId: VENUE_ID,
  })
})

describe('POST /admin/voices/api/regenerate', () => {
  it('200 + body+fidelity on happy path', async () => {
    vi.mocked(regenerateWithCritique).mockResolvedValue({
      ok: true,
      data: {
        body: 'yeah. oat is on.',
        voiceFidelity: 0.85,
        attempts: 1,
        attemptScores: [0.85],
        generatedAt: new Date('2026-05-08T10:00:00.000Z'),
      },
    })

    const res = await POST(
      buildRequest({
        venueId: VENUE_ID,
        originalMessageId: MSG_ID,
        critique: 'too eager',
      }),
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({
      success: true,
      body: 'yeah. oat is on.',
      voiceFidelity: 0.85,
      attempts: 1,
    })
  })

  it('400 on empty critique', async () => {
    const res = await POST(
      buildRequest({
        venueId: VENUE_ID,
        originalMessageId: MSG_ID,
        critique: '',
      }),
    )
    expect(res.status).toBe(400)
    expect(regenerateWithCritique).not.toHaveBeenCalled()
  })

  it('404 when message not found', async () => {
    vi.mocked(regenerateWithCritique).mockResolvedValue({
      ok: false,
      errorCode: 'message_not_found',
      error: 'gone',
    })
    const res = await POST(
      buildRequest({
        venueId: VENUE_ID,
        originalMessageId: MSG_ID,
        critique: 'x',
      }),
    )
    expect(res.status).toBe(404)
  })

  it('400 when outbound has no reply_to_message_id', async () => {
    vi.mocked(regenerateWithCritique).mockResolvedValue({
      ok: false,
      errorCode: 'not_an_outbound_reply',
      error: 'no inbound link',
    })
    const res = await POST(
      buildRequest({
        venueId: VENUE_ID,
        originalMessageId: MSG_ID,
        critique: 'x',
      }),
    )
    expect(res.status).toBe(400)
  })

  it('passes through 401 from auth helper', async () => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    })
    const res = await POST(
      buildRequest({
        venueId: VENUE_ID,
        originalMessageId: MSG_ID,
        critique: 'x',
      }),
    )
    expect(res.status).toBe(401)
  })
})
