// Resolve which venue a POS event belongs to, via the pos_credentials
// connection (migration 030). Transactions + inventory key on location;
// catalog events key on merchant. A miss is not an error — we simply don't
// have a connected venue to attribute the event to (logged, returns null).

import { createAdminClient } from '@/lib/db/admin'

import type { PosProviderName } from './types'

type AdminClient = ReturnType<typeof createAdminClient>

export async function resolveVenueByLocation(
  supabase: AdminClient,
  provider: PosProviderName,
  locationExternalId: string | null,
): Promise<string | null> {
  if (!locationExternalId) return null
  const { data, error } = await supabase
    .from('pos_credentials')
    .select('venue_id')
    .eq('provider', provider)
    .eq('location_external_id', locationExternalId)
    .eq('is_active', true)
    .maybeSingle()
  if (error) {
    console.error('pos resolve: by-location lookup failed', {
      provider,
      locationExternalId,
      error: error.message,
    })
    return null
  }
  return data?.venue_id ?? null
}

export async function resolveVenueByMerchant(
  supabase: AdminClient,
  provider: PosProviderName,
  merchantExternalId: string | null,
): Promise<string | null> {
  if (!merchantExternalId) return null
  const { data, error } = await supabase
    .from('pos_credentials')
    .select('venue_id')
    .eq('provider', provider)
    .eq('merchant_external_id', merchantExternalId)
    .eq('is_active', true)
    .maybeSingle()
  if (error) {
    console.error('pos resolve: by-merchant lookup failed', {
      provider,
      merchantExternalId,
      error: error.message,
    })
    return null
  }
  return data?.venue_id ?? null
}
