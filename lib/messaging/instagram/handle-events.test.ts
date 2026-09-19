// What the handler writes for each kind of event, run against Meta's recorded
// deliveries (fixtures/) and an in-memory store (testing/db-fake.ts) that
// throws on any query shape the handler shouldn't send.
//
// The insert payloads are pinned whole with toEqual, never toMatchObject: the
// fields that must NOT appear matter as much as the ones that must. A missing
// `channel` would save an Instagram message as a text message with no error
// (messages.channel defaults to 'text' until TAC-472), and a partial match
// would pass it.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

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
        provider_sent_at: '2026-09-18T04:00:54.588Z',
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
        hasProviderSentAt: true,
        guestCreatedVia: 'inbound_message',
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
        // Synthetic payload, timestamp 1: not a millisecond epoch, so no time.
        provider_sent_at: null,
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
        provider_sent_at: '2026-09-18T04:24:24.295Z',
        referral_ref: 'TESTVENUE',
        referral_source: 'SHORTLINK',
      },
    ])
    expect(outcomes).toMatchObject([{ status: 'persisted', kind: 'postback', hasReferral: true }])
  })

  it('creates the guest when a postback is their first action', async () => {
    const db = createInstagramDbFake({ venues: [VENUE] })
    await processInstagramDelivery(fixture('postback-referral'), db.client)
    expect(db.inserts('guests')).toMatchObject([{ instagram_scoped_id: GUEST_IGSID }])
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

// TAC-492: a new guest is 'qr_scan' when the event creating them carries a
// SHORTLINK referral, which is what the opener and understand_order key on.
// Every payload here is a recorded fixture or one changed in a single named
// way, so each case differs from Meta's real delivery by exactly the thing it
// tests.
describe("a new guest's created_via", () => {
  type Json = Record<string, unknown>
  type PostbackItem = { postback: Json & { referral?: Json } }

  /** postback-referral.json with its postback changed in place. */
  function postbackWith(change: (postback: PostbackItem['postback']) => void): unknown {
    const delivery = structuredClone(fixture('postback-referral')) as { entry: Array<{ messaging: PostbackItem[] }> }
    const item = delivery.entry[0]?.messaging[0]
    if (!item) throw new Error('postback-referral fixture has no messaging item')
    change(item.postback)
    return delivery
  }

  /** The referral object exactly as the recorded postback carried it. */
  function recordedReferral(): Json {
    const referral = (fixture('postback-referral') as { entry: Array<{ messaging: PostbackItem[] }> }).entry[0]
      ?.messaging[0]?.postback.referral
    if (!referral) throw new Error('postback-referral fixture has no referral')
    return referral
  }

  function guestRow(createdVia: 'qr_scan' | 'inbound_message'): Json {
    return {
      venue_id: VENUE_ID,
      instagram_scoped_id: GUEST_IGSID,
      created_via: createdVia,
      first_contacted_at: NOW,
      last_inbound_at: NOW,
      last_interaction_at: NOW,
    }
  }

  async function createdGuests(delivery: unknown): Promise<{ rows: Json[]; outcomes: InstagramEventOutcome[] }> {
    const db = createInstagramDbFake({ venues: [VENUE] })
    const outcomes = await processInstagramDelivery(delivery, db.client)
    return { rows: db.inserts('guests'), outcomes }
  }

  it('is qr_scan for the recorded icebreaker tap that followed an ig.me link', async () => {
    const { rows, outcomes } = await createdGuests(fixture('postback-referral'))
    expect(rows).toEqual([guestRow('qr_scan')])
    expect(outcomes).toMatchObject([{ status: 'persisted', guestCreated: true, guestCreatedVia: 'qr_scan' }])
  })

  it('is inbound_message for the same tap without the referral', async () => {
    const { rows, outcomes } = await createdGuests(postbackWith((p) => delete p.referral))
    expect(rows).toEqual([guestRow('inbound_message')])
    expect(outcomes).toMatchObject([{ guestCreatedVia: 'inbound_message' }])
  })

  it('is inbound_message for the recorded message, which carries no referral', async () => {
    const { rows } = await createdGuests(fixture('message'))
    expect(rows).toEqual([guestRow('inbound_message')])
  })

  // The icebreaker's payload is a label the venue chose, not evidence of a
  // scan (ruled 2026-09-18; TAC-455 on how it drifts). It must decide nothing.
  it.each<[string, (p: PostbackItem['postback']) => void, 'qr_scan' | 'inbound_message']>([
    [
      'a hello payload without the referral',
      (p) => {
        p.payload = 'ICEBREAKER_HELLO'
        delete p.referral
      },
      'inbound_message',
    ],
    ['no payload at all, with the referral', (p) => delete p.payload, 'qr_scan'],
  ])('ignores the icebreaker payload: %s', async (_case, change, expected) => {
    const { rows } = await createdGuests(postbackWith(change))
    expect(rows).toEqual([guestRow(expected)])
  })

  // Only Meta's source decides. The ref is not required, and nothing but the
  // exact SHORTLINK value counts.
  it.each<[string, (referral: Json) => void, 'qr_scan' | 'inbound_message']>([
    ['SHORTLINK with no ref', (r) => delete r.ref, 'qr_scan'],
    ['a ref with no source', (r) => delete r.source, 'inbound_message'],
    ['another source', (r) => (r.source = 'ADS'), 'inbound_message'],
    ['SHORTLINK in another case', (r) => (r.source = 'shortlink'), 'inbound_message'],
  ])('reads only the referral source: %s', async (_case, change, expected) => {
    const { rows } = await createdGuests(
      postbackWith((p) => {
        if (!p.referral) throw new Error('postback-referral fixture has no referral')
        change(p.referral)
      }),
    )
    expect(rows).toEqual([guestRow(expected)])
  })

  // Synthetic: a typed first message carrying a referral has never been
  // captured, so whether Meta sends one, and where, is still open (device QA).
  // Built from the recorded message plus the recorded referral, in both places
  // the parser accepts one. If Meta does send it, it counts: the evidence is
  // Meta's classification, not whether the guest tapped or typed.
  it.each<[string, (item: Json & { message: Json }) => void]>([
    ['inside `message`', (item) => (item.message.referral = recordedReferral())],
    ['beside `message`', (item) => (item.referral = recordedReferral())],
  ])('is qr_scan for a typed first message carrying the referral %s', async (_where, attach) => {
    const delivery = structuredClone(fixture('message')) as { entry: Array<{ messaging: Array<Json & { message: Json }> }> }
    const item = delivery.entry[0]?.messaging[0]
    if (!item) throw new Error('message fixture has no messaging item')
    attach(item)

    const { rows } = await createdGuests(delivery)
    expect(rows).toEqual([guestRow('qr_scan')])
  })

  // As on Sendblue, only creation sets it. The store has no update, so any
  // attempt to re-label would throw rather than pass.
  it('never re-labels a guest the venue already has', async () => {
    const existing: FakeRow = { ...GUEST, created_via: 'inbound_message' }
    const db = createInstagramDbFake({ venues: [VENUE], guests: [existing] })
    const outcomes = await processInstagramDelivery(fixture('postback-referral'), db.client)

    expect(db.inserts('guests')).toEqual([])
    expect(db.tables.guests).toEqual([{ ...GUEST, created_via: 'inbound_message' }])
    expect(outcomes).toMatchObject([{ status: 'persisted', guestCreated: false, guestCreatedVia: null }])
  })

  it('is decided by the first event that creates the guest in a delivery', async () => {
    const { rows, outcomes } = await createdGuests(batch('message', 'postback-referral'))
    expect(rows).toEqual([guestRow('inbound_message')])
    expect(outcomes).toMatchObject([
      { kind: 'message', guestCreated: true, guestCreatedVia: 'inbound_message' },
      { kind: 'postback', guestCreated: false, guestCreatedVia: null },
    ])
  })

  it("keeps the racing delivery's guest as it was created", async () => {
    const db = createInstagramDbFake({ venues: [VENUE] })
    db.beforeNextInsert('guests', () =>
      db.tables.guests.push({ ...GUEST, id: 'guest-winner', created_via: 'inbound_message' }),
    )
    const outcomes = await processInstagramDelivery(fixture('postback-referral'), db.client)

    expect(db.tables.guests).toEqual([{ ...GUEST, id: 'guest-winner', created_via: 'inbound_message' }])
    expect(outcomes).toMatchObject([{ status: 'persisted', guestId: 'guest-winner', guestCreatedVia: null }])
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
        provider_sent_at: '2026-09-18T04:02:26.605Z',
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
      { status: 'persisted', kind: 'postback', venueId: 'v', guestId: 'g', messageId: 'm', guestCreated: true, hasReferral: true, hasProviderSentAt: false, guestCreatedVia: 'qr_scan' },
      { event: 'instagram_event_persisted', kind: 'postback', venueId: 'v', guestId: 'g', messageId: 'm', guestCreated: true, hasReferral: true, hasProviderSentAt: false, guestCreatedVia: 'qr_scan' },
    ],
    [
      { status: 'persisted', kind: 'echo', venueId: 'v', guestId: 'g', messageId: 'm', guestCreated: false, hasReferral: false, hasProviderSentAt: true, guestCreatedVia: null },
      { event: 'instagram_event_persisted', kind: 'echo', venueId: 'v', guestId: 'g', messageId: 'm', guestCreated: false, hasReferral: false, hasProviderSentAt: true, guestCreatedVia: null },
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

// TAC-479: Instagram's own time on each saved row (migration 049). The rows the
// recorded deliveries produce are pinned whole above; these cover a missing
// time and who may write the column at all.
describe('provider_sent_at', () => {
  it('saves NULL, and says so in the outcome, when the item has no millisecond timestamp', async () => {
    const db = createInstagramDbFake({ venues: [VENUE], guests: [GUEST] })
    const payload = {
      object: 'instagram',
      entry: [
        {
          id: ACCOUNT_ID,
          time: 1789704055296,
          messaging: [{ sender: { id: GUEST_IGSID }, recipient: { id: ACCOUNT_ID }, message: { mid: 'm-no-time', text: 'hi' } }],
        },
      ],
    }
    const outcomes = await processInstagramDelivery(payload, db.client)

    expect(db.inserts('messages')).toMatchObject([{ provider_message_id: 'm-no-time', provider_sent_at: null }])
    expect(outcomes).toMatchObject([{ status: 'persisted', hasProviderSentAt: false }])
  })

  // The column has no default, so a writer that doesn't name it gets NULL. That
  // is what keeps it NULL on every Sendblue row, and it holds only while this
  // handler is the one place that writes it. The check is by mention, so a
  // reader (TAC-469's window gate) is also added here, deliberately, along
  // with any second writer. TAC-469 added its two readers: the window gate
  // and the reply check, both Instagram-only.
  it('is named by this handler and the Instagram outbound readers, and nothing else in the app', () => {
    const root = join(__dirname, '..', '..', '..')
    const writers: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(path)
          continue
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue
        if (readFileSync(path, 'utf8').includes('provider_sent_at')) writers.push(relative(root, path))
      }
    }
    for (const dir of ['app', 'lib', 'scripts']) walk(join(root, dir))

    expect(writers.sort()).toEqual([
      join('lib', 'messaging', 'instagram', 'handle-events.ts'),
      join('lib', 'messaging', 'instagram', 'reply-check.ts'),
      join('lib', 'messaging', 'instagram', 'window.ts'),
    ])
  })
})
