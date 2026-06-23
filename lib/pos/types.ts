// POS provider abstraction — the internal interface every POS integration
// (Square now; Toast / Clover later) implements. Consumers (the webhook route,
// the reconciler, the catalog/inventory sync) depend on these normalized
// models and the PosProvider interface, never on a vendor SDK directly — per
// CLAUDE.md §"Tech stack": "Code should depend on internal interfaces, not on
// vendor names."
//
// Only Square is implemented this cycle; the abstraction exists so adding a
// provider later is a new class under lib/pos/<provider>/ plus a registry
// entry, with zero changes to downstream consumers.

// Errors-as-values, mirroring RAGResult (lib/rag/types.ts) and AIResult
// (lib/ai/types.ts) per the repo convention. Parallel alias rather than a
// shared import so lib/pos stays decoupled from lib/rag.
export type PosResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; errorCode?: string }

export type PosProviderName = 'square' | 'toast' | 'clover'

// Decrypted credential handed to a provider at call time. The persisted shape
// (encrypted tokens) lives in the pos_credentials table (migration 030); the
// loader decrypts into this before invoking provider methods.
export type PosCredential = {
  venueId: string
  provider: PosProviderName
  merchantExternalId: string | null
  locationExternalId: string | null
  accessToken: string
  refreshToken: string | null
  tokenExpiresAt: string | null
  scopes: string[]
}

// ---------------------------------------------------------------------------
// Normalized domain models (provider-agnostic)
// ---------------------------------------------------------------------------

export type Money = { amountCents: number; currency: string }

// A purchased line item. `name` maps to transactions.raw_data.line_items[].name,
// which the agent's ## Visit history block reads (lib/agent/extract-recent-visits.ts)
// to personalize the first message — "I saw you got the matcha latte". The
// ingest layer is responsible for writing line items into raw_data in that shape.
export type TransactionLineItem = { name: string; quantity: number }

export type TransactionStatus = 'authorized' | 'completed' | 'voided' | 'refunded'

export type TransactionEvent = {
  provider: PosProviderName
  externalId: string // provider's payment / transaction id (→ transactions.external_id)
  merchantExternalId: string | null
  locationExternalId: string | null
  orderExternalId: string | null
  amount: Money // → transactions.amount_cents (feeds recognition money-spent signal)
  cardFingerprint: string | null // the cross-merchant identity primitive; non-PCI
  status: TransactionStatus
  lineItems: TransactionLineItem[]
  occurredAt: string // ISO; provider timestamp (→ transactions.occurred_at)
}

export type MenuItem = {
  externalId: string // variation id (→ pos_catalog_items.external_id)
  parentExternalId: string | null
  name: string
  category: string | null
  price: Money | null
  isAvailable: boolean
  version: number | null // provider catalog version, for staleness guards
}

export type InventoryCount = {
  catalogExternalId: string // variation id
  locationExternalId: string
  quantity: number | null
  state: string | null // provider state, e.g. IN_STOCK
}

// What a verified webhook carries once normalized. `eventId` is the provider's
// delivery id, used for idempotency against pos_webhook_events.
export type NormalizedEvent =
  | { kind: 'transaction'; eventId: string; data: TransactionEvent }
  | { kind: 'catalog_updated'; eventId: string; merchantExternalId: string | null }
  | { kind: 'inventory_updated'; eventId: string; counts: InventoryCount[] }
  | { kind: 'unknown'; eventId: string; type: string }

// The seam. A provider verifies + parses its webhooks and exposes the REST
// reads the integration needs. Methods return PosResult or throw only at the
// route/script boundary, per the errors-as-values convention.
export interface PosProvider {
  readonly name: PosProviderName

  // Verify a webhook delivery's signature. `rawBody` MUST be the unparsed
  // request body (Square's HMAC is computed over notificationUrl + rawBody).
  verifyWebhook(rawBody: string, headers: Headers, notificationUrl: string): boolean

  // Parse a verified webhook body into normalized events (one delivery can
  // carry one logical event; the array shape leaves room for batched providers).
  parseWebhook(rawBody: string): PosResult<NormalizedEvent[]>

  // Initial menu backfill + resync target.
  fetchCatalog(cred: PosCredential): Promise<PosResult<MenuItem[]>>

  // Inventory backfill; `catalogIds` narrows to specific variations when set.
  fetchInventory(cred: PosCredential, catalogIds?: string[]): Promise<PosResult<InventoryCount[]>>

  // Hydrate a transaction's line items from its order (line items live on the
  // Order, not the Payment, for Square).
  fetchOrder(cred: PosCredential, orderExternalId: string): Promise<PosResult<TransactionLineItem[]>>
}
