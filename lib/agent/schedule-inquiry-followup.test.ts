// TAC-386. Which inbound turns arm a follow-up, and which never do.
//
// The excluded categories are the important half. Each is refused here as well
// as in the classifier prompt, and the prompt already has a test per line, so
// what these prove is the BELT: that a model ignoring its instruction once
// cannot put a cheerful check-in three hours behind a guest reporting a stale
// muffin. A test that only exercised `followUpWorthy: false` would prove the
// prompt and nothing else.

import { describe, expect, it, vi } from 'vitest'

import {
  callsNamed,
  queryRecorder,
} from '@/lib/messaging/instagram/testing/query-recorder'
import {
  scheduleInquiryFollowup,
  type ScheduleInquiryInput,
} from './schedule-inquiry-followup'
import type { MessageCategory } from '@/lib/ai/types'

const VENUE = '11111111-1111-4111-8111-111111111111'
const GUEST = '22222222-2222-4222-8222-222222222222'
const MESSAGE = '33333333-3333-4333-8333-333333333333'

/** Mon 2026-09-28 11:00 PDT, inside Le Mil's 7:00 - 15:00. */
const META_SENT_AT = '2026-09-28T18:00:00.000Z'

const ok = (data: unknown) => ({ data, error: null })

function input(over: Partial<ScheduleInquiryInput> = {}): ScheduleInquiryInput {
  return {
    classification: {
      category: 'new_question',
      crisisSafety: false,
      followUpWorthy: true,
    },
    currentMessage: { id: MESSAGE, body: 'where do I park around there' },
    conversationChannel: 'instagram',
    venue: {
      id: VENUE,
      timezone: 'America/Los_Angeles',
      venueInfo: {
        hours: {
          monday: '7:00 AM – 3:00 PM',
          tuesday: '7:00 AM – 3:00 PM',
          wednesday: '7:00 AM – 3:00 PM',
          thursday: '7:00 AM – 3:00 PM',
          friday: '7:00 AM – 3:00 PM',
          saturday: '7:00 AM – 3:00 PM',
          sunday: '7:00 AM – 3:00 PM',
        },
      },
    },
    guest: { id: GUEST },
    ...over,
  }
}

/** A client that answers the provider_sent_at read and accepts the insert. */
function client(over: Record<string, unknown[]> = {}) {
  return queryRecorder({
    messages: [ok({ provider_sent_at: META_SENT_AT })],
    inquiry_followups: [ok(null)],
    ...over,
  })
}

describe('scheduleInquiryFollowup — arming', () => {
  it('arms a row with the question and the derived moment', async () => {
    const { client: c, queries } = client()
    const r = await scheduleInquiryFollowup(input(), c)
    expect(r).toEqual({
      kind: 'armed',
      // 11:00 PDT + 3h = 14:00 PDT, still open.
      dueAt: new Date('2026-09-28T21:00:00.000Z'),
    })
    const [row] = callsNamed(queries[1], 'insert')[0] as [
      Record<string, unknown>,
    ]
    expect(row).toMatchObject({
      venue_id: VENUE,
      guest_id: GUEST,
      source_message_id: MESSAGE,
      question: 'where do I park around there',
      asked_at: META_SENT_AT,
      due_at: '2026-09-28T21:00:00.000Z',
    })
  })

  it("stores the window from META'S clock, not our receive time", async () => {
    // provider_sent_at + 24h. Deriving it from `receivedAt` would put the close
    // LATER than Meta's own, which is the one direction that matters.
    const { client: c, queries } = client()
    await scheduleInquiryFollowup(input(), c)
    const [row] = callsNamed(queries[1], 'insert')[0] as [
      Record<string, unknown>,
    ]
    expect(row.window_closes_at).toBe('2026-09-29T18:00:00.000Z')
  })

  it('trims the question rather than storing surrounding whitespace', async () => {
    const { client: c, queries } = client()
    await scheduleInquiryFollowup(
      input({ currentMessage: { id: MESSAGE, body: '  which beans?  ' } }),
      c,
    )
    const [row] = callsNamed(queries[1], 'insert')[0] as [
      Record<string, unknown>,
    ]
    expect(row.question).toBe('which beans?')
  })
})

describe('scheduleInquiryFollowup — the classifier signal', () => {
  it('arms nothing when followUpWorthy is false', async () => {
    const { client: c } = client()
    const r = await scheduleInquiryFollowup(
      input({
        classification: {
          category: 'new_question',
          crisisSafety: false,
          followUpWorthy: false,
        },
      }),
      c,
    )
    expect(r).toEqual({ kind: 'not_worthy' })
  })

  it('arms nothing on an unclassified turn', async () => {
    const { client: c } = client()
    const r = await scheduleInquiryFollowup(input({ classification: null }), c)
    expect(r).toEqual({ kind: 'excluded', reason: 'no_classified_inbound' })
  })
})

describe('scheduleInquiryFollowup — the structural exclusions (the belt)', () => {
  // THE POINT OF THESE: each one passes `followUpWorthy: true`, which is the
  // model having got it wrong. The prompt says not to, and these prove the code
  // does not rely on that.
  it.each<[MessageCategory, string]>([
    ['comp_complaint', 'category_comp_complaint'],
    ['manual', 'category_manual'],
    ['opt_out', 'category_opt_out'],
    ['acknowledgment', 'category_acknowledgment'],
  ])(
    'refuses %s even when the model said followUpWorthy',
    async (category, reason) => {
      const { client: c, queries } = client()
      const r = await scheduleInquiryFollowup(
        input({
          classification: {
            category,
            crisisSafety: false,
            followUpWorthy: true,
          },
        }),
        c,
      )
      expect(r).toEqual({ kind: 'excluded', reason })
      // Nothing was written, and nothing was even read.
      expect(queries).toHaveLength(0)
    },
  )

  it('refuses a crisis message even when the model said followUpWorthy', async () => {
    const { client: c, queries } = client()
    const r = await scheduleInquiryFollowup(
      input({
        classification: {
          category: 'new_question',
          crisisSafety: true,
          followUpWorthy: true,
        },
      }),
      c,
    )
    expect(r).toEqual({ kind: 'excluded', reason: 'crisis_safety' })
    expect(queries).toHaveLength(0)
  })

  it('arms nothing on a text conversation', async () => {
    // Ruled 2026-09-30: Instagram only. Arming a text row would build a queue of
    // work handleFollowup refuses at dispatch.
    const { client: c } = client()
    const r = await scheduleInquiryFollowup(
      input({ conversationChannel: 'text' }),
      c,
    )
    expect(r).toEqual({ kind: 'excluded', reason: 'not_instagram' })
  })

  it('arms nothing on an unresolved channel', async () => {
    const { client: c } = client()
    const r = await scheduleInquiryFollowup(
      input({ conversationChannel: null }),
      c,
    )
    expect(r).toEqual({ kind: 'excluded', reason: 'not_instagram' })
  })

  it('arms nothing for an empty body', async () => {
    // A photo with no text. classifyMessage refuses an empty body so this should
    // be unreachable, but a row with an empty question would render an empty
    // quoted string straight into the prompt.
    const { client: c } = client()
    const r = await scheduleInquiryFollowup(
      input({ currentMessage: { id: MESSAGE, body: '   ' } }),
      c,
    )
    expect(r).toEqual({ kind: 'excluded', reason: 'empty_question' })
  })
})

describe('scheduleInquiryFollowup — timing and the window', () => {
  it('arms nothing when the venue hours cannot be read', async () => {
    const { client: c } = client()
    const r = await scheduleInquiryFollowup(
      input({
        venue: { ...input().venue, venueInfo: { hours: {} } },
      }),
      c,
    )
    expect(r).toEqual({ kind: 'skipped', reason: 'hours_unreadable' })
  })

  it('arms nothing when the moment would land past the window', async () => {
    // Sat 13:00 PDT with Sunday and Monday shut: the next open period is
    // Tuesday, by which time the window has been closed for two days.
    const { client: c } = client({
      messages: [ok({ provider_sent_at: '2026-10-03T20:00:00.000Z' })],
    })
    const hours = {
      ...input().venue.venueInfo.hours,
      sunday: 'Closed',
      monday: 'Closed',
    }
    const r = await scheduleInquiryFollowup(
      input({ venue: { ...input().venue, venueInfo: { hours } } }),
      c,
    )
    expect(r).toEqual({ kind: 'skipped', reason: 'past_window' })
  })

  it('arms nothing when the row carries no Meta timestamp', async () => {
    // Every row before migration 049. The window cannot be derived, so nothing
    // is armed: same direction as unreadable hours.
    const { client: c } = client({
      messages: [ok({ provider_sent_at: null })],
    })
    const r = await scheduleInquiryFollowup(input(), c)
    expect(r).toEqual({ kind: 'excluded', reason: 'no_provider_sent_at' })
  })
})

describe('scheduleInquiryFollowup — the unique indexes', () => {
  it('reports already_pending on a unique violation', async () => {
    // Either index: the per-message one (a retried webhook) or the
    // per-guest-pending one (the guest already has a question waiting, which is
    // the one-at-a-time rule doing its job). Both are expected states.
    const { client: c } = client({
      inquiry_followups: [
        { data: null, error: { code: '23505', message: 'duplicate key' } },
      ],
    })
    const r = await scheduleInquiryFollowup(input(), c)
    expect(r).toEqual({ kind: 'already_pending' })
  })

  it('reports a real insert failure as failed, not as already_pending', async () => {
    const { client: c } = client({
      inquiry_followups: [
        { data: null, error: { code: '42P01', message: 'no such table' } },
      ],
    })
    const r = await scheduleInquiryFollowup(input(), c)
    expect(r).toEqual({ kind: 'failed', error: 'no such table' })
  })
})

describe('scheduleInquiryFollowup — never throws into the reply path', () => {
  it('returns failed rather than throwing when the client blows up', async () => {
    // The whole posture of this module: a failure costs a missed follow-up,
    // never a broken reply. handle-inbound calls it inside waitUntil and would
    // log an unexpected throw as an error.
    const exploding = {
      from: vi.fn(() => {
        throw new Error('connection reset')
      }),
    } as unknown as Parameters<typeof scheduleInquiryFollowup>[1]
    const r = await scheduleInquiryFollowup(input(), exploding)
    expect(r).toEqual({ kind: 'failed', error: 'connection reset' })
  })
})
