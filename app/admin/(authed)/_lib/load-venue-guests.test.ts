import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FETCH_CEILING, loadVenueGuestsByActivity, type VenueGuestRow } from './load-venue-guests'

const VENUE = '11111111-1111-1111-1111-111111111111'

// Every query argument the loader sends. The mock answers whatever it is
// asked, so without capturing these a mutant that ignores the RPC, or asks for
// the wrong venue, passes every behavioural assertion below — which is exactly
// what happened while these two calls lived inline in the page: both mutants
// survived the full suite.
let capturedRpcCalls: Array<{ fn: string; args: unknown }> = []
let capturedGuestSelect: string | null = null
let capturedGuestVenue: string | null = null
let capturedGuestLimit: number | null = null
let capturedGuestOrder: Array<{ column: string; opts: unknown }> = []

function makeClient(opts: {
  guests?: Partial<VenueGuestRow>[]
  guestsError?: string
  activity?: Array<{ guest_id: string; last_interaction_at: string }>
  activityError?: string
}) {
  return {
    from: () => ({
      select: (columns: string) => {
        capturedGuestSelect = columns
        const chain = {
          eq: (_c: string, v: string) => {
            capturedGuestVenue = v
            return chain
          },
          order: (column: string, o: unknown) => {
            capturedGuestOrder.push({ column, opts: o })
            return chain
          },
          limit: (n: number) => {
            capturedGuestLimit = n
            return Promise.resolve(
              opts.guestsError !== undefined
                ? { data: null, error: { message: opts.guestsError } }
                : { data: opts.guests ?? [], error: null },
            )
          },
        }
        return chain
      },
    }),
    rpc: (fn: string, args: unknown) => {
      capturedRpcCalls.push({ fn, args })
      return Promise.resolve(
        opts.activityError !== undefined
          ? { data: null, error: { message: opts.activityError } }
          : { data: opts.activity ?? [], error: null },
      )
    },
  } as never
}

const guest = (id: string, enrolled: string): Partial<VenueGuestRow> => ({
  id,
  first_name: id,
  last_name: null,
  phone_number: null,
  instagram_username: null,
  first_contacted_at: enrolled,
})

beforeEach(() => {
  capturedRpcCalls = []
  capturedGuestSelect = null
  capturedGuestVenue = null
  capturedGuestLimit = null
  capturedGuestOrder = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('loadVenueGuestsByActivity', () => {
  // The ticket, end to end through the loader: enrollment order and activity
  // order disagree, and activity wins.
  it('orders by derived activity, not by enrollment', async () => {
    const result = await loadVenueGuestsByActivity(
      makeClient({
        guests: [guest('newest-enrolled', '2026-09-19T00:00:00Z'), guest('oldest-enrolled', '2026-01-01T00:00:00Z')],
        activity: [{ guest_id: 'oldest-enrolled', last_interaction_at: '2026-09-20T00:00:00Z' }],
      }),
      VENUE,
      50,
    )
    expect(result.rows.map((g) => g.id)).toEqual(['oldest-enrolled', 'newest-enrolled'])
    expect(result.activityDegraded).toBe(false)
  })

  // The wiring guard. Non-behavioural on purpose: the mock returns the same
  // rows whatever venue is asked for.
  it('asks venue_guest_activity for the venue it is loading', async () => {
    await loadVenueGuestsByActivity(makeClient({}), VENUE, 50)
    expect(capturedRpcCalls).toEqual([{ fn: 'venue_guest_activity', args: { p_venue_id: VENUE } }])
  })

  it('scopes the guest query to the venue and selects what the dropdown renders', async () => {
    await loadVenueGuestsByActivity(makeClient({}), VENUE, 50)
    expect(capturedGuestVenue).toBe(VENUE)
    for (const column of [
      'id',
      'first_name',
      'last_name',
      'phone_number',
      'instagram_username',
      'first_contacted_at',
    ]) {
      expect(capturedGuestSelect).toContain(column)
    }
  })

  // The fetch must be bounded AND deterministically ordered: an unordered
  // unbounded read truncated by any row cap gives an arbitrary slice, which
  // the activity sort then dutifully orders — the TAC-316 shape one layer up.
  //
  // Pins the ceiling's VALUE, not just "bigger than the caller's limit" — a
  // first version asserted `> 50`, which `Number.MAX_SAFE_INTEGER` satisfies,
  // so the mutant that removed the bound entirely passed it.
  it('bounds the fetch and orders it, so truncation is deterministic', async () => {
    await loadVenueGuestsByActivity(makeClient({}), VENUE, 50)
    expect(capturedGuestLimit).toBe(FETCH_CEILING)
    expect(Number.isSafeInteger(FETCH_CEILING)).toBe(true)
    expect(FETCH_CEILING).toBeGreaterThan(50)
    expect(FETCH_CEILING).toBeLessThanOrEqual(10_000)
    expect(capturedGuestOrder).toEqual([
      { column: 'first_contacted_at', opts: { ascending: false, nullsFirst: false } },
    ])
  })

  it('applies the caller limit after sorting by activity', async () => {
    const result = await loadVenueGuestsByActivity(
      makeClient({
        guests: [guest('a', '2026-01-01T00:00:00Z'), guest('b', '2026-01-02T00:00:00Z')],
        activity: [{ guest_id: 'a', last_interaction_at: '2026-09-20T00:00:00Z' }],
      }),
      VENUE,
      1,
    )
    expect(result.rows.map((g) => g.id)).toEqual(['a'])
  })

  // A failed RPC is invisible in the rendered list — every guest ties, the
  // fallback ordering takes over, and the operator sees a plausible dropdown
  // in the wrong order. The flag is the only signal.
  it('flags a failed activity read and still returns the guests', async () => {
    const result = await loadVenueGuestsByActivity(
      makeClient({
        guests: [guest('older', '2026-01-01T00:00:00Z'), guest('newer', '2026-09-01T00:00:00Z')],
        activityError: 'PGRST202',
      }),
      VENUE,
      50,
    )
    expect(result.activityDegraded).toBe(true)
    // Falls back to enrollment, newest first — not UUID order.
    expect(result.rows.map((g) => g.id)).toEqual(['newer', 'older'])
    expect(console.warn).toHaveBeenCalled()
  })

  it('returns no rows and does not claim degradation when the guest query fails', async () => {
    const result = await loadVenueGuestsByActivity(makeClient({ guestsError: 'boom' }), VENUE, 50)
    expect(result.rows).toEqual([])
    expect(result.activityDegraded).toBe(false)
  })

  it('keeps a guest with no activity row', async () => {
    const result = await loadVenueGuestsByActivity(
      makeClient({
        guests: [guest('silent', '2026-01-01T00:00:00Z'), guest('active', '2026-01-02T00:00:00Z')],
        activity: [{ guest_id: 'active', last_interaction_at: '2026-09-20T00:00:00Z' }],
      }),
      VENUE,
      50,
    )
    expect(result.rows.map((g) => g.id)).toEqual(['active', 'silent'])
  })
})
