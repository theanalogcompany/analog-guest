import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadGuestThreadByGuestId } from './guest-thread'

const VENUE_A = '00000000-0000-0000-0000-00000000000a'
const VENUE_B = '00000000-0000-0000-0000-00000000000b'
const GUEST_X = '00000000-0000-0000-0000-000000000001'

let nextGuestLookup: { data: unknown; error: { message: string } | null } = {
  data: null,
  error: null,
}
let nextThreadRows: { data: unknown; error: { message: string } | null } = {
  data: [],
  error: null,
}

const limitMock = vi.fn(() => Promise.resolve(nextThreadRows))
const orderMock = vi.fn(() => ({ limit: limitMock }))
const neqMock = vi.fn(() => ({ order: orderMock }))
const eqGuestMock = vi.fn(() => ({ neq: neqMock }))
const eqVenueMock = vi.fn(() => ({ eq: eqGuestMock }))
const maybeSingleMock = vi.fn(() => Promise.resolve(nextGuestLookup))
const eqIdMock = vi.fn(() => ({ maybeSingle: maybeSingleMock }))

const selectMock = vi.fn((cols: string) => {
  if (cols === 'venue_id') return { eq: eqIdMock }
  return { eq: eqVenueMock }
})
const fromMock = vi.fn(() => ({ select: selectMock }))

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({ from: fromMock }),
}))

beforeEach(() => {
  nextGuestLookup = { data: null, error: null }
  nextThreadRows = { data: [], error: null }
  fromMock.mockClear()
  selectMock.mockClear()
  eqIdMock.mockClear()
  maybeSingleMock.mockClear()
  eqVenueMock.mockClear()
  eqGuestMock.mockClear()
  neqMock.mockClear()
  orderMock.mockClear()
  limitMock.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('loadGuestThreadByGuestId', () => {
  it('short-circuits to out_of_allowlist when allowedVenueIds is empty', async () => {
    const result = await loadGuestThreadByGuestId({ guestId: GUEST_X, allowedVenueIds: [] })
    expect(result).toEqual({ ok: false, errorCode: 'out_of_allowlist' })
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('returns guest_not_found when the guest lookup returns no row', async () => {
    nextGuestLookup = { data: null, error: null }
    const result = await loadGuestThreadByGuestId({
      guestId: GUEST_X,
      allowedVenueIds: [VENUE_A],
    })
    expect(result).toEqual({ ok: false, errorCode: 'guest_not_found' })
    expect(eqIdMock).toHaveBeenCalledWith('id', GUEST_X)
  })

  it('returns out_of_allowlist when the guest exists at a venue outside the allowlist', async () => {
    nextGuestLookup = { data: { venue_id: VENUE_B }, error: null }
    const result = await loadGuestThreadByGuestId({
      guestId: GUEST_X,
      allowedVenueIds: [VENUE_A],
    })
    expect(result).toEqual({ ok: false, errorCode: 'out_of_allowlist' })
    expect(eqVenueMock).not.toHaveBeenCalled()
  })

  it('returns the thread for a guest inside the allowlist', async () => {
    nextGuestLookup = { data: { venue_id: VENUE_A }, error: null }
    nextThreadRows = {
      data: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          body: 'hey!',
          direction: 'inbound',
          created_at: '2026-09-05T18:00:00.000Z',
        },
      ],
      error: null,
    }
    const result = await loadGuestThreadByGuestId({
      guestId: GUEST_X,
      allowedVenueIds: [VENUE_A],
    })
    expect(result).toEqual({
      ok: true,
      messages: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          direction: 'inbound',
          body: 'hey!',
          createdAt: '2026-09-05T18:00:00.000Z',
        },
      ],
    })
    expect(eqGuestMock).toHaveBeenCalledWith('guest_id', GUEST_X)
  })

  it('returns db_error when the guest lookup errors', async () => {
    nextGuestLookup = { data: null, error: { message: 'connection lost' } }
    const result = await loadGuestThreadByGuestId({
      guestId: GUEST_X,
      allowedVenueIds: [VENUE_A],
    })
    expect(result).toEqual({ ok: false, errorCode: 'db_error', error: 'connection lost' })
  })
})
