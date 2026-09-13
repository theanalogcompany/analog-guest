import { z } from 'zod'

// A single freeform context note the operator curates: seasonal items, events,
// perks, inventory, ops notes — anything the agent should know is true at the
// venue right now. The file fields are reserved for THE-136 (file ingestion).
export const VenueContextNoteSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  // Free-form provenance string (e.g. 'interview_operating_reality', 'text', 'file').
  source: z.string().min(1),
  fileUrl: z.url().optional(),
  fileName: z.string().optional(),
  fileType: z.string().optional(),
  addedAt: z.coerce.date(),
  // Entry is active strictly before this moment. Stored as ISO string (not
  // coerced to Date) so a malformed value drops just the entry at filter time
  // rather than failing the whole venue_info JSONB validation. See
  // filterActiveContext below.
  expiresAt: z.string().optional(),
})

export type VenueContextNote = z.infer<typeof VenueContextNoteSchema>

/**
 * Classify a single currentContext entry against `now`. Extracted from
 * filterActiveContext (TAC-343) so the admin venue page's expiry queue can
 * partition entries into active/expired/malformed without re-deriving the
 * date logic a second time — the two callers share this one primitive
 * instead of drifting apart on what "expired" means.
 *
 * 'malformed' logs a warning (per-entry resilience — never crash the agent
 * run for one bad date) and is treated as non-active by filterActiveContext,
 * same as before this was extracted.
 *
 * Comparison is strictly-future: `expiresAt > now` is 'active'. An entry
 * whose expiresAt equals now is 'expired', not 'active'.
 */
export function classifyContextEntry(
  entry: VenueContextNote,
  now: Date,
): 'active' | 'expired' | 'malformed' {
  if (entry.expiresAt === undefined) return 'active'
  const expiry = new Date(entry.expiresAt)
  if (Number.isNaN(expiry.getTime())) {
    console.warn(
      `[venue-info] dropping currentContext entry "${entry.id}": malformed expiresAt "${entry.expiresAt}"`,
    )
    return 'malformed'
  }
  return expiry.getTime() > now.getTime() ? 'active' : 'expired'
}

/**
 * Drop currentContext entries whose expiresAt has elapsed. Entries with no
 * expiresAt are treated as permanent. Entries with a malformed expiresAt are
 * logged and dropped (per-entry resilience — never crash the agent run for one
 * bad date).
 *
 * Comparison is strictly-future: `expiresAt > now` keeps the entry. An entry
 * whose expiresAt equals now is dropped.
 */
export function filterActiveContext(
  entries: readonly VenueContextNote[],
  now: Date,
): VenueContextNote[] {
  return entries.filter((entry) => classifyContextEntry(entry, now) === 'active')
}

// A single row from the venue's menu CSV (04-{slug}-menu in Drive). Items are
// the source-of-truth for structured menu lookups by the agent (e.g. answering
// "how much is the cappuccino?" or "do you have oat milk?"); the venue-spec
// markdown's `menu.notes` and `menu.highlights` cover prose framing only.
export const MenuItemSchema = z
  .object({
    name: z.string().min(1),
    size: z.string().optional(),
    // price is optional when priceNote is set (e.g. "by request" pricing).
    price: z.number().optional(),
    priceNote: z.string().optional(),
    category: z.string().min(1),
    modifiers: z.array(z.string()).default([]),
    dietary: z.array(z.string()).default([]),
    description: z.string().optional(),
    availability: z.string().optional(),
    isOffMenu: z.boolean(),
  })
  .refine(
    (item) => item.price !== undefined || item.priceNote !== undefined,
    { message: 'item must have either a price or a priceNote', path: ['price'] },
  )

export type MenuItem = z.infer<typeof MenuItemSchema>

// Sub-schemas named and exported (TAC-343 Stage C) so the venue admin
// page's venue_info PATCH boundary validates against the exact same shapes
// VenueInfoSchema composes, rather than a hand-duplicated copy that could
// drift. Purely an extraction — VenueInfoSchema's composed shape (defaults,
// optionality) is unchanged; every existing parse behaves identically.
export const VenueAddressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  region: z.string().min(1),
  postalCode: z.string().min(1),
})

export const VenueContactSchema = z.object({
  publicPhone: z.string().optional(),
  publicEmail: z.string().email().optional(),
  website: z.string().url().optional(),
})

export const VenueHoursSchema = z.object({
  monday: z.string().optional(),
  tuesday: z.string().optional(),
  wednesday: z.string().optional(),
  thursday: z.string().optional(),
  friday: z.string().optional(),
  saturday: z.string().optional(),
  sunday: z.string().optional(),
  notes: z.string().optional(),
})

export const VenueAmenitiesSchema = z.object({
  wifi: z.boolean().optional(),
  petFriendly: z.boolean().optional(),
  parking: z.string().optional(),
  seating: z.string().optional(),
  notes: z.string().optional(),
})

/**
 * TAC-301 part 2: what the venue actually does and doesn't do for a guest.
 *
 * Exists because capability was systemically unconstrained. Nothing in the
 * runtime stopped the agent offering a service the venue doesn't provide —
 * `formatMechanicEligibility` constrains PERKS and nothing did the equivalent
 * for services. The incident: at a counter-only, walk-in venue with no hold
 * mechanism, the agent confirmed it would have a guest's order ready.
 *
 * THREE-STATE, and the distinction is the whole design:
 *   true      offered. Say so, offer it.
 *   false     explicitly NOT offered. Renders as an unmissable negative.
 *   absent    nobody has said. Renders NOTHING.
 *
 * Absent must never render as a negative. Doing so would have the agent deny
 * real services at every venue nobody has configured yet, which is a worse and
 * far more frequent failure than the one being fixed. The prompt's own default
 * (# Commitments: don't offer what the venue facts don't say it does) covers
 * the unconfigured case without this schema claiming anything false.
 *
 * A CLOSED list of named fields rather than Record<string, boolean>, because
 * `services.holds === false` should be a compile-checked expression the day
 * commitment vocabulary is conditioned on venue capability. A Record reads the
 * same at runtime and gives tsc nothing. Adding a sixth service is then a
 * deliberate schema edit, which is the right amount of friction.
 */
export const VenueServicesSchema = z.object({
  // Ordering before arrival, by any channel.
  aheadOrdering: z.boolean().optional(),
  // Setting an item aside for later pickup. The one the incident turned on,
  // and the one `# Commitments`'s `hold` type is gated behind.
  holds: z.boolean().optional(),
  // A booked table or time.
  reservations: z.boolean().optional(),
  // Venue-run or third-party.
  delivery: z.boolean().optional(),
  // Pre-arranged large orders. Kept on operator call: it's the shape of the
  // failure class (a thing a cafe is plausibly asked for and may not do), and
  // Le Mil's persona already states the owner doesn't handle it over text.
  catering: z.boolean().optional(),
  // Escape hatches for services the closed list doesn't model. Two arrays
  // rather than one notes blob so the positive/negative split stays structured
  // at the edges too — the negative is the half that does the work.
  alsoOffers: z.array(z.string()).default([]),
  alsoDoesNotOffer: z.array(z.string()).default([]),
})

export type VenueServices = z.infer<typeof VenueServicesSchema>

export const VenueMenuSchema = z.object({
  highlights: z.array(z.string()).default([]),
  notes: z.string().optional(),
  items: z.array(MenuItemSchema).default([]),
})

export const VenueInfoSchema = z.object({
  address: VenueAddressSchema,
  contact: VenueContactSchema.default({}),
  hours: VenueHoursSchema.default({}),
  menu: VenueMenuSchema.default({ highlights: [], items: [] }),
  staff: z.array(z.string()).default([]),
  amenities: VenueAmenitiesSchema.optional(),
  // TAC-301: optional, so every venue that predates this parses unchanged and
  // renders no services section at all.
  //
  // `.catch(undefined)` is the repo's permissive-at-the-LIVE-boundary rule
  // (see CLAUDE.md → Common gotchas). This field has no write path yet, so it
  // is hand-edited in Studio, and `buildRuntimeContext` THROWS on a venue_info
  // parse failure — meaning `"holds": "false"` (a string, the natural Studio
  // typo) would take down every agent run for that venue rather than just
  // dropping the block. Malformed services now degrades to "nobody said",
  // which renders nothing, which is the same safe state as unconfigured.
  services: VenueServicesSchema.optional().catch(undefined),
  currentContext: z.array(VenueContextNoteSchema).default([]),
  // TAC-323: the exact prefilled-message string a guest sends by scanning the
  // venue's static QR sign (e.g. "Hi Sana!" for Mock Sextant). Used by the
  // Sendblue webhook to distinguish a QR enrollment (created_via: 'qr_scan')
  // from an unprompted inbound (created_via: 'inbound_message') on a
  // never-seen phone number. Must match the printed sign character-for-
  // character — that's an operator/print-process concern, not validated here.
  qrEnrollmentMessage: z.string().optional(),
})

export type VenueInfo = z.infer<typeof VenueInfoSchema>