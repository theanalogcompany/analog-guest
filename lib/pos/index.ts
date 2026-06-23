// Public API for the POS integration module. Import POS types from here, not
// from provider-internal files (lib/pos/<provider>/*).

export type {
  PosResult,
  PosProvider,
  PosProviderName,
  PosCredential,
  Money,
  TransactionLineItem,
  TransactionStatus,
  TransactionEvent,
  MenuItem,
  InventoryCount,
  NormalizedEvent,
} from './types'
