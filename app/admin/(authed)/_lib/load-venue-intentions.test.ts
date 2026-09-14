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
const DAY = 24 * 60 * 60 * 1000
const daysAgoIso = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString()

interface QueryCall {
  table: string
  method: string
  args: unknown[]
}

type Result = { data: unknown; error: { message: string } | null }

/**
 * Four queries across two round trips (eligibility and re-armed rows, then
 * guests + transactions), so results are keyed by TABLE rather than
 * by call order — the Promise.all pair has no guaranteed ordering and a
 * positional mock would be flaky for reasons unrelated to the code under test.
 */
function mockTables(byTable: Record<string, Result>) {
  const calls: QueryCall[] = []
  const from = vi.fn((table: string) => {
    const result = byTable[table] ?? { data: [], error: null }
    const builder: Record<string, unknown> = {}
    let prompted = false
    for (const method of ['select', 'eq', 'is', 'in', 'not', 'gte', 'order', 'limit']) {
      builder[method] = vi.fn((...args: unknown[]) => {
        calls.push({ table, method, args })
        if (method === 'not') prompted = true
        return builder
      })
    }
    // The re-armed-rows read is the only one that calls .not(). It has its own
    // key, `<table>:prompted`, and defaults to empty.
    builder.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(
        prompted ? (byTable[`${table}:prompted`] ?? { data: [], error: null }) : result,
      ).then(resolve)
    return builder
  })
  vi.mocked(createAdminClient).mockReturnValue({ from } as unknown as ReturnType<
    typeof createAdminClient
  >)
  return { calls, from }
}

const eligibility = (key: string, eligibleDaysAgo: number, guestId = GUEST_ID) => ({
  guest_id: guestId,
  intention_key: key,
  eligible_at: daysAgoIso(eligibleDaysAgo),
})

/** No name and no home base on record, so neither proxy closes anything. */
const guestRow = (overrides: Record<string, unknown> = {}) => ({
  id: GUEST_ID,
  first_name: null,
  last_name: null,
  phone_number: '+15555550142',
  created_at: daysAgoIso(2),
  context: {},
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('loadVenueOpenIntentions', () => {
  it('reports eligible, unprompted intentions as open, in priority order', async () => {
    mockTables({
      guest_intention_prompts: {
        data: [
          eligibility('why_theyre_here', 1),
          eligibility('learn_name', 1),
          eligibility('understand_order', 1),
        ],
        error: null,
      },
      guests: { data: [guestRow()], error: null },
      transactions: { data: [], error: null },
    })

    const { rows, degraded, cohortTruncated } = await loadVenueOpenIntentions(VENUE_ID, NOW)

    expect(rows).toHaveLength(1)
    expect(rows[0].guestId).toBe(GUEST_ID)
    expect(rows[0].guestCreatedAt).toBe(daysAgoIso(2))
    expect(rows[0].openKeys).toEqual(['understand_order', 'learn_name', 'why_theyre_here'])
    expect(degraded).toBe(false)
    expect(cohortTruncated).toBe(false)
  })

  it('labels the guest by name and phone', async () => {
    mockTables({
      guest_intention_prompts: { data: [eligibility('are_they_local', 1)], error: null },
      guests: { data: [guestRow({ first_name: 'Liam', last_name: 'Chen' })], error: null },
      transactions: { data: [], error: null },
    })

    const { rows } = await loadVenueOpenIntentions(VENUE_ID, NOW)
    expect(rows[0].guestLabel).toBe('Liam Chen · +15555550142')
  })

  // TAC-380 trap 1 on this surface. Without the prompted_at filter every
  // intention already asked would list here as still being pursued.
  it('reads unprompted rows, plus prompted rows of the re-armable keys, scoped to the venue, inside the longest window', async () => {
    const { calls } = mockTables({ guest_intention_prompts: { data: [], error: null } })

    await loadVenueOpenIntentions(VENUE_ID, NOW)

    const query = calls.filter((c) => c.table === 'guest_intention_prompts')
    expect(query.filter((c) => c.method === 'eq').map((c) => c.args)).toEqual([
      ['venue_id', VENUE_ID],
      ['venue_id', VENUE_ID],
    ])
    expect(query.filter((c) => c.method === 'is').map((c) => c.args)).toEqual([
      ['prompted_at', null],
    ])
    // The re-armed read: prompted rows of the two event-armed keys only.
    expect(query.find((c) => c.method === 'not')?.args).toEqual(['prompted_at', 'is', null])
    expect(query.find((c) => c.method === 'in')?.args).toEqual([
      'intention_key',
      ['got_the_recommendation', 'did_they_like_it'],
    ])
    expect(query.find((c) => c.method === 'gte')?.args).toEqual([
      'eligible_at',
      new Date(NOW.getTime() - maxIntentionWindowMs()).toISOString(),
    ])
    expect(maxIntentionWindowMs()).toBe(
      Math.max(...INTENTION_DEFINITIONS.map((d) => d.expiresAfterMs)),
    )
  })

  // Ruling 5: each window runs from when the intention became eligible, and
  // each intention has its own. Five days is past understand_order's three and
  // inside learn_name's fourteen.
  it('expires each intention by its own window, measured from eligibility', async () => {
    mockTables({
      guest_intention_prompts: {
        data: [eligibility('understand_order', 5), eligibility('learn_name', 5)],
        error: null,
      },
      guests: { data: [guestRow()], error: null },
      transactions: { data: [], error: null },
    })

    const { rows } = await loadVenueOpenIntentions(VENUE_ID, NOW)
    expect(rows[0].openKeys).toEqual(['learn_name'])
  })

  // The derivation is deriveIntentionState's, not this file's. A transaction
  // closes understand_order and nothing else.
  it('closes understand_order once the guest has a transaction, and nothing else', async () => {
    mockTables({
      guest_intention_prompts: {
        data: [eligibility('understand_order', 1), eligibility('learn_name', 1)],
        error: null,
      },
      guests: { data: [guestRow()], error: null },
      transactions: { data: [{ guest_id: GUEST_ID }], error: null },
    })

    const { rows } = await loadVenueOpenIntentions(VENUE_ID, NOW)
    expect(rows[0].openKeys).toEqual(['learn_name'])
  })

  it('closes learn_name on a recorded first name and are_they_local on a recorded home base', async () => {
    mockTables({
      guest_intention_prompts: {
        data: [
          eligibility('learn_name', 1),
          eligibility('are_they_local', 1),
          eligibility('their_rhythm', 1),
        ],
        error: null,
      },
      guests: {
        data: [
          guestRow({ first_name: 'Liam', context: { guest_details: { home_base: 'Mission' } } }),
        ],
        error: null,
      },
      transactions: { data: [], error: null },
    })

    const { rows } = await loadVenueOpenIntentions(VENUE_ID, NOW)
    expect(rows[0].openKeys).toEqual(['their_rhythm'])
  })

  // The orphaned invite_contact_save row is a real value in a bare-text column.
  it('ignores a retired key without querying further', async () => {
    const { from } = mockTables({
      guest_intention_prompts: { data: [eligibility('invite_contact_save', 1)], error: null },
    })

    await expect(loadVenueOpenIntentions(VENUE_ID, NOW)).resolves.toEqual({
      rows: [],
      cohortTruncated: false,
      degraded: false,
    })
    expect(from).toHaveBeenCalledTimes(2)
  })

  // A guest with nothing open is omitted entirely rather than rendered as an
  // empty row, so the list length is the count of guests actually being
  // pursued.
  it('omits a guest whose every eligible intention is closed', async () => {
    mockTables({
      guest_intention_prompts: { data: [eligibility('understand_order', 1)], error: null },
      guests: { data: [guestRow()], error: null },
      transactions: { data: [{ guest_id: GUEST_ID }], error: null },
    })

    const { rows } = await loadVenueOpenIntentions(VENUE_ID, NOW)
    expect(rows).toEqual([])
  })

  // SOURCE-LEVEL, and it has to be. Mutation-checked in TAC-381: replacing the
  // helper's body with a hardcoded 14 days passes every behavioural test in
  // this file, because the longest definition window IS 14 days today — the
  // two values coincide, so no assertion comparing them can tell a derivation
  // from a literal. The whole point of the helper is the day that coincidence
  // ends. Same technique as lib/ui/token-bridge.test.ts.
  it('derives that cutoff from the constant rather than restating the number', () => {
    const src = readFileSync(join(__dirname, 'load-venue-intentions.ts'), 'utf-8')
    const body = src.slice(src.indexOf('export function maxIntentionWindowMs'))
    const fn = body.slice(0, body.indexOf('\n}') + 2)
    expect(fn).toContain('INTENTION_DEFINITIONS')
    expect(fn).toContain('expiresAfterMs')
    expect(fn).not.toMatch(/\d+\s*\*\s*24\s*\*\s*60/)
    expect(fn).not.toMatch(/86_?400_?000/)
  })

  // The mock ignores .limit(), so only a direct call-arg assertion can pin
  // this. Dropping the `+ 1` makes cohortTruncated permanently false and the
  // scan truncates silently — the TAC-316 failure.
  it('fetches one row past the cap so truncation is detectable at all', async () => {
    const { calls } = mockTables({ guest_intention_prompts: { data: [], error: null } })

    await loadVenueOpenIntentions(VENUE_ID, NOW)

    expect(
      calls.find((c) => c.table === 'guest_intention_prompts' && c.method === 'limit')?.args,
    ).toEqual([INTENTION_COHORT_LIMIT + 1])
  })

  // The boundary is the whole reason for the probe row. Exactly-at-cap must
  // NOT claim truncation; `>=` here would report every full page as truncated.
  it('reports cohortTruncated false at exactly the cap', async () => {
    const ids = Array.from({ length: INTENTION_COHORT_LIMIT }, (_, i) => `guest-${i}`)
    mockTables({
      guest_intention_prompts: { data: ids.map((id) => eligibility('learn_name', 1, id)), error: null },
      guests: { data: ids.map((id) => guestRow({ id })), error: null },
      transactions: { data: [], error: null },
    })

    const { rows, cohortTruncated } = await loadVenueOpenIntentions(VENUE_ID, NOW)
    expect(cohortTruncated).toBe(false)
    expect(rows).toHaveLength(INTENTION_COHORT_LIMIT)
  })

  it('marks the scan truncated and drops the probe row past the cap', async () => {
    const ids = Array.from({ length: INTENTION_COHORT_LIMIT + 1 }, (_, i) => `guest-${i}`)
    mockTables({
      guest_intention_prompts: { data: ids.map((id) => eligibility('learn_name', 1, id)), error: null },
      guests: { data: ids.map((id) => guestRow({ id })), error: null },
      transactions: { data: [], error: null },
    })

    const { rows, cohortTruncated } = await loadVenueOpenIntentions(VENUE_ID, NOW)
    expect(cohortTruncated).toBe(true)
    expect(rows).toHaveLength(INTENTION_COHORT_LIMIT)
  })

  // FAIL CLOSED, mirroring the agent. `degraded` is what stops the short list
  // reading as a complete one.
  it('fails closed and flags degraded when the transactions read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockTables({
      guest_intention_prompts: {
        data: [eligibility('understand_order', 1), eligibility('learn_name', 1)],
        error: null,
      },
      guests: { data: [guestRow()], error: null },
      transactions: { data: null, error: { message: 'connection reset' } },
    })

    const { rows, degraded } = await loadVenueOpenIntentions(VENUE_ID, NOW)
    // understand_order closes because an unreadable transaction list is read as
    // "we have heard"; learn_name is unaffected by transactions.
    expect(rows[0].openKeys).toEqual(['learn_name'])
    expect(degraded).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('degrades to empty and flags degraded when the eligibility read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockTables({
      guest_intention_prompts: { data: null, error: { message: 'connection reset' } },
    })

    await expect(loadVenueOpenIntentions(VENUE_ID, NOW)).resolves.toEqual({
      rows: [],
      cohortTruncated: false,
      degraded: true,
    })
    warn.mockRestore()
  })

  it('degrades to empty and flags degraded when the guests read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockTables({
      guest_intention_prompts: { data: [eligibility('learn_name', 1)], error: null },
      guests: { data: null, error: { message: 'connection reset' } },
      transactions: { data: [], error: null },
    })

    await expect(loadVenueOpenIntentions(VENUE_ID, NOW)).resolves.toEqual({
      rows: [],
      cohortTruncated: false,
      degraded: true,
    })
    warn.mockRestore()
  })

  // A re-armed event-armed row keeps its last prompt, so it carries a prompted_at
  // and reads as open only while that prompt predates its eligible_at.
  it('lists a re-armed intention as open while its last prompt predates its anchor', async () => {
    mockTables({
      guest_intention_prompts: { data: [eligibility('learn_name', 1)], error: null },
      'guest_intention_prompts:prompted': {
        data: [
          {
            guest_id: GUEST_ID,
            intention_key: 'got_the_recommendation',
            eligible_at: daysAgoIso(1),
            prompted_at: daysAgoIso(5),
          },
          {
            guest_id: GUEST_ID,
            intention_key: 'did_they_like_it',
            eligible_at: daysAgoIso(1),
            prompted_at: daysAgoIso(0.5),
          },
        ],
        error: null,
      },
      guests: { data: [guestRow()], error: null },
      transactions: { data: [], error: null },
    })

    const { rows } = await loadVenueOpenIntentions(VENUE_ID, NOW)
    expect(rows[0].openKeys).toEqual(['got_the_recommendation', 'learn_name'])
  })

  it('keeps the eligibility rows and flags degraded when the re-armed read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockTables({
      guest_intention_prompts: { data: [eligibility('learn_name', 1)], error: null },
      'guest_intention_prompts:prompted': { data: null, error: { message: 'connection reset' } },
      guests: { data: [guestRow()], error: null },
      transactions: { data: [], error: null },
    })

    const { rows, degraded } = await loadVenueOpenIntentions(VENUE_ID, NOW)
    expect(rows[0].openKeys).toEqual(['learn_name'])
    expect(degraded).toBe(true)
    warn.mockRestore()
  })

  // Found in review: nothing eligible AND a failed re-armed read must not render
  // as "Nothing open", an absolute claim off a read that never ran. The same
  // defect TAC-381 fixed on the commitments half of this page.
  it('flags degraded when nothing is eligible and the re-armed read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockTables({
      guest_intention_prompts: { data: [], error: null },
      'guest_intention_prompts:prompted': { data: null, error: { message: 'connection reset' } },
    })

    await expect(loadVenueOpenIntentions(VENUE_ID, NOW)).resolves.toEqual({
      rows: [],
      cohortTruncated: false,
      degraded: true,
    })
    warn.mockRestore()
  })

  it('skips the follow-up queries entirely when nothing is eligible', async () => {
    const { from } = mockTables({ guest_intention_prompts: { data: [], error: null } })

    await loadVenueOpenIntentions(VENUE_ID, NOW)
    expect(from).toHaveBeenCalledTimes(2)
  })
})
