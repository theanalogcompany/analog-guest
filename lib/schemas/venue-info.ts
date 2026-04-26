import { z } from 'zod'

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
})

export type VenueInfo = z.infer<typeof VenueInfoSchema>