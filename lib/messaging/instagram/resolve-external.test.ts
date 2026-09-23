// TAC-473: a card answered from the Instagram app clears itself.
//
// The db-fake in ./testing/db-fake.ts deliberately answers only the shapes the
// inbound handler sends, and has no `order`. This resolver orders its card read
// (oldest first) and filters on channel, and BOTH are load-bearing, so the
// double here records every filter and honours ordering — the query-recorder
// posture, not a mock's opinion of a query string.

import { describe, expect, it } from 'vitest'

import type { InstagramEventOutcome } from './handle-events'
import { RESOLVED_EXTERNALLY_REVIEW_STATE } from '@/lib/schemas/review-state'

import { externalResolutionTargetFor, resolveCardAnsweredExternally } from './resolve-external'
import { INSTAGRAM_WINDOW_MS } from './window'

const VENUE = 'venue-1'
const GUEST = 'guest-1'
const ECHO = 'msg-echo'
const NOW = new Date('2026-09-23T12:00:00.000Z')

interface CardRow {
  id: string
  venue_id: string
  guest_id: string
  review_state: string
  channel: string
  created_at: string
  pending_commitment?: Record<string, unknown> | null
}

interface FakeOptions {
  /** Meta's time for the guest's newest Instagram inbound, or null for none. */
  lastGuestActionAt?: string | null
  cards?: CardRow[]
  /** Make the anchor read fail. */
  anchorError?: string
  /** Make the card read fail. */
  cardError?: string
  /** Make the update fail. */
  updateError?: string
  /** Simulate the CAS losing: the update matches nothing. */
  casLost?: boolean
}

function createDb(options: FakeOptions = {}) {
  const updates: Array<{ patch: Record<string, unknown>; filters: Record<string, unknown> }> = []
  const selectFilters: Array<Record<string, unknown>> = []
  let ordering: { column: string; ascending: boolean } | null = null

  function selectBuilder(columns: string) {
    const filters: Record<string, unknown> = {}
    const builder = {
      eq(column: string, value: unknown) {
        filters[column] = value
        return builder
      },
      not(column: string) {
        filters[`${column}__notnull`] = true
        return builder
      },
      order(column: string, opts: { ascending: boolean }) {
        ordering = { column, ascending: opts.ascending }
        return builder
      },
      limit() {
        return builder
      },
      async maybeSingle() {
        selectFilters.push({ ...filters, __columns: columns })
        // The window anchor read.
        if (columns.includes('provider_sent_at')) {
          if (options.anchorError) return { data: null, error: { message: options.anchorError } }
          return {
            data:
              options.lastGuestActionAt === undefined || options.lastGuestActionAt === null
                ? null
                : { provider_sent_at: options.lastGuestActionAt },
            error: null,
          }
        }
        // The card read.
        if (options.cardError) return { data: null, error: { message: options.cardError } }
        const matching = (options.cards ?? []).filter((c) =>
          Object.entries(filters).every(([k, v]) => k.endsWith('__notnull') || c[k as keyof CardRow] === v),
        )
        const sorted = [...matching].sort((a, b) =>
          ordering?.ascending === false
            ? b.created_at.localeCompare(a.created_at)
            : a.created_at.localeCompare(b.created_at),
        )
        return {
          data: sorted[0] ? { id: sorted[0].id, pending_commitment: sorted[0].pending_commitment ?? null } : null,
          error: null,
        }
      },
    }
    return builder
  }

  function updateBuilder(patch: Record<string, unknown>) {
    const filters: Record<string, unknown> = {}
    const builder = {
      eq(column: string, value: unknown) {
        filters[column] = value
        return builder
      },
      async select() {
        updates.push({ patch, filters })
        if (options.updateError) return { data: null, error: { message: options.updateError } }
        if (options.casLost) return { data: [], error: null }
        return { data: [{ id: filters.id }], error: null }
      },
    }
    return builder
  }

  return {
    client: {
      from() {
        return {
          select: (columns: string) => selectBuilder(columns),
          update: (patch: Record<string, unknown>) => updateBuilder(patch),
        }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    updates,
    selectFilters,
    get ordering() {
      return ordering
    },
  }
}

function card(id: string, createdAt: string, over: Partial<CardRow> = {}): CardRow {
  return {
    id,
    venue_id: VENUE,
    guest_id: GUEST,
    review_state: 'pending',
    channel: 'instagram',
    created_at: createdAt,
    ...over,
  }
}

/** An action old enough that the window has closed by NOW. */
const EXPIRED_ANCHOR = new Date(NOW.getTime() - INSTAGRAM_WINDOW_MS - 60_000).toISOString()
/** An action recent enough that the window is still open at NOW. */
const OPEN_ANCHOR = new Date(NOW.getTime() - 60_000).toISOString()

function persistedEcho(over: Partial<InstagramEventOutcome> = {}): InstagramEventOutcome {
  return {
    status: 'persisted',
    kind: 'echo',
    venueId: VENUE,
    guestId: GUEST,
    messageId: ECHO,
    guestCreated: false,
    hasReferral: false,
    referralSource: null,
    hasProviderSentAt: true,
    titlelessPostback: false,
    guestCreatedVia: null,
    ...over,
  } as InstagramEventOutcome
}

describe('externalResolutionTargetFor', () => {
  it('selects a newly persisted echo', () => {
    expect(externalResolutionTargetFor(persistedEcho())).toEqual({
      venueId: VENUE,
      guestId: GUEST,
      echoMessageId: ECHO,
    })
  })

  it.each(['message', 'postback'] as const)('ignores a persisted %s from the guest', (kind) => {
    expect(externalResolutionTargetFor(persistedEcho({ kind }))).toBeNull()
  })

  it('ignores a DUPLICATE echo', () => {
    // Meta redelivered it, or TAC-469 is reconciling one of our own sends onto
    // it. Either way the row already existed, so nothing new was said.
    expect(
      externalResolutionTargetFor({ status: 'duplicate', kind: 'echo', venueId: VENUE, messageId: ECHO }),
    ).toBeNull()
  })

  it('ignores a read receipt, a skip, a failure and an unhandled event', () => {
    expect(
      externalResolutionTargetFor({ status: 'read', venueId: VENUE, guestId: GUEST, messageId: ECHO }),
    ).toBeNull()
    expect(
      externalResolutionTargetFor({ status: 'skipped', kind: 'echo', reason: 'unknown_guest', venueId: VENUE }),
    ).toBeNull()
    expect(
      externalResolutionTargetFor({
        status: 'failed',
        kind: 'echo',
        stage: 'message_insert',
        venueId: VENUE,
      } as InstagramEventOutcome),
    ).toBeNull()
    expect(
      externalResolutionTargetFor({ status: 'unhandled', reason: 'standby', fields: [] }),
    ).toBeNull()
  })
})

describe('resolveCardAnsweredExternally', () => {
  const target = { venueId: VENUE, guestId: GUEST, echoMessageId: ECHO }

  // THE GUARD. Every send we make is gated on the window being open, so an
  // echo arriving while it is open may well be our own — the agent's reply or
  // an operator's approve echoing back. Resolving then would let the agent
  // silently close its own cards.
  it('resolves NOTHING while the reply window is still open', async () => {
    const db = createDb({ lastGuestActionAt: OPEN_ANCHOR, cards: [card('c1', '2026-09-22T09:00:00.000Z')] })
    const result = await resolveCardAnsweredExternally(db.client, target, NOW)
    expect(result).toEqual({ status: 'window_open' })
    expect(db.updates).toHaveLength(0)
  })

  it('resolves nothing when no saved guest action carries Meta clock', async () => {
    // Expiry cannot be established, and a guess here is a guess about whether
    // this echo is our own.
    const db = createDb({ lastGuestActionAt: null, cards: [card('c1', '2026-09-22T09:00:00.000Z')] })
    const result = await resolveCardAnsweredExternally(db.client, target, NOW)
    expect(result).toEqual({ status: 'window_unknown' })
    expect(db.updates).toHaveLength(0)
  })

  it('uses the TRUE deadline, with no display margin subtracted', async () => {
    // Exactly 24 hours is expired. Subtracting INSTAGRAM_WINDOW_MARGIN_MS would
    // make the expired set LARGER, and the margin window is precisely where one
    // of our own sends could still be in flight.
    const exactly = new Date(NOW.getTime() - INSTAGRAM_WINDOW_MS).toISOString()
    const db = createDb({ lastGuestActionAt: exactly, cards: [card('c1', '2026-09-22T09:00:00.000Z')] })
    expect((await resolveCardAnsweredExternally(db.client, target, NOW)).status).toBe('resolved')

    const justInside = new Date(NOW.getTime() - INSTAGRAM_WINDOW_MS + 1).toISOString()
    const db2 = createDb({ lastGuestActionAt: justInside, cards: [card('c1', '2026-09-22T09:00:00.000Z')] })
    expect((await resolveCardAnsweredExternally(db2.client, target, NOW)).status).toBe('window_open')
  })

  // AC: one card.
  it('resolves the one expired pending card and records the echo against it', async () => {
    const db = createDb({ lastGuestActionAt: EXPIRED_ANCHOR, cards: [card('c1', '2026-09-22T09:00:00.000Z')] })
    const result = await resolveCardAnsweredExternally(db.client, target, NOW)
    expect(result).toEqual({ status: 'resolved', cardId: 'c1', hadPendingCommitment: false })
    expect(db.updates).toHaveLength(1)
    expect(db.updates[0]!.patch).toEqual({
      review_state: RESOLVED_EXTERNALLY_REVIEW_STATE,
      resolved_by_message_id: ECHO,
    })
  })

  // AC: several cards. One send, one card — and the OLDEST, which is the order
  // the queue itself shows them in. Resolving several would silently drop a
  // question the guest actually asked.
  it('resolves ONLY the oldest when the guest holds several cards', async () => {
    const db = createDb({
      lastGuestActionAt: EXPIRED_ANCHOR,
      cards: [
        card('newest', '2026-09-22T11:00:00.000Z'),
        card('oldest', '2026-09-22T09:00:00.000Z'),
        card('middle', '2026-09-22T10:00:00.000Z'),
      ],
    })
    const result = await resolveCardAnsweredExternally(db.client, target, NOW)
    expect(result).toEqual({ status: 'resolved', cardId: 'oldest', hadPendingCommitment: false })
    expect(db.updates).toHaveLength(1)
    expect(db.updates[0]!.filters.id).toBe('oldest')
    // The ordering is what makes "oldest" true; a read that forgot it would
    // return whichever row the database happened to hand back first.
    expect(db.ordering).toEqual({ column: 'created_at', ascending: true })
  })

  // AC: no card.
  it('reports when the card it resolved carried an obligation', async () => {
    // FIFO takes the oldest card whatever slot it is in, so an obligation card
    // (comp / hold / discount) can be resolved and its commitment never
    // materialised. Counted rather than prevented; this is what makes it
    // countable, and a mutant hardcoding the flag false hides the case.
    const db = createDb({
      lastGuestActionAt: EXPIRED_ANCHOR,
      cards: [card('c1', '2026-09-22T09:00:00.000Z', { pending_commitment: { type: 'comp' } })],
    })
    const result = await resolveCardAnsweredExternally(db.client, target, NOW)
    expect(result).toEqual({ status: 'resolved', cardId: 'c1', hadPendingCommitment: true })
  })

  it('does nothing when the guest holds no pending card', async () => {
    const db = createDb({ lastGuestActionAt: EXPIRED_ANCHOR, cards: [] })
    const result = await resolveCardAnsweredExternally(db.client, target, NOW)
    expect(result).toEqual({ status: 'no_card' })
    expect(db.updates).toHaveLength(0)
  })

  it('never resolves a TEXT card', async () => {
    // A guest with both identifiers can hold a text card, and a reply typed in
    // the Instagram app does not answer one queued for SMS.
    const db = createDb({
      lastGuestActionAt: EXPIRED_ANCHOR,
      cards: [card('sms', '2026-09-22T09:00:00.000Z', { channel: 'text' })],
    })
    const result = await resolveCardAnsweredExternally(db.client, target, NOW)
    expect(result).toEqual({ status: 'no_card' })
    expect(db.selectFilters.some((f) => f.channel === 'instagram')).toBe(true)
  })

  it('scopes the card read to this venue and this guest', async () => {
    const db = createDb({ lastGuestActionAt: EXPIRED_ANCHOR, cards: [card('c1', '2026-09-22T09:00:00.000Z')] })
    await resolveCardAnsweredExternally(db.client, target, NOW)
    const cardRead = db.selectFilters.find((f) => !String(f.__columns).includes('provider_sent_at'))
    expect(cardRead).toMatchObject({ venue_id: VENUE, guest_id: GUEST, review_state: 'pending' })
  })

  it('CAS-guards the write, so a card an operator just handled is left alone', async () => {
    const db = createDb({
      lastGuestActionAt: EXPIRED_ANCHOR,
      cards: [card('c1', '2026-09-22T09:00:00.000Z')],
      casLost: true,
    })
    const result = await resolveCardAnsweredExternally(db.client, target, NOW)
    expect(result).toEqual({ status: 'lost_race', cardId: 'c1' })
    // The filter is what makes it a CAS rather than a blind write.
    expect(db.updates[0]!.filters).toMatchObject({ id: 'c1', review_state: 'pending' })
  })

  it.each([
    ['the anchor read', { anchorError: 'anchor boom' }, 'anchor boom'],
    ['the card read', { lastGuestActionAt: EXPIRED_ANCHOR, cardError: 'card boom' }, 'card boom'],
    [
      'the update',
      { lastGuestActionAt: EXPIRED_ANCHOR, cards: [card('c1', '2026-09-22T09:00:00.000Z')], updateError: 'write boom' },
      'write boom',
    ],
  ] as const)('reports a failure of %s as a value, never a throw', async (_name, opts, message) => {
    const db = createDb(opts as FakeOptions)
    const result = await resolveCardAnsweredExternally(db.client, target, NOW)
    expect(result).toEqual({ status: 'failed', error: message })
  })

  it('never throws when the client itself blows up', async () => {
    // It runs inside waitUntil after the webhook has answered 200. A throw
    // there is an unhandled rejection, not a caught failure.
    const exploding = {
      from() {
        throw new Error('client gone')
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    const result = await resolveCardAnsweredExternally(exploding, target, NOW)
    expect(result).toEqual({ status: 'failed', error: 'client gone' })
  })

  it('does not resolve a second time once a card is already resolved', async () => {
    // TAC-486 item 5's "Sent" prompt can resolve a card before the echo lands.
    // The card is no longer pending, so the read finds nothing and the late
    // echo cannot duplicate the resolution.
    const db = createDb({
      lastGuestActionAt: EXPIRED_ANCHOR,
      cards: [card('c1', '2026-09-22T09:00:00.000Z', { review_state: RESOLVED_EXTERNALLY_REVIEW_STATE })],
    })
    const result = await resolveCardAnsweredExternally(db.client, target, NOW)
    expect(result).toEqual({ status: 'no_card' })
    expect(db.updates).toHaveLength(0)
  })
})
