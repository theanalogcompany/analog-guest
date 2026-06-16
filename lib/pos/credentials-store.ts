// Read/write pos_credentials with token encryption at rest. The OAuth callback
// writes here; loadSquareCredential is the per-venue token source that
// supersedes the env token once a venue has connected (multi-merchant).

import { createAdminClient } from '@/lib/db/admin'
import type { RAGResult } from '@/lib/rag/types'

import { decryptToken, encryptToken } from './crypto'
import type { PosCredential } from './types'

type AdminClient = ReturnType<typeof createAdminClient>

export async function upsertSquareCredential(opts: {
  venueId: string
  merchantId: string | null
  locationId?: string | null
  accessToken: string
  refreshToken: string | null
  expiresAt: string | null
  scopes: readonly string[]
  supabase?: AdminClient
}): Promise<RAGResult<{ stored: true }>> {
  const supabase = opts.supabase ?? createAdminClient()
  const { error } = await supabase.from('pos_credentials').upsert(
    {
      venue_id: opts.venueId,
      provider: 'square',
      merchant_external_id: opts.merchantId,
      location_external_id: opts.locationId ?? null,
      access_token_enc: encryptToken(opts.accessToken),
      refresh_token_enc: opts.refreshToken ? encryptToken(opts.refreshToken) : null,
      token_expires_at: opts.expiresAt,
      scopes: [...opts.scopes],
      is_active: true,
    },
    { onConflict: 'venue_id,provider' },
  )
  if (error) {
    return { ok: false, error: error.message, errorCode: 'credential_upsert_failed' }
  }
  return { ok: true, data: { stored: true } }
}

/**
 * Load + decrypt a venue's Square credential. Returns null (ok:true) when the
 * venue hasn't connected — callers fall back to the env token for the
 * single-merchant MVP.
 */
export async function loadSquareCredential(opts: {
  venueId: string
  supabase?: AdminClient
}): Promise<RAGResult<PosCredential | null>> {
  const supabase = opts.supabase ?? createAdminClient()
  const { data, error } = await supabase
    .from('pos_credentials')
    .select(
      'venue_id, merchant_external_id, location_external_id, access_token_enc, refresh_token_enc, token_expires_at, scopes',
    )
    .eq('venue_id', opts.venueId)
    .eq('provider', 'square')
    .eq('is_active', true)
    .maybeSingle()
  if (error) {
    return { ok: false, error: error.message, errorCode: 'credential_load_failed' }
  }
  if (!data || !data.access_token_enc) {
    return { ok: true, data: null }
  }
  return {
    ok: true,
    data: {
      venueId: data.venue_id,
      provider: 'square',
      merchantExternalId: data.merchant_external_id,
      locationExternalId: data.location_external_id,
      accessToken: decryptToken(data.access_token_enc),
      refreshToken: data.refresh_token_enc ? decryptToken(data.refresh_token_enc) : null,
      tokenExpiresAt: data.token_expires_at,
      scopes: data.scopes ?? [],
    },
  }
}
