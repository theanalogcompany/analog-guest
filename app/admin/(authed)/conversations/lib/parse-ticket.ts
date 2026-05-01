// Pure parser + preview helpers for transactions.raw_data. The column is
// jsonb (Json | null in db/types) — the agent doesn't write it, the POS
// integration does. Shape per migration 001 + the seeded fixture:
//
//   {
//     "pos_provider": "mock" | "square" | "toast" | ...,
//     "ticket_id": "TKT-...",
//     "line_items": [{ "name": ..., "quantity": ..., "unit_price_cents": ..., "category"?: ... }, ...],
//     "subtotal_cents": ...,
//     "tax_cents": ...,
//     "tip_cents": ...,
//     "payment_method": "card" | "cash" | ...,
//     "card_last_four": "0786"
//   }
//
// Defensive parsing: any field missing or wrong-typed is dropped silently.
// Returns null when raw_data isn't an object or when no parsable line items
// exist — caller renders the row in collapsed-only "no detail available" form.

import { readNumber, readRecord, readString } from '../stage-detail/_primitives'

export interface TicketLineItem {
  name: string
  quantity: number
  unitPriceCents: number
}

export interface ParsedTicket {
  posProvider: string | null
  ticketId: string | null
  lineItems: TicketLineItem[]
  subtotalCents: number | null
  tipCents: number | null
  paymentMethod: string | null
  cardLastFour: string | null
}

export function parseTicket(rawData: unknown): ParsedTicket | null {
  const r = readRecord(rawData)
  if (!r) return null
  const lineItemsRaw = r.line_items
  if (!Array.isArray(lineItemsRaw)) return null

  const lineItems: TicketLineItem[] = []
  for (const item of lineItemsRaw) {
    const ir = readRecord(item)
    if (!ir) continue
    const name = readString(ir.name)
    const quantity = readNumber(ir.quantity)
    const unitPriceCents = readNumber(ir.unit_price_cents)
    if (name === null || quantity === null || unitPriceCents === null) continue
    lineItems.push({ name, quantity, unitPriceCents })
  }
  if (lineItems.length === 0) return null

  return {
    posProvider: readString(r.pos_provider),
    ticketId: readString(r.ticket_id),
    lineItems,
    subtotalCents: readNumber(r.subtotal_cents),
    tipCents: readNumber(r.tip_cents),
    paymentMethod: readString(r.payment_method),
    cardLastFour: readString(r.card_last_four),
  }
}

// Build a preview string of comma-separated line item names, capped at
// `maxNames` items and `maxChars` chars total. Truncates by item-name
// boundary (no mid-word ellipsis); appends "…" only when items were dropped.
export function buildItemsPreview(
  lineItems: TicketLineItem[],
  maxNames = 4,
  maxChars = 50,
): string {
  if (lineItems.length === 0) return ''
  const taken: string[] = []
  let runningChars = 0
  for (const item of lineItems) {
    const next = item.name
    const sepLen = taken.length === 0 ? 0 : 2 // ", "
    if (taken.length >= maxNames) break
    if (taken.length > 0 && runningChars + sepLen + next.length > maxChars) break
    taken.push(next)
    runningChars += sepLen + next.length
  }
  const joined = taken.join(', ')
  return taken.length < lineItems.length ? `${joined}…` : joined
}

// Display-friendly POS provider label. Falls back to the raw string for
// unknown providers so a future POS integration shows up sensibly without
// a code change.
export function formatPosProvider(provider: string | null): string {
  if (!provider) return ''
  switch (provider.toLowerCase()) {
    case 'mock':
      return 'mock POS'
    case 'square':
      return 'Square'
    case 'toast':
      return 'Toast'
    default:
      return provider
  }
}
