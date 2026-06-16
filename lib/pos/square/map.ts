// Pure mappers: Square API/webhook objects → normalized POS domain models
// (lib/pos/types.ts). Permissive Zod at the boundary — a payload that doesn't
// parse yields null/[] rather than throwing, so a single malformed delivery
// degrades to "skip" instead of crashing the webhook handler (the runtime-side
// of the permissive-schema rule in CLAUDE.md §"Common gotchas").

import { z } from 'zod'

import type {
  InventoryCount,
  MenuItem,
  TransactionEvent,
  TransactionLineItem,
  TransactionStatus,
} from '../types'

// Raw webhook JSON carries money amounts as plain numbers (the SDK uses bigint,
// but webhook bodies are JSON). Currency may be absent on edge payloads.
const MoneySchema = z
  .object({
    amount: z.number().optional(),
    currency: z.string().optional(),
  })
  .optional()

const SquarePaymentSchema = z.object({
  id: z.string(),
  created_at: z.string().optional(),
  status: z.string().optional(),
  location_id: z.string().optional(),
  order_id: z.string().optional(),
  amount_money: MoneySchema,
  card_details: z
    .object({
      card: z.object({ fingerprint: z.string().optional() }).optional(),
    })
    .optional(),
})

const SquareOrderLineItemSchema = z.object({
  name: z.string().optional(),
  quantity: z.string().optional(), // Square sends quantity as a string, e.g. "2"
})

// Accept both casings: webhook JSON is snake_case (line_items), but the Square
// SDK response objects (from fetchOrder via client.orders.get) are camelCase
// (lineItems). Item-level `name`/`quantity` are identical in both.
const SquareOrderSchema = z.object({
  lineItems: z.array(SquareOrderLineItemSchema).optional(),
  line_items: z.array(SquareOrderLineItemSchema).optional(),
})

// Dual-cased like orders: webhook JSON is snake_case (catalog_object_id), the
// SDK batchGetCounts response is camelCase (catalogObjectId).
const SquareInventoryCountSchema = z.object({
  catalog_object_id: z.string().optional(),
  catalogObjectId: z.string().optional(),
  location_id: z.string().optional(),
  locationId: z.string().optional(),
  quantity: z.string().optional(), // string, e.g. "5"
  state: z.string().optional(),
})

// Catalog objects come only from the SDK (catalog.version.updated just signals
// "resync"; we then fetch), so this targets the camelCase SDK shape. Permissive:
// money amount / version are bigint in the SDK, number in JSON — accept both.
const CatalogMoneySchema = z
  .object({
    amount: z.union([z.number(), z.bigint()]).optional(),
    currency: z.string().optional(),
  })
  .optional()

const CatalogVariationSchema = z.object({
  id: z.string().optional(),
  itemVariationData: z
    .object({
      name: z.string().optional(),
      priceMoney: CatalogMoneySchema,
    })
    .optional(),
})

const CatalogObjectSchema = z.object({
  type: z.string().optional(),
  id: z.string().optional(),
  version: z.union([z.number(), z.bigint()]).optional(),
  isDeleted: z.boolean().optional(),
  itemData: z
    .object({
      name: z.string().optional(),
      categoryId: z.string().optional(),
      variations: z.array(CatalogVariationSchema).optional(),
    })
    .optional(),
})

// Square payment.status → our normalized status. FAILED/CANCELED map to
// 'voided' (a non-visit); unknown defaults to 'completed' so we don't silently
// drop a real sale on an unrecognized status. Refunds arrive via separate
// refund events (not handled this cycle).
function mapStatus(raw: string | undefined): TransactionStatus {
  switch (raw) {
    case 'COMPLETED':
      return 'completed'
    case 'APPROVED':
      return 'authorized'
    case 'CANCELED':
    case 'FAILED':
      return 'voided'
    default:
      return 'completed'
  }
}

function parseQuantity(raw: string | undefined): number {
  if (raw === undefined) return 1
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 1
}

/**
 * Map a Square payment object (from a payment.* webhook) to a TransactionEvent.
 * Line items are NOT on the payment — they live on the Order and are hydrated
 * separately via fetchOrder. Returns null if the object doesn't parse.
 */
export function mapSquarePaymentToTransaction(payment: unknown): TransactionEvent | null {
  const parsed = SquarePaymentSchema.safeParse(payment)
  if (!parsed.success) return null
  const p = parsed.data

  return {
    provider: 'square',
    externalId: p.id,
    merchantExternalId: null, // carried on the webhook envelope, set by the parser
    locationExternalId: p.location_id ?? null,
    orderExternalId: p.order_id ?? null,
    amount: {
      amountCents: p.amount_money?.amount ?? 0,
      currency: p.amount_money?.currency ?? 'USD',
    },
    cardFingerprint: p.card_details?.card?.fingerprint ?? null,
    status: mapStatus(p.status),
    lineItems: [],
    occurredAt: p.created_at ?? new Date().toISOString(),
  }
}

/**
 * Extract line items from a Square order object. `name` feeds
 * transactions.raw_data.line_items[].name, which the agent's ## Visit history
 * block reads to personalize the first message. Unnamed items are dropped.
 */
export function mapSquareOrderLineItems(order: unknown): TransactionLineItem[] {
  const parsed = SquareOrderSchema.safeParse(order)
  if (!parsed.success) return []
  const lineItems = parsed.data.lineItems ?? parsed.data.line_items ?? []
  const out: TransactionLineItem[] = []
  for (const item of lineItems) {
    const name = item.name?.trim()
    if (!name) continue
    out.push({ name, quantity: parseQuantity(item.quantity) })
  }
  return out
}

/**
 * Map the inventory_counts array from an inventory.count.updated webhook to
 * normalized InventoryCount rows. Rows missing the variation id or location are
 * dropped (they can't be keyed).
 */
export function mapSquareInventoryCounts(counts: unknown): InventoryCount[] {
  const parsed = z.array(SquareInventoryCountSchema).safeParse(counts)
  if (!parsed.success) return []
  const out: InventoryCount[] = []
  for (const c of parsed.data) {
    const catalogExternalId = c.catalog_object_id ?? c.catalogObjectId
    const locationExternalId = c.location_id ?? c.locationId
    if (!catalogExternalId || !locationExternalId) continue
    const qty = c.quantity === undefined ? null : Number(c.quantity)
    out.push({
      catalogExternalId,
      locationExternalId,
      quantity: qty !== null && Number.isFinite(qty) ? qty : null,
      state: c.state ?? null,
    })
  }
  return out
}

/**
 * Map Square catalog objects (from catalog.list) to normalized MenuItem rows —
 * one per ITEM_VARIATION, since inventory is tracked at the variation level.
 * `name` is the parent item's name (what a guest says — "croissant"); the
 * variation id is the external id. Non-ITEM objects and unnamed items are
 * dropped. `category` carries the category id (name resolution is a later pass).
 */
export function mapSquareCatalogObjects(objects: unknown): MenuItem[] {
  const parsed = z.array(CatalogObjectSchema).safeParse(objects)
  if (!parsed.success) return []
  const out: MenuItem[] = []
  for (const obj of parsed.data) {
    if (obj.type !== 'ITEM' || !obj.itemData) continue
    const itemName = obj.itemData.name?.trim()
    if (!itemName) continue
    const version = obj.version === undefined ? null : Number(obj.version)
    for (const v of obj.itemData.variations ?? []) {
      if (!v.id) continue
      const money = v.itemVariationData?.priceMoney
      const amount = money?.amount === undefined ? null : Number(money.amount)
      out.push({
        externalId: v.id,
        parentExternalId: obj.id ?? null,
        name: itemName,
        category: obj.itemData.categoryId ?? null,
        price:
          amount !== null && Number.isFinite(amount)
            ? { amountCents: amount, currency: money?.currency ?? 'USD' }
            : null,
        isAvailable: obj.isDeleted !== true,
        version: version !== null && Number.isFinite(version) ? version : null,
      })
    }
  }
  return out
}
