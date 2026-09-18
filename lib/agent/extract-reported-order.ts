import { extractReportedOrder as callExtractReportedOrder } from '@/lib/ai'
import { createAdminClient } from '@/lib/db/admin'
import { toJson } from '@/lib/db/json'
import { venueLocalDate, venueLocalInstant } from '@/lib/guests/commitment-expiry'
import { normalizeMenuItemName } from '@/lib/recognition/extract-menu-exploration'
import { resolveOpenState, type VisitTimePrecision } from '@/lib/schemas'
import type { MenuItem } from '@/lib/schemas'
import type { Json } from '@/db/types'
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
// TAC-325 adds a second, ONGOING capture path alongside enrollment's
// original one-scan-and-done behavior. Gate (all still evaluated in order):
//   1. Prefilter hit — the inbound body names a real menu item (pure string
//      check, zero DB/LLM calls on a miss — most inbound messages never
//      mention a menu item at all). Shared by both paths.
//   2 + 3. Enrollment eligibility: zero existing `guest_reported` rows for
//      this guest, AND within 7 days of guests.created_at. When BOTH hold,
//      a completed-order report enrolls as before (`source='guest_reported'`,
//      the storage-layer index `idx_transactions_one_guest_reported_per_guest`
//      still caps this at one row per guest, ever). When EITHER fails, the
//      report falls through to ongoing capture instead of being dropped —
//      that fallthrough, not a new gate, is what TAC-325 adds. Enrollment's
//      own index, gate and delete-to-re-arm route (Command Center) are
//      untouched.
export const REPORTED_ORDER_WINDOW_DAYS = 7
const MS_PER_DAY = 24 * 60 * 60 * 1000

// TAC-325. How many of a guest's most recent ongoing-capture rows to load
// when looking for a same-venue-local-day merge target. A guest who reports
// orders occasionally will never approach this; it exists only so a very
// chatty guest's read stays bounded rather than scanning their whole
// history.
const ONGOING_MERGE_LOOKBACK_LIMIT = 10

export type ExtractReportedOrderOutcome =
  | { kind: 'no_menu_item_mentioned' }
  | { kind: 'already_reported' }
  | { kind: 'no_items_resolved' }
  // TAC-325: the model could not place the report on one identifiable
  // calendar day (ruling 6c) — nothing is written, on either path.
  | { kind: 'vague_past_report' }
  // TAC-325: an ongoing report whose every item was already present on the
  // same-local-day transaction it would have merged into. Nothing written.
  | { kind: 'no_new_items_ongoing' }
  | {
      kind: 'recorded'
      transactionId: string
      amountCents: number | null
      itemCount: number
      precision: VisitTimePrecision
    }
  // TAC-325: a new `guest_reported_ongoing` row — no same-local-day
  // transaction existed to merge into (or continuesRecentVisit said this is
  // a separate trip).
  | {
      kind: 'recorded_ongoing'
      transactionId: string
      amountCents: number | null
      itemCount: number
      precision: VisitTimePrecision
    }
  // TAC-325: new items appended to an existing same-local-day
  // `guest_reported_ongoing` row. `itemCount`/`amountCents` reflect the
  // MERGED row, not just what this report added.
  | {
      kind: 'merged_ongoing'
      transactionId: string
      amountCents: number | null
      itemCount: number
      addedItemCount: number
    }
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
  // ̀-ͯ is the Unicode combining diacritical marks block, so
  // stripping it leaves the plain base characters ("crème" -> "creme").
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '')
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
 *     "## What you're hoping to get to" line for understand_order on the
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
 * Combine the model's tense read with the venue's own hours to decide how
 * precisely this visit's time is known (TAC-377). Only ever called for a
 * 'present' report (TAC-325's 'specific_past_day' is never "pinned" — see
 * resolveOccurredAt below).
 *
 * `pinned` requires BOTH halves: the guest described the order as happening
 * now, AND the venue was actually open when the message landed. A
 * present-tense report at 9pm to a venue that shuts at 3pm is not a receipt
 * — they may well have come in that morning and be speaking loosely — so it
 * records the visit at `approximate` and no post_visit_* followup is
 * scheduled off it.
 *
 * An `unknown` open-state resolves to `pinned`, NOT `approximate`. Only a
 * positive `closed` downgrades. The two failure directions are not
 * symmetric: a wrong `approximate` permanently suppresses post_visit_* for
 * that guest, which is the exact bug this ticket exists to fix, while a
 * wrong `pinned` costs a check-in that lands a few hours early. It is also
 * a live case rather than a hypothetical — parse-venue-spec.ts silently
 * drops hours rows whose label isn't in DAY_KEY_MAP ("Sat & Sun",
 * "Weekends"), so a venue can genuinely have unreadable weekend hours, and
 * reading that as "shut" would quietly kill every weekend visit.
 * resolveOpenState also returns `unknown` for a timezone this runtime can't
 * use, which lands on the same safe side for the same reason.
 */
function resolvePresentPrecision(ctx: RuntimeContext, reportedAt: Date): VisitTimePrecision {
  const openState = resolveOpenState(ctx.venue.venueInfo.hours, ctx.venue.timezone, reportedAt)
  return openState.state === 'closed' ? 'approximate' : 'pinned'
}

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

// TAC-325. The venue-local "Weekday, YYYY-MM-DD" anchor handed to the
// extractor so it can resolve a relative day ("yesterday", "Saturday")
// against a real calendar date. Null when the venue's timezone can't be
// read — see venueLocalDate's own contract. The extractor's prompt is
// written to fall back to 'vague_past' rather than guess when this is null.
function formatTodayInVenueTimezone(timezone: string, receivedAt: Date): string | null {
  const local = venueLocalDate(timezone, receivedAt)
  if (!local) return null
  return `${WEEKDAY_NAMES[local.dayIndex]}, ${pad(local.year, 4)}-${pad(local.month, 2)}-${pad(local.day, 2)}`
}

function parseYmd(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return { year, month, day }
}

// TAC-325. The venue-local calendar day string for an instant, used only to
// compare two occurred_at values for "same day" purposes (the ongoing-merge
// lookup and the last_visit_at pinned-downgrade guard). Falls back to the
// instant's own UTC calendar day when the timezone is unreadable — a
// same-day comparison that's occasionally off by a timezone offset is a far
// smaller error than crashing or silently skipping the comparison.
function venueLocalDayKey(timezone: string, instant: Date): string {
  const local = venueLocalDate(timezone, instant)
  if (!local) return instant.toISOString().slice(0, 10)
  return `${pad(local.year, 4)}-${pad(local.month, 2)}-${pad(local.day, 2)}`
}

function sameVenueLocalDay(aIso: string, bIso: string, timezone: string): boolean {
  return venueLocalDayKey(timezone, new Date(aIso)) === venueLocalDayKey(timezone, new Date(bIso))
}

/**
 * Resolve THIS report's occurred_at instant + precision (TAC-325).
 *
 * 'present' is unchanged from TAC-377 — resolvePresentPrecision combines the
 * model's tense read with the venue's open/closed state.
 *
 * 'specific_past_day' resolves `occurredOnDate` to a venue-local NOON
 * instant (there's no reported time-of-day, so noon is a synthetic anchor,
 * not a claim about when in the day it happened) and is ALWAYS
 * `approximate` — a resolved day is still not a claim that this was the
 * live moment. A malformed `occurredOnDate`, or a venue timezone that can't
 * be read, degrades to the message's OWN timestamp at `approximate`
 * precision rather than losing the report — the same "unreadable clock
 * never asserts a confident thing, but never throws the report away either"
 * posture resolvePresentPrecision already carries.
 */
function resolveOccurredAt(
  reportTiming: 'present' | 'specific_past_day',
  occurredOnDate: string,
  ctx: RuntimeContext,
  reportedAt: Date,
): { occurredAt: Date; precision: VisitTimePrecision } {
  if (reportTiming === 'present') {
    return { occurredAt: reportedAt, precision: resolvePresentPrecision(ctx, reportedAt) }
  }
  const parsed = parseYmd(occurredOnDate)
  if (!parsed) {
    return { occurredAt: reportedAt, precision: 'approximate' }
  }
  const instant = venueLocalInstant(ctx.venue.timezone, parsed.year, parsed.month, parsed.day, 12 * 60)
  if (instant === null) {
    return { occurredAt: reportedAt, precision: 'approximate' }
  }
  return { occurredAt: instant, precision: 'approximate' }
}

// The stored shape for one line item — omits unit_price_cents entirely
// (rather than writing 0) when the item has no venue price, so parseTicket
// (Command Center) renders a blank price cell instead of a fabricated
// $0.00. `toJson` (lib/db/json.ts) is the repo's standard bridge from a
// plain typed value to the `raw_data` column's `Json` type — a named
// interface has no index signature, so TypeScript won't structurally accept
// it as `Json` on its own.
function buildStoredLineItems(items: readonly ResolvedReportedItem[]): Json[] {
  return items.map((item) =>
    toJson({
      name: item.name,
      quantity: item.quantity,
      ...(item.unitPriceCents !== null ? { unit_price_cents: item.unitPriceCents } : {}),
    }),
  )
}

// Null when ANY item has no price — a partial sum looks complete and isn't.
function computeAmountCents(items: readonly { unitPriceCents: number | null; quantity: number }[]): number | null {
  if (items.some((i) => i.unitPriceCents === null)) return null
  return items.reduce((sum, i) => sum + (i.unitPriceCents as number) * i.quantity, 0)
}

// TAC-325. Defensive read of a `guest_reported_ongoing` row's existing line
// items — permissive at this boundary (drop anything malformed rather than
// throwing) since this reads back data this same module already wrote.
function parseStoredLineItems(
  rawData: unknown,
): { name: string; quantity: number; unitPriceCents: number | null }[] {
  if (typeof rawData !== 'object' || rawData === null) return []
  const lineItems = (rawData as Record<string, unknown>).line_items
  if (!Array.isArray(lineItems)) return []
  const result: { name: string; quantity: number; unitPriceCents: number | null }[] = []
  for (const raw of lineItems) {
    if (typeof raw !== 'object' || raw === null) continue
    const rec = raw as Record<string, unknown>
    const name = typeof rec.name === 'string' ? rec.name : null
    const quantity = typeof rec.quantity === 'number' ? rec.quantity : null
    if (name === null || quantity === null) continue
    const unitPriceCents = typeof rec.unit_price_cents === 'number' ? rec.unit_price_cents : null
    result.push({ name, quantity, unitPriceCents })
  }
  return result
}

// TAC-325. Drops any newly-resolved item whose name already appears among
// an ongoing row's existing line items — deliberately NAME-ONLY, not "was
// this a re-order": "got another cortado" reads the same as "that cortado
// was cold", both treated as no new information. Accepted simplification
// (flagged, not solved) — the cost lands on item/spend attribution, never
// on visit count, which is unaffected by how many line items one
// transaction row carries.
function dropAlreadyRecordedItems(
  newItems: readonly ResolvedReportedItem[],
  existingItems: readonly { name: string }[],
): ResolvedReportedItem[] {
  const existingNames = new Set(existingItems.map((i) => normalizeMenuItemName(i.name)))
  return newItems.filter((item) => !existingNames.has(normalizeMenuItemName(item.name)))
}

type SupabaseAdminClient = ReturnType<typeof createAdminClient>

/**
 * Advance `guests.last_visit_at` / `last_visit_precision` (TAC-377, guarded
 * per TAC-325 ruling 7). Shared by the enrollment and ongoing paths so the
 * pinned-same-day guard exists once rather than twice.
 *
 * Forward-only per the `.or(...)` filter — a fresher last_visit_at is never
 * walked backwards. On top of that, TAC-325 adds one more guard: an
 * `approximate` write is never allowed to displace a `pinned` value that
 * already anchors the SAME venue-local day, because that would downgrade
 * confidence about a visit without changing which visit it is (and, per
 * followups/engine.ts, would silently drop the post_visit_* dedup key
 * precision needs to fire correctly).
 *
 * `currentLastVisitAt`/`currentLastVisitPrecision` are passed in rather than
 * re-read here — both callers already loaded the guest row once at the top
 * of `extractReportedOrder`, and re-reading here would be a second round
 * trip for data the caller already has. Failure to write is logged and
 * swallowed: the transaction row is the durable record of the visit and is
 * already written by the time this runs; this cache is derived and the next
 * report rebuilds it.
 */
async function advanceLastVisit(
  supabase: SupabaseAdminClient,
  guestId: string,
  currentLastVisitAt: string | null,
  currentLastVisitPrecision: string | null,
  occurredAtIso: string,
  precision: VisitTimePrecision,
  timezone: string,
): Promise<void> {
  if (
    currentLastVisitPrecision === 'pinned' &&
    currentLastVisitAt !== null &&
    sameVenueLocalDay(currentLastVisitAt, occurredAtIso, timezone)
  ) {
    return
  }

  const { error } = await supabase
    .from('guests')
    .update({ last_visit_at: occurredAtIso, last_visit_precision: precision })
    .eq('id', guestId)
    .or(`last_visit_at.is.null,last_visit_at.lt.${occurredAtIso}`)
  if (error) {
    console.warn('[agent] guest_reported last_visit_at update failed (continuing)', {
      guestId,
      error: error.message,
    })
  }
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
        .select('created_at, last_visit_at, last_visit_precision')
        .eq('id', ctx.guest.id)
        .single(),
    ])
    if (existingResult.error) {
      return { kind: 'failed', error: existingResult.error.message }
    }
    if (guestRowResult.error || !guestRowResult.data) {
      return { kind: 'failed', error: guestRowResult.error?.message ?? 'guest not found' }
    }

    // TAC-325: gate 2+3 no longer terminate the run. Enrollment fires when
    // BOTH hold; either failing falls through to ongoing capture instead of
    // stopping — see the module header.
    const createdAt = new Date(guestRowResult.data.created_at)
    const withinEnrollmentWindow =
      Date.now() - createdAt.getTime() <= REPORTED_ORDER_WINDOW_DAYS * MS_PER_DAY
    const enrollmentEligible = !existingResult.data && withinEnrollmentWindow

    const reportedAt = ctx.currentMessage.receivedAt
    const todayInVenueTimezone = formatTodayInVenueTimezone(ctx.venue.timezone, reportedAt)

    const extraction = await callExtractReportedOrder({
      inboundBody: ctx.currentMessage.body,
      menuItemNames: menuItems.map((m) => m.name),
      todayInVenueTimezone,
    })
    if (!extraction.ok) {
      return { kind: 'failed', error: extraction.error }
    }
    // TAC-325 ruling 6c: a genuinely vague past reference writes nothing on
    // either path — checked before item resolution so an empty-items vague
    // report and a populated-items vague report both report the same,
    // more-informative outcome rather than collapsing into no_items_resolved.
    if (extraction.data.reportTiming === 'vague_past') {
      return { kind: 'vague_past_report' }
    }
    if (extraction.data.items.length === 0) {
      return { kind: 'no_items_resolved' }
    }

    const resolved = resolveReportedItems(extraction.data.items, menuItems)
    if (resolved.length === 0) {
      return { kind: 'no_items_resolved' }
    }

    const { occurredAt, precision } = resolveOccurredAt(
      extraction.data.reportTiming,
      extraction.data.occurredOnDate,
      ctx,
      reportedAt,
    )
    const occurredAtIso = occurredAt.toISOString()

    if (enrollmentEligible) {
      const amountCents = computeAmountCents(resolved)

      const { data: inserted, error: insertError } = await supabase
        .from('transactions')
        .insert({
          venue_id: ctx.venue.id,
          guest_id: ctx.guest.id,
          source: 'guest_reported',
          amount_cents: amountCents,
          item_count: resolved.length,
          occurred_at: occurredAtIso,
          occurred_at_precision: precision,
          external_id: null,
          matched_at: null,
          match_method: null,
          raw_data: {
            pos_provider: 'guest_reported',
            amount_source: 'menu_estimate',
            line_items: buildStoredLineItems(resolved),
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

      await advanceLastVisit(
        supabase,
        ctx.guest.id,
        guestRowResult.data.last_visit_at,
        guestRowResult.data.last_visit_precision,
        occurredAtIso,
        precision,
        ctx.venue.timezone,
      )

      return {
        kind: 'recorded',
        transactionId: inserted.id,
        amountCents,
        itemCount: resolved.length,
        precision,
      }
    }

    // ------------------------------------------------------------------
    // TAC-325: ongoing capture. One row per guest per venue-local day;
    // later items on the same day join the most recent row rather than
    // starting a new one, unless the model reads this as a separate trip.
    // ------------------------------------------------------------------

    const { data: recentOngoing, error: recentOngoingError } = await supabase
      .from('transactions')
      .select('id, occurred_at, raw_data')
      .eq('venue_id', ctx.venue.id)
      .eq('guest_id', ctx.guest.id)
      .eq('source', 'guest_reported_ongoing')
      .order('occurred_at', { ascending: false })
      .limit(ONGOING_MERGE_LOOKBACK_LIMIT)
    if (recentOngoingError) {
      return { kind: 'failed', error: recentOngoingError.message }
    }

    const mergeTarget = extraction.data.continuesRecentVisit
      ? (recentOngoing ?? []).find(
          (row) =>
            typeof row.occurred_at === 'string' &&
            sameVenueLocalDay(row.occurred_at, occurredAtIso, ctx.venue.timezone),
        )
      : undefined

    if (mergeTarget) {
      const existingRaw =
        typeof mergeTarget.raw_data === 'object' && mergeTarget.raw_data !== null
          ? (mergeTarget.raw_data as Record<string, Json>)
          : {}
      const existingLineItemsRaw: Json[] = Array.isArray(existingRaw.line_items)
        ? (existingRaw.line_items as Json[])
        : []
      const existingParsed = parseStoredLineItems(mergeTarget.raw_data)

      const itemsToAdd = dropAlreadyRecordedItems(resolved, existingParsed)
      if (itemsToAdd.length === 0) {
        return { kind: 'no_new_items_ongoing' }
      }

      const mergedRawLineItems: Json[] = [...existingLineItemsRaw, ...buildStoredLineItems(itemsToAdd)]
      const amountCents = computeAmountCents([...existingParsed, ...itemsToAdd])

      const { error: updateError } = await supabase
        .from('transactions')
        .update({
          raw_data: { ...existingRaw, line_items: mergedRawLineItems },
          item_count: mergedRawLineItems.length,
          amount_cents: amountCents,
        })
        .eq('id', mergeTarget.id)
      if (updateError) {
        return { kind: 'failed', error: updateError.message }
      }

      await advanceLastVisit(
        supabase,
        ctx.guest.id,
        guestRowResult.data.last_visit_at,
        guestRowResult.data.last_visit_precision,
        occurredAtIso,
        precision,
        ctx.venue.timezone,
      )

      return {
        kind: 'merged_ongoing',
        transactionId: mergeTarget.id,
        amountCents,
        itemCount: mergedRawLineItems.length,
        addedItemCount: itemsToAdd.length,
      }
    }

    const amountCents = computeAmountCents(resolved)
    const { data: insertedOngoing, error: insertOngoingError } = await supabase
      .from('transactions')
      .insert({
        venue_id: ctx.venue.id,
        guest_id: ctx.guest.id,
        source: 'guest_reported_ongoing',
        amount_cents: amountCents,
        item_count: resolved.length,
        occurred_at: occurredAtIso,
        occurred_at_precision: precision,
        external_id: null,
        matched_at: null,
        match_method: null,
        raw_data: {
          pos_provider: 'guest_reported',
          amount_source: 'menu_estimate',
          line_items: buildStoredLineItems(resolved),
        },
      })
      .select('id')
      .single()
    if (insertOngoingError || !insertedOngoing) {
      return { kind: 'failed', error: insertOngoingError?.message ?? 'insert returned no row' }
    }

    await advanceLastVisit(
      supabase,
      ctx.guest.id,
      guestRowResult.data.last_visit_at,
      guestRowResult.data.last_visit_precision,
      occurredAtIso,
      precision,
      ctx.venue.timezone,
    )

    return {
      kind: 'recorded_ongoing',
      transactionId: insertedOngoing.id,
      amountCents,
      itemCount: resolved.length,
      precision,
    }
  } catch (e) {
    return { kind: 'failed', error: e instanceof Error ? e.message : String(e) }
  }
}
