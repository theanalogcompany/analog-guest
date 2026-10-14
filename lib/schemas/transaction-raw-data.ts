// TAC-586: `transactions.raw_data.line_items[].name`, read through a schema.
//
// The writer is lib/pos/ingest-transaction.ts, which stores Square's line
// items as `{ name, quantity }` in Square's order. `name` is the ITEM's name;
// Square keeps the variation ("Large") in a separate field that is never
// stored, so two sizes of one drink already arrive as one name.
//
// PERMISSIVE PER ENTRY, in Square's order and casing. An entry with no usable
// name is dropped on its own rather than failing the row: a purchase whose
// items cannot be read still earns its stamp (ARRIVED or VISIT), it just
// cannot be DISCOVERED. lib/agent/extract-recent-visits.ts reads the same
// field lowercased and deduped for the prompt; the passport needs the names as
// Square wrote them, so this is the separate reader.

import { z } from 'zod'

const LineItemSchema = z.object({ name: z.string() })

const RawDataSchema = z.object({ line_items: z.array(z.unknown()) })

export function parseLineItemNames(rawData: unknown): string[] {
  const parsed = RawDataSchema.safeParse(rawData)
  if (!parsed.success) return []
  const names: string[] = []
  for (const entry of parsed.data.line_items) {
    const item = LineItemSchema.safeParse(entry)
    if (!item.success) continue
    const name = item.data.name.trim()
    if (name !== '') names.push(name)
  }
  return names
}
