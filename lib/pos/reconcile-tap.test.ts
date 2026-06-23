/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest'

import type { createAdminClient } from '@/lib/db/admin'

import { expireStalePendingTaps, extractTapToken, reconcileTapFromInbound } from './reconcile-tap'

type AdminClient = ReturnType<typeof createAdminClient>

interface Cfg {
  maybeSingle?: Record<string, { data: unknown; error: unknown }>
  then?: Record<string, { data?: unknown; error: unknown }>
}

function makeClient(cfg: Cfg): {
  client: AdminClient
  captured: { updates: Record<string, any>; upserts: Record<string, any> }
} {
  const captured = { updates: {} as Record<string, any>, upserts: {} as Record<string, any> }
  function chain(table: string): any {
    const self: any = {}
    const ret = () => self
    self.select = ret
    self.eq = ret
    self.or = ret
    self.lt = ret
    self.gt = ret
    self.update = (p: any) => {
      captured.updates[table] = p
      return self
    }
    self.upsert = (p: any) => {
      captured.upserts[table] = p
      return self
    }
    self.maybeSingle = async () => cfg.maybeSingle?.[table] ?? { data: null, error: null }
    self.then = (resolve: (r: { data?: unknown; error: unknown }) => unknown) =>
      resolve(cfg.then?.[table] ?? { data: null, error: null })
    return self
  }
  return { client: { from: (t: string) => chain(t) } as unknown as AdminClient, captured }
}

const VENUE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const GUEST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('extractTapToken', () => {
  it('finds a tap token embedded in surrounding text', () => {
    expect(extractTapToken('hi! tt_abcdefghijklmnop12345678 thanks')).toBe(
      'tt_abcdefghijklmnop12345678',
    )
  })
  it('returns null when absent or empty', () => {
    expect(extractTapToken('just a normal message')).toBeNull()
    expect(extractTapToken('')).toBeNull()
    expect(extractTapToken(null)).toBeNull()
  })
})

describe('reconcileTapFromInbound', () => {
  const TOKEN = 'tt_abcdefghijklmnop12345678'
  const body = `notes please ${TOKEN}`

  it('no-ops when the body has no token', async () => {
    const { client } = makeClient({})
    const res = await reconcileTapFromInbound({
      venueId: VENUE,
      guestId: GUEST,
      phoneNumber: '+15551230000',
      body: 'no token here',
      supabase: client,
    })
    expect(res).toEqual({ ok: true, data: { status: 'no_token' } })
  })

  it('returns tap_not_found when no pending tap matches the token', async () => {
    const { client } = makeClient({ maybeSingle: { pos_tap_events: { data: null, error: null } } })
    const res = await reconcileTapFromInbound({
      venueId: VENUE,
      guestId: GUEST,
      phoneNumber: '+15551230000',
      body,
      supabase: client,
    })
    expect(res.ok && res.data).toEqual({ status: 'tap_not_found' })
  })

  it('attaches the guest to the linked transaction and maps the fingerprint', async () => {
    const { client, captured } = makeClient({
      maybeSingle: {
        pos_tap_events: { data: { reconciled_transaction_id: 'tx_1' }, error: null },
        transactions: { data: { card_fingerprint: 'fp_1', occurred_at: '2026-06-15T10:00:00Z' }, error: null },
      },
    })
    const res = await reconcileTapFromInbound({
      venueId: VENUE,
      guestId: GUEST,
      phoneNumber: '+15551230000',
      body,
      supabase: client,
    })
    expect(res.ok && res.data).toEqual({ status: 'matched', transactionId: 'tx_1' })
    expect(captured.updates.transactions).toMatchObject({
      guest_id: GUEST,
      match_method: 'tap_token',
      match_confidence: 1,
    })
    expect(captured.upserts.guest_card_fingerprints).toEqual({
      venue_id: VENUE,
      guest_id: GUEST,
      card_fingerprint: 'fp_1',
    })
  })

  it('still matches (transactionId null) when the tap had no linked transaction', async () => {
    const { client } = makeClient({
      maybeSingle: { pos_tap_events: { data: { reconciled_transaction_id: null }, error: null } },
    })
    const res = await reconcileTapFromInbound({
      venueId: VENUE,
      guestId: GUEST,
      phoneNumber: '+15551230000',
      body,
      supabase: client,
    })
    expect(res.ok && res.data).toEqual({ status: 'matched', transactionId: null })
  })

  it('surfaces a claim error', async () => {
    const { client } = makeClient({
      maybeSingle: { pos_tap_events: { data: null, error: { message: 'boom' } } },
    })
    const res = await reconcileTapFromInbound({
      venueId: VENUE,
      guestId: GUEST,
      phoneNumber: '+15551230000',
      body,
      supabase: client,
    })
    expect(res).toEqual({ ok: false, error: 'boom', errorCode: 'tap_claim_failed' })
  })
})

describe('expireStalePendingTaps', () => {
  it('counts the rows it expired', async () => {
    const { client } = makeClient({
      then: { pos_tap_events: { data: [{ id: 'a' }, { id: 'b' }], error: null } },
    })
    const res = await expireStalePendingTaps({
      now: new Date('2026-06-15T12:00:00Z'),
      ttlMinutes: 30,
      supabase: client,
    })
    expect(res).toEqual({ ok: true, data: { expired: 2 } })
  })

  it('surfaces an error', async () => {
    const { client } = makeClient({
      then: { pos_tap_events: { error: { message: 'nope' } } },
    })
    const res = await expireStalePendingTaps({
      now: new Date('2026-06-15T12:00:00Z'),
      ttlMinutes: 30,
      supabase: client,
    })
    expect(res).toEqual({ ok: false, error: 'nope', errorCode: 'tap_expiry_failed' })
  })
})
