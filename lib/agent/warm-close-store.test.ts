// The FILTERS, not a mock's opinion of them.
//
// Most of this module's correctness is in what it sends: the reached-guest
// condition, the Instagram channel filter, the newest-first ordering, and the
// CAS predicate that makes the close once per guest ever. A double that ignored
// its arguments would pass with any of them deleted, which is the TAC-377 /
// TAC-385 trap the query recorder exists for.

import { describe, expect, it } from 'vitest'

import {
  callsNamed,
  queryRecorder,
} from '@/lib/messaging/instagram/testing/query-recorder'
import {
  claimWarmClose,
  loadLastInboundCategory,
  loadWarmCloseCandidates,
  loadWarmCloseGuestFacts,
  loadWarmCloseVenues,
  markWarmCloseSent,
  releaseWarmCloseClaim,
} from './warm-close-store'

const VENUE = '11111111-1111-4111-8111-111111111111'
const GUEST = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-09-29T14:10:00.000Z')
const WINDOW_START = new Date('2026-09-29T12:10:00.000Z')

const ok = (data: unknown) => ({ data, error: null })

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm-out',
    guest_id: GUEST,
    direction: 'outbound',
    status: 'delivered',
    review_state: 'auto_sent',
    body: 'glad it landed',
    created_at: '2026-09-29T14:00:00.000Z',
    generation_id: null,
    rendered_intentions: null,
    ...over,
  }
}

describe('loadWarmCloseVenues (TAC-560)', () => {
  it('selects every column a gate reads', async () => {
    // The follow-up engine's own lesson: a column dropped from this string makes
    // the corresponding gate read `undefined` and go inert, and no behavioural
    // test can see it because the double ignores the select argument.
    const { client, queries } = queryRecorder({ venues: [ok([])] })
    await loadWarmCloseVenues(client)
    const [select] = callsNamed(queries[0], 'select')[0] as [string]
    for (const column of [
      'id',
      'timezone',
      'status',
      'instagram_account_id',
      'followup_rules',
    ]) {
      expect(select, column).toContain(column)
    }
  })

  it('reads an embedded config as either an object or a one-element array', async () => {
    const asArray = queryRecorder({
      venues: [
        ok([
          {
            id: VENUE,
            timezone: 'UTC',
            status: 'pending',
            instagram_account_id: 'ig',
            venue_configs: [{ followup_rules: { weekly_cap: 3 } }],
          },
        ]),
      ],
    })
    const fromArray = await loadWarmCloseVenues(asArray.client)
    const asObject = queryRecorder({
      venues: [
        ok([
          {
            id: VENUE,
            timezone: 'UTC',
            status: 'pending',
            instagram_account_id: 'ig',
            venue_configs: { followup_rules: { weekly_cap: 3 } },
          },
        ]),
      ],
    })
    const fromObject = await loadWarmCloseVenues(asObject.client)
    expect(fromArray.ok && fromArray.data[0].followupRules).toEqual({
      weekly_cap: 3,
    })
    expect(fromObject.ok && fromObject.data[0].followupRules).toEqual({
      weekly_cap: 3,
    })
  })
})

describe('loadWarmCloseCandidates (TAC-560)', () => {
  it('scopes to the venue, to Instagram, to the window, newest first', async () => {
    const { client, queries } = queryRecorder({ messages: [ok([row()])] })
    await loadWarmCloseCandidates(client, VENUE, WINDOW_START)
    const q = queries[0]
    expect(callsNamed(q, 'eq')).toEqual(
      expect.arrayContaining([
        ['venue_id', VENUE],
        ['channel', 'instagram'],
      ]),
    )
    expect(callsNamed(q, 'gte')).toEqual([
      ['created_at', WINDOW_START.toISOString()],
    ])
    // Newest first is load-bearing: the newest row per guest is what decides
    // whether our outbound is still our last word. Ascending would hand the
    // oldest row in the window to a guest who has since replied.
    expect(callsNamed(q, 'order')).toEqual([
      ['created_at', { ascending: false }],
    ])
  })

  it('does NOT filter direction in SQL, so a newer inbound stays visible', async () => {
    // The filter is applied in TS deliberately. Filtering to outbound here would
    // make a guest who replied look like a guest who went quiet, because the
    // older outbound would be promoted to "our last word".
    const { client, queries } = queryRecorder({ messages: [ok([row()])] })
    await loadWarmCloseCandidates(client, VENUE, WINDOW_START)
    expect(callsNamed(queries[0], 'eq')).not.toEqual(
      expect.arrayContaining([['direction', 'outbound']]),
    )
  })

  it('produces a candidate for an outbound that reached the guest', async () => {
    const { client } = queryRecorder({ messages: [ok([row()])] })
    const r = await loadWarmCloseCandidates(client, VENUE, WINDOW_START)
    expect(r.ok && r.data).toHaveLength(1)
    expect(r.ok && r.data[0].messageId).toBe('m-out')
  })

  it('produces NO candidate when the guest replied after our message', async () => {
    // The newest row is theirs, so they are marked seen and our older outbound
    // never becomes a candidate. This is how the timer resets on a reply.
    const { client } = queryRecorder({
      messages: [
        ok([
          row({
            id: 'm-in',
            direction: 'inbound',
            created_at: '2026-09-29T14:05:00.000Z',
          }),
          row(),
        ]),
      ],
    })
    const r = await loadWarmCloseCandidates(client, VENUE, WINDOW_START)
    expect(r.ok && r.data).toEqual([])
  })

  it('produces NO candidate when our newest outbound never reached the guest', async () => {
    // A pending card or a skipped draft is a message the guest never saw, so it
    // must not start the timer. It still disqualifies the guest rather than
    // letting an older delivered row stand in.
    for (const undelivered of [
      { review_state: 'pending', status: 'pending_review' },
      { review_state: 'skipped', status: 'pending_review' },
      { review_state: 'auto_sent', status: 'failed' },
    ]) {
      const { client } = queryRecorder({
        messages: [
          ok([
            row({
              id: 'm-new',
              created_at: '2026-09-29T14:05:00.000Z',
              ...undelivered,
            }),
            row(),
          ]),
        ],
      })
      const r = await loadWarmCloseCandidates(client, VENUE, WINDOW_START)
      expect(r.ok && r.data, JSON.stringify(undelivered)).toEqual([])
    }
  })

  it('counts rendered intentions off the carrier, and reads a missing one as none', async () => {
    const withOne = queryRecorder({
      messages: [ok([row({ rendered_intentions: [{ key: 'learn_name' }] })])],
    })
    const a = await loadWarmCloseCandidates(withOne.client, VENUE, WINDOW_START)
    expect(a.ok && a.data[0].renderedIntentionCount).toBe(1)

    const withNone = queryRecorder({
      messages: [ok([row({ rendered_intentions: null })])],
    })
    const b = await loadWarmCloseCandidates(
      withNone.client,
      VENUE,
      WINDOW_START,
    )
    expect(b.ok && b.data[0].renderedIntentionCount).toBe(0)
  })
})

describe('loadWarmCloseGuestFacts (TAC-560)', () => {
  it('selects every field a gate reads, scoped to the guest', async () => {
    const { client, queries } = queryRecorder({
      guests: [
        ok({
          created_via: 'qr_scan',
          first_contacted_at: '2026-09-29T13:50:00.000Z',
          warm_close_sent_at: null,
          opted_out_at: null,
          instagram_scoped_id: 'igsid',
          phone_number: null,
        }),
      ],
    })
    const r = await loadWarmCloseGuestFacts(client, GUEST)
    const [select] = callsNamed(queries[0], 'select')[0] as [string]
    for (const column of [
      'created_via',
      'first_contacted_at',
      'warm_close_sent_at',
      'opted_out_at',
      'instagram_scoped_id',
    ]) {
      expect(select, column).toContain(column)
    }
    expect(callsNamed(queries[0], 'eq')).toEqual([['id', GUEST]])
    expect(r.ok && r.data.createdVia).toBe('qr_scan')
  })

  it('reads an unparseable timestamp as absent rather than as a date', async () => {
    const { client } = queryRecorder({
      guests: [
        ok({
          created_via: 'qr_scan',
          first_contacted_at: 'nonsense',
          warm_close_sent_at: null,
          opted_out_at: null,
          instagram_scoped_id: 'igsid',
          phone_number: null,
        }),
      ],
    })
    const r = await loadWarmCloseGuestFacts(client, GUEST)
    expect(r.ok && r.data.firstContactedAt).toBeNull()
  })

  it('is an error, not a default, when the guest cannot be read', async () => {
    const { client } = queryRecorder({
      guests: [{ data: null, error: { message: 'boom' } }],
    })
    const r = await loadWarmCloseGuestFacts(client, GUEST)
    expect(r.ok).toBe(false)
  })
})

describe('loadLastInboundCategory (TAC-560)', () => {
  it('reads the newest inbound for this guest at this venue', async () => {
    const { client, queries } = queryRecorder({
      messages: [ok({ category: 'acknowledgment' })],
    })
    const category = await loadLastInboundCategory(client, VENUE, GUEST)
    expect(category).toBe('acknowledgment')
    expect(callsNamed(queries[0], 'eq')).toEqual(
      expect.arrayContaining([
        ['venue_id', VENUE],
        ['guest_id', GUEST],
        ['direction', 'inbound'],
      ]),
    )
    expect(callsNamed(queries[0], 'order')).toEqual([
      ['created_at', { ascending: false }],
    ])
  })

  it('reads an unreadable answer as no signal rather than as a sign-off', async () => {
    const { client } = queryRecorder({
      messages: [{ data: null, error: { message: 'boom' } }],
    })
    expect(await loadLastInboundCategory(client, VENUE, GUEST)).toBeNull()
  })
})

describe('claimWarmClose (TAC-560)', () => {
  it('is a CAS on the marker being null, and wins on one row', async () => {
    const { client, queries } = queryRecorder({ guests: [ok([{ id: GUEST }])] })
    const r = await claimWarmClose(client, GUEST, NOW)
    expect(r).toEqual({ status: 'claimed' })
    expect(callsNamed(queries[0], 'update')).toEqual([
      [{ warm_close_sent_at: NOW.toISOString() }],
    ])
    expect(callsNamed(queries[0], 'eq')).toEqual([['id', GUEST]])
    // THE PREDICATE IS THE WHOLE MECHANISM. Without it two ticks both "claim",
    // and a guest already closed weeks ago gets closed again.
    expect(callsNamed(queries[0], 'is')).toEqual([['warm_close_sent_at', null]])
  })

  it('loses on zero rows', async () => {
    const { client } = queryRecorder({ guests: [ok([])] })
    expect(await claimWarmClose(client, GUEST, NOW)).toEqual({ status: 'lost' })
  })

  it('is a failure, never a win, when the update errors', async () => {
    const { client } = queryRecorder({
      guests: [{ data: null, error: { message: 'boom' } }],
    })
    expect(await claimWarmClose(client, GUEST, NOW)).toEqual({
      status: 'failed',
      error: 'boom',
    })
  })
})

describe('releaseWarmCloseClaim (TAC-560)', () => {
  it('clears ONLY the timestamp this tick wrote', async () => {
    // Scoped to the exact value, so it can never clear a marker some other path
    // set in between.
    const { client, queries } = queryRecorder({ guests: [ok([{ id: GUEST }])] })
    await releaseWarmCloseClaim(client, GUEST, NOW)
    expect(callsNamed(queries[0], 'update')).toEqual([
      [{ warm_close_sent_at: null }],
    ])
    expect(callsNamed(queries[0], 'eq')).toEqual(
      expect.arrayContaining([
        ['id', GUEST],
        ['warm_close_sent_at', NOW.toISOString()],
      ]),
    )
  })
})

describe('markWarmCloseSent (TAC-560)', () => {
  it('marks, and reports an existing marker rather than overwriting it', async () => {
    const fresh = queryRecorder({ guests: [ok([{ id: GUEST }])] })
    expect(await markWarmCloseSent(fresh.client, GUEST, NOW)).toEqual({
      ok: true,
      data: 'marked',
    })
    // `is null` still guards: a guest the timer closed moments earlier keeps that
    // earlier timestamp.
    expect(callsNamed(fresh.queries[0], 'is')).toEqual([
      ['warm_close_sent_at', null],
    ])

    const already = queryRecorder({ guests: [ok([])] })
    expect(await markWarmCloseSent(already.client, GUEST, NOW)).toEqual({
      ok: true,
      data: 'already_marked',
    })
  })
})
