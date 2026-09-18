import { describe, expect, it } from 'vitest'

import { summarizeInstagramPayload } from './summarize-payload'

const ACCOUNT_ID = '17841400000000000'
const SENDER_IGSID = '9876543210987654'
const MESSAGE_TEXT = 'do you have oat milk?'
const MESSAGE_ID = 'aWdfZG06MRlhZAEZAEXNjUyMzE4NzY1NDMyMTA'

// Shaped after a real Instagram `messages` delivery.
const MESSAGES_PAYLOAD = {
  object: 'instagram',
  entry: [
    {
      id: ACCOUNT_ID,
      time: 1758153600000,
      messaging: [
        {
          sender: { id: SENDER_IGSID },
          recipient: { id: ACCOUNT_ID },
          timestamp: 1758153600000,
          message: { mid: MESSAGE_ID, text: MESSAGE_TEXT },
        },
      ],
    },
  ],
}

describe('summarizeInstagramPayload', () => {
  it('reduces a messages delivery to object, count, time and event type', () => {
    expect(summarizeInstagramPayload(MESSAGES_PAYLOAD)).toEqual({
      object: 'instagram',
      entryCount: 1,
      events: [{ time: 1758153600000, types: ['message'] }],
    })
  })

  // Distinct from the leak test below, and each catches a mutant the other
  // misses: this one fails if the sender/recipient/timestamp filter is
  // dropped, because those key NAMES would join `types` while no VALUE leaks.
  it('omits the routing keys from the event types', () => {
    const { events } = summarizeInstagramPayload(MESSAGES_PAYLOAD)
    expect(events[0]?.types).not.toContain('sender')
    expect(events[0]?.types).not.toContain('recipient')
    expect(events[0]?.types).not.toContain('timestamp')
  })

  // This is the assertion that holds AC #6 once INSTAGRAM_LOG_RAW_INBOUND is
  // off, which is the default and so the steady state. It fails if any value
  // reaches the summary, however it gets there.
  it('leaks no guest content and no identifiers into the serialized summary', () => {
    const serialized = JSON.stringify(summarizeInstagramPayload(MESSAGES_PAYLOAD))
    expect(serialized).not.toContain(MESSAGE_TEXT)
    expect(serialized).not.toContain(MESSAGE_ID)
    expect(serialized).not.toContain(SENDER_IGSID)
    expect(serialized).not.toContain(ACCOUNT_ID)
  })

  it('names a referral event', () => {
    const summary = summarizeInstagramPayload({
      object: 'instagram',
      entry: [
        {
          id: ACCOUNT_ID,
          time: 2,
          messaging: [{ sender: { id: SENDER_IGSID }, referral: { ref: 'promo' } }],
        },
      ],
    })
    expect(summary.events[0]?.types).toEqual(['referral'])
  })

  it('unions, dedupes and sorts types across the items of one entry', () => {
    const summary = summarizeInstagramPayload({
      object: 'instagram',
      entry: [
        {
          id: ACCOUNT_ID,
          time: 3,
          messaging: [{ read: {} }, { message: {} }, { message: {} }, { reaction: {} }],
        },
      ],
    })
    expect(summary.events[0]?.types).toEqual(['message', 'reaction', 'read'])
  })

  it('summarizes each entry of a batched delivery', () => {
    const summary = summarizeInstagramPayload({
      object: 'instagram',
      entry: [
        { id: ACCOUNT_ID, time: 1, messaging: [{ message: {} }] },
        { id: ACCOUNT_ID, time: 2, messaging: [{ read: {} }] },
      ],
    })
    expect(summary.entryCount).toBe(2)
    expect(summary.events).toEqual([
      { time: 1, types: ['message'] },
      { time: 2, types: ['read'] },
    ])
  })

  it('reports a non-numeric time as null rather than coercing it', () => {
    const summary = summarizeInstagramPayload({
      object: 'instagram',
      entry: [{ id: ACCOUNT_ID, time: '1758153600000', messaging: [{ message: {} }] }],
    })
    expect(summary.events[0]?.time).toBeNull()
  })

  // Nothing authenticates this endpoint while the signature is unenforced, so
  // the caps bound what a stranger can write into our logs.
  it('drops an absurdly long type key', () => {
    const summary = summarizeInstagramPayload({
      object: 'instagram',
      entry: [{ id: ACCOUNT_ID, time: 1, messaging: [{ ['x'.repeat(100)]: 1, message: {} }] }],
    })
    expect(summary.events[0]?.types).toEqual(['message'])
  })

  it('caps the number of type keys per entry', () => {
    const item: Record<string, number> = {}
    for (let i = 0; i < 40; i += 1) item[`k${String(i).padStart(2, '0')}`] = 1
    const summary = summarizeInstagramPayload({
      object: 'instagram',
      entry: [{ id: ACCOUNT_ID, time: 1, messaging: [item] }],
    })
    expect(summary.events[0]?.types).toHaveLength(12)
  })

  it('caps rendered entries while reporting the true count', () => {
    const entry = { id: ACCOUNT_ID, time: 1, messaging: [{ message: {} }] }
    const summary = summarizeInstagramPayload({
      object: 'instagram',
      entry: Array.from({ length: 250 }, () => entry),
    })
    // The cap is on what gets RENDERED into the log line; the count stays
    // honest about what actually arrived, which is the whole reason the two
    // are separate fields.
    expect(summary.events).toHaveLength(20)
    expect(summary.entryCount).toBe(250)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'not json shaped'],
    ['a number', 7],
    ['an array', [1, 2]],
    ['an empty object', {}],
    ['a non-array entry', { object: 'instagram', entry: 'nope' }],
    ['a null entry item', { object: 'instagram', entry: [null] }],
    ['a non-array messaging', { object: 'instagram', entry: [{ messaging: 'nope' }] }],
    ['a null messaging item', { object: 'instagram', entry: [{ messaging: [null] }] }],
    ['a non-string object field', { object: 42, entry: [] }],
  ])('degrades to a safe summary for %s', (_label, input) => {
    expect(() => summarizeInstagramPayload(input)).not.toThrow()
    const summary = summarizeInstagramPayload(input)
    expect(typeof summary.entryCount).toBe('number')
    expect(Array.isArray(summary.events)).toBe(true)
  })
})
