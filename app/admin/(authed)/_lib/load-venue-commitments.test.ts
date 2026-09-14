import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))

import { createAdminClient } from '@/lib/db/admin'
import { CommitmentStatusSchema } from '@/lib/schemas/guest-commitment'
import {
  CLOSED_COMMITMENTS_LIMIT,
  NON_TERMINAL_STATUSES,
  TERMINAL_STATUSES,
  loadVenueCommitments,
} from './load-venue-commitments'

const VENUE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const GUEST_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

interface QueryCall {
  /** Which from() call this belongs to — 0 is the open query, 1 the closed one. */
  query: number
  method: string
  args: unknown[]
}

type Result = { data: unknown; error: { message: string } | null }

/**
 * The loader fires two queries in one Promise.all, so the mock hands each
 * from() call its OWN builder and its own queued result. A single shared
 * builder (the shape load-intention-prompts.test.ts uses for its single query)
 * would resolve both to the same rows and make the open/closed split
 * untestable.
 */
function mockQueries(results: Result[]) {
  const calls: QueryCall[] = []
  let index = 0
  const from = vi.fn(() => {
    const query = index
    const result = results[index] ?? { data: [], error: null }
    index += 1
    const builder: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'in', 'order', 'limit']) {
      builder[method] = vi.fn((...args: unknown[]) => {
        calls.push({ query, method, args })
        return builder
      })
    }
    builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return builder
  })
  vi.mocked(createAdminClient).mockReturnValue({ from } as unknown as ReturnType<
    typeof createAdminClient
  >)
  return { calls, from }
}

const dbRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  guest_id: GUEST_ID,
  venue_id: VENUE_ID,
  type: 'comp',
  description: 'replacement matcha',
  code: 'Q4X9',
  status: 'open',
  expected_arrival: null,
  arrival_signal: null,
  created_by: 'agent',
  expires_at: '2026-11-07T00:00:00.000Z',
  escalated_at: null,
  acknowledged_at: null,
  acknowledged_by: null,
  redeemed_at: null,
  source_message_id: null,
  created_at: '2026-09-08T10:00:00.000Z',
  updated_at: '2026-09-08T10:00:00.000Z',
  guest: { first_name: 'Liam', last_name: 'Chen', phone_number: '+15555550142' },
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('loadVenueCommitments', () => {
  // §5's headline case. Both arrival columns null means the row cannot match
  // findScheduledOpenCommitments and cannot reach listHeadsUpQueue — this page
  // is the only place it is visible, so the projection is asserted whole.
  it('projects an untimed open comp, the case invisible everywhere else', async () => {
    mockQueries([{ data: [dbRow()], error: null }, { data: [], error: null }])

    const { open, closed, closedHasMore } = await loadVenueCommitments(VENUE_ID)

    // Whole-object, not toMatchObject: a partial match passes while a field
    // silently goes missing, which is the shape of the bug this page exists
    // to surface.
    expect(open).toEqual([
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        type: 'comp',
        status: 'open',
        description: 'replacement matcha',
        code: 'Q4X9',
        guestLabel: 'Liam Chen · +15555550142',
        createdAt: '2026-09-08T10:00:00.000Z',
        expiresAt: '2026-11-07T00:00:00.000Z',
        escalatedAt: null,
        expectedArrival: null,
        arrivalSignal: null,
      },
    ])
    expect(closed).toEqual([])
    expect(closedHasMore).toBe(false)
  })

  it('carries escalated_at through rather than dropping it', async () => {
    mockQueries([
      { data: [dbRow({ escalated_at: '2026-09-15T09:00:00.000Z' })], error: null },
      { data: [], error: null },
    ])

    const { open } = await loadVenueCommitments(VENUE_ID)
    expect(open[0].escalatedAt).toBe('2026-09-15T09:00:00.000Z')
  })

  it('returns empty lists for a venue with nothing open', async () => {
    mockQueries([{ data: [], error: null }, { data: [], error: null }])

    await expect(loadVenueCommitments(VENUE_ID)).resolves.toEqual({
      open: [],
      closed: [],
      closedHasMore: false,
      openDegraded: false,
      closedDegraded: false,
    })
  })

  it('falls back to the phone number when the guest has no name', async () => {
    mockQueries([
      {
        data: [
          dbRow({ guest: { first_name: null, last_name: null, phone_number: '+15555550142' } }),
        ],
        error: null,
      },
      { data: [], error: null },
    ])

    const { open } = await loadVenueCommitments(VENUE_ID)
    expect(open[0].guestLabel).toBe('+15555550142')
  })

  // The mock ignores its arguments, so behaviour alone cannot pin the query.
  // Asserted directly — the same technique TAC-377 used to kill a dropped-
  // column mutant. A dropped status filter would quietly drag months of
  // history into the "still owed" list.
  it('scopes the open query to the venue and to non-terminal statuses', async () => {
    const { calls, from } = mockQueries([
      { data: [], error: null },
      { data: [], error: null },
    ])

    await loadVenueCommitments(VENUE_ID)

    expect(from).toHaveBeenCalledWith('guest_commitments')
    const openCalls = calls.filter((c) => c.query === 0)
    expect(openCalls.find((c) => c.method === 'eq')?.args).toEqual(['venue_id', VENUE_ID])
    expect(openCalls.find((c) => c.method === 'in')?.args).toEqual([
      'status',
      [...NON_TERMINAL_STATUSES],
    ])
    expect(openCalls.find((c) => c.method === 'order')?.args).toEqual([
      'created_at',
      { ascending: true },
    ])
    // No cap on the open set: an uncapped obligation is the whole point.
    expect(openCalls.some((c) => c.method === 'limit')).toBe(false)
    const select = openCalls.find((c) => c.method === 'select')?.args[0] as string
    expect(select).toContain('guest:guests!inner(first_name, last_name, phone_number)')
    expect(select).toContain('escalated_at')
  })

  it('reads the closed list separately, capped, newest-first', async () => {
    const { calls } = mockQueries([
      { data: [], error: null },
      { data: [], error: null },
    ])

    await loadVenueCommitments(VENUE_ID)

    const closedCalls = calls.filter((c) => c.query === 1)
    // Load-bearing: without this the closed query could lose its venue scope
    // and leak another venue's history onto the page with every test green.
    // Mutation-verified — removing the .eq() fails here and nowhere else.
    expect(closedCalls.find((c) => c.method === 'eq')?.args).toEqual(['venue_id', VENUE_ID])
    expect(closedCalls.find((c) => c.method === 'in')?.args).toEqual([
      'status',
      [...TERMINAL_STATUSES],
    ])
    // The page label says "the 20 most recent"; ascending would make it "the
    // 20 oldest" while reading identically.
    expect(closedCalls.find((c) => c.method === 'order')?.args).toEqual([
      'updated_at',
      { ascending: false },
    ])
    // limit + 1 is load-bearing, not an off-by-one: the probe row is what
    // distinguishes exactly-at-cap from over-cap.
    expect(closedCalls.find((c) => c.method === 'limit')?.args).toEqual([
      CLOSED_COMMITMENTS_LIMIT + 1,
    ])
  })

  it('reports closedHasMore false at exactly the cap and true one past it', async () => {
    const atCap = Array.from({ length: CLOSED_COMMITMENTS_LIMIT }, (_, i) =>
      dbRow({ id: `row-${i}`, status: 'expired' }),
    )
    mockQueries([{ data: [], error: null }, { data: atCap, error: null }])
    const exact = await loadVenueCommitments(VENUE_ID)
    expect(exact.closed).toHaveLength(CLOSED_COMMITMENTS_LIMIT)
    expect(exact.closedHasMore).toBe(false)

    vi.clearAllMocks()
    const overCap = Array.from({ length: CLOSED_COMMITMENTS_LIMIT + 1 }, (_, i) =>
      dbRow({ id: `over-${i}`, status: 'expired' }),
    )
    mockQueries([{ data: [], error: null }, { data: overCap, error: null }])
    const over = await loadVenueCommitments(VENUE_ID)
    expect(over.closedHasMore).toBe(true)
    // The extra row is a probe, never rendered.
    expect(over.closed).toHaveLength(CLOSED_COMMITMENTS_LIMIT)
  })

  it('skips an unparseable row and keeps the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockQueries([
      {
        data: [dbRow({ id: 'good-1' }), dbRow({ id: 'bad-1', type: 'a_type_from_the_future' })],
        error: null,
      },
      { data: [], error: null },
    ])

    const { open } = await loadVenueCommitments(VENUE_ID)
    expect(open.map((r) => r.id)).toEqual(['good-1'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  // The two halves degrade independently. History failing must never blank the
  // list that represents money owed.
  it('keeps the open list when only the closed query fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockQueries([
      { data: [dbRow()], error: null },
      { data: null, error: { message: 'connection reset' } },
    ])

    const { open, closed, closedHasMore } = await loadVenueCommitments(VENUE_ID)
    expect(open).toHaveLength(1)
    expect(closed).toEqual([])
    expect(closedHasMore).toBe(false)
    warn.mockRestore()
  })

  // Without these flags the page renders "This venue owes no guest anything"
  // off a query that never ran — an absolute claim about money owed. The flag
  // is the only thing that distinguishes that from a real empty venue.
  it('flags openDegraded so the page cannot claim the venue owes nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockQueries([
      { data: null, error: { message: 'connection reset' } },
      { data: [], error: null },
    ])

    const { openDegraded, closedDegraded } = await loadVenueCommitments(VENUE_ID)
    expect(openDegraded).toBe(true)
    expect(closedDegraded).toBe(false)
    warn.mockRestore()
  })

  it('flags closedDegraded independently of the open half', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockQueries([
      { data: [dbRow()], error: null },
      { data: null, error: { message: 'connection reset' } },
    ])

    const { open, openDegraded, closedDegraded } = await loadVenueCommitments(VENUE_ID)
    expect(open).toHaveLength(1)
    expect(openDegraded).toBe(false)
    expect(closedDegraded).toBe(true)
    warn.mockRestore()
  })

  it('reports neither degraded on a clean read', async () => {
    mockQueries([{ data: [dbRow()], error: null }, { data: [], error: null }])
    const r = await loadVenueCommitments(VENUE_ID)
    expect(r.openDegraded).toBe(false)
    expect(r.closedDegraded).toBe(false)
  })

  it('degrades to empty instead of throwing when the open query fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockQueries([
      { data: null, error: { message: 'connection reset' } },
      { data: [], error: null },
    ])

    await expect(loadVenueCommitments(VENUE_ID)).resolves.toEqual({
      open: [],
      closed: [],
      closedHasMore: false,
      // Whole-shape, so the flag cannot go missing here: an empty list with
      // openDegraded false is the page asserting the venue owes nothing.
      openDegraded: true,
      closedDegraded: false,
    })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  // Asserts against the SCHEMA, not a hardcoded list. An earlier version
  // compared the two constants to six inline literals, which could only ever
  // confirm them against themselves: code review added a seventh status to
  // CommitmentStatusSchema and this test stayed green while the new status
  // matched neither `.in()` filter and was invisible on the page. Reading
  // CommitmentStatusSchema.options is what makes it fail.
  it('partitions every status in the schema into exactly one of the two lists', () => {
    const all = [...NON_TERMINAL_STATUSES, ...TERMINAL_STATUSES]
    expect(new Set(all).size, 'a status appears in both lists').toBe(all.length)
    expect(new Set(all)).toEqual(new Set(CommitmentStatusSchema.options))
  })
})
