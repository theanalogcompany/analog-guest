import { extractReportedOrder as callExtractReportedOrder } from '@/lib/ai'
import { createAdminClient } from '@/lib/db/admin'
import { normalizeMenuItemName } from '@/lib/recognition/extract-menu-exploration'
import type { MenuItem } from '@/lib/schemas'
import type { RuntimeContext } from './types'

// TAC-323: guest enrollment via static QR + self-reported orders. The venue
// has no POS transaction to attach a guest's order to (the QR sign lives at
// pickup, not the register), so the only record of what they ordered is
// their own account of it. This module is the plumbing that turns a guest's
// inbound "i got an oat cortado" into a `transactions` row — the CONVERSATION
// that asks the question is a separate ticket; this only ever reacts to
// whatever the guest volunteers.
//
// Non-blocking by design: called from handle-inbound.ts via `waitUntil`
// right after classification succeeds, so a slow or failed Haiku call can
// never delay or block the reply. One consequence, called out explicitly
// because it's easy to mistake for a bug later: the extracted order is NOT
// available to generateStage, so the reply itself can never reference it.
//
// Gate (all three must hold, evaluated in this order):
//   1. Prefilter hit — the inbound body names a real menu item (pure string
//      check, zero DB/LLM calls on a miss — most inbound messages never
//      mention a menu item at all).
//   2. Zero existing guest_reported transactions for this guest. Once one
//      exists, this function is a permanent no-op for that guest — "one scan
//      and done" with no dedupe window. An operator deleting the row from
//      Command Center is the only re-arm path (by construction: this check
//      reads the transactions table directly, no separate flag to reset).
//   3. Within 7 days of the guest's created_at. Without this, a menu item
//      mentioned months after enrollment would still write an order.
export const REPORTED_ORDER_WINDOW_DAYS = 7
const MS_PER_DAY = 24 * 60 * 60 * 1000

export type ExtractReportedOrderOutcome =
  | { kind: 'no_menu_item_mentioned' }
  | { kind: 'already_reported' }
  | { kind: 'window_expired' }
  | { kind: 'no_items_resolved' }
  | { kind: 'recorded'; transactionId: string; amountCents: number | null; itemCount: number }
  | { kind: 'failed'; error: string }

interface ResolvedReportedItem {
  name: string
  quantity: number
  unitPriceCents: number | null
}

/**
 * Pure prefilter: does the inbound body mention any of the venue's menu item
 * names? Substring-containment after normalization (trim + lowercase) on
 * both sides — "i got an oat cortado" contains the normalized menu name
 * "cortado". Known limitation, accepted per the TAC-323 plan: a short/generic
 * item name could false-positive inside an unrelated word; the cost of a
 * false positive here is one extra (cheap) Haiku call, never a bad write,
 * since the LLM extractor is still the actual intent gate.
 */
export function bodyMentionsMenuItem(
  body: string,
  menuItems: readonly Pick<MenuItem, 'name'>[],
): boolean {
  const normalizedBody = normalizeMenuItemName(body)
  if (normalizedBody.length === 0) return false
  return menuItems.some((item) => {
    const normalizedName = normalizeMenuItemName(item.name)
    return normalizedName.length > 0 && normalizedBody.includes(normalizedName)
  })
}

// A reported quantity this far outside normal cafe-order range is more
// likely a model misread than a real order; clamp rather than write an
// inflated amount_cents/item_count with no ceiling. Post-LLM validation per
// THE-157 — the Zod schema itself carries no min/max.
const MAX_REASONABLE_QUANTITY = 20

/**
 * Resolve the LLM's extracted item names against the real venue menu via the
 * SAME normalization the prefilter uses, so the two can't disagree about
 * what "the same menu item" means. Unmatched names are dropped silently —
 * per the ticket, unresolvable items are never stored as freeform text.
 *
 * A normalized name that maps to two-or-more menu rows with DIFFERENT prices
 * (e.g. a "Latte" with separate small/large rows sharing one name —
 * `MenuItemSchema` permits this via the `size` field, and the CSV parser
 * enforces no name uniqueness) is treated as unresolvable, same as a name
 * matching nothing at all. Size-aware pricing is explicitly out of scope for
 * this ticket, but silently picking whichever row happens to come first in
 * `venue_info.menu.items` would write a specific, wrong, permanent price —
 * worse than the accepted "drop it" outcome for anything else we can't
 * confidently resolve. Rows sharing a name with the SAME price aren't
 * ambiguous (duplicate data, not conflicting data) and resolve normally.
 */
export function resolveReportedItems(
  extracted: readonly { name: string; quantity: number }[],
  menuItems: readonly MenuItem[],
): ResolvedReportedItem[] {
  const byNormalizedName = new Map<string, MenuItem>()
  const ambiguousNames = new Set<string>()
  for (const item of menuItems) {
    const normalized = normalizeMenuItemName(item.name)
    if (normalized.length === 0) continue
    const existing = byNormalizedName.get(normalized)
    if (existing === undefined) {
      byNormalizedName.set(normalized, item)
    } else if (existing.price !== item.price) {
      ambiguousNames.add(normalized)
    }
  }

  const resolved: ResolvedReportedItem[] = []
  for (const e of extracted) {
    const normalized = normalizeMenuItemName(e.name)
    if (ambiguousNames.has(normalized)) {
      console.warn('[extract-reported-order] dropping ambiguous item name (multiple menu prices)', {
        name: e.name,
      })
      continue
    }
    const match = byNormalizedName.get(normalized)
    if (!match) continue
    const quantity =
      Number.isFinite(e.quantity) && e.quantity > 0
        ? Math.min(Math.round(e.quantity), MAX_REASONABLE_QUANTITY)
        : 1
    const unitPriceCents = match.price !== undefined ? Math.round(match.price * 100) : null
    resolved.push({ name: match.name, quantity, unitPriceCents })
  }
  return resolved
}

/**
 * Never throws. Every branch — including DB and LLM failures — returns a
 * typed outcome and is logged (console.warn/console.error), matching the
 * updateGuestContext failure-handling precedent already in handle-inbound.ts
 * (log + continue, no red alert — this side effect isn't part of the
 * voice/reply contract fireRedAlert exists to protect).
 */
export async function extractReportedOrder(
  ctx: RuntimeContext,
): Promise<ExtractReportedOrderOutcome> {
  try {
    if (ctx.currentMessage === null) return { kind: 'no_menu_item_mentioned' }

    const menuItems = ctx.venue.venueInfo.menu.items
    if (!bodyMentionsMenuItem(ctx.currentMessage.body, menuItems)) {
      return { kind: 'no_menu_item_mentioned' }
    }

    const supabase = createAdminClient()
    const [existingResult, guestRowResult] = await Promise.all([
      supabase
        .from('transactions')
        .select('id')
        .eq('venue_id', ctx.venue.id)
        .eq('guest_id', ctx.guest.id)
        .eq('source', 'guest_reported')
        .limit(1)
        .maybeSingle(),
      supabase
        .from('guests')
        .select('created_at, first_contacted_at')
        .eq('id', ctx.guest.id)
        .single(),
    ])
    if (existingResult.error) {
      return { kind: 'failed', error: existingResult.error.message }
    }
    if (existingResult.data) {
      return { kind: 'already_reported' }
    }
    if (guestRowResult.error || !guestRowResult.data) {
      return { kind: 'failed', error: guestRowResult.error?.message ?? 'guest not found' }
    }

    const createdAt = new Date(guestRowResult.data.created_at)
    if (Date.now() - createdAt.getTime() > REPORTED_ORDER_WINDOW_DAYS * MS_PER_DAY) {
      return { kind: 'window_expired' }
    }

    const extraction = await callExtractReportedOrder({
      inboundBody: ctx.currentMessage.body,
      menuItemNames: menuItems.map((m) => m.name),
    })
    if (!extraction.ok) {
      return { kind: 'failed', error: extraction.error }
    }
    if (extraction.data.items.length === 0) {
      return { kind: 'no_items_resolved' }
    }

    const resolved = resolveReportedItems(extraction.data.items, menuItems)
    if (resolved.length === 0) {
      return { kind: 'no_items_resolved' }
    }

    // Null if ANY resolved item has no price — a partial sum looks complete
    // and isn't. The unpriced item still renders in Command Center (name +
    // quantity, blank price cell) via parseTicket's relaxed line-item parse.
    const anyUnpriced = resolved.some((r) => r.unitPriceCents === null)
    const amountCents = anyUnpriced
      ? null
      : resolved.reduce((sum, r) => sum + (r.unitPriceCents as number) * r.quantity, 0)

    // Timestamp of the guest's FIRST inbound message, not this one — a guest
    // who answers three days later ordered three days ago. Falls back to
    // created_at for a guest whose first_contacted_at was never stamped
    // (e.g. created via nfc_tap/csv_import/pos_match before ever texting).
    const occurredAt = guestRowResult.data.first_contacted_at ?? guestRowResult.data.created_at

    const { data: inserted, error: insertError } = await supabase
      .from('transactions')
      .insert({
        venue_id: ctx.venue.id,
        guest_id: ctx.guest.id,
        source: 'guest_reported',
        amount_cents: amountCents,
        item_count: resolved.length,
        occurred_at: occurredAt,
        external_id: null,
        matched_at: null,
        match_method: null,
        raw_data: {
          pos_provider: 'guest_reported',
          amount_source: 'menu_estimate',
          line_items: resolved.map((r) => ({
            name: r.name,
            quantity: r.quantity,
            // Omitted (not 0) when unpriced — parseTicket keeps the item and
            // renders a blank price cell rather than a fabricated $0.00.
            ...(r.unitPriceCents !== null ? { unit_price_cents: r.unitPriceCents } : {}),
          })),
        },
      })
      .select('id')
      .single()
    if (insertError || !inserted) {
      // 23505: idx_transactions_one_guest_reported_per_guest lost a race
      // against a concurrent inbound from the same guest — same outcome as
      // finding the row already there.
      if (insertError?.code === '23505') {
        return { kind: 'already_reported' }
      }
      return { kind: 'failed', error: insertError?.message ?? 'insert returned no row' }
    }

    return {
      kind: 'recorded',
      transactionId: inserted.id,
      amountCents,
      itemCount: resolved.length,
    }
  } catch (e) {
    return { kind: 'failed', error: e instanceof Error ? e.message : String(e) }
  }
}
