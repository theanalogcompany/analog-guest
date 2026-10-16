// Zod schema for playground_conversations.turns (migration 074). Read that
// column through this, never raw SQL paths. NOT an LLM-output schema -
// .min()/.max() are fine.
//
// WHAT A SAVED TURN IS. Enough to put the chat back on screen with no model
// calls, plus the one thing that makes rerunning from the middle cheap: the
// PlaygroundSession this turn RAN WITH. The playground's rewind restores the
// session from the turn's own request rather than replaying the prefix
// ("every request carries the session snapshot it ran with",
// playground-client.tsx), so persisting the snapshot is what carries that
// property across a reload.
//
// WHAT IT IS NOT. No TurnTrace: 50-100 KB a turn, mostly reproducible, and
// stale the moment the template or graph version moves. A restored turn has a
// reply and NO trace, and the inspector says so. Nothing may synthesize a
// trace to fill the panel - a fabricated trace is worse than an empty one,
// because the empty one tells the truth.
//
// No sessionHistory either: derivable from the turns themselves, and a stored
// copy is a second transcript that can disagree with the first.
//
// Admin writes validate strictly (the admin write boundary is stricter than
// the live read boundary); the loader degrades per-row to a banner so one
// unparseable save cannot take out the picker.

import { z } from 'zod'

import {
  V2_EFFORT_REQUESTS,
  V2_MODEL_KEYS,
  V2_PLAYGROUND_MAX_OUTPUT_TOKENS,
} from '@/lib/ai/v2/model-call'

import {
  GuestProfileSchema,
  InteractionMemorySchema,
} from '@/lib/relationship/profile'

/**
 * Mirrors PlaygroundSession (lib/relationship/run-turn.ts). `stateKey` stays
 * optional for the same reason it is optional there: a turn may have run with
 * the engine resolving state deterministically from the facts, and storing a
 * resolved key would turn an inference into a pin.
 */
export const SavedPlaygroundSessionSchema = z.object({
  profile: GuestProfileSchema,
  memory: InteractionMemorySchema,
  stateKey: z.string().min(1).optional(),
  facts: z.object({
    visitCount: z.number().int().nonnegative(),
    replyCount: z.number().int().nonnegative(),
    daysSinceLastContact: z.number().nonnegative().nullable(),
  }),
})

/**
 * Mirrors TurnOverrides; a turn regenerated with overrides saves them.
 *
 * `knowledgeText` became `knowledgeBriefText` in v2.18.0, when v2 stopped
 * retrieving. Zod strips unknown keys, so a conversation saved before that
 * still parses - it replays with that one override dropped rather than
 * failing, which is the right direction for a saved artifact nobody can
 * migrate by hand. Every other override is unaffected.
 *
 * `promptBlocks` ARE SAVED, which sits oddly beside the header's reason for
 * dropping the TurnTrace ("50-100 KB a turn, mostly reproducible"). They are
 * kept on exactly that test: a hand-edited block is the one thing here that is
 * not reproducible. Nothing else holds it, the composer cannot regenerate it,
 * and it is what a human typed - losing an afternoon's ablation on save is
 * worse than a large row. It is also absent from the common case, because the
 * inspector sends only the blocks that differ from the composed ones.
 */
/**
 * The template's own blocks, hand-edited with their `{placeholders}` intact -
 * the prompt lab's template mode, mirroring `V2TemplateBlocks`
 * (lib/ai/v2/template-archive.ts).
 *
 * Capped per block at what `promptBlocks` caps a composed block at, for the
 * same reason: a template block is smaller than the composed one it produces
 * (the brief arrives through a placeholder rather than inline), so 200k leaves
 * room to paste a bigger one in without the field being a way to post a
 * megabyte. The cue is a single bracketed sentence and is capped like one.
 *
 * NOT a `z.object({...}).strict()`: Zod strips unknown keys, which is what
 * lets a turn saved before a block existed still parse. A block dropped from
 * the set later is refused at the runner by `applyV2TemplateBlocks`, with the
 * version named - the right place for that refusal, because only the runner
 * knows which version the turn resolved.
 */
export const TemplateBlocksSchema = z.object({
  frame: z.string().max(200_000).optional(),
  houseSections: z.string().max(200_000).optional(),
  houseSectionsBriefed: z.string().max(200_000).optional(),
  guestState: z.string().max(200_000).optional(),
  outreachNote: z.string().max(200_000).optional(),
  outreachCue: z.string().max(2_000).optional(),
})

export const SavedTurnOverridesSchema = z.object({
  stateKey: z.string().optional(),
  mission: z.string().optional(),
  guestProfileText: z.string().optional(),
  interactionMemoryText: z.string().optional(),
  openMovesText: z.string().optional(),
  knowledgeBriefText: z.string().optional(),
  // Only reaches the prompt on an archived template version that retrieves.
  knowledgeText: z.string().optional(),
  // A key of V2_TEMPLATE_SETS. Not a z.enum over the registry: a conversation
  // saved on a version later dropped from the archive must still parse, and
  // `resolveV2TemplateSet` fails open to the current template with a warning.
  // A hard enum here would reject the whole saved turn over a fixture.
  templateVersion: z.string().max(40).optional(),
  templateBlocks: TemplateBlocksSchema.optional(),
  voicePackText: z.string().optional(),
  venueProfileText: z.string().optional(),
  // Hand-edited SYSTEM blocks, replaced by label. Capped at the order of the
  // thing they replace: Le Mil's THE HOUSE block is ~22k chars with the
  // knowledge brief in it, so 200k per block leaves room to paste a bigger one
  // in without the field being a way to post a megabyte. 8 blocks against the
  // composer's 3, so a template can grow without this becoming the limit.
  promptBlocks: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        text: z.string().max(200_000),
      }),
    )
    .max(8)
    .optional(),
  modelKey: z.enum(V2_MODEL_KEYS).optional(),
  // Includes 'none', which is not a level: it means send no effort, which is
  // what every measurement taken before V2_DEFAULT_EFFORT existed did.
  effort: z.enum(V2_EFFORT_REQUESTS).optional(),
  // Bounded at BOTH ends, and the floor is not decoration: a 0 or a 1 here
  // generates nothing and reads as the model failing.
  maxOutputTokens: z
    .number()
    .int()
    .min(100)
    .max(V2_PLAYGROUND_MAX_OUTPUT_TOKENS)
    .optional(),
})

/**
 * What the guest sent BESIDES words, stated rather than stored - the wire
 * shape of `DeclaredTurnMedia` (lib/relationship/turn-media.ts).
 *
 * ONE DEFINITION, imported by the run route and by a saved turn, because the
 * two have to agree: a conversation that replays differently than it ran is
 * the thing this file exists to prevent, and media is the input most likely
 * to drift (links came first, the uploaded-photo fields second).
 *
 * `description` and `nameableItems` are what the DESCRIBE step produced, not
 * what the image is: the generator is never shown a picture (owner-ruled
 * 2026-10-11, lib/ai/CLAUDE.md), so the description is the entire record of
 * the photo as far as any prompt is concerned. That is also why a saved
 * conversation needs no image to restore faithfully.
 *
 * REQUIRES A LINK OR A KIND. `declaredTurnMedia` derives the kind from a
 * link's extension when none is stated, so a media object with neither
 * describes nothing - the turn would claim an attachment of no sort at all.
 */
export const DeclaredMediaSchema = z
  .object({
    /** Links, read for their extension only, exactly as production reads one with no row behind it. */
    mediaUrls: z.array(z.string().url()).max(10).optional(),
    /** Stated outright, where an uploaded file or an Instagram link has no usable extension. */
    kind: z
      .enum(['photo', 'gif', 'video', 'voice_note', 'other', 'unknown'])
      .optional(),
    /** As if the describe step had run and written this. Bounded well past the 200-char cut. */
    description: z.string().max(400).optional(),
    /** The menu items that description permits naming, in the menu's own spelling. */
    nameableItems: z.array(z.string().min(1)).max(10).optional(),
    /** The guest is replying to one of the venue's stories. */
    storyReply: z.boolean().optional(),
  })
  .refine(
    (m) => (m.mediaUrls?.length ?? 0) > 0 || m.kind !== undefined,
    'media needs a link or a stated kind - otherwise there is no attachment to describe',
  )
export type DeclaredMediaInput = z.infer<typeof DeclaredMediaSchema>

export const PlaygroundConversationTurnSchema = z
  .object({
    /** The guest's message(s) for this turn, oldest first. EMPTY only on an outreach or media turn. */
    inbound: z.array(z.string().min(1)).max(10),
    /**
     * What the guest sent besides words. The second legal empty-inbound shape:
     * a photo with no caption, which is how every one of the pilot venue's 120
     * attachments arrived.
     */
    media: DeclaredMediaSchema.optional(),
    /**
     * Set when this turn was the venue writing first (v2.21.0). Mirrors
     * `RunRequestBody.outreach`, bounds matching the run route's; the marker
     * line re-renders from it on restore.
     */
    outreach: z.object({ hoursQuiet: z.number().min(1).max(336) }).optional(),
    /**
     * The session this turn ran with. ABSENT ON THE FIRST TURN and that is
     * correct, not a gap: the sandbox's opening send carries no session, so the
     * engine enters at the graph's own initial state. Storing a fabricated
     * empty session here would make turn 1 rerun differently than it ran.
     */
    session: SavedPlaygroundSessionSchema.optional(),
    overrides: SavedTurnOverridesSchema.optional(),
    /**
     * The bubbles v2 replied with. EMPTY when the run failed or generation
     * failed - a turn that produced nothing is saved as having produced
     * nothing, and renders as the failure it was rather than as silence.
     */
    reply: z.array(z.string()).max(10),
    /** The gate verdict, for the "gate: queue" strip. Null when the run never reached the gate. */
    verdict: z.enum(['send', 'queue', 'block']).nullable(),
  })
  .superRefine((turn, ctx) => {
    // Same invariants as the run route, and they have to stay the same: a
    // turn the route accepted must save, and a saved turn must re-run. TWO
    // legal empty-inbound shapes, disjoint - an outreach turn (no inbound
    // event at all) and a media turn (a photo with no caption). A save
    // predating v2.21.0 has inbound ≥ 1 and neither key, so it parses
    // unchanged.
    if (
      turn.outreach === undefined &&
      turn.media === undefined &&
      turn.inbound.length === 0
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'inbound may be empty only on an outreach turn or a media turn',
      })
    if (turn.outreach !== undefined && turn.inbound.length > 0)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'an outreach turn carries no inbound - it is the venue writing first',
      })
    // Media rides an inbound event; an outreach turn has none to carry it.
    if (turn.outreach !== undefined && turn.media !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'an outreach turn has no inbound event, so it cannot carry the guest’s media',
      })
  })
export type PlaygroundConversationTurn = z.infer<
  typeof PlaygroundConversationTurnSchema
>

/** The whole `turns` column. Capped so one save cannot become unbounded JSONB. */
export const PlaygroundConversationTurnsSchema = z
  .array(PlaygroundConversationTurnSchema)
  .min(1)
  .max(100)

/**
 * `next_session`: the session a new message typed into the restored
 * conversation would run with - what the last turn's assessor handed back.
 *
 * Nullable, and null is a real answer rather than a gap: a conversation whose
 * every run failed produced no session, and restores to the same "no session"
 * a fresh chat starts from. The parse fails OPEN to null for the live-boundary
 * reason - a malformed snapshot should cost the continuation state, not the
 * whole saved conversation.
 */
export const PlaygroundNextSessionSchema =
  SavedPlaygroundSessionSchema.nullable()

export function parsePlaygroundNextSession(
  value: unknown,
): z.infer<typeof SavedPlaygroundSessionSchema> | null {
  if (value === null || value === undefined) return null
  const parsed = SavedPlaygroundSessionSchema.safeParse(value)
  if (parsed.success) return parsed.data
  console.warn('[playground] malformed next_session, restoring without it')
  return null
}

export const PLAYGROUND_CONVERSATION_NAME_MAX = 120
