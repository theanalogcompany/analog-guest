// TAC-394: the harness's clean-state preflight reads a guest's pending drafts
// through loadPendingRowsBySlot. A guest can hold one pending card per slot, so
// every card is reported rather than whichever one an unordered read returned,
// and a failed read is reported rather than passed.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadPendingRowsBySlotMock = vi.fn()
const findActiveCommitmentsForGuestMock = vi.fn()

vi.mock('@/lib/agent/pending-slots', () => ({
  loadPendingRowsBySlot: (...args: unknown[]) => loadPendingRowsBySlotMock(...args),
}))
vi.mock('@/lib/guests/commitments', () => ({
  findActiveCommitmentsForGuest: (...args: unknown[]) =>
    findActiveCommitmentsForGuestMock(...args),
}))
vi.mock('@/lib/db/admin', () => ({ createAdminClient: vi.fn() }))

import { checkCleanState } from './preflight'

const VENUE = 'venue-1'
const GUESTS = { new: 'guest-new' }
const PHONES = { new: '+15550001000' }

beforeEach(() => {
  loadPendingRowsBySlotMock.mockReset()
  findActiveCommitmentsForGuestMock.mockReset()
  findActiveCommitmentsForGuestMock.mockResolvedValue({ ok: true, data: [] })
})

describe('checkCleanState — pending drafts (TAC-394)', () => {
  it('reports EVERY pending card for a guest, one per slot', async () => {
    loadPendingRowsBySlotMock.mockResolvedValue({
      obligation: { id: 'card-a', review_reason: 'commitment_type_gated' },
      conversation: [{ id: 'card-conv', review_reason: 'category_requires_approval' }],
    })

    const hits = await checkCleanState(VENUE, GUESTS, PHONES)

    expect(loadPendingRowsBySlotMock).toHaveBeenCalledWith(VENUE, 'guest-new')
    expect(hits).toEqual([
      {
        state: 'new',
        phone: '+15550001000',
        guestId: 'guest-new',
        kind: 'pending_draft',
        detail: 'message id=card-a, slot=obligation, review_reason=commitment_type_gated',
      },
      {
        state: 'new',
        phone: '+15550001000',
        guestId: 'guest-new',
        kind: 'pending_draft',
        detail: 'message id=card-conv, slot=conversation, review_reason=category_requires_approval',
      },
    ])
  })

  it('reports nothing for a guest with no pending cards', async () => {
    loadPendingRowsBySlotMock.mockResolvedValue({ obligation: null, conversation: [] })
    expect(await checkCleanState(VENUE, GUESTS, PHONES)).toEqual([])
  })

  // The check exists to abort a run against a dirty state. Passing because the
  // read failed is the wrong way for it to fail.
  it('reports a failed read instead of passing it', async () => {
    loadPendingRowsBySlotMock.mockResolvedValue(null)
    expect(await checkCleanState(VENUE, GUESTS, PHONES)).toEqual([
      {
        state: 'new',
        phone: '+15550001000',
        guestId: 'guest-new',
        kind: 'pending_draft',
        detail: 'could not read pending drafts; check this guest by hand before running',
      },
    ])
  })
})
