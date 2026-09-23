// TAC-473: the one-hour Instagram reply-window warning.
//
// The acceptance criterion is "exactly one push", so the assertions that carry
// weight here are the ones about the SECOND tick, not the first.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const pushMock = vi.fn()
vi.mock('@/lib/notifications/send-instagram-window-push', () => ({
  sendInstagramWindowWarningPush: (...args: unknown[]) => pushMock(...args),
}))

interface DraftRow {
  id: string
  venue_id: string
  guest_id: string
  guests: { first_name: string | null } | null
  window_warning_pushed_at?: string | null
}

interface Script {
  drafts?: DraftRow[]
  scanError?: string
  /** provider_sent_at of the guest's newest Instagram inbound, keyed venue:guest. */
  anchors?: Record<string, string | null>
  anchorError?: string
  /** Guest ids whose anchor read should fail, keyed venue:guest. */
  anchorErrorFor?: string[]
  claimError?: string
  /** Ids whose CAS claim should lose. */
  casLost?: string[]
}

let script: Script = {}
const claims: Array<{ patch: Record<string, unknown>; filters: Record<string, unknown> }> = []
const scanFilters: Record<string, unknown> = {}
let anchorLookups = 0

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => ({
    from() {
      return {
        select(columns: string) {
          const filters: Record<string, unknown> = {}
          const b = {
            eq(c: string, v: unknown) {
              filters[c] = v
              return b
            },
            is(c: string, v: unknown) {
              filters[c] = v === null ? 'IS NULL' : v
              return b
            },
            not(c: string) {
              filters[`${c}__notnull`] = true
              return b
            },
            order() {
              return b
            },
            limit() {
              return b
            },
            async maybeSingle() {
              anchorLookups += 1
              if (script.anchorError) return { data: null, error: { message: script.anchorError } }
              const key = `${filters.venue_id}:${filters.guest_id}`
              if ((script.anchorErrorFor ?? []).includes(key)) {
                return { data: null, error: { message: `anchor boom for ${key}` } }
              }
              const at = script.anchors?.[key] ?? null
              return { data: at === null ? null : { provider_sent_at: at }, error: null }
            },
            then(resolve: (r: unknown) => unknown) {
              // The scan itself is awaited directly, with no maybeSingle.
              Object.assign(scanFilters, filters)
              if (script.scanError) return resolve({ data: null, error: { message: script.scanError } })
              return resolve({ data: script.drafts ?? [], error: null })
            },
          }
          void columns
          return b
        },
        update(patch: Record<string, unknown>) {
          const filters: Record<string, unknown> = {}
          const b = {
            eq(c: string, v: unknown) {
              filters[c] = v
              return b
            },
            is(c: string, v: unknown) {
              filters[c] = v === null ? 'IS NULL' : v
              return b
            },
            async select() {
              claims.push({ patch, filters })
              if (script.claimError) return { data: null, error: { message: script.claimError } }
              if ((script.casLost ?? []).includes(filters.id as string)) return { data: [], error: null }
              return { data: [{ id: filters.id }], error: null }
            },
          }
          return b
        },
      }
    },
  }),
}))

import {
  INSTAGRAM_WINDOW_WARNING_MS,
  processInstagramWindowWarnings,
} from './instagram-window-warning'
import { INSTAGRAM_WINDOW_MS } from '@/lib/messaging/instagram/window'

const VENUE = 'venue-1'
const GUEST = 'guest-1'
const NOW = new Date('2026-09-23T12:00:00.000Z')

/** An anchor leaving exactly `remainingMs` of Meta's window at NOW. */
function anchorLeaving(remainingMs: number): string {
  return new Date(NOW.getTime() + remainingMs - INSTAGRAM_WINDOW_MS).toISOString()
}

function draft(id: string, over: Partial<DraftRow> = {}): DraftRow {
  return { id, venue_id: VENUE, guest_id: GUEST, guests: { first_name: 'Ana' }, ...over }
}

beforeEach(() => {
  vi.clearAllMocks()
  claims.length = 0
  anchorLookups = 0
  for (const k of Object.keys(scanFilters)) delete scanFilters[k]
  script = {}
})

describe('processInstagramWindowWarnings', () => {
  it('pushes once for a draft with under an hour left', async () => {
    script = {
      drafts: [draft('d1')],
      anchors: { [`${VENUE}:${GUEST}`]: anchorLeaving(42 * 60_000) },
    }
    const summary = await processInstagramWindowWarnings(NOW)
    expect(summary).toMatchObject({ scanned: 1, due: 1, claimed: 1, pushed: 1 })
    expect(pushMock).toHaveBeenCalledTimes(1)
    expect(pushMock).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 'd1', venueId: VENUE, guestId: GUEST, guestFirstName: 'Ana' }),
    )
  })

  // THE ACCEPTANCE CRITERION. The tick is every minute and the window is an
  // hour, so without the durable marker one card would push sixty times.
  it('does NOT push again on the next tick, because the marker is claimed', async () => {
    script = {
      drafts: [draft('d1')],
      anchors: { [`${VENUE}:${GUEST}`]: anchorLeaving(42 * 60_000) },
    }
    await processInstagramWindowWarnings(NOW)
    expect(pushMock).toHaveBeenCalledTimes(1)

    // The second tick's scan excludes the row, because the marker is set.
    // Modelled the way the database would: the filter is on the column.
    script = { drafts: [], anchors: script.anchors }
    pushMock.mockClear()
    const second = await processInstagramWindowWarnings(new Date(NOW.getTime() + 60_000))
    expect(second).toMatchObject({ scanned: 0, pushed: 0 })
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('scans only pending, Instagram, never-warned drafts', async () => {
    script = { drafts: [], anchors: {} }
    await processInstagramWindowWarnings(NOW)
    expect(scanFilters).toEqual({
      review_state: 'pending',
      channel: 'instagram',
      window_warning_pushed_at: 'IS NULL',
    })
  })

  it('claims the marker BEFORE pushing, CAS-guarded on still-pending and never-warned', async () => {
    script = {
      drafts: [draft('d1')],
      anchors: { [`${VENUE}:${GUEST}`]: anchorLeaving(10 * 60_000) },
    }
    await processInstagramWindowWarnings(NOW)
    expect(claims).toHaveLength(1)
    expect(claims[0]!.filters).toEqual({
      id: 'd1',
      review_state: 'pending',
      window_warning_pushed_at: 'IS NULL',
    })
    expect(claims[0]!.patch).toEqual({ window_warning_pushed_at: NOW.toISOString() })
  })

  it('does not push when the CAS loses to a concurrent tick', async () => {
    script = {
      drafts: [draft('d1')],
      anchors: { [`${VENUE}:${GUEST}`]: anchorLeaving(10 * 60_000) },
      casLost: ['d1'],
    }
    const summary = await processInstagramWindowWarnings(NOW)
    expect(summary).toMatchObject({ due: 1, claimed: 0, casLost: 1, pushed: 0 })
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('does not push above the threshold', async () => {
    script = {
      drafts: [draft('d1')],
      anchors: { [`${VENUE}:${GUEST}`]: anchorLeaving(INSTAGRAM_WINDOW_WARNING_MS + 60_000) },
    }
    const summary = await processInstagramWindowWarnings(NOW)
    expect(summary).toMatchObject({ notYet: 1, due: 0, pushed: 0 })
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('pushes exactly AT the threshold', async () => {
    script = {
      drafts: [draft('d1')],
      anchors: { [`${VENUE}:${GUEST}`]: anchorLeaving(INSTAGRAM_WINDOW_WARNING_MS) },
    }
    expect((await processInstagramWindowWarnings(NOW)).pushed).toBe(1)
  })

  it('does not push once the window has already closed', async () => {
    // Telling an operator to hurry for something they can no longer do from
    // the app is worse than saying nothing.
    script = {
      drafts: [draft('d1')],
      anchors: { [`${VENUE}:${GUEST}`]: anchorLeaving(-60_000) },
    }
    const summary = await processInstagramWindowWarnings(NOW)
    expect(summary).toMatchObject({ expired: 1, pushed: 0 })
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('does not push when no guest action carries Meta clock', async () => {
    script = { drafts: [draft('d1')], anchors: { [`${VENUE}:${GUEST}`]: null } }
    const summary = await processInstagramWindowWarnings(NOW)
    expect(summary).toMatchObject({ windowUnknown: 1, pushed: 0 })
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('reads the window anchor ONCE for a guest holding several cards', async () => {
    // The anchor is a property of the guest, not of the card.
    script = {
      drafts: [draft('d1'), draft('d2'), draft('d3')],
      anchors: { [`${VENUE}:${GUEST}`]: anchorLeaving(30 * 60_000) },
    }
    const summary = await processInstagramWindowWarnings(NOW)
    expect(summary).toMatchObject({ scanned: 3, pushed: 3 })
    expect(anchorLookups).toBe(1)
  })

  it('keeps going when one draft THROWS, rather than abandoning the tick', async () => {
    // A real failure, not an unknown window: the first draft's anchor read
    // errors, which the per-draft try/catch turns into `errored`. The point is
    // that the second draft is still processed after it.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    script = {
      drafts: [draft('d1', { guest_id: 'guest-bad' }), draft('d2')],
      anchors: { [`${VENUE}:${GUEST}`]: anchorLeaving(10 * 60_000) },
      anchorErrorFor: [`${VENUE}:guest-bad`],
    }
    const summary = await processInstagramWindowWarnings(NOW)
    expect(summary).toMatchObject({ scanned: 2, errored: 1, pushed: 1 })
    expect(pushMock).toHaveBeenCalledTimes(1)
    expect(pushMock).toHaveBeenCalledWith(expect.objectContaining({ draftId: 'd2' }))
  })

  it('reports a failed scan rather than throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    script = { scanError: 'scan boom' }
    const summary = await processInstagramWindowWarnings(NOW)
    expect(summary).toMatchObject({ scanned: 0, errored: 1, pushed: 0 })
  })

  it('reports a failed claim rather than throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    script = {
      drafts: [draft('d1')],
      anchors: { [`${VENUE}:${GUEST}`]: anchorLeaving(10 * 60_000) },
      claimError: 'claim boom',
    }
    const summary = await processInstagramWindowWarnings(NOW)
    expect(summary).toMatchObject({ errored: 1, pushed: 0 })
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('measures against Meta true deadline, not the margin-adjusted send gate', async () => {
    // The Contract's replyWindowExpiresAt carries the true deadline too, so
    // the push, the wire and the card all agree about "time left".
    script = {
      drafts: [draft('d1')],
      anchors: { [`${VENUE}:${GUEST}`]: anchorLeaving(INSTAGRAM_WINDOW_WARNING_MS + 1000) },
    }
    expect((await processInstagramWindowWarnings(NOW)).pushed).toBe(0)
  })
})

describe('INSTAGRAM_WINDOW_WARNING_MS', () => {
  it('is one hour', () => {
    expect(INSTAGRAM_WINDOW_WARNING_MS).toBe(60 * 60 * 1000)
  })

  it('is well inside the window it warns about', () => {
    expect(INSTAGRAM_WINDOW_WARNING_MS).toBeLessThan(INSTAGRAM_WINDOW_MS)
  })
})
