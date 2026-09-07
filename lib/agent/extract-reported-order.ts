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

// Prefilter word-splitting is deliberately crude — this is a cheapness gate
// (avoid the Haiku call on the common case of a message naming no menu item
// at all), not a correctness gate (that's the LLM extractor + the resolver's
// structural enum constraint, below). A false positive here costs one extra
// Haiku call and writes nothing; a false negative silently kills the feature
// for that message. Bias accordingly: this list drops only tokens generic
// enough to appear in ordinary chat regardless of any menu item ("and",
// "with"), not tokens that merely seem short. Every entry must be
// >= MIN_SIGNIFICANT_WORD_LENGTH chars — a shorter entry ("of", "in", "a",
// "an", "to") is dead code, since the length floor below already excludes it
// before this set is ever checked.
const MENU_WORD_STOPWORDS = new Set(['the', 'and', 'with', 'for'])
const MIN_SIGNIFICANT_WORD_LENGTH = 3

// Diacritics-as-separator is a real failure mode, not a hypothetical one:
// the un-normalized split regex below treats "ñ"/"è"/"û" as separators (not
// a-z0-9), so "Piña" -> ["pi", "a"] -> both fragments die at the length
// floor -> the item is UNMATCHABLE by any phrasing, forever. Independent
// cafes/bakeries routinely carry accented names ("Crème Brûlée", "Piña
// Colada"). NFD + strip combining marks turns "crème" into "creme" before
// either side of the comparison sees it.
function stripDiacritics(value: string): string {
  // NFD decomposes an accented char into base char + combining mark(s);
  // \u0300-\u036f is the Unicode combining diacritical marks block, so
  // stripping it leaves the plain base characters ("cr\u00e8me" -> "creme").
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

// Splits a menu item name into its individually-matchable words. "Gibraltar
// / Cortado" -> ["gibraltar", "cortado"]; "Hario V60 Dripper" ->
// ["hario", "v60", "dripper"]. Alphanumeric runs stay whole ("v60" isn't
// split into "v" + "60"), and separators (whitespace, "/", punctuation,
// diacritics once stripped) all split alike.
//
// Also generates naive de-pluralized variants alongside the original word —
// a menu item stored in PLURAL form ("Croissants") must still match a
// guest's natural singular phrasing ("i got a croissant"); the reverse
// (singular menu, plural guest) already works via plain substring
// containment ("croissant" is a substring of "croissants"). This is not a
// lemmatizer: for a word ending "s" it also tries the word minus one
// trailing char, and for a word ending "es" it also tries the word minus two
// — deliberately BOTH when applicable ("sandwiches" yields the correct
// "sandwich" via the -es rule AND the linguistically-wrong-but-harmless
// "sandwiche" via the -s rule). A wrong extra candidate only ever costs one
// more cheap Haiku call on a false positive; the alternative — picking just
// one rule and guessing wrong for a given word — is what would leave real
// plurals silently unmatchable again.
function extractSignificantWords(name: string): string[] {
  const words = stripDiacritics(name.toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= MIN_SIGNIFICANT_WORD_LENGTH && !MENU_WORD_STOPWORDS.has(word))

  const withSingularVariants = new Set(words)
  for (const word of words) {
    if (word.endsWith('s') && word.length - 1 >= MIN_SIGNIFICANT_WORD_LENGTH) {
      withSingularVariants.add(word.slice(0, -1))
    }
    if (word.endsWith('es') && word.length - 2 >= MIN_SIGNIFICANT_WORD_LENGTH) {
      withSingularVariants.add(word.slice(0, -2))
    }
  }
  return [...withSingularVariants]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// TAC-326: boundary-checked word match, not raw substring containment. The
// leading side always requires a real boundary; the trailing side allows a
// real boundary OR exactly one recognized plural suffix (s/es — the SAME
// suffix vocabulary extractSignificantWords already uses for its own
// de-pluralization above, not a new concept) then a boundary. Boundary is
// "not a-z0-9", matching extractSignificantWords' own split regex exactly,
// so hyphen and apostrophe count as boundaries on both sides ("cold-brew"
// and "latte's" both still match correctly). Deliberately NOT the native
// `\b` anchor used in lib/agent/comp-backstop.ts and
// lib/agent/complaint-floor.ts: `\b` treats underscore as a word character
// (no boundary at "_"), which would disagree with extractSignificantWords'
// `[^a-z0-9]+` splitter treating underscore as a separator. Unlikely to
// matter on real menu/message text, but the explicit class keeps this
// function's notion of "boundary" identical to the tokenizer's, rather than
// two subtly different definitions in the same file.
//
// This is what stops "san" (from "San Pellegrino") matching inside "Sana",
// or "ice" (from "Hibiscus Ice Tea") matching inside "nice" — both were live
// production false positives (TAC-326) where a menu-derived word was a
// strict prefix of a longer, unrelated word. It does NOT stop a menu word
// that is a genuinely separate, correctly-boundaried word elsewhere with a
// different meaning ("san" inside "San Francisco") — that is a distinct,
// larger problem (single-word matching on a multi-word proper noun) and is
// deliberately deferred; see TAC-326's plan for why narrowing that is unsafe
// to bundle here (it breaks existing, deliberately-shipped single-word
// matches like "ginger" alone for "Wild Wonder Peach Ginger").
function bodyContainsWord(normalizedBody: string, word: string): boolean {
  const escaped = escapeRegExp(word)
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:es|s)?(?:$|[^a-z0-9])`).test(normalizedBody)
}

/**
 * Pure prefilter: does the inbound body mention any of the venue's menu item
 * names? Matches on individual significant WORDS drawn from each menu name,
 * not the whole name as one string — real multi-word/slash-separated names
 * ("Gibraltar / Cortado") are never typed verbatim by a guest who just says
 * "cortado" or "oat cortado", and 47 of Mock Sextant's 69 menu items are
 * multi-word (confirmed against production data in UAT). Matching on the
 * whole name here was a real bug, not an accepted tradeoff — it left the
 * feature effectively dead for the majority of real menu items. Word-level
 * matching uses `bodyContainsWord` (boundary-checked, TAC-326) rather than
 * raw substring containment: "cortados" (plural) still contains "cortado"
 * via the allowed plural-suffix tail, but "sana" no longer contains "san".
 *
 * ASYMMETRY — read before tuning this function further. Its two callers want
 * opposite things from a wrong answer:
 *   - extractReportedOrder (this file, TAC-323) tolerates a false positive:
 *     it costs one wasted Haiku call that correctly returns zero items. It
 *     is hurt by a false negative: that silently kills order extraction for
 *     that message, permanently, with no second chance.
 *   - applyCurrentTurnSuppression (lib/agent/intentions/derive.ts, TAC-324)
 *     is the reverse. A false positive there silently drops the
 *     "## What you're hoping to get to" line for learn_first_order on the
 *     exact turn it exists to cover, with nothing to signal that it
 *     happened. A false negative there just means the block renders on a
 *     turn where it maybe didn't strictly need to — redundant, not harmful.
 * Any future change to this function should move in the direction of fewer
 * false positives, even at the cost of occasionally more false negatives —
 * that trade helps the suppression caller and only mildly costs the
 * extractor (one more wasted call), never the reverse.
 */
export function bodyMentionsMenuItem(
  body: string,
  menuItems: readonly Pick<MenuItem, 'name'>[],
): boolean {
  const normalizedBody = stripDiacritics(normalizeMenuItemName(body))
  if (normalizedBody.length === 0) return false
  return menuItems.some((item) =>
    extractSignificantWords(item.name).some((word) => bodyContainsWord(normalizedBody, word)),
  )
}

// A reported quantity this far outside normal cafe-order range is more
// likely a model misread than a real order; clamp rather than write an
// inflated amount_cents/item_count with no ceiling. Post-LLM validation per
// THE-157 — the Zod schema itself carries no min/max.
const MAX_REASONABLE_QUANTITY = 20

/**
 * Resolve the LLM's extracted item names against the real venue menu.
 * Deliberately NOT a fuzzy match (per the ticket's §6 "no fuzzy or
 * embedding-based item matching") — the extractor prompt instructs the model
 * to return the menu item's name EXACTLY as given in the candidate list it
 * was shown (mapping the guest's own words, e.g. "oat cortado", onto the
 * canonical name, e.g. "Gibraltar / Cortado"), and this function does an
 * exact match (after trim/lowercase via `normalizeMenuItemName`) against
 * that same canonical list — it never tries to interpret or fuzzy-map the
 * model's output itself. This is a DIFFERENT normalization step from the
 * prefilter's `extractSignificantWords` (word-level, above): the prefilter's
 * job is "is it worth calling the model at all," this function's job is
 * "did the model return something real." Unmatched names are dropped
 * silently — per the ticket, unresolvable items are never stored as
 * freeform text.
 *
 * A normalized name can map to two-or-more menu rows (e.g. a "Latte" with
 * separate small/large rows sharing one name — `MenuItemSchema` permits this
 * via the `size` field, and the CSV parser enforces no name uniqueness;
 * confirmed live on the Mock Sextant menu, five duplicated names, three of
 * which disagree on price). The item is still resolved — the guest DID
 * report a real menu item, and dropping it would lose information they
 * actually gave us over a price ambiguity alone — priced at the HIGHEST of
 * the matching rows' prices. Rows with no price at all (`priceNote`-only)
 * are excluded from that max; if none of the matching rows has a price, the
 * item resolves with a null unitPriceCents, same as a single unpriced item.
 */
export function resolveReportedItems(
  extracted: readonly { name: string; quantity: number }[],
  menuItems: readonly MenuItem[],
): ResolvedReportedItem[] {
  const groupsByNormalizedName = new Map<string, MenuItem[]>()
  for (const item of menuItems) {
    const normalized = normalizeMenuItemName(item.name)
    if (normalized.length === 0) continue
    const group = groupsByNormalizedName.get(normalized)
    if (group) {
      group.push(item)
    } else {
      groupsByNormalizedName.set(normalized, [item])
    }
  }

  const resolved: ResolvedReportedItem[] = []
  for (const e of extracted) {
    const group = groupsByNormalizedName.get(normalizeMenuItemName(e.name))
    if (!group) continue
    const quantity =
      Number.isFinite(e.quantity) && e.quantity > 0
        ? Math.min(Math.round(e.quantity), MAX_REASONABLE_QUANTITY)
        : 1
    const highestPrice = group.reduce<number | undefined>(
      (max, item) =>
        item.price === undefined ? max : max === undefined || item.price > max ? item.price : max,
      undefined,
    )
    const unitPriceCents = highestPrice !== undefined ? Math.round(highestPrice * 100) : null
    resolved.push({ name: group[0].name, quantity, unitPriceCents })
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
