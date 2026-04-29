import { z } from 'zod'

// A single freeform context note the operator curates: seasonal items, events,
// perks, inventory, ops notes — anything the agent should know is true at the
// venue right now. The file fields are reserved for THE-136 (file ingestion).
export const VenueContextNoteSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  // Free-form provenance string (e.g. 'interview_section_9', 'text', 'file').
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
  return entries.filter((entry) => {
    if (entry.expiresAt === undefined) return true
    const expiry = new Date(entry.expiresAt)
    if (Number.isNaN(expiry.getTime())) {
      console.warn(
        `[venue-info] dropping currentContext entry "${entry.id}": malformed expiresAt "${entry.expiresAt}"`,
      )
      return false
    }
    return expiry.getTime() > now.getTime()
  })
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

export const VenueInfoSchema = z.object({
  address: z.object({
    line1: z.string().min(1),
    line2: z.string().optional(),
    city: z.string().min(1),
    region: z.string().min(1),
    postalCode: z.string().min(1),
  }),
  contact: z.object({
    publicPhone: z.string().optional(),
    publicEmail: z.string().email().optional(),
    website: z.string().url().optional(),
  }).default({}),
  hours: z.object({
    monday: z.string().optional(),
    tuesday: z.string().optional(),
    wednesday: z.string().optional(),
    thursday: z.string().optional(),
    friday: z.string().optional(),
    saturday: z.string().optional(),
    sunday: z.string().optional(),
    notes: z.string().optional(),
  }).default({}),
  menu: z.object({
    highlights: z.array(z.string()).default([]),
    notes: z.string().optional(),
    items: z.array(MenuItemSchema).default([]),
  }).default({ highlights: [], items: [] }),
  staff: z.array(z.string()).default([]),
  amenities: z.object({
    wifi: z.boolean().optional(),
    petFriendly: z.boolean().optional(),
    parking: z.string().optional(),
    seating: z.string().optional(),
    notes: z.string().optional(),
  }).optional(),
  currentContext: z.array(VenueContextNoteSchema).default([]),
})

export type VenueInfo = z.infer<typeof VenueInfoSchema>