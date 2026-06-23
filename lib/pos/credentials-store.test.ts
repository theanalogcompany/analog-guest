/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { createAdminClient } from '@/lib/db/admin'

import { upsertSquareCredential, loadSquareCredential } from './credentials-store'
import { decryptToken, encryptToken } from './crypto'

type AdminClient = ReturnType<typeof createAdminClient>

const PREV = process.env.POS_TOKEN_ENC_KEY
beforeAll(() => {
  process.env.POS_TOKEN_ENC_KEY = Buffer.alloc(32, 9).toString('base64')
})
afterAll(() => {
  process.env.POS_TOKEN_ENC_KEY = PREV
})

function makeClient(opts: { row?: Record<string, unknown> | null; error?: { message: string } | null }): {
  client: AdminClient
  captured: { upsert?: Record<string, unknown> }
} {
  const captured: { upsert?: Record<string, unknown> } = {}
  function chain(): any {
    const self: any = {}
    self.select = () => self
    self.eq = () => self
    self.upsert = (payload: Record<string, unknown>) => {
      captured.upsert = payload
      return self
    }
    self.maybeSingle = async () => ({ data: opts.row ?? null, error: opts.error ?? null })
    self.then = (resolve: (r: { error: unknown }) => unknown) => resolve({ error: opts.error ?? null })
    return self
  }
  return { client: { from: () => chain() } as unknown as AdminClient, captured }
}

const VENUE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

describe('upsertSquareCredential', () => {
  it('encrypts tokens at rest (plaintext never stored, decryptable)', async () => {
    const { client, captured } = makeClient({})
    const res = await upsertSquareCredential({
      venueId: VENUE,
      merchantId: 'M1',
      locationId: 'L1',
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
      expiresAt: '2026-07-15T00:00:00Z',
      scopes: ['PAYMENTS_READ'],
      supabase: client,
    })
    expect(res).toEqual({ ok: true, data: { stored: true } })
    const payload = captured.upsert!
    expect(payload.access_token_enc).not.toBe('access-123')
    expect(decryptToken(payload.access_token_enc as string)).toBe('access-123')
    expect(decryptToken(payload.refresh_token_enc as string)).toBe('refresh-456')
    expect(payload).toMatchObject({ venue_id: VENUE, provider: 'square', location_external_id: 'L1' })
  })
})

describe('loadSquareCredential', () => {
  it('returns null when the venue has not connected', async () => {
    const { client } = makeClient({ row: null })
    const res = await loadSquareCredential({ venueId: VENUE, supabase: client })
    expect(res).toEqual({ ok: true, data: null })
  })

  it('decrypts the stored tokens into a PosCredential', async () => {
    const { client } = makeClient({
      row: {
        venue_id: VENUE,
        merchant_external_id: 'M1',
        location_external_id: 'L1',
        access_token_enc: encryptToken('access-123'),
        refresh_token_enc: encryptToken('refresh-456'),
        token_expires_at: null,
        scopes: ['PAYMENTS_READ'],
      },
    })
    const res = await loadSquareCredential({ venueId: VENUE, supabase: client })
    expect(res.ok).toBe(true)
    if (!res.ok || !res.data) throw new Error('expected a credential')
    expect(res.data.accessToken).toBe('access-123')
    expect(res.data.refreshToken).toBe('refresh-456')
    expect(res.data.locationExternalId).toBe('L1')
  })

  it('surfaces a load error', async () => {
    const { client } = makeClient({ error: { message: 'boom' } })
    const res = await loadSquareCredential({ venueId: VENUE, supabase: client })
    expect(res).toEqual({ ok: false, error: 'boom', errorCode: 'credential_load_failed' })
  })
})
