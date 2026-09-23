import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))

import { createAdminClient } from '@/lib/db/admin'
import { INTENTION_KEYS } from '@/lib/agent/intentions/definitions'
import { loadIntentionPrompts, RECORDED_PROMPTS_LIMIT } from './load-intention-prompts'
import { adminVenueScope } from '@/lib/auth/venue-scope'

const VENUE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

interface QueryCall {
  method: string
  args: unknown[]
}

function mockQuery(result: { data: unknown; error: { message: string } | null }) {
  const calls: QueryCall[] = []
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'order', 'limit', 'in', 'not']) {
    builder[method] = vi.fn((...args: unknown[]) => {
      calls.push({ method, args })
      return builder
    })
  }
  // The supabase query builder is thenable; awaiting it resolves the query.
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)

  const from = vi.fn(() => builder)
  vi.mocked(createAdminClient).mockReturnValue({ from } as unknown as ReturnType<
    typeof createAdminClient
  >)
  return { calls, from }
}

const dbRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  intention_key: 'understand_order',
  prompted_at: '2026-09-13T10:00:00.000Z',
  message_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  prompt_source: 'classified',
  guest: { first_name: 'Liam', last_name: 'Chen', phone_number: '+15555550142' },
  venue: { name: "Le Mil's Coffee" },
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('loadIntentionPrompts', () => {
  it('projects a recorded prompt with its guest, venue and timestamp', async () => {
    mockQuery({ data: [dbRow()], error: null })

    const { rows, hasMore } = await loadIntentionPrompts(adminVenueScope([]))

    // Whole-object assertion, not toMatchObject: a partial match would pass
    // while a field silently went missing.
    expect(rows).toEqual([
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        intentionKey: 'understand_order',
        promptedAt: '2026-09-13T10:00:00.000Z',
        messageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        promptSource: 'classified',
        guestLabel: 'Liam Chen · +15555550142',
        venueName: "Le Mil's Coffee",
      },
    ])
    expect(hasMore).toBe(false)
  })

  // §5: "the recorded-prompts query returns correctly for a guest with one
  // and a guest with none." The none case is the live shape today — one row
  // exists fleet-wide, so most filters return nothing.
  it('returns an empty list when the guest has no recorded prompts', async () => {
    mockQuery({ data: [], error: null })
    await expect(loadIntentionPrompts(adminVenueScope([]))).resolves.toEqual({ rows: [], hasMore: false })
  })

  it('falls back to the phone number when the guest has no name', async () => {
    mockQuery({
      data: [dbRow({ guest: { first_name: null, last_name: null, phone_number: '+15555550142' } })],
      error: null,
    })

    const { rows } = await loadIntentionPrompts(adminVenueScope([]))
    expect(rows[0].guestLabel).toBe('+15555550142')
  })

  // TAC-479: an Instagram guest with no name shows their handle, once fetched.
  it('shows the Instagram handle for a guest with no name and no phone', async () => {
    mockQuery({
      data: [dbRow({ guest: { first_name: null, last_name: null, phone_number: null, instagram_username: 'maya.oakland' } })],
      error: null,
    })

    const { rows } = await loadIntentionPrompts(adminVenueScope([]))
    expect(rows[0].guestLabel).toBe('@maya.oakland')
  })

  it('preserves a null message_id rather than inventing one', async () => {
    mockQuery({ data: [dbRow({ message_id: null })], error: null })

    const { rows } = await loadIntentionPrompts(adminVenueScope([]))
    expect(rows[0].messageId).toBeNull()
  })

  // TAC-380: a pessimistic closure asked nothing for certain; the viewer marks
  // it, so the source must survive the projection.
  it('carries a pessimistic prompt_source through to the row', async () => {
    mockQuery({ data: [dbRow({ prompt_source: 'pessimistic' })], error: null })

    const { rows } = await loadIntentionPrompts(adminVenueScope([]))
    expect(rows[0].promptSource).toBe('pessimistic')
  })

  // Load-bearing. intention_key is bare text with no FK (migration 035), so a
  // renamed or removed definition leaves orphan history. Filtering those out
  // here would hide the rows that prove the point; the viewer marks them
  // unrecognized instead.
  it('passes through an intention_key that matches no definition', async () => {
    const orphanKey = 'retired_intention_v0'
    // Guards the guard: if someone ever ships this key for real, this test
    // stops meaning anything, so fail loudly instead.
    expect(INTENTION_KEYS as readonly string[]).not.toContain(orphanKey)

    mockQuery({ data: [dbRow({ intention_key: orphanKey })], error: null })

    const { rows } = await loadIntentionPrompts(adminVenueScope([]))
    expect(rows).toHaveLength(1)
    expect(rows[0].intentionKey).toBe(orphanKey)
  })

  it('scopes to the allowlist when one is present', async () => {
    const { calls } = mockQuery({ data: [], error: null })

    await loadIntentionPrompts(adminVenueScope([VENUE_ID]))

    expect(calls.filter((c) => c.method === 'in')).toEqual([
      { method: 'in', args: ['venue_id', [VENUE_ID]] },
    ])
  })

  // Empty allowlist is analog-admin scope (sees everything), exactly as
  // load-venues.ts treats it. Asserting the ABSENCE of the filter, because an
  // accidental `.in('venue_id', [])` would return nothing at all.
  it('applies no venue filter when the allowlist is empty', async () => {
    const { calls } = mockQuery({ data: [], error: null })

    await loadIntentionPrompts(adminVenueScope([]))

    expect(calls.some((c) => c.method === 'in')).toBe(false)
  })

  // The mock ignores its arguments, so behaviour alone cannot pin the query.
  // Asserted directly, same technique TAC-377 used to kill a dropped-column
  // mutant.
  it('reads newest-first, bounded, with the guest and venue embeds', async () => {
    const { calls, from } = mockQuery({ data: [], error: null })

    await loadIntentionPrompts(adminVenueScope([]))

    expect(from).toHaveBeenCalledWith('guest_intention_prompts')
    const select = calls.find((c) => c.method === 'select')?.args[0] as string
    expect(select).toContain('guest:guests!inner(first_name, last_name, phone_number, instagram_username)')
    expect(select).toContain('venue:venues!inner(name)')
    expect(select).toContain('prompt_source')
    expect(calls.find((c) => c.method === 'order')?.args).toEqual([
      'prompted_at',
      { ascending: false },
    ])
    // limit + 1 is load-bearing, not an off-by-one: the extra row is what
    // distinguishes exactly-at-cap from over-cap. See the hasMore tests.
    expect(calls.find((c) => c.method === 'limit')?.args).toEqual([RECORDED_PROMPTS_LIMIT + 1])
  })

  // TAC-380 trap 5. Since migration 040 the table also holds ELIGIBILITY rows
  // (prompted_at null) — intentions that became askable and haven't been
  // raised. This page lists what was RAISED; without the filter, every
  // eligible intention would render here as already asked. The mock ignores
  // its arguments, so the filter is asserted directly.
  it('reads only rows that were actually prompted (trap 5)', async () => {
    const { calls } = mockQuery({ data: [], error: null })

    await loadIntentionPrompts(adminVenueScope([]))

    expect(calls.filter((c) => c.method === 'not')).toEqual([
      { method: 'not', args: ['prompted_at', 'is', null] },
    ])
  })

  // The boundary is the whole reason the query fetches limit + 1. The page
  // states "older prompts exist" as fact, so exactly-at-cap must NOT claim it.
  it('reports hasMore false when the result is exactly at the cap', async () => {
    const exactly = Array.from({ length: RECORDED_PROMPTS_LIMIT }, (_, i) =>
      dbRow({ id: `row-${i}` }),
    )
    mockQuery({ data: exactly, error: null })

    const { rows, hasMore } = await loadIntentionPrompts(adminVenueScope([]))
    expect(rows).toHaveLength(RECORDED_PROMPTS_LIMIT)
    expect(hasMore).toBe(false)
  })

  it('reports hasMore true and drops the probe row when one row is over the cap', async () => {
    const overflowing = Array.from({ length: RECORDED_PROMPTS_LIMIT + 1 }, (_, i) =>
      dbRow({ id: `row-${i}` }),
    )
    mockQuery({ data: overflowing, error: null })

    const { rows, hasMore } = await loadIntentionPrompts(adminVenueScope([]))
    expect(hasMore).toBe(true)
    // The extra row is a probe, never rendered.
    expect(rows).toHaveLength(RECORDED_PROMPTS_LIMIT)
    expect(rows.at(-1)?.id).toBe(`row-${RECORDED_PROMPTS_LIMIT - 1}`)
  })

  it('degrades to an empty list on a query error instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockQuery({ data: null, error: { message: 'connection reset' } })

    await expect(loadIntentionPrompts(adminVenueScope([]))).resolves.toEqual({ rows: [], hasMore: false })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
