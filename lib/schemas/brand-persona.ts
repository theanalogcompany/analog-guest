import { z } from 'zod'

// THE-236: voiceAntiPatterns reshape from string[] to struct[] with source +
// author + timestamp metadata. The Voices command-center surface needs to
// distinguish auto-promoted rules (from the regen loop's classifier) from
// manually-typed ones, and surface authorship + recency.
//
// Backward compat: legacy string entries from existing venue_configs rows are
// accepted on parse and normalized to {text, source: 'manual'} (no timestamp,
// no author — those are unrecoverable for legacy data). Forward writes use the
// struct shape; in-place migration happens whenever a venue's persona is
// rewritten through dedupeAndAppendAntiPatterns or any other writer.
//
// Stored shape after normalization:
//   { text: string, source: 'auto' | 'manual', authorOperatorId?, addedAt? }

const AntiPatternSourceSchema = z.enum(['auto', 'manual'])
export type AntiPatternSource = z.infer<typeof AntiPatternSourceSchema>

const AntiPatternStructSchema = z.object({
  text: z.string().min(1),
  source: AntiPatternSourceSchema.default('manual'),
  authorOperatorId: z.string().uuid().optional(),
  addedAt: z.string().optional(),
})

export const VoiceAntiPatternSchema = z
  .union([z.string().min(1), AntiPatternStructSchema])
  .transform((value) => {
    if (typeof value === 'string') {
      return { text: value, source: 'manual' as const }
    }
    return value
  })

export type VoiceAntiPattern = z.output<typeof VoiceAntiPatternSchema>

export const BrandPersonaSchema = z.object({
  tone: z.string().min(1),
  formality: z.enum(['casual', 'warm', 'formal']),
  speakerFraming: z.enum(['venue', 'named_person', 'owner']),
  speakerName: z.string().optional(),
  signaturePhrases: z.array(z.string()).default([]),
  bannedTopics: z.array(z.string()).default([]),
  emojiPolicy: z.enum(['never', 'sparingly', 'frequent']),
  lengthGuide: z.string().min(1),
  voiceAntiPatterns: z.array(VoiceAntiPatternSchema).default([]),
  voiceTouchstones: z.array(z.string()).default([]),
}).refine(
  (data) => data.speakerFraming !== 'named_person' || (data.speakerName && data.speakerName.length > 0),
  {
    message: 'speakerName is required when speakerFraming is "named_person"',
    path: ['speakerName'],
  }
)

export type BrandPersona = z.infer<typeof BrandPersonaSchema>
