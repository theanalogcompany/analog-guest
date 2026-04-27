import { z } from 'zod'

// A single freeform context note the operator curates: seasonal items, events,
// perks, inventory, ops notes — anything the agent should know is true at the
// venue right now. For v1 every note is source: 'text'; the file fields are
// reserved for THE-136 (file ingestion).
export const VenueContextNoteSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  source: z.enum(['text', 'file']),
  fileUrl: z.url().optional(),
  fileName: z.string().optional(),
  fileType: z.string().optional(),
  addedAt: z.coerce.date(),
})

export type VenueContextNote = z.infer<typeof VenueContextNoteSchema>

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
  }).default({ highlights: [] }),
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