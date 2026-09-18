// What the handler writes for each kind of event, run against Meta's recorded
// deliveries (fixtures/) and an in-memory store (testing/db-fake.ts) that
// throws on any query shape the handler shouldn't send.
//
// The insert payloads are pinned whole with toEqual, never toMatchObject: the
// fields that must NOT appear matter as much as the ones that must. A missing
// `channel` would save an Instagram message as a text message with no error
// (messages.channel defaults to 'text' until TAC-472), and a partial match
// would pass it.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { logInstagramOutcome, processInstagramDelivery, type InstagramEventOutcome } from './handle-events'
import { createInstagramDbFake, type FakeRow } from './testing/db-fake'

const ACCOUNT_ID = '17841400000000001'
const GUEST_IGSID = '1000000000000001'
const VENUE_ID = 'venue-1'
const GUEST_ID = 'guest-1'
const NOW = '2026-09-18T08:00:00.000Z'

type FixtureName = 'message' | 'echo' | 'read' | 'postback-referral'

function fixture(name: FixtureName): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', `${name}.json`), 'utf8'))
}

function midOf(name: FixtureName, key: 'message' | 'read' | 'postback'): string {
  const parsed = fixture(name) as { entry: Array<{ messaging: Array<Record<string, { mid: string }>> }> }
  const mid = parsed.entry[0]?.messaging[0]?.[key]?.mid
  if (!mid) throw new Error(`fixture ${name} has no ${key}.mid`)
  return mid
}

/** Several recorded deliveries' entries in one delivery, as Meta batches them. */
function batch(...names: FixtureName[]): unknown {
  return {
    object: 'instagram',
    entry: names.flatMap((name) => (fixture(name) as { entry: unknown[] }).entry),
  }
}

const VENUE: FakeRow = { id: VENUE_ID, instagram_account_id: ACCOUNT_ID }
const GUEST: FakeRow = { id: GUEST_ID, venue_id: VENUE_ID, instagram_scoped_id: GUEST_IGSID }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a guest message', () => {
  it('creates the guest by IGSID and saves an inbound Instagram row', async () => {
    const db = createInstagramDbFake({ venues: [VENUE] })
    const outcomes = await processInstagramDelivery(fixture('message'), db.client)

    expect(db.inserts('guests')).toEqual([
      {
        venue_id: VENUE_ID,
        instagram_scoped_id: GUEST_IGSID,
        created_via: 'inbound_message',
        first_contacted_at: NOW,
        last_inbound_at: NOW,
        last_interaction_at: NOW,
      },
    ])
    const [guest] = db.tables.guests
    expect(db.inserts('messages')).toEqual([
      {
        venue_id: VENUE_ID,
        guest_id: guest?.id,
        channel: 'instagram',
        direction: 'inbound',
        status: 'received',
        body: 'MSGTEXT',
        media_urls: [],
        provider_message_id: midOf('message', 'message'),
        referral_ref: null,
        referral_source: null,
      },
    ])
    expect(outcomes).toEqual([
      {
        status: 'persisted',
        kind: 'message',
        venueId: VENUE_ID,
        guestId: guest?.id,
        messageId: db.tables.messages[0]?.id,
        guestCreated: true,
        hasReferral: false,
      },
    ])
  })

  it('reuses a guest it already has', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [GUEST] })
    const outcomes = await processInstagramDelivery(fixture('message'), db.client)

    expect(db.inserts('guests')).toEqual([])
    expect(db.inserts('messages')).toMatchObject([{ guest_id: GUEST_ID }])
    expect(outcomes).toMatchObject([{ status: 'persisted', guestId: GUEST_ID, guestCreated: false }])
  })

  it('never matches a guest from another venue with the same IGSID', async () => {
    const other: FakeRow = { id: 'guest-elsewhere', venue_id: 'venue-2', instagram_scoped_id: GUEST_IGSID }
    const db = createInstagramDbFake({ venues: [VENUE], guests: [other] })
    await processInstagramDelivery(fixture('message'), db.client)

    expect(db.inserts('guests')).toMatchObject([{ venue_id: VENUE_ID, instagram_scoped_id: GUEST_IGSID }])
    expect(db.inserts('messages')[0]?.guest_id).not.toBe('guest-elsewhere')
  })

  // A guest who follows an ig.me link and then types, rather than tapping an
  // icebreaker, may bring the referral on the message instead (not captured
  // yet, so synthetic). It arrives once and can't be fetched later, so a
  // regression here would lose the attribution silently.
  it.each<[string, Record<string, unknown>]>([
    ['inside `message`', { message: { mid: 'm-ref', text: 'hi', referral: { ref: 'QR1', source: 'SHORTLINK' } } }],
    ['beside `message`', { message: { mid: 'm-ref', text: 'hi' }, referral: { ref: 'QR1', source: 'SHORTLINK' } }],
  ])('saves the referral on a guest message when it arrives %s', async (_where, parts) => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [GUEST] })
    const payload = {
      object: 'instagram',
      entry: [
        {
          id: ACCOUNT_ID,
          time: 1,
          messaging: [{ sender: { id: GUEST_IGSID }, recipient: { id: ACCOUNT_ID }, timestamp: 1, ...parts }],
        },
      ],
    }
    const outcomes = await processInstagramDelivery(payload, db.client)

    expect(db.inserts('messages')).toEqual([
      {
        venue_id: VENUE_ID,
        guest_id: GUEST_ID,
        channel: 'instagram',
        direction: 'inbound',
        status: 'received',
        body: 'hi',
        media_urls: [],
        provider_message_id: 'm-ref',
        referral_ref: 'QR1',
        referral_source: 'SHORTLINK',
      },
    ])
    expect(outcomes).toMatchObject([{ status: 'persisted', kind: 'message', hasReferral: true }])
  })

  // Two first contacts from the same new guest in parallel deliveries. The
  // losing insert gets 23505 and must file its message under the winner's
  // guest. Sendblue's path loses the message here.
  it('files the message under the guest a racing delivery created first', async () => {
    const db = createInstagramDbFake({ venues: [VENUE] })
    db.beforeNextInsert('guests', () => db.tables.guests.push({ ...GUEST, id: 'guest-winner' }))

    const outcomes = await processInstagramDelivery(fixture('message'), db.client)

    expect(db.tables.guests.map((g) => g.id)).toEqual(['guest-winner'])
    expect(db.inserts('messages')).toMatchObject([{ guest_id: 'guest-winner' }])
    expect(outcomes).toMatchObject([{ status: 'persisted', guestId: 'guest-winner', guestCreated: false }])
  })
})

describe('an icebreaker postback', () => {
  it('saves an inbound row with the title as its body and the referral on it', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [GUEST] })
    const outcomes = await processInstagramDelivery(fixture('postback-referral'), db.client)

    expect(db.inserts('messages')).toEqual([
      {
        venue_id: VENUE_ID,
        guest_id: GUEST_ID,
        channel: 'instagram',
        direction: 'inbound',
        status: 'received',
        body: 'What are your hours?',
        media_urls: [],
        provider_message_id: midOf('postback-referral', 'postback'),
        referral_ref: 'TESTVENUE',
        referral_source: 'SHORTLINK',
      },
    ])
    expect(outcomes).toMatchObject([{ status: 'persisted', kind: 'postback', hasReferral: true }])
  })

  it('creates the guest when a postback is their first action', async () => {
    const db = createInstagramDbFake({ venues: [VENUE] })
    await processInstagramDelivery(fixture('postback-referral'), db.client)
    expect(db.inserts('guests')).toMatchObject([{ instagram_scoped_id: GUEST_IGSID, created_via: 'inbound_message' }])
  })

  // TAC-469 computes the reply window from the newest inbound Instagram row.
  // A postback opens the window, so it is saved even with nothing to show.
  it('saves a postback with no title, so it still opens the reply window', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [GUEST] })
    const payload = {
      object: 'instagram',
      entry: [
        {
          id: ACCOUNT_ID,
          time: 1,
          messaging: [
            { sender: { id: GUEST_IGSID }, recipient: { id: ACCOUNT_ID }, timestamp: 1, postback: { mid: 'p1', payload: 'X' } },
          ],
        },
      ],
    }
    await processInstagramDelivery(payload, db.client)
    expect(db.inserts('messages')).toMatchObject([{ direction: 'inbound', channel: 'instagram', body: '' }])
  })
})

describe('an echo', () => {
  it('saves an outbound row to the guest, shaped like the other non-agent outbound insert', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [GUEST] })
    const outcomes = await processInstagramDelivery(fixture('echo'), db.client)

    expect(db.inserts('messages')).toEqual([
      {
        venue_id: VENUE_ID,
        guest_id: GUEST_ID,
        channel: 'instagram',
        direction: 'outbound',
        status: 'sent',
        body: 'ECHO',
        media_urls: [],
        provider_message_id: midOf('echo', 'message'),
        sent_at: NOW,
      },
    ])
    expect(outcomes).toMatchObject([{ status: 'persisted', kind: 'echo', guestCreated: false, hasReferral: false }])
  })

  // Ruled 2026-09-18: an echo is the venue's activity. Staff messaging a
  // supplier from the venue account must not create a guest.
  it('never creates a guest, and skips an echo to someone it does not know', async () => {
    const db = createInstagramDbFake({ venues: [VENUE] })
    const outcomes = await processInstagramDelivery(fixture('echo'), db.client)

    expect(db.inserts('guests')).toEqual([])
    expect(db.inserts('messages')).toEqual([])
    expect(outcomes).toEqual([{ status: 'skipped', kind: 'echo', reason: 'unknown_guest' }])
  })

  // TAC-469's own sends will echo back with the mid its send already saved.
  it('does not save an echo of a message it already has', async () => {
    const saved: FakeRow = { id: 'msg-sent', provider_message_id: midOf('echo', 'message') }
    const db = createInstagramDbFake({ venues: [VENUE], guests: [GUEST], messages: [saved] })
    const outcomes = await processInstagramDelivery(fixture('echo'), db.client)

    expect(db.inserts('messages')).toEqual([])
    expect(outcomes).toEqual([{ status: 'duplicate', kind: 'echo', venueId: VENUE_ID, messageId: 'msg-sent' }])
  })
})

describe('a read receipt', () => {
  const echoRow: FakeRow = {
    id: 'msg-echo',
    venue_id: VENUE_ID,
    guest_id: GUEST_ID,
    provider_message_id: midOf('echo', 'message'),
  }

  // Ruled 2026-09-18 (option C): no column holds read state, so the receipt is
  // matched and logged, and nothing is written. The fake has no update method,
  // so any write attempt would throw.
  it('matches the message that was read and writes nothing', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [GUEST], messages: [echoRow] })
    const outcomes = await processInstagramDelivery(fixture('read'), db.client)

    expect(outcomes).toEqual([{ status: 'read', venueId: VENUE_ID, guestId: GUEST_ID, messageId: 'msg-echo' }])
    expect(db.calls.filter((c) => c.op !== 'select')).toEqual([])
  })

  it('matches only within this venue and guest', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [GUEST], messages: [echoRow] })
    await processInstagramDelivery(fixture('read'), db.client)

    expect(db.calls.at(-1)).toEqual({
      op: 'select',
      table: 'messages',
      columns: 'id',
      filters: [
        ['provider_message_id', midOf('read', 'read')],
        ['venue_id', VENUE_ID],
        ['guest_id', GUEST_ID],
      ],
    })
  })

  it('reports a receipt for a message it does not have', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [GUEST] })
    const outcomes = await processInstagramDelivery(fixture('read'), db.client)
    expect(outcomes).toEqual([{ status: 'read', venueId: VENUE_ID, guestId: GUEST_ID, messageId: null }])
  })

  it('never creates a guest, and skips a receipt from someone it does not know', async () => {
    const db = createInstagramDbFake({ venues: [VENUE] })
    const outcomes = await processInstagramDelivery(fixture('read'), db.client)

    expect(db.inserts('guests')).toEqual([])
    expect(outcomes).toEqual([{ status: 'skipped', kind: 'read', reason: 'unknown_guest' }])
  })
})

describe('venues and duplicates', () => {
  it('skips an event for an account no venue is mapped to, before touching guests or messages', async () => {
    const db = createInstagramDbFake()
    const outcomes = await processInstagramDelivery(fixture('message'), db.client)

    expect(outcomes).toEqual([{ status: 'skipped', kind: 'message', reason: 'venue_not_found' }])
    expect(db.calls.map((c) => c.table)).toEqual(['venues'])
  })

  it('looks the venue up once for a batched delivery', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [GUEST] })
    await processInstagramDelivery(batch('message', 'echo', 'postback-referral'), db.client)
    expect(db.calls.filter((c) => c.table === 'venues')).toHaveLength(1)
  })

  it('does not save a message it already has', async () => {
    const saved: FakeRow = { id: 'msg-1', provider_message_id: midOf('message', 'message') }
    const db = createInstagramDbFake({ venues: [VENUE], guests: [GUEST], messages: [saved] })
    const outcomes = await processInstagramDelivery(fixture('message'), db.client)

    expect(db.inserts('messages')).toEqual([])
    expect(outcomes).toEqual([{ status: 'duplicate', kind: 'message', venueId: VENUE_ID, messageId: 'msg-1' }])
  })

  // Meta delivering the same event twice at once: both reads miss, and the
  // second insert hits the unique constraint on provider_message_id.
  it('reports a duplicate when a racing delivery saved the message first', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [GUEST] })
    db.beforeNextInsert('messages', () =>
      db.tables.messages.push({ id: 'msg-racer', provider_message_id: midOf('message', 'message') }),
    )
    const outcomes = await processInstagramDelivery(fixture('message'), db.client)
    expect(outcomes).toEqual([{ status: 'duplicate', kind: 'message', venueId: VENUE_ID, messageId: null }])
  })

  it('saves each kind in a batched delivery in order, every row naming its channel', async () => {
    const db = createInstagramDbFake({ venues: [VENUE] })
    const outcomes = await processInstagramDelivery(
      batch('message', 'echo', 'read', 'postback-referral'),
      db.client,
    )

    expect(outcomes.map((o) => o.status)).toEqual(['persisted', 'persisted', 'read', 'persisted'])
    // The message created the guest, so the echo, read and postback find them.
    expect(db.inserts('guests')).toHaveLength(1)
    const inserts = db.inserts('messages')
    expect(inserts.map((row) => row.direction)).toEqual(['inbound', 'outbound', 'inbound'])
    for (const row of inserts) expect(row.channel).toBe('instagram')
    // The read found the echo saved one event earlier in the same delivery.
    expect(outcomes[2]).toMatchObject({ messageId: db.tables.messages[1]?.id })
  })

  it('passes unhandled events through in order without touching the store', async () => {
    const db = createInstagramDbFake({ venues: [VENUE] })
    const outcomes = await processInstagramDelivery(
      { object: 'instagram', entry: [{ id: ACCOUNT_ID, time: 1, changes: [{ field: 'comments', value: {} }] }] },
      db.client,
    )
    expect(outcomes).toEqual([{ status: 'unhandled', reason: 'changes_field', fields: ['comments'] }])
    expect(db.calls).toEqual([])
  })
})

describe('failures', () => {
  const dbError = { code: '08006', message: 'connection failure' }

  it.each<['venues' | 'guests' | 'messages', 'select' | 'insert', string]>([
    ['venues', 'select', 'venue_lookup'],
    ['guests', 'select', 'guest_lookup'],
    ['guests', 'insert', 'guest_insert'],
    ['messages', 'select', 'message_lookup'],
    ['messages', 'insert', 'message_insert'],
  ])('reports a failed %s %s as a failed %s, and saves nothing more for that event', async (table, op, stage) => {
    const db = createInstagramDbFake({ venues: [VENUE] })
    db.failNext(table, op, dbError)
    const outcomes = await processInstagramDelivery(fixture('message'), db.client)
    expect(outcomes).toEqual([
      { status: 'failed', kind: 'message', stage, error: 'connection failure', code: '08006' },
    ])
  })

  it('reports a failed read lookup', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [GUEST] })
    // A read receipt's only messages query is the match itself.
    db.failNext('messages', 'select', dbError)
    const outcomes = await processInstagramDelivery(fixture('read'), db.client)
    expect(outcomes).toEqual([
      { status: 'failed', kind: 'read', stage: 'read_lookup', error: 'connection failure', code: '08006' },
    ])
  })

  it('does not remember a failed venue lookup, so the next event in the delivery retries it', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [GUEST] })
    db.failNext('venues', 'select', dbError)
    const outcomes = await processInstagramDelivery(batch('message', 'postback-referral'), db.client)
    expect(outcomes.map((o) => o.status)).toEqual(['failed', 'persisted'])
  })

  it('keeps going after an event throws', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [GUEST] })
    const client = db.client as unknown as { from: (table: string) => unknown }
    const original = client.from.bind(client)
    let thrown = false
    client.from = (table: string) => {
      if (table === 'guests' && !thrown) {
        thrown = true
        throw new Error('boom')
      }
      return original(table)
    }

    const outcomes = await processInstagramDelivery(batch('message', 'postback-referral'), db.client)
    expect(outcomes).toEqual([
      { status: 'failed', kind: 'message', stage: 'unexpected', error: 'boom', code: null },
      expect.objectContaining({ status: 'persisted', kind: 'postback' }),
    ])
  })
})

// The only place an outcome reaches a log. Each line's field set is pinned so
// that adding an identifier to it has to fail a test.
describe('logInstagramOutcome', () => {
  function logged(): unknown[][] {
    const lines: unknown[][] = []
    const capture = (...args: unknown[]): void => {
      lines.push(args)
    }
    vi.spyOn(console, 'log').mockImplementation(capture)
    vi.spyOn(console, 'warn').mockImplementation(capture)
    vi.spyOn(console, 'error').mockImplementation(capture)
    return lines
  }

  it.each<[InstagramEventOutcome, Record<string, unknown>]>([
    [
      { status: 'unhandled', reason: 'changes_field', fields: ['comments'] },
      { event: 'instagram_event_unhandled', reason: 'changes_field', fields: ['comments'] },
    ],
    [
      { status: 'persisted', kind: 'postback', venueId: 'v', guestId: 'g', messageId: 'm', guestCreated: true, hasReferral: true },
      { event: 'instagram_event_persisted', kind: 'postback', venueId: 'v', guestId: 'g', messageId: 'm', guestCreated: true, hasReferral: true },
    ],
    [
      { status: 'duplicate', kind: 'echo', venueId: 'v', messageId: null },
      { event: 'instagram_event_duplicate', kind: 'echo', venueId: 'v', messageId: null },
    ],
    [
      { status: 'read', venueId: 'v', guestId: 'g', messageId: 'm' },
      { event: 'instagram_read_receipt', venueId: 'v', guestId: 'g', matched: true, messageId: 'm' },
    ],
    [
      { status: 'skipped', kind: 'message', reason: 'venue_not_found' },
      { event: 'instagram_event_skipped', kind: 'message', reason: 'venue_not_found' },
    ],
    [
      { status: 'failed', kind: 'message', stage: 'message_insert', error: 'x', code: '23514' },
      { event: 'instagram_event_persist_failed', kind: 'message', stage: 'message_insert', error: 'x', code: '23514' },
    ],
  ])('logs %o as one line with exactly these fields', (outcome, expected) => {
    const lines = logged()
    logInstagramOutcome(outcome)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.[1]).toEqual(expected)
  })
})
