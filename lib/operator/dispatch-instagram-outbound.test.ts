import { describe, expect, it } from 'vitest'

import { callsNamed, queryRecorder } from '@/lib/messaging/instagram/testing/query-recorder'
import {
  prepareInstagramOperatorSend,
  restoreCardAfterRefusedSend,
  settleFailedInstagramOperatorSend,
  stampInstagramOperatorSend,
} from './dispatch-instagram-outbound'

const NOW = new Date('2026-09-19T18:00:00.000Z')
const HOUR = 60 * 60 * 1000
const INPUT = { venueId: 'venue-1', guestId: 'guest-1', body: 'Open until 3', now: NOW }

function target(accountId: string | null = '17841400000000001', igsid: string | null = '1000000000000001') {
  return {
    venues: [{ data: { instagram_account_id: accountId }, error: null }],
    guests: [{ data: { instagram_scoped_id: igsid }, error: null }],
  }
}

describe('prepareInstagramOperatorSend: checked before the card leaves the queue', () => {
  it('passes a card inside the window', async () => {
    const { client } = queryRecorder({
      ...target(),
      messages: [{ data: { provider_sent_at: new Date(NOW.getTime() - HOUR).toISOString() }, error: null }],
    })
    expect(await prepareInstagramOperatorSend(client, INPUT, () => 'tok')).toEqual({
      ok: true,
      target: { accountId: '17841400000000001', recipientId: '1000000000000001', token: 'tok' },
    })
  })

  it("refuses a card whose guest last wrote over 24 hours ago, and says to send it from the app", async () => {
    const { client } = queryRecorder({
      ...target(),
      messages: [{ data: { provider_sent_at: new Date(NOW.getTime() - 25 * HOUR).toISOString() }, error: null }],
    })
    const result = await prepareInstagramOperatorSend(client, INPUT, () => 'tok')
    expect(result).toMatchObject({ ok: false, errorCode: 'instagram_window_closed' })
    expect(!result.ok && result.error).toContain('Instagram app')
  })

  it('refuses an over-cap card rather than splitting what the operator approved', async () => {
    const { client, queries } = queryRecorder({})
    const result = await prepareInstagramOperatorSend(client, { ...INPUT, body: 'a'.repeat(1001) }, () => 'tok')
    expect(result).toMatchObject({ ok: false, errorCode: 'over_byte_cap' })
    expect(queries).toHaveLength(0)
  })

  it('refuses a guest with no Instagram ID', async () => {
    const { client } = queryRecorder(target('acct', null))
    expect(await prepareInstagramOperatorSend(client, INPUT, () => 'tok')).toMatchObject({
      ok: false,
      errorCode: 'no_instagram_id',
    })
  })

  it('refuses a venue with no Instagram account, and a missing token, as misconfiguration', async () => {
    expect(await prepareInstagramOperatorSend(queryRecorder(target(null)).client, INPUT, () => 'tok')).toMatchObject({
      errorCode: 'venue_misconfigured',
    })
    expect(await prepareInstagramOperatorSend(queryRecorder(target()).client, INPUT, () => null)).toMatchObject({
      errorCode: 'venue_misconfigured',
    })
  })

  it('does not refuse when the window cannot be read: Meta decides', async () => {
    const { client } = queryRecorder({ ...target(), messages: [{ data: null, error: { message: 'boom' } }] })
    expect((await prepareInstagramOperatorSend(client, INPUT, () => 'tok')).ok).toBe(true)
  })
})

describe('restoreCardAfterRefusedSend: a refused send stays a card (rule 4)', () => {
  it('puts the card back in the queue only if it is still flipped and unsent', async () => {
    const { client, queries } = queryRecorder({ messages: [{ data: [{ id: 'card-1' }], error: null }] })
    expect(await restoreCardAfterRefusedSend(client, { messageId: 'card-1', flippedTo: 'approved' })).toBe(true)
    const [query] = queries
    expect(callsNamed(query!, 'update')).toEqual([[{ review_state: 'pending', previous_review_state: null }]])
    expect(callsNamed(query!, 'eq')).toEqual([
      ['id', 'card-1'],
      ['review_state', 'approved'],
    ])
    expect(callsNamed(query!, 'is')).toEqual([['provider_message_id', null]])
  })

  it('reports a card it could not restore', async () => {
    const { client } = queryRecorder({ messages: [{ data: [], error: null }] })
    expect(await restoreCardAfterRefusedSend(client, { messageId: 'card-1', flippedTo: 'edited' })).toBe(false)
  })
})

describe('stampInstagramOperatorSend: the echo got here first (rule 6)', () => {
  const STAMP = { messageId: 'card-1', venueId: 'venue-1', guestId: 'guest-1', mid: 'mid-1', sentAt: NOW.toISOString() }
  const COLLISION = {
    data: null,
    error: { code: '23505', message: 'duplicate key value violates unique constraint "messages_provider_message_id_unique"' },
  }

  it('writes the mid onto the card when our write lands first', async () => {
    const { client, queries } = queryRecorder({ messages: [{ data: null, error: null }] })
    expect(await stampInstagramOperatorSend(client, STAMP)).toEqual({ ok: true, folded: false })
    expect(callsNamed(queries[0]!, 'update')).toEqual([[{ status: 'sent', sent_at: NOW.toISOString(), provider_message_id: 'mid-1' }]])
  })

  it("copies the echo's provider_sent_at onto the card BEFORE deleting the echo, then writes the mid (ruled)", async () => {
    const { client, queries } = queryRecorder({
      messages: [
        COLLISION,
        { data: { id: 'echo-1', provider_sent_at: '2026-09-19T17:59:59.500Z' }, error: null },
        { data: null, error: null }, // copy
        { data: null, error: null }, // delete
        { data: null, error: null }, // stamp again
      ],
    })
    expect(await stampInstagramOperatorSend(client, STAMP)).toEqual({ ok: true, folded: true })

    const [, findEcho, copy, remove, restamp] = queries
    // Only that echo: the same mid, this guest, this venue, outbound, not an
    // agent row, and not the card itself.
    expect(callsNamed(findEcho!, 'eq')).toEqual([
      ['provider_message_id', 'mid-1'],
      ['venue_id', 'venue-1'],
      ['guest_id', 'guest-1'],
      ['direction', 'outbound'],
    ])
    expect(callsNamed(findEcho!, 'is')).toEqual([['generated_by', null]])
    expect(callsNamed(findEcho!, 'neq')).toEqual([['id', 'card-1']])
    // The order is the ruling: nothing the reply check reads is lost.
    expect(callsNamed(copy!, 'update')).toEqual([[{ provider_sent_at: '2026-09-19T17:59:59.500Z' }]])
    expect(callsNamed(copy!, 'eq')).toEqual([['id', 'card-1']])
    expect(callsNamed(remove!, 'delete')).toEqual([[]])
    expect(callsNamed(remove!, 'eq')).toEqual([
      ['id', 'echo-1'],
      ['provider_message_id', 'mid-1'],
    ])
    expect(callsNamed(remove!, 'is')).toEqual([['generated_by', null]])
    expect(callsNamed(restamp!, 'update')).toEqual([[{ status: 'sent', sent_at: NOW.toISOString(), provider_message_id: 'mid-1' }]])
  })

  it('skips the copy when the echo has no Meta time', async () => {
    const { client, queries } = queryRecorder({
      messages: [COLLISION, { data: { id: 'echo-1', provider_sent_at: null }, error: null }, { data: null, error: null }, { data: null, error: null }],
    })
    expect(await stampInstagramOperatorSend(client, STAMP)).toEqual({ ok: true, folded: true })
    expect(queries.map((q) => q.calls[0]![0])).toEqual(['update', 'select', 'delete', 'update'])
  })

  it('never deletes anything when the echo copy fails', async () => {
    const { client, queries } = queryRecorder({
      messages: [
        COLLISION,
        { data: { id: 'echo-1', provider_sent_at: '2026-09-19T17:59:59.500Z' }, error: null },
        { data: null, error: { message: 'copy failed' } },
      ],
    })
    expect(await stampInstagramOperatorSend(client, STAMP)).toMatchObject({ ok: false })
    expect(queries.some((q) => q.calls.some(([name]) => name === 'delete'))).toBe(false)
  })

  it('fails when the mid collides with no echo to fold in', async () => {
    const { client } = queryRecorder({ messages: [COLLISION, { data: null, error: null }] })
    expect(await stampInstagramOperatorSend(client, STAMP)).toMatchObject({ ok: false })
  })

  it('does not treat a collision on any other constraint as the echo', async () => {
    const { client, queries } = queryRecorder({
      messages: [{ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "something_else"' } }],
    })
    expect(await stampInstagramOperatorSend(client, STAMP)).toMatchObject({ ok: false })
    expect(queries).toHaveLength(1)
  })
})

describe('settleFailedInstagramOperatorSend', () => {
  const refused = (kind: 'window_closed' | 'rate_limited') => ({ ok: false as const, kind, failure: null })

  it('puts the card back when Meta definitely refused, and says so', async () => {
    const { client, queries } = queryRecorder({ messages: [{ data: [{ id: 'card-1' }], error: null }] })
    expect(
      await settleFailedInstagramOperatorSend(client, { messageId: 'card-1', flippedTo: 'approved', sent: refused('window_closed') }),
    ).toBe('Instagram refused this send (window_closed). The card is back in the queue.')
    expect(queries).toHaveLength(1)
  })

  // Migration 041: a message the guest sent while this was in flight can take
  // the slot, so the card can't go back. The operator has to be told.
  it('says the text has to be retyped when the card could not go back', async () => {
    const { client } = queryRecorder({ messages: [{ data: [], error: null }] })
    const message = await settleFailedInstagramOperatorSend(client, {
      messageId: 'card-1',
      flippedTo: 'approved',
      sent: refused('rate_limited'),
    })
    expect(message).toContain('retyped')
    expect(message).not.toContain('The card is back in the queue')
  })

  it.each(['timeout', 'network', 'malformed_response'] as const)(
    'leaves the card out after %s, since it may already be in the thread',
    async (kind) => {
      const { client, queries } = queryRecorder({})
      const message = await settleFailedInstagramOperatorSend(client, {
        messageId: 'card-1',
        flippedTo: 'approved',
        sent: { ok: false, kind, failure: null },
      })
      expect(message).toContain('Check the thread')
      expect(queries).toHaveLength(0)
    },
  )

  // Meta's own side failed: it may have accepted the message before it did.
  it('leaves the card out after a Graph error carrying a 5xx', async () => {
    const { client, queries } = queryRecorder({})
    const message = await settleFailedInstagramOperatorSend(client, {
      messageId: 'card-1',
      flippedTo: 'approved',
      sent: {
        ok: false,
        kind: 'graph_error',
        failure: { reason: 'graph_error', httpStatus: 503, code: 2, subcode: null, type: 'OAuthException', fbtraceId: null },
      },
    })
    expect(message).toContain('Check the thread')
    expect(queries).toHaveLength(0)
  })

  it('puts the card back after a Graph error carrying a 4xx, which Meta did refuse', async () => {
    const { client, queries } = queryRecorder({ messages: [{ data: [{ id: 'card-1' }], error: null }] })
    const message = await settleFailedInstagramOperatorSend(client, {
      messageId: 'card-1',
      flippedTo: 'approved',
      sent: {
        ok: false,
        kind: 'graph_error',
        failure: { reason: 'graph_error', httpStatus: 400, code: 100, subcode: null, type: 'IGApiException', fbtraceId: null },
      },
    })
    expect(message).toContain('back in the queue')
    expect(queries).toHaveLength(1)
  })
})
