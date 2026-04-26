import { z } from 'zod'

export const BrandPersonaSchema = z.object({
  tone: z.string().min(1),
  formality: z.enum(['casual', 'warm', 'formal']),
  speakerFraming: z.enum(['venue', 'named_person', 'owner']),
  speakerName: z.string().optional(),
  signaturePhrases: z.array(z.string()).default([]),
  bannedTopics: z.array(z.string()).default([]),
  emojiPolicy: z.enum(['never', 'sparingly', 'frequent']),
  lengthGuide: z.string().min(1),
  voiceAntiPatterns: z.array(z.string()).default([]),
  voiceTouchstones: z.array(z.string()).default([]),
}).refine(
  (data) => data.speakerFraming !== 'named_person' || (data.speakerName && data.speakerName.length > 0),
  {
    message: 'speakerName is required when speakerFraming is "named_person"',
    path: ['speakerName'],
  }
)

export type BrandPersona = z.infer<typeof BrandPersonaSchema>