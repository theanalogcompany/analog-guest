// TAC-588: what a receipt scan tells us the guest ordered, and which item the
// hello compliments.
//
// A scan of a receipt code binds one Square payment to the guest (reconcile-
// tap.ts) before the hello goes (the webhook chains them). The hello then
// compliments what they ordered instead of asking, and about twenty minutes
// after the order the venue asks how they liked it. Both read the order from
// here.
//
// ONE RECORD OF WHICH ORDER A SCAN BOUND, AND IT IS NOT A COPY. The scan's own
// message row carries the code it arrived with (`referral_ref`); that code's
// `pos_tap_events` row carries the transaction it bound
// (`reconciled_transaction_id`). Nothing on the scan-arrival row repeats it,
// so there is nothing to drift.
//
// THREE ANSWERS, and the third is the one that matters for wording (ruled
// 2026-10-14, question 3):
//
//   bound     the code bound an order to this guest. The hello compliments it.
//   expired   the code is ours but older than SCAN_CODE_TTL_MS, so it bound
//             nothing. The hello goes with no compliment and no question:
//             asking "what did you get?" a day after the order reads wrong.
//   none      no code (the counter sign), a payment Square had not told us
//             about, a code already bound by an earlier scan, or anything we
//             could not read. Today's greeting and flow, unchanged: we
//             genuinely do not know the order, so it is asked for.
//
// FAILS TO `none`. An unreadable read is today's greeting, which asks what they
// got. The cost is one question we could have avoided; the other direction is
// complimenting an order we cannot show they made.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/db/types'
import { itemKey } from '@/lib/passport/decide'
import { isScanCodeExpired, looksLikeScanCode } from '@/lib/pos/scan-code'
import { normalizeMenuItemName } from '@/lib/recognition/extract-menu-exploration'
import { parseLineItemNames, type MenuItem } from '@/lib/schemas'
import { logger } from '@/lib/observability/logger'

type AdminSupabaseClient = SupabaseClient<Database>

/** What a scan's receipt code tells us. See the module header. */
export type ScanOrder =
  | {
      kind: 'bound'
      transactionId: string
      /** When Square says the order was paid. The item question counts from it. */
      orderedAt: Date
      /** Square's line items, in Square's order. */
      lineItemNames: string[]
      /** The item this order's passport stamp DISCOVERED, if it did. */
      discoveredLabel: string | null
    }
  | { kind: 'expired' }
  | { kind: 'none' }

const NONE: ScanOrder = { kind: 'none' }

/**
 * The order a scan bound, read from the scan's own message row.
 *
 * `scannedAt` is the instant the code's age is judged at, for `expired`. It is
 * the scan, not now: the bind judged the code when the guest scanned, and a
 * cron reaching this row a minute later must not see a different answer.
 *
 * Never throws; see the module header for the direction.
 */
export async function loadScanOrder(
  supabase: AdminSupabaseClient,
  scan: {
    venueId: string
    guestId: string
    scanMessageId: string | null
    scannedAt: Date
  },
): Promise<ScanOrder> {
  if (scan.scanMessageId === null) return NONE
  try {
    const message = await supabase
      .from('messages')
      .select('referral_ref')
      .eq('id', scan.scanMessageId)
      .maybeSingle()
    if (message.error) return unreadable(scan, 'scan', message.error.message)
    const code = message.data?.referral_ref ?? null
    if (!looksLikeScanCode(code)) return NONE

    const tap = await supabase
      .from('pos_tap_events')
      .select('status, received_at, reconciled_transaction_id')
      .eq('tap_token', code)
      .eq('venue_id', scan.venueId)
      .maybeSingle()
    if (tap.error) return unreadable(scan, 'code', tap.error.message)
    if (!tap.data) return NONE

    const transactionId = tap.data.reconciled_transaction_id
    if (tap.data.status === 'matched' && transactionId !== null) {
      return await loadBoundOrder(supabase, scan, transactionId)
    }
    // Never bound. Expired if it was already past its day when they scanned,
    // whether or not the expiry cron has flipped the row yet; otherwise it is
    // a payment Square had not told us about, which is `none`.
    return isScanCodeExpired(new Date(tap.data.received_at), scan.scannedAt)
      ? { kind: 'expired' }
      : NONE
  } catch (e) {
    return unreadable(
      scan,
      'unexpected',
      e instanceof Error ? e.message : String(e),
    )
  }
}

async function loadBoundOrder(
  supabase: AdminSupabaseClient,
  scan: { venueId: string; guestId: string },
  transactionId: string,
): Promise<ScanOrder> {
  const [transaction, stamp] = await Promise.all([
    supabase
      .from('transactions')
      .select('id, guest_id, occurred_at, raw_data, retracted_at')
      .eq('id', transactionId)
      .eq('venue_id', scan.venueId)
      .maybeSingle(),
    supabase
      .from('passport_stamps')
      .select('kind, label')
      .eq('transaction_id', transactionId)
      .maybeSingle(),
  ])
  if (transaction.error)
    return unreadable(scan, 'transaction', transaction.error.message)
  const row = transaction.data
  // Bound to someone else (a later re-bind), or taken back: not this guest's
  // order to compliment.
  if (!row || row.guest_id !== scan.guestId || row.retracted_at !== null)
    return NONE
  const orderedAt = new Date(row.occurred_at)
  if (!Number.isFinite(orderedAt.getTime())) return NONE

  // The stamp is optional: a venue with no passport issues none, and an
  // unreadable stamp only costs the "new to them" preference.
  const discoveredLabel =
    !stamp.error && stamp.data?.kind === 'discovered'
      ? (stamp.data.label ?? null)
      : null
  return {
    kind: 'bound',
    transactionId: row.id,
    orderedAt,
    lineItemNames: parseLineItemNames(row.raw_data),
    discoveredLabel,
  }
}

function unreadable(
  scan: { venueId: string; guestId: string },
  stage: string,
  error: string,
): ScanOrder {
  logger.warn(
    '[scan-order] scan order unreadable; greeting as an unknown order',
    {
      venueId: scan.venueId,
      guestId: scan.guestId,
      stage,
      error,
    },
  )
  return NONE
}

// ---------------------------------------------------------------------------
// Which item the hello compliments
// ---------------------------------------------------------------------------

/**
 * Words that make a menu CATEGORY a drink category. Matched as whole words,
 * case-folded, against the free-text `category` of the venue's own menu row.
 *
 * A LIST, AND A CHOICE (TAC-588). Square keeps only a line item's name and
 * quantity (transaction-raw-data.ts), its catalogue category id is never
 * resolved, and nothing else in this repo tells a drink from food. The venue's
 * menu CSV has a free-text category per item, which is the one signal there is.
 */
export const DRINK_CATEGORY_WORDS = [
  'coffee',
  'coffees',
  'espresso',
  'tea',
  'teas',
  'matcha',
  'chai',
  'latte',
  'lattes',
  'drink',
  'drinks',
  'beverage',
  'beverages',
  'juice',
  'juices',
  'smoothie',
  'smoothies',
  'lemonade',
  'soda',
  'sodas',
  'cocoa',
  'hot chocolate',
] as const

/**
 * Words that make an item NAME a drink, when the name matches no menu row.
 * The category list plus the drinks a cafe names without saying "coffee".
 */
export const DRINK_NAME_WORDS = [
  ...DRINK_CATEGORY_WORDS,
  'cortado',
  'americano',
  'cappuccino',
  'flat white',
  'mocha',
  'macchiato',
  'cold brew',
  'pour over',
  'drip',
  'frappe',
  'spritz',
] as const

function hasWord(text: string, words: readonly string[]): boolean {
  const folded = text.toLocaleLowerCase('en-US')
  return words.some((word) =>
    new RegExp(`(^|[^a-z])${word.replace(/ /g, '\\s+')}([^a-z]|$)`).test(
      folded,
    ),
  )
}

/** Is this line item a drink? Its menu row's category if it has one, else its name. */
export function isDrink(
  lineItemName: string,
  menuItem: MenuItem | null,
): boolean {
  if (menuItem !== null) return hasWord(menuItem.category, DRINK_CATEGORY_WORDS)
  return hasWord(lineItemName, DRINK_NAME_WORDS)
}

/** The venue's own menu row for a Square line item, by normalized name. */
export function menuItemFor(
  lineItemName: string,
  menuItems: readonly MenuItem[],
): MenuItem | null {
  const key = normalizeMenuItemName(lineItemName)
  return (
    menuItems.find((item) => normalizeMenuItemName(item.name) === key) ?? null
  )
}

/** The item the hello compliments, and what is known about it. */
export interface ComplimentPick {
  /** The line item's name as Square has it. */
  item: string
  /** It got a DISCOVERED stamp on this order: the first time they have had it. */
  firstTime: boolean
  /** The venue's own description of it, verbatim, when the menu has one. */
  menuDescription: string | null
}

/**
 * Which item to compliment (ruled 2026-10-14):
 *
 *   1. the one this order's stamp DISCOVERED, because it is new to them
 *   2. otherwise the first drink, in Square's order
 *   3. otherwise the first item
 *
 * Null for an order with no named items, which then greets as an unknown
 * order: there is nothing to compliment. Pure.
 */
export function pickComplimentItem(input: {
  lineItemNames: readonly string[]
  discoveredLabel: string | null
  menuItems: readonly MenuItem[]
}): ComplimentPick | null {
  const names = input.lineItemNames.filter((name) => name.trim() !== '')
  if (names.length === 0) return null

  const pick = (item: string, firstTime: boolean): ComplimentPick => {
    const menuItem = menuItemFor(item, input.menuItems)
    const description = menuItem?.description?.trim() ?? ''
    return {
      item,
      firstTime,
      menuDescription: description === '' ? null : description,
    }
  }

  if (input.discoveredLabel !== null) {
    const discoveredKey = itemKey(input.discoveredLabel)
    const discovered = names.find((name) => itemKey(name) === discoveredKey)
    if (discovered !== undefined) return pick(discovered, true)
  }
  const drink = names.find((name) =>
    isDrink(name, menuItemFor(name, input.menuItems)),
  )
  return pick(drink ?? names[0], false)
}
