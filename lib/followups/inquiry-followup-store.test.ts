// TAC-386. Every query this mechanism makes.
//
// THIS FILE EXISTS BECAUSE ITS ABSENCE HID TWO DEFECTS. The engine's test mocks
// this module wholesale, so nothing exercised a single query's SQL semantics,
// and both of the following shipped past a green suite and a mutation run:
//
//   `hasInboundSince` matched the question's OWN row, because `asked_at` is
//   Meta's clock and the filter is on our insert time. Every follow-up resolved
//   `guest_wrote_again`. The mechanism could never send.
//
//   `loadOurAnswer` selected `status` and ignored it, so a card an operator
//   skipped came back as "what we told them" and would have been rendered
//   verbatim into a message to the guest.
//
// Both have a test below that fails without the fix. The module header's claim
// that its select string was "captured the same way" TAC-560's is was also
// false until this file; the guard is the first describe block.

import { describe, expect, it } from 'vitest'

import {
  callsNamed,
  queryRecorder,
} from '@/lib/messaging/instagram/testing/query-recorder'
import {
  claimInquiryFollowup,
  hasInboundSince,
  isInquiryFollowupMessage,
  loadDueInquiryFollowups,
  loadInquiryFollowupVenues,
  loadInquiryGuestFacts,
  loadOurAnswer,
  recordProactiveSend,
  releaseInquiryFollowupClaim,
  resolveInquiryFollowup,
} from './inquiry-followup-store'

const VENUE = '11111111-1111-4111-8111-111111111111'
const GUEST = '22222222-2222-4222-8222-222222222222'
const SOURCE = '33333333-3333-4333-8333-333333333333'
const ROW = '44444444-4444-4444-8444-444444444444'

const ok = (data: unknown) => ({ data, error: null })
const err = (message: string, code?: string) => ({
  data: null,
  error: { message, code },
})

/** Meta's clock for the question. */
const ASKED_AT = new Date('2026-09-29T03:00:00.000Z')

describe('loadInquiryFollowupVenues', () => {
  // TAC-560's own lesson, and the claim this module's header makes: a column
  // dropped from this string makes its gate read `undefined` and go inert, and
  // no behavioural test can see it because the double ignores the argument.
  it('selects every column a gate reads', async () => {
    const { client, queries } = queryRecorder({ venues: [ok([])] })
    await loadInquiryFollowupVenues(client)
    const [select] = callsNamed(queries[0], 'select')[0] as [string]
    for (const column of [
      'id',
      'timezone',
      'status',
      'instagram_account_id',
      'followup_rules',
      'venue_info',
    ]) {
      expect(select, column).toContain(column)
    }
  })

  it('reads an embedded config as either an object or a one-element array', async () => {
    // PostgREST returns one shape or the other depending on the relationship.
    const asArray = queryRecorder({
      venues: [
        ok([
          {
            id: VENUE,
            timezone: 'America/Los_Angeles',
            status: 'pending',
            instagram_account_id: 'ig',
            venue_configs: [
              { followup_rules: { weekly_cap: 2 }, venue_info: {} },
            ],
          },
        ]),
      ],
    })
    const a = await loadInquiryFollowupVenues(asArray.client)
    expect(a.ok && a.data[0].followupRules).toEqual({ weekly_cap: 2 })

    const asObject = queryRecorder({
      venues: [
        ok([
          {
            id: VENUE,
            timezone: 'America/Los_Angeles',
            status: 'pending',
            instagram_account_id: 'ig',
            venue_configs: {
              followup_rules: { weekly_cap: 3 },
              venue_info: {},
            },
          },
        ]),
      ],
    })
    const b = await loadInquiryFollowupVenues(asObject.client)
    expect(b.ok && b.data[0].followupRules).toEqual({ weekly_cap: 3 })
  })

  it('reads a venue with no config row without throwing', async () => {
    const { client } = queryRecorder({
      venues: [
        ok([
          {
            id: VENUE,
            timezone: null,
            status: null,
            instagram_account_id: null,
            venue_configs: null,
          },
        ]),
      ],
    })
    const r = await loadInquiryFollowupVenues(client)
    expect(r.ok && r.data[0]).toMatchObject({
      followupRules: null,
      venueInfo: null,
      timezone: null,
    })
  })
})

describe('loadDueInquiryFollowups', () => {
  it('scopes to the venue, to pending, and to due_at at or before now', async () => {
    const now = new Date('2026-09-29T17:00:00.000Z')
    const { client, queries } = queryRecorder({ inquiry_followups: [ok([])] })
    await loadDueInquiryFollowups(client, VENUE, now)
    const q = queries[0]
    expect(callsNamed(q, 'eq')).toEqual(
      expect.arrayContaining([
        ['venue_id', VENUE],
        ['status', 'pending'],
      ]),
    )
    // `lte`, not `lt`: a row due exactly now is due.
    expect(callsNamed(q, 'lte')).toEqual([['due_at', now.toISOString()]])
    expect(callsNamed(q, 'order')).toEqual([['due_at', { ascending: true }]])
  })

  it('parses the timestamps it returns', async () => {
    const { client } = queryRecorder({
      inquiry_followups: [
        ok([
          {
            id: ROW,
            venue_id: VENUE,
            guest_id: GUEST,
            source_message_id: SOURCE,
            question: 'where do I park',
            asked_at: ASKED_AT.toISOString(),
            window_closes_at: '2026-09-30T03:00:00.000Z',
            due_at: '2026-09-29T17:00:00.000Z',
          },
        ]),
      ],
    })
    const r = await loadDueInquiryFollowups(client, VENUE, new Date())
    expect(r.ok && r.data[0].askedAt).toEqual(ASKED_AT)
    expect(r.ok && r.data[0].question).toBe('where do I park')
  })
})

describe('loadInquiryGuestFacts', () => {
  it('selects every column a gate reads', async () => {
    const { client, queries } = queryRecorder({
      guests: [
        ok({
          opted_out_at: null,
          instagram_scoped_id: 'x',
          last_proactive_send_at: null,
        }),
      ],
    })
    await loadInquiryGuestFacts(client, GUEST)
    const [select] = callsNamed(queries[0], 'select')[0] as [string]
    for (const column of [
      'opted_out_at',
      'instagram_scoped_id',
      'last_proactive_send_at',
    ]) {
      expect(select, column).toContain(column)
    }
  })

  it('reports a missing guest as an error, not as empty facts', async () => {
    // Empty facts would read as "not opted out, no spacing marker", which is
    // the permissive direction on a guest we could not read at all.
    const { client } = queryRecorder({ guests: [ok(null)] })
    const r = await loadInquiryGuestFacts(client, GUEST)
    expect(r.ok).toBe(false)
  })
})

describe('hasInboundSince (ruling 5b)', () => {
  // THE BLOCKER. Without the id exclusion this gate matched the question's own
  // row and nothing could ever send.
  it('EXCLUDES the source row, whose created_at is later than asked_at', async () => {
    const { client, queries } = queryRecorder({ messages: [ok([])] })
    await hasInboundSince(client, VENUE, GUEST, ASKED_AT, SOURCE)
    expect(callsNamed(queries[0], 'neq')).toEqual([['id', SOURCE]])
  })

  it('is false when nothing newer comes back', async () => {
    // The recorder ignores filters, so this pins the mapping (empty means
    // false), not the SQL. The assertion above is what holds the exclusion:
    // `neq` is a call the double records whether or not it honours it.
    const { client } = queryRecorder({ messages: [ok([])] })
    const r = await hasInboundSince(client, VENUE, GUEST, ASKED_AT, SOURCE)
    expect(r.ok && r.data).toBe(false)
  })

  it('is true when some OTHER inbound is newer', async () => {
    const { client } = queryRecorder({
      messages: [ok([{ id: 'another-inbound' }])],
    })
    const r = await hasInboundSince(client, VENUE, GUEST, ASKED_AT, SOURCE)
    expect(r.ok && r.data).toBe(true)
  })

  it('compares against the instant it is given, on inbound rows only', async () => {
    const { client, queries } = queryRecorder({ messages: [ok([])] })
    await hasInboundSince(client, VENUE, GUEST, ASKED_AT, SOURCE)
    expect(callsNamed(queries[0], 'gt')).toEqual([
      ['created_at', ASKED_AT.toISOString()],
    ])
    expect(callsNamed(queries[0], 'eq')).toEqual(
      expect.arrayContaining([['direction', 'inbound']]),
    )
  })

  it('reports a failed read rather than answering false', async () => {
    const { client } = queryRecorder({ messages: [err('boom')] })
    const r = await hasInboundSince(client, VENUE, GUEST, ASKED_AT, SOURCE)
    expect(r.ok).toBe(false)
  })
})

describe('loadOurAnswer', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'm-answer',
    body: 'Street parking on Polk is usually fine.',
    status: 'delivered',
    review_state: 'auto_sent',
    ...over,
  })

  it('returns a delivered answer', async () => {
    const { client } = queryRecorder({ messages: [ok([row()])] })
    const r = await loadOurAnswer(client, SOURCE)
    expect(r.ok && r.data).toEqual({
      messageId: 'm-answer',
      body: 'Street parking on Polk is usually fine.',
    })
  })

  // THE SECOND BLOCKER. Every draft carries reply_to_message_id from insert, so
  // taking the newest row returned cards the guest never saw.
  it.each([
    [
      'a card still pending',
      { review_state: 'pending', status: 'pending_review' },
    ],
    [
      'a card the operator skipped',
      { review_state: 'skipped', status: 'pending_review' },
    ],
    ['a send that failed', { review_state: 'auto_sent', status: 'failed' }],
    // THE CASE THAT ISOLATES THE review_state CHECK. The three above all fail
    // the delivered-status test too, so a mutation removing the review_state
    // line left the whole file green: the two filters overlapped and nothing
    // measured the second. This row is the interleaving window the belt exists
    // for, a delivered status whose review_state has not caught up.
    [
      'a delivered row still marked pending review',
      { review_state: 'pending', status: 'delivered' },
    ],
  ])('returns null for %s', async (_label, over) => {
    const { client } = queryRecorder({ messages: [ok([row(over)])] })
    const r = await loadOurAnswer(client, SOURCE)
    expect(r.ok && r.data).toBeNull()
  })

  it('takes the newest row that PASSES, not the newest row', async () => {
    // A failed retry above a delivered original must not hide it.
    const { client } = queryRecorder({
      messages: [
        ok([
          row({ id: 'm-retry', status: 'failed', body: 'never arrived' }),
          row({ id: 'm-original', body: 'the real answer' }),
        ]),
      ],
    })
    const r = await loadOurAnswer(client, SOURCE)
    expect(r.ok && r.data).toEqual({
      messageId: 'm-original',
      body: 'the real answer',
    })
  })

  it('returns null when nothing ever answered the question', async () => {
    const { client } = queryRecorder({ messages: [ok([])] })
    const r = await loadOurAnswer(client, SOURCE)
    expect(r.ok && r.data).toBeNull()
  })

  it('returns null for a delivered row with an empty body', async () => {
    const { client } = queryRecorder({ messages: [ok([row({ body: '   ' })])] })
    const r = await loadOurAnswer(client, SOURCE)
    expect(r.ok && r.data).toBeNull()
  })

  it('trims the body it returns', async () => {
    const { client } = queryRecorder({
      messages: [ok([row({ body: '  the answer  ' })])],
    })
    const r = await loadOurAnswer(client, SOURCE)
    expect(r.ok && r.data?.body).toBe('the answer')
  })

  it('selects the columns the delivery filter needs', async () => {
    const { client, queries } = queryRecorder({ messages: [ok([])] })
    await loadOurAnswer(client, SOURCE)
    const [select] = callsNamed(queries[0], 'select')[0] as [string]
    for (const column of ['body', 'status', 'review_state']) {
      expect(select, column).toContain(column)
    }
  })
})

describe('claimInquiryFollowup', () => {
  it('claims only a row still pending, and moves it out of pending', async () => {
    const { client, queries } = queryRecorder({
      inquiry_followups: [ok([{ id: ROW }])],
    })
    const now = new Date('2026-09-29T17:00:00.000Z')
    const r = await claimInquiryFollowup(client, ROW, now)
    expect(r).toEqual({ status: 'claimed' })
    // The CAS predicate: two ticks together cannot both claim one row.
    expect(callsNamed(queries[0], 'eq')).toEqual(
      expect.arrayContaining([
        ['id', ROW],
        ['status', 'pending'],
      ]),
    )
    const [update] = callsNamed(queries[0], 'update')[0] as [
      Record<string, unknown>,
    ]
    expect(update).toMatchObject({
      status: 'dispatched',
      dispatched_at: now.toISOString(),
    })
  })

  it('is lost when the update matched no row', async () => {
    const { client } = queryRecorder({ inquiry_followups: [ok([])] })
    const r = await claimInquiryFollowup(client, ROW, new Date())
    expect(r).toEqual({ status: 'lost' })
  })

  it('is lost, not claimed, when the update matched more than one', async () => {
    // Structurally impossible on a primary key, but "claimed" here would spend
    // a row this process does not own.
    const { client } = queryRecorder({
      inquiry_followups: [ok([{ id: ROW }, { id: 'other' }])],
    })
    const r = await claimInquiryFollowup(client, ROW, new Date())
    expect(r).toEqual({ status: 'lost' })
  })

  it('reports a failed claim rather than assuming either way', async () => {
    const { client } = queryRecorder({ inquiry_followups: [err('boom')] })
    const r = await claimInquiryFollowup(client, ROW, new Date())
    expect(r).toMatchObject({ status: 'failed' })
  })
})

describe('releaseInquiryFollowupClaim', () => {
  it('puts the row back to pending', async () => {
    const { client, queries } = queryRecorder({ inquiry_followups: [ok(null)] })
    const r = await releaseInquiryFollowupClaim(client, ROW)
    expect(r).toEqual({ status: 'released' })
    const [update] = callsNamed(queries[0], 'update')[0] as [
      Record<string, unknown>,
    ]
    expect(update).toMatchObject({ status: 'pending', dispatched_at: null })
  })

  // The claim freed the guest's one pending slot, so a question asked in the
  // meantime may already occupy it. That is an expected state, not a fault.
  it('reports superseded on a unique violation', async () => {
    const { client } = queryRecorder({
      inquiry_followups: [err('duplicate key', '23505')],
    })
    const r = await releaseInquiryFollowupClaim(client, ROW)
    expect(r).toEqual({ status: 'superseded' })
  })

  it('reports any other error as failed, not superseded', async () => {
    const { client } = queryRecorder({
      inquiry_followups: [err('no such table', '42P01')],
    })
    const r = await releaseInquiryFollowupClaim(client, ROW)
    expect(r).toMatchObject({ status: 'failed' })
  })
})

describe('resolveInquiryFollowup', () => {
  it('writes the status and the reason that produced it', async () => {
    const { client, queries } = queryRecorder({ inquiry_followups: [ok(null)] })
    await resolveInquiryFollowup(client, ROW, 'skipped', 'weekly_cap')
    const [update] = callsNamed(queries[0], 'update')[0] as [
      Record<string, unknown>,
    ]
    expect(update).toEqual({ status: 'skipped', skip_reason: 'weekly_cap' })
  })
})

describe('recordProactiveSend', () => {
  it('stamps the shared spacing marker on the guest', async () => {
    const now = new Date('2026-09-29T17:00:00.000Z')
    const { client, queries } = queryRecorder({ guests: [ok(null)] })
    await recordProactiveSend(client, GUEST, now)
    const [update] = callsNamed(queries[0], 'update')[0] as [
      Record<string, unknown>,
    ]
    expect(update).toEqual({ last_proactive_send_at: now.toISOString() })
    expect(callsNamed(queries[0], 'eq')).toEqual([['id', GUEST]])
  })
})

describe('isInquiryFollowupMessage', () => {
  it('returns the ids that are follow-up dispatches', async () => {
    const { client } = queryRecorder({
      inquiry_followups: [ok([{ dispatched_message_id: 'm-followup' }])],
    })
    const r = await isInquiryFollowupMessage(client, ['m-followup', 'm-other'])
    expect(r.ok && [...r.data]).toEqual(['m-followup'])
  })

  it('makes no query for an empty list', async () => {
    const { client, queries } = queryRecorder({ inquiry_followups: [ok([])] })
    const r = await isInquiryFollowupMessage(client, [])
    expect(r.ok && r.data.size).toBe(0)
    expect(queries).toHaveLength(0)
  })

  it('skips a null dispatched_message_id rather than adding it to the set', async () => {
    // ON DELETE SET NULL makes this reachable; `new Set([null])` would then
    // contain a member nothing can match and the caller reads `.has(id)`.
    const { client } = queryRecorder({
      inquiry_followups: [ok([{ dispatched_message_id: null }])],
    })
    const r = await isInquiryFollowupMessage(client, ['m-a'])
    expect(r.ok && r.data.size).toBe(0)
  })

  it('reports a failed read rather than an empty set', async () => {
    // An empty set reads as "none of these are follow-ups", which is exactly
    // the wrong answer for the warm close's anchor exclusion.
    const { client } = queryRecorder({ inquiry_followups: [err('boom')] })
    const r = await isInquiryFollowupMessage(client, ['m-a'])
    expect(r.ok).toBe(false)
  })
})
