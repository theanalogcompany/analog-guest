// Provider registry. The single place that maps a PosProviderName to its
// implementation, so consumers (the webhook route, ingest, sync jobs) never
// import a vendor SDK directly. Adding Toast/Clover later = one new class + one
// entry here.

import { SquareProvider } from './square/provider'
import type { PosProvider, PosProviderName } from './types'

const squareProvider = new SquareProvider()

export function getProvider(name: PosProviderName): PosProvider {
  switch (name) {
    case 'square':
      return squareProvider
    case 'toast':
    case 'clover':
      throw new Error(`POS provider not implemented: ${name}`)
  }
}
