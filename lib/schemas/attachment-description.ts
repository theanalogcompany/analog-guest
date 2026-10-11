// TAC-584: what the describe step recorded about one guest attachment, and
// the two rules that read it.
//
// `message_attachments.description` is one sentence. Everything else the
// vision call returned is `description_meta` (migration 081), which this file
// parses. Three readers, and they must not disagree, so each rule is one
// function here and nowhere else:
//
//   nameableItems   which menu items a reply may name, AND which items go on
//                   the visit as an order. One function for both, so a drink
//                   the draft may not name can never be recorded as ordered.
//   evidencesVisit  whether this attachment is evidence the guest was at the
//                   venue.
//   usableDescription  whether there is a description to put in a prompt.
//
// PERMISSIVE AT THE LIVE BOUNDARY, like parseVisitPrecision: a row whose meta
// does not parse is read as "not described", which is today's behaviour (the
// agent is told a photo arrived and that it cannot see it). Nothing here
// throws inside an agent run.
//
// NOT EXPORTED FROM lib/schemas/index.ts. Every consumer imports it by path.

import { z } from 'zod'

export const DESCRIPTION_META_VERSION = 1

/** Can the image be made out at all. `unclear` is never described to the model. */
export const LEGIBILITY = ['clear', 'unclear'] as const
export type Legibility = (typeof LEGIBILITY)[number]

/**
 * Is this the venue. `yes` needs something IN THE FRAME: a drink matching an
 * appearance entry's distinguishing features, or a venue marker. A story tag
 * alone is not a visit.
 */
export const SHOWS_VENUE = ['yes', 'no', 'unsure'] as const
export type ShowsVenue = (typeof SHOWS_VENUE)[number]

/**
 * How sure the model is of a menu item. Only `unmistakable` is ever acted on;
 * `possible` is kept on the row so a miss can be read later, and names
 * nothing.
 */
export const ITEM_CONFIDENCE = ['unmistakable', 'possible'] as const
export type ItemConfidence = (typeof ITEM_CONFIDENCE)[number]

/**
 * Why an attachment has `described_at` and no description. A fixed list, so
 * the reasons can be counted.
 */
export const DESCRIBE_SKIP_REASONS = [
  /** the re-host copy never reached `ready` inside the wait */
  'not_ready',
  /** the bytes could not be loaded: a dead story link, a missing object */
  'bytes_unavailable',
  /** a type the model cannot take and ffmpeg could not convert */
  'unsupported_type',
  /** no frame could be pulled from the video */
  'no_frames',
  /** the vision call failed or was truncated */
  'model_failed',
] as const
export type DescribeSkipReason = (typeof DESCRIBE_SKIP_REASONS)[number]

const describedItemSchema = z.object({
  name: z.string().min(1),
  confidence: z.enum(ITEM_CONFIDENCE),
})

const describedMetaSchema = z.object({
  version: z.literal(DESCRIPTION_META_VERSION),
  outcome: z.literal('described'),
  promptVersion: z.string(),
  model: z.string(),
  legibility: z.enum(LEGIBILITY),
  showsVenue: z.enum(SHOWS_VENUE),
  peoplePresent: z.boolean(),
  items: z.array(describedItemSchema),
  /** How many images the model was shown: 1 for a photo, up to 4 for a video. */
  frames: z.number(),
  /**
   * `transient` for a story: the bytes were fetched for the call and dropped.
   * `stored` for everything read from our own bucket.
   */
  source: z.enum(['stored', 'transient']),
})

const skippedMetaSchema = z.object({
  version: z.literal(DESCRIPTION_META_VERSION),
  outcome: z.literal('skipped'),
  reason: z.enum(DESCRIBE_SKIP_REASONS),
})

const descriptionMetaSchema = z.discriminatedUnion('outcome', [
  describedMetaSchema,
  skippedMetaSchema,
])

export type DescribedMeta = z.infer<typeof describedMetaSchema>
export type SkippedMeta = z.infer<typeof skippedMetaSchema>
export type AttachmentDescriptionMeta = z.infer<typeof descriptionMetaSchema>

/** A raw `description_meta` value to its shape, or null when it has none. */
export function parseDescriptionMeta(
  value: unknown,
): AttachmentDescriptionMeta | null {
  if (value === null || value === undefined) return null
  const parsed = descriptionMetaSchema.safeParse(value)
  if (!parsed.success) {
    console.warn(
      '[attachment-description] description_meta did not parse; reading the attachment as not described',
    )
    return null
  }
  return parsed.data
}

const MAX_DESCRIPTION_CHARS = 200

/**
 * A description as it may sit inside a bracketed prompt line.
 *
 * It is a model's sentence about a guest's picture, and it is about to be
 * read by another model. So it is flattened to one line, stripped of the
 * characters that could close the bracket or a quote around it, and cut
 * short, exactly as a reel's caption is (cleanShareTitle). That keeps the
 * line's shape, which is all wording can do; it is not a claim that a
 * description cannot carry an instruction.
 *
 * Counted in CODE POINTS: `slice` counts UTF-16 units, and a cut inside an
 * emoji leaves half a character the model API can refuse.
 */
export function cleanDescription(
  text: string | null | undefined,
): string | null {
  if (text === null || text === undefined) return null
  const flat = text
    .replace(/[[\]'"`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // A sentence ends the line it is put in; the line adds its own stop.
    .replace(/[.!?]+$/, '')
    .trim()
  if (flat === '') return null
  const points = Array.from(flat)
  return points.length > MAX_DESCRIPTION_CHARS
    ? `${points.slice(0, MAX_DESCRIPTION_CHARS).join('').trimEnd()}…`
    : flat
}

export type UsableDescription = {
  description: string
  meta: DescribedMeta
}

/**
 * The description, when there is one a prompt may carry.
 *
 * Null for an attachment that was never described, one whose describe was
 * skipped, and one the model could not make out. All three keep the line the
 * agent has always been given: a photo arrived and you cannot see it.
 */
export function usableDescription(row: {
  description: string | null
  descriptionMeta: unknown
}): UsableDescription | null {
  const meta = parseDescriptionMeta(row.descriptionMeta)
  if (meta === null || meta.outcome !== 'described') return null
  if (meta.legibility !== 'clear') return null
  const description = cleanDescription(row.description)
  if (description === null) return null
  return { description, meta }
}

/** Described, and too unclear to make out. Its own wording on the turn that answers it. */
export function isUnclear(row: { descriptionMeta: unknown }): boolean {
  const meta = parseDescriptionMeta(row.descriptionMeta)
  return (
    meta !== null &&
    meta.outcome === 'described' &&
    meta.legibility === 'unclear'
  )
}

/**
 * The menu items a reply may name and a visit may carry.
 *
 * `unmistakable` AND on the venue's menu, in the menu's own spelling. The
 * menu check is repeated here although the vision call's schema already
 * restricts `name` to the menu it was given: the row outlives that call, and
 * a menu item renamed since must not be named from an old description.
 */
export function nameableItems(
  meta: Pick<DescribedMeta, 'items' | 'legibility'>,
  menuItemNames: readonly string[],
): string[] {
  if (meta.legibility !== 'clear') return []
  const onMenu = new Set(menuItemNames)
  const named: string[] = []
  for (const item of meta.items) {
    if (item.confidence !== 'unmistakable') continue
    if (!onMenu.has(item.name) || named.includes(item.name)) continue
    named.push(item.name)
  }
  return named
}

/**
 * Is this attachment evidence the guest was at the venue.
 *
 * `yes` and legible. `unsure` records nothing (the ticket's rule): a visit
 * moves recognition, and a wrong one is not something the guest can see or
 * correct.
 */
export function evidencesVisit(
  meta: Pick<DescribedMeta, 'showsVenue' | 'legibility'>,
): boolean {
  return meta.legibility === 'clear' && meta.showsVenue === 'yes'
}
