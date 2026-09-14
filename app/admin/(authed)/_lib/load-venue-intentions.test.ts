import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))

import { createAdminClient } from '@/lib/db/admin'
import { INTENTION_DEFINITIONS } from '@/lib/agent/intentions/definitions'
import {
  INTENTION_COHORT_LIMIT,
  loadVenueOpenIntentions,
  maxIntentionWindowMs,
} from './load-venue-intentions'

const VENUE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const GUEST_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const NOW = new Date('2026-09-14T12:00:00.000Z')

interface QueryCall {
  table: string
  method: string
  args: unknown[]
}

type Result = { data: unknown; error: { message: string } | null }

/**
 * Three queries across two round trips (guests, then prompts + transactions in
 * one Promise.all), so results are keyed by TABLE rather than by call order —
 * the Promise.all pair has no guaranteed ordering and a positional mock would
 * be flaky for reasons that have nothing to do with the code under test.
 */
function mockTables(byTable: Record<string, Result>) {
  const calls: QueryCall[] = []
  const from = vi.fn((table: string) => {
    const result = byTable[table] ?? { data: [], error: null }
    const builder: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'in', 'gte', 'order', 'limit']) {
      builder[method] = vi.fn((...args: unknown[]) => {
        calls.push({ table, method, args })
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

/** A qr_scan guest one day old — inside every definition's window. */
const guestRow = (overrides: Record<string, unknown> = {}) => ({
  id: GUEST_ID,
  first_name: 'Liam',
  last_name: 'Chen',
  phone_number: '+15555550142',
  created_at: '2026-09-13T12:00:00.000Z',
  created_via: 'qr_scan',
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('loadVenueOpenIntentions', () => {
  it('reports both intentions open for a fresh qr_scan guest with no history', async () => {
    mockTables({
      guests: { data: [guestRow()], error: null },
      guest_intention_prompts: { data: [], error: null },
      transactions: { data: [], error: null },
    })

    const { rows, degraded, cohortTruncated } = await loadVenueOpenIntentions(VENUE_ID, NOW)

    expect(rows).toEqual([
      {
        guestId: GUEST_ID,
        guestLabel: 'Liam Chen · +15555550142',
        guestCreatedAt: '2026-09-13T12:00:00.000Z',
        openKeys: INTENTION_DEFINITIONS.map((d) => d.key),
      },
    ])
    expect(degraded).toBe(false)
    expect(cohortTruncated).toBe(false)
  })

  // The derivation is deriveOpenIntentions's, not this file's. A transaction
  // closes learn_first_order and nothing else.
  it('drops learn_first_order once the guest has a transaction', async () => {
    mockTables({
      guests: { data: [guestRow()], error: null },
      guest_intention_prompts: { data: [], error: null },
      transactions: { data: [{ guest_id: GUEST_ID }], error: null },
    })

    const { rows } = await loadVenueOpenIntentions(VENUE_ID, NOW)
    expect(rows[0].openKeys).not.toContain('learn_first_order')
    expect(rows[0].openKeys).toContain('invite_contact_save')
  })

  it('drops an intention that has already been raised for that guest', async () => {
    mockTables({
      guests: { data: [guestRow()], error: null },
      guest_intention_prompts: {
        data: [{ guest_id: GUEST_ID, intention_key: 'invite_contact_save' }],
        error: null,
      },
      transactions: { data: [], error: null },
    })

    const { rows } = await loadVenueOpenIntentions(VENUE_ID, NOW)
    expect(rows[0].openKeys).not.toContain('invite_contact_save')
  })

  // A guest with nothing open is omitted entirely rather than rendered as an
  // empty row, so the list length is the count of guests actually being
  // pursued.
  it('omits a guest with no open intentions', async () => {
    mockTables({
      guests: { data: [guestRow({ created_via: 'inbound_message' })], error: null },
      guest_intention_prompts: { data: [], error: null },
      transactions: { data: [], error: null },
    })

    await expect(loadVenueOpenIntentions(VENUE_ID, NOW)).resolves.toEqual({
      rows: [],
      cohortTruncated: false,
      degraded: false,
    })
  })

  // Load-bearing, and the reason the SQL does NOT filter on created_via: the
  // origin gate lives in deriveOpenIntentions. Encoding it in the query too
  // would mean a future intention that drops the gate silently renders nothing
  // here, with no error to point at.
  it('does not filter the cohort query on created_via', async () => {
    const { calls } = mockTables({
      guests: { data: [], error: null },
    })

    await loadVenueOpenIntentions(VENUE_ID, NOW)

    const guestEqs = calls.filter((c) => c.table === 'guests' && c.method === 'eq')
    expect(guestEqs).toEqual([{ table: 'guests', method: 'eq', args: ['venue_id', VENUE_ID] }])
    expect(
      calls.some((c) => c.args.some((a) => a === 'created_via' || a === 'qr_scan')),
    ).toBe(false)
  })

  // The cutoff must track the definitions, not a literal. A new intention with
  // a longer window would otherwise be genuinely open in the agent and
  // invisible here, because its guests fell outside the scanned cohort.
  it('derives the cohort cutoff from the longest definition window', async () => {
    const { calls } = mockTables({
      guests: { data: [], error: null },
    })

    await loadVenueOpenIntentions(VENUE_ID, NOW)

    const gte = calls.find((c) => c.table === 'guests' && c.method === 'gte')
    const expected = new Date(NOW.getTime() - maxIntentionWindowMs()).toISOString()
    expect(gte?.args).toEqual(['created_at', expected])
    expect(maxIntentionWindowMs()).toBe(
      Math.max(...INTENTION_DEFINITIONS.map((d) => d.expiresAfterMs)),
    )
  })

  // SOURCE-LEVEL, and it has to be. Mutation-checked: replacing the helper's
  // body with a hardcoded 14 days passes every behavioural test in this file,
  // because the longest definition window IS 14 days today — the two values
  // coincide, so no assertion comparing them can tell a derivation from a
  // literal. The whole point of the helper is the day that coincidence ends:
  // a new intention with a longer window would be genuinely open in the agent
  // and invisible here, its guests having fallen outside the scanned cohort.
  // Same technique as lib/ui/token-bridge.test.ts and TAC-366's
  // filterByRelevance import assertion.
  it('derives that cutoff from the constant rather than restating the number', () => {
    const src = readFileSync(join(__dirname, 'load-venue-intentions.ts'), 'utf-8')
    const body = src.slice(src.indexOf('export function maxIntentionWindowMs'))
    const fn = body.slice(0, body.indexOf('\n}') + 2)
    expect(fn).toContain('INTENTION_DEFINITIONS')
    expect(fn).toContain('expiresAfterMs')
    // No hand-rolled duration arithmetic standing in for the definitions.
    expect(fn).not.toMatch(/\d+\s*\*\s*24\s*\*\s*60/)
    expect(fn).not.toMatch(/86_?400_?000/)
  })

  // The mock ignores .limit(), so only a direct call-arg assertion can pin
  // this. Mutation-verified: dropping the `+ 1` makes cohortTruncated
  // permanently false and the cohort truncates silently — the exact TAC-316
  // failure this loader's own docstring invokes — with all 12 tests green.
  it('fetches one row past the cap so truncation is detectable at all', async () => {
    const { calls } = mockTables({ guests: { data: [], error: null } })

    await loadVenueOpenIntentions(VENUE_ID, NOW)

    expect(calls.find((c) => c.table === 'guests' && c.method === 'limit')?.args).toEqual([
      INTENTION_COHORT_LIMIT + 1,
    ])
  })

  // The boundary is the whole reason for the probe row. Exactly-at-cap must
  // NOT claim truncation; `>=` here would report every full page as truncated.
  it('reports cohortTruncated false at exactly the cap', async () => {
    const exactly = Array.from({ length: INTENTION_COHORT_LIMIT }, (_, i) =>
      guestRow({ id: `guest-${i}` }),
    )
    mockTables({
      guests: { data: exactly, error: null },
      guest_intention_prompts: { data: [], error: null },
      transactions: { data: [], error: null },
    })

    const { rows, cohortTruncated } = await loadVenueOpenIntentions(VENUE_ID, NOW)
    expect(cohortTruncated).toBe(false)
    expect(rows).toHaveLength(INTENTION_COHORT_LIMIT)
  })

  it('marks the cohort truncated and drops the probe row past the cap', async () => {
    const overflowing = Array.from({ length: INTENTION_COHORT_LIMIT + 1 }, (_, i) =>
      guestRow({ id: `guest-${i}` }),
    )
    mockTables({
      guests: { data: overflowing, error: null },
      guest_intention_prompts: { data: [], error: null },
      transactions: { data: [], error: null },
    })

    const { rows, cohortTruncated } = await loadVenueOpenIntentions(VENUE_ID, NOW)
    expect(cohortTruncated).toBe(true)
    expect(rows).toHaveLength(INTENTION_COHORT_LIMIT)
  })

  // FAIL CLOSED, mirroring build-runtime-context.ts. A broken prompts read is
  // modelled as "everything already prompted", so the page under-reports
  // rather than claiming an intention is open when the row saying otherwise
  // simply did not load. `degraded` is what stops the short list reading as a
  // complete one.
  it('fails closed and flags degraded when the prompts read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockTables({
      guests: { data: [guestRow()], error: null },
      guest_intention_prompts: { data: null, error: { message: 'connection reset' } },
      transactions: { data: [], error: null },
    })

    const { rows, degraded } = await loadVenueOpenIntentions(VENUE_ID, NOW)
    expect(rows).toEqual([])
    expect(degraded).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('fails closed and flags degraded when the transactions read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockTables({
      guests: { data: [guestRow()], error: null },
      guest_intention_prompts: { data: [], error: null },
      transactions: { data: null, error: { message: 'connection reset' } },
    })

    const { rows, degraded } = await loadVenueOpenIntentions(VENUE_ID, NOW)
    // learn_first_order closes because an unreadable transaction list is read
    // as "we have heard"; invite_contact_save is unaffected by transactions.
    expect(rows[0].openKeys).not.toContain('learn_first_order')
    expect(degraded).toBe(true)
    warn.mockRestore()
  })

  it('degrades to empty and flags degraded when the guest cohort read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockTables({
      guests: { data: null, error: { message: 'connection reset' } },
    })

    await expect(loadVenueOpenIntentions(VENUE_ID, NOW)).resolves.toEqual({
      rows: [],
      cohortTruncated: false,
      degraded: true,
    })
    warn.mockRestore()
  })

  it('skips the follow-up queries entirely when the venue has no recent guests', async () => {
    const { from } = mockTables({ guests: { data: [], error: null } })

    await loadVenueOpenIntentions(VENUE_ID, NOW)
    expect(from).toHaveBeenCalledTimes(1)
  })
})
