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
      { kind: 'read', accountId: ACCOUNT_ID, guestIgsid: GUEST_IGSID, mid: midOf('read', 'read') },
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
        text: null,
        mediaUrls: ['https://cdn.example/x.jpg'],
      },
    ])
  })

  it('reads a postback with no title as a postback, so it still counts as a guest action', () => {
    expect(parseInstagramDelivery(delivery({ ...fromGuest, postback: { mid: 'p1', payload: 'X' } }))).toEqual([
      { kind: 'postback', accountId: ACCOUNT_ID, guestIgsid: GUEST_IGSID, mid: 'p1', title: null, referral: null },
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
    // A guest following an ig.me link into a thread that already has messages.
    // Its own reason, because its ref is lost and that loss should be countable.
    ['a referral with no message', { ...fromGuest, referral: { ref: 'QR1', source: 'SHORTLINK', type: 'OPEN_THREAD' } }, { kind: 'unhandled', reason: 'standalone_referral', fields: ['referral'] }],
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
