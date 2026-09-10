import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireMechanicAdmin: vi.fn(),
}))
vi.mock('../../../../_lib/mechanics', () => ({
  deactivateMechanic: vi.fn(),
  editMechanic: vi.fn(),
}))

import { requireMechanicAdmin } from '@/lib/auth'
import { deactivateMechanic, editMechanic } from '../../../../_lib/mechanics'
import { DELETE, PATCH } from './route'

const VENUE_ID = '11111111-1111-4111-8111-111111111111'
const OPERATOR_ID = '22222222-2222-4222-8222-222222222222'
const MECHANIC_ID = '33333333-3333-4333-8333-333333333333'

function buildRequest(body?: unknown): Request {
  return new Request('http://test/admin/venues/api/mechanics/x', {
    method: body === undefined ? 'DELETE' : 'PATCH',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json' },
  })
}

function buildParams() {
  return { params: Promise.resolve({ mechanicId: MECHANIC_ID }) }
}

beforeEach(() => {
  vi.mocked(requireMechanicAdmin).mockReset()
  vi.mocked(editMechanic).mockReset()
  vi.mocked(deactivateMechanic).mockReset()
})

describe('PATCH /admin/venues/api/mechanics/[mechanicId]', () => {
  beforeEach(() => {
    vi.mocked(requireMechanicAdmin).mockResolvedValue({
      ok: true,
      operatorId: OPERATOR_ID,
      venueId: VENUE_ID,
      mechanicId: MECHANIC_ID,
    })
  })

  it('200 on a valid partial patch', async () => {
    vi.mocked(editMechanic).mockResolvedValue({ ok: true, mechanicId: MECHANIC_ID })
    const res = await PATCH(buildRequest({ minState: 'raving_fan' }), buildParams())
    expect(res.status).toBe(200)
    expect(editMechanic).toHaveBeenCalledWith({
      mechanicId: MECHANIC_ID,
      patch: { minState: 'raving_fan' },
    })
  })

  it('400 on a per-field violation (empty-string name)', async () => {
    const res = await PATCH(buildRequest({ name: '' }), buildParams())
    expect(res.status).toBe(400)
    expect(editMechanic).not.toHaveBeenCalled()
  })

  it('400 when the helper reports invalid_after_merge', async () => {
    vi.mocked(editMechanic).mockResolvedValue({
      ok: false,
      error: 'redemptionWindowDays must be set when renewable',
      errorCode: 'invalid_after_merge',
    })
    const res = await PATCH(buildRequest({ redemptionPolicy: 'renewable' }), buildParams())
    expect(res.status).toBe(400)
  })

  it('404 when the helper reports not_found', async () => {
    vi.mocked(editMechanic).mockResolvedValue({
      ok: false,
      error: 'mechanic not found',
      errorCode: 'not_found',
    })
    const res = await PATCH(buildRequest({ name: 'New name' }), buildParams())
    expect(res.status).toBe(404)
  })

  it('passes through 404 from auth helper', async () => {
    vi.mocked(requireMechanicAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'mechanic not found' }, { status: 404 }),
    })
    const res = await PATCH(buildRequest({ name: 'New name' }), buildParams())
    expect(res.status).toBe(404)
    expect(editMechanic).not.toHaveBeenCalled()
  })
})

describe('DELETE /admin/venues/api/mechanics/[mechanicId]', () => {
  beforeEach(() => {
    vi.mocked(requireMechanicAdmin).mockResolvedValue({
      ok: true,
      operatorId: OPERATOR_ID,
      venueId: VENUE_ID,
      mechanicId: MECHANIC_ID,
    })
  })

  it('200 on successful deactivate', async () => {
    vi.mocked(deactivateMechanic).mockResolvedValue({ ok: true, mechanicId: MECHANIC_ID })
    const res = await DELETE(buildRequest(), buildParams())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ success: true, deactivated: true })
    expect(deactivateMechanic).toHaveBeenCalledWith(MECHANIC_ID)
  })

  it('404 when the mechanic is already gone', async () => {
    vi.mocked(deactivateMechanic).mockResolvedValue({
      ok: false,
      error: 'not found',
      errorCode: 'not_found',
    })
    const res = await DELETE(buildRequest(), buildParams())
    expect(res.status).toBe(404)
  })

  it('passes through 403 from auth helper', async () => {
    vi.mocked(requireMechanicAdmin).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'venue not allowed' }, { status: 403 }),
    })
    const res = await DELETE(buildRequest(), buildParams())
    expect(res.status).toBe(403)
    expect(deactivateMechanic).not.toHaveBeenCalled()
  })
})
