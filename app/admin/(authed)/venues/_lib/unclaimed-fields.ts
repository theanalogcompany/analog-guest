import type { VenueInfo } from '@/lib/schemas'
import type { VenueDetailMechanicRow } from '../../_lib/load-venue-detail'

// "Render from the data, not from my list" (TAC-343 plan review). The §2
// table enumerates sections by naming specific fields; building one
// component per named field means anything the table failed to name simply
// never renders, and the page looks complete while quietly omitting things —
// the exact failure the coverage-test principle in §2 exists to prevent,
// applied here to the render path instead of the ticket prose.
//
// These two functions compute the complement of "what a named section
// claims" structurally, so the venue page can render a visible catch-all
// for anything unclaimed instead of a human maintaining that list by eye.

// Top-level venue_info keys a named §2 section explicitly covers. `menu` is
// listed whole here — both `menu.items`/`menu.notes` (the roster) and
// `menu.highlights` are claimed by "The menu" section as of the plan-review
// ruling below. `qrEnrollmentMessage` is claimed by Venue facts (guest-facing
// operational copy, not knowledge and not menu).
//
// `menu.highlights` was surfaced through the unclaimed mechanism first, per
// design, then placed deliberately rather than guessed: it is the exact
// field TAC-331's "latte to a guest already holding a drink" bug lived in —
// an always-on, every-turn-rendered field that silently carried opinionated
// advice ("first-timer pick") instead of a fact about what's on the menu.
// MenuRosterSection renders it with an explicit caption carrying that
// ruling forward: highlights are facts about the menu, not advice about
// what to order — advice belongs in knowledge_corpus.
const CLAIMED_TOP_LEVEL_VENUE_INFO_KEYS = [
  'address',
  'contact',
  'hours',
  'amenities',
  'staff',
  'currentContext',
  'menu',
  'qrEnrollmentMessage',
] as const

export interface UnclaimedField {
  key: string
  value: unknown
}

/**
 * Top-level venue_info keys with no named §2 destination. Undefined values
 * are omitted — an unclaimed field with nothing in it isn't worth a
 * catch-all row. Every current schema field is claimed as of the ruling
 * above; this returns [] today and exists so a FUTURE schema addition
 * surfaces automatically instead of silently never rendering.
 */
export function computeUnclaimedVenueInfoFields(venueInfo: VenueInfo): UnclaimedField[] {
  const unclaimed: UnclaimedField[] = []

  for (const [key, value] of Object.entries(venueInfo)) {
    if ((CLAIMED_TOP_LEVEL_VENUE_INFO_KEYS as readonly string[]).includes(key)) continue
    if (value === undefined) continue
    unclaimed.push({ key, value })
  }

  return unclaimed
}

// Mechanics columns accounted for by either the corrected §2 editable set
// (live fields + trigger/expiration_rule, marked unused) or by row chrome
// rendered directly (id for keying, isActive/deactivatedAt for the inactive
// marker, timestamps as a caption, schemaVersion as bookkeeping).
// `redemption` is DECIDED — not exposed for editing per §2 — but is still
// listed here as claimed/chrome rather than unclaimed: a deliberate decision
// about a known field is not the same as a field nobody accounted for, and
// it still renders read-only near the mechanics detail rather than vanishing.
//
// Keyed in the loader's camelCase (VenueDetailMechanicRow), not the raw
// snake_case DB column names — that's the shape every call site actually
// has. An earlier version of this list was snake_case while the only call
// site passed the camelCase row through an `as unknown as Record<...>`
// cast, so every mapped field silently "matched nothing" and rendered as
// unclaimed noise on every mechanic. Typing the function's parameter against
// VenueDetailMechanicRow directly (below) removes the cast and the
// shape-mismatch class of bug it was hiding.
const MECHANIC_CLAIMED_OR_CHROME_COLUMNS = [
  'id',
  'type',
  'name',
  'description',
  'qualification',
  'rewardDescription',
  'minState',
  'redemptionPolicy',
  'redemptionWindowDays',
  'requiresOperatorApproval',
  'trigger',
  'expirationRule',
  'redemption',
  'isActive',
  'deactivatedAt',
  'createdAt',
  'updatedAt',
  'schemaVersion',
] as const satisfies ReadonlyArray<keyof VenueDetailMechanicRow>

/**
 * True for a value not worth surfacing in an unclaimed-field catch-all:
 * undefined/null, an empty string, an empty array, or a plain object with
 * no keys (jsonb columns default to `{}`, not null — `mechanics.metadata`
 * is `{}` on all 6 live mechanics as of this check, per plan review; a
 * `{}` unclaimed row would be noise, not signal).
 */
function isEmptyUnclaimedValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

/**
 * Names any VenueDetailMechanicRow field not accounted for above AND whose
 * value is non-empty (today: `metadata` is empty on every live mechanic, so
 * this returns [] for all of them — confirmed by querying the live table,
 * not assumed). Structural, not hardcoded to "just metadata" — a future
 * loader field with an actual value surfaces here automatically until
 * someone updates the claimed list, rather than silently never rendering.
 * The `satisfies` constraint above also means removing a field from the
 * loader without updating this list fails `tsc`, not just this function's
 * own tests.
 */
export function computeUnclaimedMechanicColumns(row: VenueDetailMechanicRow): string[] {
  return Object.entries(row)
    .filter(
      ([key, value]) =>
        !(MECHANIC_CLAIMED_OR_CHROME_COLUMNS as readonly string[]).includes(key) &&
        !isEmptyUnclaimedValue(value),
    )
    .map(([key]) => key)
}
