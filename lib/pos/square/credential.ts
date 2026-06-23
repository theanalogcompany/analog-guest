// Build the PosCredential used for Square API calls. For the single-merchant
// MVP the token comes from env (SQUARE_*_ACCESS_TOKEN); per-merchant OAuth
// tokens from pos_credentials supersede this once they're wired into ingest/sync.
// Shared by ingest (order hydration) and the catalog/inventory sync.

import type { PosCredential } from '../types'
import { squareAccessTokenFromEnv } from './client'

export function squareEnvCredential(
  venueId: string,
  locationExternalId: string | null,
): PosCredential {
  const { token } = squareAccessTokenFromEnv()
  return {
    venueId,
    provider: 'square',
    merchantExternalId: null,
    locationExternalId,
    accessToken: token,
    refreshToken: null,
    tokenExpiresAt: null,
    scopes: [],
  }
}
