import { describe, expect, it } from 'vitest'
import { activityIndex, orderGuestsByActivity } from './order-guests-by-activity'

const AT = (iso: string) => new Date(iso).getTime()

describe('activityIndex', () => {
  it('maps each guest to its activity time in ms', () => {
    const index = activityIndex([
      { guest_id: 'a', last_interaction_at: '2026-09-20T10:00:00Z' },
      { guest_id: 'b', last_interaction_at: '2026-09-18T10:00:00Z' },
    ])
    expect(index.get('a')).toBe(AT('2026-09-20T10:00:00Z'))
    expect(index.get('b')).toBe(AT('2026-09-18T10:00:00Z'))
  })

  // An unparseable timestamp must not seed the comparator with NaN: `NaN - x`
  // is NaN, which Array.sort reads as "equal", so one bad row would scramble
  // the whole list rather than misplacing itself.
  it('degrades an unparseable timestamp to no-activity rather than NaN', () => {
    const index = activityIndex([{ guest_id: 'a', last_interaction_at: 'not a date' }])
    expect(Number.isFinite(index.get('a'))).toBe(true)
    expect(index.get('a')).toBe(-1)
  })

  it('is empty for no rows', () => {
    expect(activityIndex([]).size).toBe(0)
  })
})

describe('orderGuestsByActivity', () => {
  const guests = [{ id: 'old' }, { id: 'active' }, { id: 'middle' }]

  // The ticket: enrollment order and activity order disagree. `old` enrolled
  // first and messaged most recently; ordering on the stored column put it
  // last, which at a venue past the cap means it is not in the list at all.
  it('orders by most recent activity, not by input order', () => {
    const index = activityIndex([
      { guest_id: 'old', last_interaction_at: '2026-09-20T10:00:00Z' },
      { guest_id: 'active', last_interaction_at: '2026-09-01T10:00:00Z' },
      { guest_id: 'middle', last_interaction_at: '2026-09-10T10:00:00Z' },
    ])
    expect(orderGuestsByActivity(guests, index, 10).map((g) => g.id)).toEqual([
      'old',
      'middle',
      'active',
    ])
  })

  it('keeps a guest with no activity row, sorted last', () => {
    const index = activityIndex([{ guest_id: 'active', last_interaction_at: '2026-09-20T10:00:00Z' }])
    expect(orderGuestsByActivity([{ id: 'silent' }, { id: 'active' }], index, 10).map((g) => g.id)).toEqual([
      'active',
      'silent',
    ])
  })

  // The truncation half, and the reason ordering is load-bearing rather than
  // cosmetic: the cap is applied AFTER the sort, so the guests that survive it
  // are the active ones. Applied before, an active guest would be cut.
  it('applies the cap after sorting, so the most active survive it', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `g${i}` }))
    const index = activityIndex(
      many.map((g, i) => ({
        guest_id: g.id,
        // g0 oldest ... g4 newest
        last_interaction_at: new Date(Date.UTC(2026, 8, 1 + i)).toISOString(),
      })),
    )
    expect(orderGuestsByActivity(many, index, 2).map((g) => g.id)).toEqual(['g4', 'g3'])
  })

  it('does not mutate its input', () => {
    const input = [{ id: 'b' }, { id: 'a' }]
    const index = activityIndex([{ guest_id: 'a', last_interaction_at: '2026-09-20T10:00:00Z' }])
    orderGuestsByActivity(input, index, 10)
    expect(input.map((g) => g.id)).toEqual(['b', 'a'])
  })

  // Two guests sharing a millisecond sort unstably without a tiebreak, so the
  // dropdown would reorder itself between page loads on a seeded venue.
  it('breaks ties on id so the order is total', () => {
    const same = '2026-09-20T10:00:00Z'
    const index = activityIndex([
      { guest_id: 'b', last_interaction_at: same },
      { guest_id: 'a', last_interaction_at: same },
    ])
    expect(orderGuestsByActivity([{ id: 'b' }, { id: 'a' }], index, 10).map((g) => g.id)).toEqual([
      'a',
      'b',
    ])
    expect(orderGuestsByActivity([{ id: 'a' }, { id: 'b' }], index, 10).map((g) => g.id)).toEqual([
      'a',
      'b',
    ])
  })

  // The no-activity tail. Without the enrollment tiebreak this falls to UUID
  // order — and at a freshly seeded venue EVERY guest is in this tail, so the
  // whole dropdown would be UUID-ordered where it used to be by enrollment.
  //
  // THE IDS SORT AGAINST ENROLLMENT ON PURPOSE. With ids that happen to agree
  // with enrollment order, deleting the tiebreak leaves the id fallback
  // producing the same answer and the test passes against the mutant — which
  // is exactly what the first version of this test did.
  it('orders guests with no activity by enrollment, newest first', () => {
    const guestsByEnrollment = [
      { id: 'aaa-oldest', first_contacted_at: '2026-01-01T00:00:00Z' },
      { id: 'zzz-newest', first_contacted_at: '2026-09-01T00:00:00Z' },
    ]
    expect(orderGuestsByActivity(guestsByEnrollment, new Map(), 10).map((g) => g.id)).toEqual([
      'zzz-newest',
      'aaa-oldest',
    ])
  })

  // Enrollment is the SECOND key, never the first: a long-enrolled guest who
  // messaged today still outranks a guest who enrolled today and never wrote.
  it('ranks activity above enrollment', () => {
    const index = activityIndex([
      { guest_id: 'old-but-active', last_interaction_at: '2026-09-20T10:00:00Z' },
    ])
    const ordered = orderGuestsByActivity(
      [
        { id: 'new-and-silent', first_contacted_at: '2026-09-19T00:00:00Z' },
        { id: 'old-but-active', first_contacted_at: '2026-01-01T00:00:00Z' },
      ],
      index,
      10,
    )
    expect(ordered.map((g) => g.id)).toEqual(['old-but-active', 'new-and-silent'])
  })

  it('falls back to id when enrollment is absent on both', () => {
    expect(orderGuestsByActivity([{ id: 'b' }, { id: 'a' }], new Map(), 10).map((g) => g.id)).toEqual([
      'a',
      'b',
    ])
  })

  it('returns everything when the list is under the cap', () => {
    expect(orderGuestsByActivity(guests, new Map(), 10)).toHaveLength(3)
  })

  it('preserves the full guest shape, not just the id', () => {
    const index = activityIndex([{ guest_id: 'a', last_interaction_at: '2026-09-20T10:00:00Z' }])
    const [first] = orderGuestsByActivity([{ id: 'a', firstName: 'Ada' }], index, 10)
    expect(first).toEqual({ id: 'a', firstName: 'Ada' })
  })
})
