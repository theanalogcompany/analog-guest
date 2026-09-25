// The first block runs Meta's recorded deliveries (fixtures/, captured
// 2026-09-17) through the parser. The IDs and text asserted there are the
// replacements fixtures/README.md documents, typed out here rather than read
// back from the files, so a fixture and the parser can't agree by construction.
// Only the mids are read from the files: they are long, and what matters about
// them is which item each one came from.
//
// The later blocks are SYNTHETIC. Nothing else has been captured from Meta, so
// those payloads follow Meta's documented shapes and are named as such.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseInstagramDelivery, type InstagramEvent } from './parse-events'

const ACCOUNT_ID = '17841400000000001'
const GUEST_IGSID = '1000000000000001'

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

/** A one-entry, one-item delivery around a synthetic messaging item. */
function delivery(item: Record<string, unknown>, entry: Record<string, unknown> = {}): unknown {
  return { object: 'instagram', entry: [{ id: ACCOUNT_ID, time: 1, messaging: [item], ...entry }] }
}

// `timestamp: 1` is not a millisecond epoch, so every synthetic event built on
// these reads providerSentAt as null. The providerSentAt block sets real values.
const fromGuest = { sender: { id: GUEST_IGSID }, recipient: { id: ACCOUNT_ID }, timestamp: 1 }
const fromVenue = { sender: { id: ACCOUNT_ID }, recipient: { id: GUEST_IGSID }, timestamp: 1 }

describe('parseInstagramDelivery on the recorded Meta deliveries', () => {
  it('reads a guest message', () => {
    expect(parseInstagramDelivery(fixture('message'))).toEqual([
      {
        kind: 'message',
        accountId: ACCOUNT_ID,
        guestIgsid: GUEST_IGSID,
        mid: midOf('message', 'message'),
        providerSentAt: '2026-09-18T04:00:54.588Z',
        text: 'MSGTEXT',
        mediaUrls: [],
        referral: null,
      },
    ])
  })

  // Sender and recipient are reversed on an echo, so the guest is the
  // RECIPIENT. Reading the sender here would file the venue's reply under a
  // "guest" whose IGSID is the venue's own account.
  it('reads an echo as the venue talking to the guest', () => {
    expect(parseInstagramDelivery(fixture('echo'))).toEqual([
      {
        kind: 'echo',
        accountId: ACCOUNT_ID,
        guestIgsid: GUEST_IGSID,
        mid: midOf('echo', 'message'),
        providerSentAt: '2026-09-18T04:02:26.605Z',
        text: 'ECHO',
        mediaUrls: [],
      },
    ])
  })

  // The payload key is `read`. `messaging_seen` is only the subscription name,
  // and a parser keyed on it would file every receipt as unhandled.
  it('reads a read receipt by its `read` key, naming the message that was read', () => {
    const events = parseInstagramDelivery(fixture('read'))
    expect(events).toEqual([
      {
        kind: 'read',
        accountId: ACCOUNT_ID,
        guestIgsid: GUEST_IGSID,
        mid: midOf('read', 'read'),
        providerSentAt: '2026-09-18T04:02:30.514Z',
      },
    ])
    // The captured receipt points at the staff reply in echo.json.
    expect(midOf('read', 'read')).toBe(midOf('echo', 'message'))
  })

  it('reads an icebreaker postback with its title, its mid from inside `postback`, and the referral', () => {
    expect(parseInstagramDelivery(fixture('postback-referral'))).toEqual([
      {
        kind: 'postback',
        accountId: ACCOUNT_ID,
        guestIgsid: GUEST_IGSID,
        mid: midOf('postback-referral', 'postback'),
        providerSentAt: '2026-09-18T04:24:24.295Z',
        title: 'What are your hours?',
        referral: { ref: 'TESTVENUE', source: 'SHORTLINK' },
      },
    ])
  })

  it('keeps delivery order across a batched delivery', () => {
    const batched = {
      object: 'instagram',
      entry: (['message', 'echo', 'read'] as const).flatMap(
        (name) => (fixture(name) as { entry: unknown[] }).entry,
      ),
    }
    expect(parseInstagramDelivery(batched).map((e) => e.kind)).toEqual(['message', 'echo', 'read'])
  })
})

// TAC-479: Instagram's own time for each event. TAC-469's 24-hour window gate
// and TAC-486's countdown run from it, so the source matters: the ITEM's
// `timestamp` (when the guest acted), never `entry.time` (when Meta sent the
// delivery, later in every recorded payload).
describe('providerSentAt, Instagram\'s own time for the event', () => {
  it.each<[FixtureName]>([['message'], ['echo'], ['read'], ['postback-referral']])(
    'takes the recorded %s delivery\'s time from the item, not from the entry',
    (name) => {
      const raw = fixture(name) as { entry: Array<{ time: number; messaging: Array<{ timestamp: number }> }> }
      const entryTime = raw.entry[0]?.time
      const itemTime = raw.entry[0]?.messaging[0]?.timestamp
      if (entryTime === undefined || itemTime === undefined) throw new Error(`fixture ${name} has no times`)
      // The two differ in every capture; if a re-capture made them equal, this
      // test could no longer tell which one the parser read.
      expect(entryTime).not.toBe(itemTime)

      const [event] = parseInstagramDelivery(raw)
      expect(event).toHaveProperty('providerSentAt', new Date(itemTime).toISOString())
      expect(event).not.toHaveProperty('providerSentAt', new Date(entryTime).toISOString())
    },
  )

  it('keeps the milliseconds', () => {
    const [event] = parseInstagramDelivery(delivery({ ...fromGuest, timestamp: 1789704054588, message: { mid: 'm1', text: 'hi' } }))
    expect(event).toHaveProperty('providerSentAt', '2026-09-18T04:00:54.588Z')
  })

  it('accepts the lowest millisecond value it allows', () => {
    const [event] = parseInstagramDelivery(delivery({ ...fromGuest, timestamp: 1e12, message: { mid: 'm1', text: 'hi' } }))
    expect(event).toHaveProperty('providerSentAt', '2001-09-09T01:46:40.000Z')
  })

  // Seconds is the realistic unit mistake, and the dangerous one: read as
  // milliseconds it is January 1970, a window that closed decades ago.
  it.each<[string, unknown]>([
    ['a value in seconds', 1789704054],
    ['a numeric string', '1789704054588'],
    ['a fraction of a millisecond', 1789704054588.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a negative value', -1789704054588],
    ['zero', 0],
    ['a value past the upper bound', 1e13],
    ['null', null],
  ])('reads %s as no time at all', (_label, timestamp) => {
    const [event] = parseInstagramDelivery(delivery({ ...fromGuest, timestamp, message: { mid: 'm1', text: 'hi' } }))
    expect(event).toHaveProperty('providerSentAt', null)
  })

  it('reads a missing timestamp as no time at all', () => {
    const [event] = parseInstagramDelivery(
      delivery({ sender: { id: GUEST_IGSID }, recipient: { id: ACCOUNT_ID }, message: { mid: 'm1', text: 'hi' } }),
    )
    expect(event).toHaveProperty('providerSentAt', null)
  })

  it('reads an echo\'s and a postback\'s time the same way as a message\'s', () => {
    const echo = parseInstagramDelivery(
      delivery({ ...fromVenue, timestamp: 1789704146605, message: { mid: 'e1', is_echo: true, text: 'ok' } }),
    )
    const postback = parseInstagramDelivery(
      delivery({ ...fromGuest, timestamp: 1789705464295, postback: { mid: 'p1', title: 'Hours?' } }),
    )
    expect(echo).toMatchObject([{ kind: 'echo', providerSentAt: '2026-09-18T04:02:26.605Z' }])
    expect(postback).toMatchObject([{ kind: 'postback', providerSentAt: '2026-09-18T04:24:24.295Z' }])
  })
})

describe('parseInstagramDelivery on synthetic message shapes (not captured from Meta)', () => {
  it('keeps attachment URLs, with or without text', () => {
    const events = parseInstagramDelivery(
      delivery({
        ...fromGuest,
        message: {
          mid: 'm1',
          attachments: [
            { type: 'image', payload: { url: 'https://cdn.example/a.jpg' } },
            { type: 'story_mention', payload: { url: 'https://cdn.example/s.mp4' } },
            { type: 'image', payload: {} },
            'not an object',
          ],
        },
      }),
    )
    expect(events).toEqual([
      {
        kind: 'message',
        accountId: ACCOUNT_ID,
        guestIgsid: GUEST_IGSID,
        mid: 'm1',
        providerSentAt: null,
        text: null,
        mediaUrls: ['https://cdn.example/a.jpg', 'https://cdn.example/s.mp4'],
        referral: null,
      },
    ])
  })

  it('takes a referral from inside `message`, or from beside it', () => {
    const inside = parseInstagramDelivery(
      delivery({ ...fromGuest, message: { mid: 'm1', text: 'hi', referral: { ref: 'QR1', source: 'SHORTLINK' } } }),
    )
    const beside = parseInstagramDelivery(
      delivery({ ...fromGuest, message: { mid: 'm2', text: 'hi' }, referral: { source: 'ADS' } }),
    )
    expect(inside).toMatchObject([{ kind: 'message', referral: { ref: 'QR1', source: 'SHORTLINK' } }])
    expect(beside).toMatchObject([{ kind: 'message', referral: { ref: null, source: 'ADS' } }])
  })

  it('reads an echo carrying only an attachment', () => {
    const events = parseInstagramDelivery(
      delivery({
        ...fromVenue,
        message: { mid: 'e1', is_echo: true, attachments: [{ type: 'image', payload: { url: 'https://cdn.example/x.jpg' } }] },
      }),
    )
    expect(events).toEqual([
      {
        kind: 'echo',
        accountId: ACCOUNT_ID,
        guestIgsid: GUEST_IGSID,
        mid: 'e1',
        providerSentAt: null,
        text: null,
        mediaUrls: ['https://cdn.example/x.jpg'],
      },
    ])
  })

  it('reads a postback with no title as a postback, so it still counts as a guest action', () => {
    expect(parseInstagramDelivery(delivery({ ...fromGuest, postback: { mid: 'p1', payload: 'X' } }))).toEqual([
      { kind: 'postback', accountId: ACCOUNT_ID, guestIgsid: GUEST_IGSID, mid: 'p1', providerSentAt: null, title: null, referral: null },
    ])
  })

  it.each<[string, Record<string, unknown>, InstagramEvent]>([
    [
      'an unsent message',
      { ...fromGuest, message: { mid: 'm1', is_deleted: true } },
      { kind: 'unhandled', reason: 'message_deleted', fields: ['is_deleted', 'mid'] },
    ],
    [
      'unsupported content',
      { ...fromGuest, message: { mid: 'm1', is_unsupported: true } },
      { kind: 'unhandled', reason: 'message_unsupported', fields: ['is_unsupported', 'mid'] },
    ],
    [
      'a message with no text and no attachment URL',
      { ...fromGuest, message: { mid: 'm1', text: '', attachments: [] } },
      { kind: 'unhandled', reason: 'message_no_content', fields: ['attachments', 'mid', 'text'] },
    ],
    [
      'a message missing its mid',
      { ...fromGuest, message: { text: 'hi' } },
      { kind: 'unhandled', reason: 'malformed', fields: ['text'] },
    ],
    [
      'a guest message not addressed to the account',
      { sender: { id: GUEST_IGSID }, recipient: { id: '999' }, message: { mid: 'm1', text: 'hi' } },
      { kind: 'unhandled', reason: 'account_mismatch', fields: ['message'] },
    ],
    [
      'an echo not sent by the account',
      { sender: { id: '999' }, recipient: { id: GUEST_IGSID }, message: { mid: 'm1', text: 'hi', is_echo: true } },
      { kind: 'unhandled', reason: 'account_mismatch', fields: ['message'] },
    ],
    [
      'a read receipt from the account itself',
      { ...fromVenue, read: { mid: 'm1' } },
      { kind: 'unhandled', reason: 'account_mismatch', fields: ['read'] },
    ],
    [
      'an item with no sender',
      { recipient: { id: ACCOUNT_ID }, message: { mid: 'm1', text: 'hi' } },
      { kind: 'unhandled', reason: 'malformed', fields: ['message'] },
    ],
  ])('turns %s into an unhandled event, never a silent drop', (_name, item, expected) => {
    expect(parseInstagramDelivery(delivery(item))).toEqual([expected])
  })
})

describe('parseInstagramDelivery on fields this handler does not handle (synthetic)', () => {
  it.each<[string, Record<string, unknown>, InstagramEvent]>([
    ['a reaction', { ...fromGuest, reaction: { mid: 'm1', action: 'react' } }, { kind: 'unhandled', reason: 'unhandled_messaging_type', fields: ['reaction'] }],
    ['an edit', { ...fromGuest, message_edit: { mid: 'm1', text: 'x' } }, { kind: 'unhandled', reason: 'unhandled_messaging_type', fields: ['message_edit'] }],
    ['a handover', { ...fromGuest, pass_thread_control: { new_owner_app_id: '1' } }, { kind: 'unhandled', reason: 'unhandled_messaging_type', fields: ['pass_thread_control'] }],
    // TAC-536 made an ordinary standalone referral a handled kind; the reason
    // now names only the case with nothing usable in it.
    ['a referral carrying neither ref nor source', { ...fromGuest, referral: { type: 'OPEN_THREAD' } }, { kind: 'unhandled', reason: 'standalone_referral', fields: ['referral'] }],
  ])('names %s by its keys', (_name, item, expected) => {
    expect(parseInstagramDelivery(delivery(item))).toEqual([expected])
  })

  it('names each comment, live comment and mention change by its field', () => {
    const events = parseInstagramDelivery({
      object: 'instagram',
      entry: [
        {
          id: ACCOUNT_ID,
          time: 1,
          changes: [
            { field: 'comments', value: { text: 'nice' } },
            { field: 'live_comments', value: {} },
            { field: 'mentions', value: {} },
          ],
        },
      ],
    })
    expect(events).toEqual([
      { kind: 'unhandled', reason: 'changes_field', fields: ['comments'] },
      { kind: 'unhandled', reason: 'changes_field', fields: ['live_comments'] },
      { kind: 'unhandled', reason: 'changes_field', fields: ['mentions'] },
    ])
  })

  it('reports standby items', () => {
    const events = parseInstagramDelivery({
      object: 'instagram',
      entry: [{ id: ACCOUNT_ID, time: 1, standby: [{ ...fromGuest, message: { mid: 'm1', text: 'hi' } }] }],
    })
    expect(events).toEqual([{ kind: 'unhandled', reason: 'standby', fields: ['message'] }])
  })

  it('reports a delivery for another Meta product by its object', () => {
    expect(parseInstagramDelivery({ object: 'page', entry: [] })).toEqual([
      { kind: 'unhandled', reason: 'not_instagram', fields: ['page'] },
    ])
  })

  it('reports an entry with nothing it recognizes', () => {
    expect(parseInstagramDelivery({ object: 'instagram', entry: [{ id: ACCOUNT_ID, time: 1, other: [] }] })).toEqual([
      { kind: 'unhandled', reason: 'unrecognized_entry_field', fields: ['other'] },
    ])
    expect(parseInstagramDelivery({ object: 'instagram', entry: [{ id: ACCOUNT_ID, time: 1 }] })).toEqual([
      { kind: 'unhandled', reason: 'malformed', fields: [] },
    ])
  })

  // summarize-payload.ts only reads keys inside `messaging` items, so an array
  // Meta adds beside `messaging` would otherwise reach no log at all.
  it('reports an unknown array beside `messaging` and still reads the messaging', () => {
    const events = parseInstagramDelivery({
      object: 'instagram',
      entry: [
        {
          id: ACCOUNT_ID,
          time: 1,
          messaging: [{ ...fromGuest, message: { mid: 'm1', text: 'hi' } }],
          new_thing: [{ x: 1 }],
        },
      ],
    })
    expect(events.map((e) => (e.kind === 'unhandled' ? `${e.reason}:${e.fields.join(',')}` : e.kind))).toEqual([
      'message',
      'unrecognized_entry_field:new_thing',
    ])
  })

  it('handles a message beside unhandled items in the same entry, in order', () => {
    const events = parseInstagramDelivery({
      object: 'instagram',
      entry: [
        {
          id: ACCOUNT_ID,
          time: 1,
          messaging: [
            { ...fromGuest, reaction: { mid: 'm0' } },
            { ...fromGuest, message: { mid: 'm1', text: 'hi' } },
          ],
        },
      ],
    })
    expect(events.map((e) => (e.kind === 'unhandled' ? e.reason : e.kind))).toEqual([
      'unhandled_messaging_type',
      'message',
    ])
  })
})

describe('parseInstagramDelivery never throws and never carries content in an unhandled event', () => {
  it.each<[string, unknown]>([
    ['null', null],
    ['a string', 'hello'],
    ['an array', []],
    ['an entry that is not an array', { object: 'instagram', entry: {} }],
    ['an entry item that is a number', { object: 'instagram', entry: [7] }],
    ['a messaging item that is null', { object: 'instagram', entry: [{ id: ACCOUNT_ID, messaging: [null] }] }],
    ['a change that is a string', { object: 'instagram', entry: [{ id: ACCOUNT_ID, changes: ['x'] }] }],
  ])('degrades %s to unhandled events', (_name, input) => {
    const events = parseInstagramDelivery(input)
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) expect(event.kind).toBe('unhandled')
  })

  it('carries key names only, never the values beside them', () => {
    const events = parseInstagramDelivery(
      delivery({ ...fromGuest, reaction: { mid: 'secret-mid', emoji: 'SECRET-EMOJI' } }),
    )
    const text = JSON.stringify(events)
    expect(text).not.toContain('secret-mid')
    expect(text).not.toContain('SECRET-EMOJI')
    expect(text).not.toContain(GUEST_IGSID)
  })

  it('caps how many names and how long a name it carries', () => {
    // The over-long key comes first, so it is skipped rather than merely cut
    // off by the count cap.
    const item: Record<string, unknown> = { ...fromGuest, ['x'.repeat(65)]: 1 }
    for (let i = 0; i < 30; i++) item[`k${String(i).padStart(2, '0')}`] = 1
    const [event] = parseInstagramDelivery(delivery(item))
    expect(event).toMatchObject({ kind: 'unhandled', reason: 'unhandled_messaging_type' })
    const fields = event?.kind === 'unhandled' ? event.fields : []
    expect(fields).toEqual(Array.from({ length: 12 }, (_, i) => `k${String(i).padStart(2, '0')}`))
  })
})

// TAC-536. SYNTHETIC: no standalone referral has ever been captured from Meta.
// The shape follows Meta's documentation and the two production log lines of
// 2026-09-20, which recorded `fields: ['referral']` and nothing else. The
// referral's own contents are the ones the recorded POSTBACK fixture carries,
// since that is the same ig.me link arriving by the other path.
describe('parseInstagramDelivery on a standalone referral (synthetic, TAC-536)', () => {
  const referralItem = {
    ...fromGuest,
    referral: { ref: 'QR1', source: 'SHORTLINK', type: 'OPEN_THREAD' },
  }

  it('parses it as its own kind, with the guest taken from the sender', () => {
    expect(parseInstagramDelivery(delivery(referralItem))).toEqual([
      {
        kind: 'referral',
        accountId: ACCOUNT_ID,
        guestIgsid: GUEST_IGSID,
        providerSentAt: null,
        referral: { ref: 'QR1', source: 'SHORTLINK' },
      },
    ])
  })

  // The whole point of handling it: without a real timestamp the row it
  // becomes carries no provider_sent_at, and TAC-469's window gate would not
  // see the scan reopen Meta's window.
  it('carries Meta own clock from the item timestamp, not entry.time', () => {
    const events = parseInstagramDelivery(
      // 2026-09-20T20:18:08Z: the first of the two standalone referrals the
      // ticket reports, to the second.
      delivery({ ...referralItem, timestamp: 1789935488000 }, { time: 1789935489 }),
    )
    expect(events).toEqual([expect.objectContaining({ providerSentAt: '2026-09-20T20:18:08.000Z' })])
  })

  // A referral whose only usable field is `source` still identifies the link.
  // TAC-492 already rules that `ref` is not required.
  it('accepts a source with no ref', () => {
    const events = parseInstagramDelivery(
      delivery({ ...fromGuest, referral: { source: 'SHORTLINK' } }),
    )
    expect(events).toEqual([
      expect.objectContaining({ kind: 'referral', referral: { ref: null, source: 'SHORTLINK' } }),
    ])
  })

  // The account never sends itself a referral. Without this the sender would
  // be read as the guest and the event filed against the venue's own ID.
  it('refuses an item addressed the wrong way round', () => {
    const events = parseInstagramDelivery(
      delivery({ ...fromVenue, referral: { ref: 'QR1', source: 'SHORTLINK' } }),
    )
    expect(events).toEqual([
      { kind: 'unhandled', reason: 'account_mismatch', fields: ['referral'] },
    ])
  })

  // A referral BESIDE a message is the message's own referral (TAC-492) and
  // must not become a second, separate event: the message branch is checked
  // first and carries it.
  it('leaves a referral that arrives beside a message to the message', () => {
    const events = parseInstagramDelivery(
      delivery({
        ...fromGuest,
        message: { mid: 'mid-1', text: 'hey' },
        referral: { ref: 'QR1', source: 'SHORTLINK' },
      }),
    )
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'message',
        referral: { ref: 'QR1', source: 'SHORTLINK' },
      }),
    ])
  })
})
