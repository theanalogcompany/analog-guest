import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireVenueAdmin: vi.fn(),
}))
vi.mock('@/lib/voice-training', () => ({
  dedupeAndAppendAntiPatterns: vi.fn(),
  removeAntiPattern: vi.fn(),
}))

import { requireVenueAdmin } from '@/lib/auth'
import {
  dedupeAndAppendAntiPatterns,
  removeAntiPattern,
} from '@/lib/voice-training'
import { DELETE, POST } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222'

function buildRequest(method: 'POST' | 'DELETE', body: unknown): Request {
  return new Request('http://test/admin/voices/api/venues/x/rules', {
    method,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

function buildParams(venueId: string) {
  return { params: Promise.resolve({ venueId }) }
}

beforeEach(() => {
  vi.mocked(requireVenueAdmin).mockReset()
  vi.mocked(dedupeAndAppendAntiPatterns).mockReset()
  vi.mocked(removeAntiPattern).mockReset()
  vi.mocked(requireVenueAdmin).mockResolvedValue({
    ok: true,
    operatorId: OPERATOR_ID,
    venueId: VENUE_ID,
  })
})

describe('POST /admin/voices/api/venues/[venueId]/rules', () => {
  it('200 + added on happy path; passes operatorId + source=manual', async () => {
    vi.mocked(dedupeAndAppendAntiPatterns).mockResolvedValue({
      existing: [],
      added: ['no marketing flourishes'],
    })
    const res = await POST(
      buildRequest('POST', { ruleText: 'no marketing flourishes' }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(200)
    expect(dedupeAndAppendAntiPatterns).toHaveBeenCalledWith(
      VENUE_ID,
      ['no marketing flourishes'],
      { source: 'manual', authorOperatorId: OPERATOR_ID },
    )
  })

  it('trims outer whitespace before passing to writer', async () => {
    vi.mocked(dedupeAndAppendAntiPatterns).mockResolvedValue({
      existing: [],
      added: ['no marketing flourishes'],
    })
    await POST(
      buildRequest('POST', { ruleText: '   no marketing flourishes   ' }),
      buildParams(VENUE_ID),
    )
    expect(dedupeAndAppendAntiPatterns).toHaveBeenCalledWith(
      VENUE_ID,
      ['no marketing flourishes'],
      expect.any(Object),
    )
  })

  it('400 on whitespace-only ruleText', async () => {
    const res = await POST(
      buildRequest('POST', { ruleText: '    ' }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(400)
    expect(dedupeAndAppendAntiPatterns).not.toHaveBeenCalled()
  })

  it('500 when writer throws', async () => {
    vi.mocked(dedupeAndAppendAntiPatterns).mockRejectedValue(
      new Error('connection lost'),
    )
    const res = await POST(
      buildRequest('POST', { ruleText: 'x' }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(500)
  })

  it('passes through 401 from auth helper', async () => {
    vi.mocked(requireVenueAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    })
    const res = await POST(
      buildRequest('POST', { ruleText: 'x' }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(401)
  })
})

describe('DELETE /admin/voices/api/venues/[venueId]/rules', () => {
  it('200 + removed on happy path', async () => {
    vi.mocked(removeAntiPattern).mockResolvedValue({
      ok: true,
      removed: true,
      remainingCount: 0,
    })
    const res = await DELETE(
      buildRequest('DELETE', { ruleText: 'no marketing flourishes' }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(200)
  })

  it('404 when target rule not present', async () => {
    vi.mocked(removeAntiPattern).mockResolvedValue({
      ok: false,
      error: 'rule not found',
      errorCode: 'not_found',
    })
    const res = await DELETE(
      buildRequest('DELETE', { ruleText: 'gone' }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(404)
  })

  it('500 on db error', async () => {
    vi.mocked(removeAntiPattern).mockResolvedValue({
      ok: false,
      error: 'lookup failed',
      errorCode: 'db_error',
    })
    const res = await DELETE(
      buildRequest('DELETE', { ruleText: 'x' }),
      buildParams(VENUE_ID),
    )
    expect(res.status).toBe(500)
  })
})
