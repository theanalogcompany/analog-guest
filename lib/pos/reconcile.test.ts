/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest'

import type { createAdminClient } from '@/lib/db/admin'

import { linkFingerprintToGuest, reconcileTransactionByFingerprint } from './reconcile'

type AdminClient = ReturnType<typeof createAdminClient>

const VENUE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const GUEST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TXN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OCCURRED = '2026-06-15T10:00:00Z'

interface MockOpts {
  mapping?: { guest_id: string } | null
  lookupError?: { message: string } | null
  txnError?: { message: string } | null
  guestError?: { message: string } | null
  upsertError?: { message: string } | null
}

interface Captured {
  txnUpdate?: Record<string, unknown>
  guestUpdate?: Record<string, unknown>
  upsert?: Record<string, unknown>
}

function makeClient(opts: MockOpts): { client: AdminClient; captured: Captured } {
  const captured: Captured = {}

  function chain(table: string): any {
    const self: any = {}
    self.select = () => self
    self.eq = () => self
    self.or = () => self
    self.update = (payload: Record<string, unknown>) => {
      if (table === 'transactions') captured.txnUpdate = payload
      if (table === 'guests') captured.guestUpdate = payload
      return self
    }
    self.upsert = (payload: Record<string, unknown>) => {
      captured.upsert = payload
      return self
    }
    self.maybeSingle = async () => ({
      data: opts.mapping ?? null,
      error: opts.lookupError ?? null,
    })
    // Make awaited update/upsert chains resolve to { error }.
    self.then = (resolve: (r: { error: { message: string } | null }) => unknown) => {
      const error =
        table === 'transactions'
          ? (opts.txnError ?? null)
          : table === 'guests'
            ? (opts.guestError ?? null)
            : (opts.upsertError ?? null)
      return resolve({ error })
    }
    return self
  }

  return { client: { from: (t: string) => chain(t) } as unknown as AdminClient, captured }
}

describe('reconcileTransactionByFingerprint', () => {
  it('returns unmatched (no_fingerprint) and touches nothing when fingerprint is null', async () => {
    const { client, captured } = makeClient({})
    const res = await reconcileTransactionByFingerprint({
      transactionId: TXN,
      venueId: VENUE,
      cardFingerprint: null,
      occurredAt: OCCURRED,
      supabase: client,
    })
    expect(res).toEqual({ ok: true, data: { status: 'unmatched', reason: 'no_fingerprint' } })
    expect(captured.txnUpdate).toBeUndefined()
  })

  it('returns unmatched (no_mapping) when the fingerprint is not yet linked', async () => {
    const { client } = makeClient({ mapping: null })
    const res = await reconcileTransactionByFingerprint({
      transactionId: TXN,
      venueId: VENUE,
      cardFingerprint: 'fp_x',
      occurredAt: OCCURRED,
      supabase: client,
    })
    expect(res.ok && res.data).toEqual({ status: 'unmatched', reason: 'no_mapping' })
  })

  it('matches a returning guest and stamps the transaction + last_visit_at', async () => {
    const { client, captured } = makeClient({ mapping: { guest_id: GUEST } })
    const res = await reconcileTransactionByFingerprint({
      transactionId: TXN,
      venueId: VENUE,
      cardFingerprint: 'fp_known',
      occurredAt: OCCURRED,
      supabase: client,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data).toEqual({ status: 'matched', guestId: GUEST, method: 'card_fingerprint' })
    expect(captured.txnUpdate).toMatchObject({
      guest_id: GUEST,
      match_method: 'card_fingerprint',
      match_confidence: 1,
    })
    expect(captured.txnUpdate?.matched_at).toBeTypeOf('string')
    expect(captured.guestUpdate).toEqual({ last_visit_at: OCCURRED })
  })

  it('surfaces a lookup error as ok:false', async () => {
    const { client } = makeClient({ lookupError: { message: 'boom' } })
    const res = await reconcileTransactionByFingerprint({
      transactionId: TXN,
      venueId: VENUE,
      cardFingerprint: 'fp_x',
      occurredAt: OCCURRED,
      supabase: client,
    })
    expect(res).toEqual({ ok: false, error: 'boom', errorCode: 'fingerprint_lookup_failed' })
  })

  it('surfaces a transaction-update error as ok:false', async () => {
    const { client } = makeClient({ mapping: { guest_id: GUEST }, txnError: { message: 'nope' } })
    const res = await reconcileTransactionByFingerprint({
      transactionId: TXN,
      venueId: VENUE,
      cardFingerprint: 'fp_known',
      occurredAt: OCCURRED,
      supabase: client,
    })
    expect(res).toEqual({ ok: false, error: 'nope', errorCode: 'transaction_update_failed' })
  })

  it('still matches when the non-fatal last_visit_at bump errors', async () => {
    const { client } = makeClient({ mapping: { guest_id: GUEST }, guestError: { message: 'lv fail' } })
    const res = await reconcileTransactionByFingerprint({
      transactionId: TXN,
      venueId: VENUE,
      cardFingerprint: 'fp_known',
      occurredAt: OCCURRED,
      supabase: client,
    })
    expect(res.ok && res.data.status).toBe('matched')
  })
})

describe('linkFingerprintToGuest', () => {
  it('upserts the mapping and returns linked', async () => {
    const { client, captured } = makeClient({})
    const res = await linkFingerprintToGuest({
      venueId: VENUE,
      guestId: GUEST,
      cardFingerprint: 'fp_new',
      supabase: client,
    })
    expect(res).toEqual({ ok: true, data: { linked: true } })
    expect(captured.upsert).toEqual({
      venue_id: VENUE,
      guest_id: GUEST,
      card_fingerprint: 'fp_new',
    })
  })

  it('surfaces an upsert error', async () => {
    const { client } = makeClient({ upsertError: { message: 'dup' } })
    const res = await linkFingerprintToGuest({
      venueId: VENUE,
      guestId: GUEST,
      cardFingerprint: 'fp_new',
      supabase: client,
    })
    expect(res).toEqual({ ok: false, error: 'dup', errorCode: 'fingerprint_link_failed' })
  })
})
