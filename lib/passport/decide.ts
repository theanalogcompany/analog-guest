// TAC-586: which stamp a bound purchase gets. Pure: no I/O, no clock.
//
// The order of a passport, from the sticker set in Figma ("Passport — final",
// 157:3310): ARRIVED first, always; then DISCOVERED whenever they order
// something new, VISIT when they order something they've had before; INVITED
// on the visit a perk unlocks. One stamp per visit.
//
//   arrived     the guest's first stamp at this venue, even for a regular of
//               five years. Beats everything, a perk included.
//   invited     only when the caller passes `perkUnlocked`. Nothing passes it
//               yet; auto-issuing from venue perks is out of scope.
//   discovered  the order holds an item not yet discovered. The stamp names
//               the FIRST such item in line-item order, and only that one
//               becomes discovered: a second new item in the same order stays
//               discoverable on a later visit.
//   visit       everything else.
//
// "Discovered" = every item on the ARRIVED visit + every item a DISCOVERED
// stamp named. Matching is on `itemKey`, so "Oat Cortado" and "oat  cortado"
// are one item.
//
// THE NAME IS THE ITEM, NEVER ITS VARIATION (ruled 2026-10-14). A large and a
// small of the same drink are one item: the second is a VISIT, not a new
// DISCOVERED, and the stamp prints the item alone. Square keeps the two
// apart already - an order line item's `name` is the item and its
// `variation_name` ("Large") is a separate field - and the transaction row
// stores only `name` (lib/pos/square/map.ts mapSquareOrderLineItems). So
// `stampItemName` takes the variation only to say, in its signature, that it
// is dropped; nothing here tries to cut a size out of a name, because a name
// like "Pink Panther" has no size to find and guessing would mangle it.

export type StampKind = 'arrived' | 'visit' | 'discovered' | 'invited'

export const STAMP_KINDS: readonly StampKind[] = [
  'arrived',
  'visit',
  'discovered',
  'invited',
]

export function isStampKind(value: unknown): value is StampKind {
  return (
    typeof value === 'string' &&
    (STAMP_KINDS as readonly string[]).includes(value)
  )
}

export type PriorStamp = {
  kind: StampKind
  /** The item a DISCOVERED stamp named, or an INVITED stamp's perk line. */
  label: string | null
  /** That stamp's transaction's line-item names. Only an ARRIVED stamp's are read. */
  lineItemNames: readonly string[]
}

export type StampDecision = { kind: StampKind; label: string | null }

/** A line item as the stamp sees it. `variationName` is never printed. */
export type StampLineItem = { name: string; variationName?: string | null }

/**
 * The name a stamp prints for a line item: the item's own name, trimmed and
 * with runs of whitespace collapsed. The variation is dropped. Capitals are
 * the renderer's job, so this keeps Square's casing.
 */
export function stampItemName(item: StampLineItem): string {
  return item.name.trim().replace(/\s+/g, ' ')
}

/** The matching key for "already discovered": the printed name, case-folded. */
export function itemKey(name: string): string {
  return stampItemName({ name }).toLocaleLowerCase('en-US')
}

export function decideStamp(input: {
  prior: readonly PriorStamp[]
  /** `transactions.raw_data.line_items[].name`, in Square's order. */
  lineItemNames: readonly string[]
  perkUnlocked?: { perk: string }
}): StampDecision {
  if (input.prior.length === 0) return { kind: 'arrived', label: null }

  if (input.perkUnlocked !== undefined) {
    const perk = input.perkUnlocked.perk.trim()
    if (perk !== '') return { kind: 'invited', label: perk }
  }

  const discovered = new Set<string>()
  for (const stamp of input.prior) {
    if (stamp.kind === 'arrived') {
      for (const name of stamp.lineItemNames) discovered.add(itemKey(name))
    } else if (stamp.kind === 'discovered' && stamp.label !== null) {
      discovered.add(itemKey(stamp.label))
    }
  }

  for (const name of input.lineItemNames) {
    const printed = stampItemName({ name })
    if (printed === '') continue
    if (!discovered.has(itemKey(printed)))
      return { kind: 'discovered', label: printed }
  }
  return { kind: 'visit', label: null }
}
