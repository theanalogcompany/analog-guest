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

// How this venue's team actually texts, MEASURED from the replies they sent
// (scripts/derive-voice-profile.ts over the Instagram history import). Ruled
// 2026-10-07: nothing about HOW a venue texts is written by us, so when a
// profile is present its numbers replace the hand-written `lengthGuide` and
// `emojiPolicy` in the prompt, set the length check's ceiling, the emoji coin
// and the split coin. A venue without one behaves exactly as before.
//
// Every share is a fraction from 0 to 1. Words are whole numbers.
// POSITIVE, not merely non-negative. These figures are applied by hand, the
// per-message p90 is what dispatch cuts a long reply to, and the median is
// what the prompt asks for: a zero is a typo that would otherwise cut every
// reply into nothing or ask for "about 0 words".
const WordSpreadSchema = z.object({
  median: z.number().int().positive(),
  p75: z.number().int().positive(),
  p90: z.number().int().positive(),
  max: z.number().int().positive(),
})
const ShareSchema = z.number().min(0).max(1)

export const VoiceProfileSchema = z.object({
  /** How many of the team's replies the numbers below were measured from. */
  replies: z.number().int().positive(),
  bubbles: z.number().int().positive(),
  guests: z.number().int().positive(),
  wordsPerReply: WordSpreadSchema,
  wordsPerBubble: WordSpreadSchema,
  /** Share of replies sent as more than one message. */
  splitShare: ShareSchema,
  bubblesPerReply: z.record(z.string(), z.number().int().nonnegative()),
  emojiShareOfReplies: ShareSchema,
  emojiShareOfBubbles: ShareSchema,
  /** Share of messages with a typed smiley such as ":)". */
  smileyShareOfBubbles: ShareSchema,
  /** Of messages that start with a letter: how many start lowercase. */
  lowercaseStartShare: ShareSchema,
  /** How a message ends. Shares of all messages. */
  endings: z.object({
    nothing: ShareSchema,
    period: ShareSchema,
    exclamation: ShareSchema,
    question: ShareSchema,
    emoji: ShareSchema,
    other: ShareSchema,
  }),
  /** Share of messages containing each mark anywhere. */
  marks: z.object({
    exclamation: ShareSchema,
    parenthesis: ShareSchema,
    dash: ShareSchema,
  }),
  openers: z.array(z.object({ word: z.string(), share: ShareSchema })),
  // The length check's two figures, in words (lib/ai/reply-length.ts). They
  // are CHOSEN from the spread above when the profile is applied, and stored
  // so the choice is the venue's and visible: for the first venue the ceiling
  // is the team's p90, a backstop, and the typical length their median (ruled
  // 2026-10-07; the p75 tried first fired on a third of question turns).
  // Absent means no length check for this venue.
  replyLength: z
    .object({
      maxWords: z.number().int().positive(),
      typicalWords: z.number().int().positive(),
    })
    .optional(),
  // What the team did when a guest sent a pure close ("ok", "thanks", a lone
  // emoji) after one of their messages: how many were seen, and the share
  // left with no reply (lib/agent/pure-close.ts). At or past a half, the agent
  // sends nothing to such a message either. Absent: every message is answered.
  closes: z
    .object({
      seen: z.number().int().nonnegative(),
      unansweredShare: ShareSchema,
    })
    .optional(),
  /** ISO time the profile was derived. Absent on a hand-built test profile. */
  derivedAt: z.string().optional(),
})

export type VoiceProfile = z.infer<typeof VoiceProfileSchema>

export const BrandPersonaSchema = z
  .object({
    // Human-readable label for the voice. Editable from the Voices
    // command-center persona pane; rendered in the topbar + sidebar voice
    // list. Optional — venues onboarded before this field landed fall back
    // to the venue display name in the UI. JSONB-additive so no migration;
    // will move to a `voices` table whenever the 1-voice-per-venue
    // assumption finally breaks.
    voiceName: z.string().min(1).optional(),
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
    // FAILS OPEN TO "NO PROFILE", on its own. This object is parsed on every
    // agent run, and a malformed profile must cost the venue its measured
    // style, never its whole persona: without the catch one bad number here
    // would fail the persona parse and take the venue's voice with it.
    //
    // NOT SILENT. The venue falls back to its hand-written style, and the
    // next save of the persona would write it back without the profile, so
    // the drop is logged where a person looking at the venue's runs sees it.
    voiceProfile: VoiceProfileSchema.optional().catch((ctx) => {
      console.warn(
        `[schemas] brand_persona.voiceProfile does not parse and is being ignored: ${ctx.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      )
      return undefined
    }),
  })
  .refine(
    (data) =>
      data.speakerFraming !== 'named_person' ||
      (data.speakerName && data.speakerName.length > 0),
    {
      message: 'speakerName is required when speakerFraming is "named_person"',
      path: ['speakerName'],
    },
  )

export type BrandPersona = z.infer<typeof BrandPersonaSchema>
