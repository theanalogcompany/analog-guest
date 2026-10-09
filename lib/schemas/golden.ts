// Zod schemas for the golden set: the question shape (validated as a
// hand-edited code literal, not read from anywhere) and the two result
// columns' JSONB (migration 078). Read `golden_run_units.v1` / `.v2` through
// these, never raw SQL paths.
//
// NOT LLM-output schemas - .min()/.max() are fine here.
//
// A question's DEFINITION is code (lib/eval/golden-set.ts, decision 0011's
// direction): no table carries it, so there is no stored row to validate and
// no overlay to merge. These schemas exist for the opposite reason - to check
// the code literal against itself, and to parse run results back out of the
// database for /admin/tests/golden.

import { z } from 'zod'

/**
 * Display buckets, in the order the page and the export render them. A group
 * is presentation only: nothing branches on it, and no question's handling
 * depends on which bucket it sits in.
 */
export const GOLDEN_GROUPS = [
  'logistics',
  'menu',
  'dietary',
  'recommend',
  'origin',
  'beans',
  'returning',
  'ops',
  'boundary',
  'complaint',
  'safety',
  'identity',
  'adversarial',
  'press',
  'handling',
  'proactive',
  'arrival',
] as const
export type GoldenGroup = (typeof GOLDEN_GROUPS)[number]

/**
 * What drives a scenario. `inbound` is the only one the harness runs.
 *
 * The rest are real production paths with NO read-only test entry: only
 * `runInboundTurn` has a test sink (`draftInboundReply`), so a proactive
 * follow-up, a scan greeting, a media-only turn and a held-draft timeout
 * cannot be drafted without new test-mode plumbing in paths that do not have
 * it - which is `lib/agent/` runtime work, not a harness change. They are in
 * the set, named and explained, because a gap you can see is worth more than
 * a set that looks complete.
 */
export const GOLDEN_DRIVERS = [
  'inbound',
  'proactive',
  'scan_arrival',
  'media',
  'held_draft_expiry',
] as const
export type GoldenDriver = (typeof GOLDEN_DRIVERS)[number]

/** One prior turn. `assistant` is us - the venue, or a staff member by hand. */
export const GoldenHistoryTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1),
})

export const GoldenQuestionSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'kebab-case keys only'),
  group: z.enum(GOLDEN_GROUPS),
  /** The guest's message this turn, verbatim. */
  question: z.string().min(1),
  /**
   * What the guest said this turn, when it is a BURST rather than one
   * message. Omit for the ordinary single-message case; `question` is then
   * the whole turn. When present it replaces `question` as the turn's
   * messages and `question` is the display label.
   *
   * `messages: []` means the guest sent NO TEXT this turn, which is only
   * meaningful alongside `mediaUrls` - a photo and nothing else. The
   * validator refuses an empty turn with no media, because that is an
   * inbound with nothing in it.
   */
  messages: z.array(z.string().min(1)).max(5).optional(),
  /**
   * Attachment links on the guest's LAST message this turn. Omit for text.
   *
   * WHAT THE SYSTEM ACTUALLY DOES WITH THESE, because the gap between the
   * scenario you want to write and the turn the agent sees is wide here:
   *
   *   - No model looks at the image. `mediaKindFromUrls` reads the file
   *     extension off the link and nothing else, so what the picture shows
   *     is irrelevant - only `.jpg` vs `.m4a` vs no extension changes the
   *     turn.
   *   - ONE kind per message. A message carrying a photo and a voice memo
   *     resolves to 'photo'; there is no "and also" to test.
   *   - These attach to an EXTRA, FINAL, BODYLESS message on the turn - the
   *     shape both webhooks actually store. With `messages: []` that bodyless
   *     message is the whole turn (media-only, raises a blank operator card).
   *     With text in `messages` it is the photo-last case, which does
   *     generate.
   *
   * v2 IS NOT RUN on a scenario carrying these. It has no media input at
   * all - nothing in `run-turn.ts` or the v2 composer takes one - so an
   * answer from it would be an answer to a turn that never mentioned a
   * photo, which is worse than no answer.
   */
  mediaUrls: z.array(z.string().url()).min(1).optional(),
  /**
   * The conversation before this turn, oldest first. Omit for a cold open.
   *
   * BOTH ARMS SEE THIS IDENTICALLY, which is the point: the v1 arm
   * materializes it as `messages` rows so v1 builds context from the database
   * the way production does, and v2 gets the same text as `sessionHistory`.
   * Nothing about the guest is declared anywhere else - no seeded visits, no
   * invented profile - so a scenario that needs a past order carries it as
   * something the guest actually said.
   */
  history: z.array(GoldenHistoryTurnSchema).max(12).optional(),
  driver: z.enum(GOLDEN_DRIVERS).default('inbound'),
  /**
   * Which follow-up trigger drives this scenario. Required when `driver` is
   * `proactive`, meaningless otherwise - the validator enforces both.
   *
   * It is the trigger the scenario rides IN PRODUCTION, not the nearest one
   * that happens to run in the sandbox. Four of these are Instagram-only
   * (`handle-followup.ts` refuses them on a text conversation by name), so
   * a scenario naming one also needs `channel: 'instagram'`.
   */
  followupTrigger: z
    .enum([
      'day_1',
      'day_3',
      'day_7',
      'day_14',
      'cold_lapsed',
      'perk_unlock',
      'event',
      'manual',
      'instagram_scan_arrival',
      'warm_close',
      'inquiry_followup',
      'visit_checkback',
    ])
    .optional(),
  /**
   * The conversation this scenario happens on. Defaults to text.
   *
   * Not cosmetic: `conversationChannel` decides which follow-up triggers are
   * allowed at all, and the channel is resolved from the last inbound row's
   * own `channel` column, so this changes what the materialized transcript
   * is written as.
   */
  channel: z.enum(['text', 'instagram']).optional(),
  /** Required when driver is not `inbound`: why it cannot be run yet. */
  notAutomated: z.string().optional(),
})
/**
 * The AUTHORING type - `z.input`, not `z.infer`.
 *
 * `driver` carries a Zod default, which makes it REQUIRED in the output type:
 * every one of the 66 literals would have to spell out `driver: 'inbound'`,
 * and the one value that matters would be lost in the noise. The input type
 * leaves it optional, and every reader resolves it the same way -
 * `q.driver ?? 'inbound'` - with `runnableGoldenQuestions` as the one place
 * that decides what runs.
 */
export type GoldenQuestion = z.input<typeof GoldenQuestionSchema>

/**
 * An arm that did not produce a reply. One shape for both arms: a named stage
 * so "v1 errored here" never renders as "v1 said nothing", the message, and
 * how long it took before failing.
 *
 * `kind` separates the two ways that happens, because they are opposite
 * findings and a reader must not have to guess which one a blank column is:
 * `error` is the engine breaking on something it is supposed to handle,
 * `not_run` is the harness declining to ask because the engine has no such
 * capability (v2 and media). Defaulted to `error` so every row stored before
 * this field existed keeps its original meaning.
 *
 * It is NOT a new member of the union. `ok: false` stays the only
 * discriminator, so every `if (!column.ok)` in the app keeps working - a
 * third `ok` value would have been truthy and broken all of them silently.
 */
const ArmFailureSchema = z.object({
  ok: z.literal(false),
  kind: z.enum(['error', 'not_run']).default('error'),
  stage: z.string(),
  error: z.string(),
  durationMs: z.number(),
})

/**
 * The v1 column.
 *
 * `substitute` is carried rather than collapsed into an empty reply: "v1 would
 * have sent this fixed crisis text" and "v1 would have sent nothing and
 * carded it" are different answers, and a comparison surface rendering both as
 * silence is lying about one of them (the reasoning is TestDraft's own, in
 * lib/agent/handle-inbound.ts - this mirrors it rather than restating it).
 *
 * `bubbles` ARE REAL BOUNDARIES, BUT THE COUNT IS NOT COMPARABLE TO v2's.
 * The v1 test path pins the probabilistic sentence split off
 * (TEST_RUN_SPLIT_RNG = 0.99 against SPLIT_PROBABILITY = 0.5), so a v1 reply
 * splits only where a tail earns its own bubble structurally - the
 * further-help offer, the getting-to-know-you question. Store what it said;
 * never report the count as a difference between the engines.
 */
export const GoldenV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    bubbles: z.array(z.string()),
    category: z.string(),
    recognitionState: z.string(),
    // Mirrors TestDraft['substitute']. `no_reply_needed` arrived with
    // pure-close.ts (ruled 2026-10-07): a bare "ok" or "thanks" at a venue
    // whose own team mostly left those alone gets NO reply at all. On this
    // set that is a real answer rather than a failure, and the one the
    // "Loved it, thank you!" shape will land on - so it renders as a labelled
    // outcome, never as an empty column.
    substitute: z
      .enum([
        'crisis_safety',
        'media_only_card',
        'opt_out_confirmation',
        'no_reply_needed',
      ])
      .nullable(),
    promptVersion: z.string(),
    durationMs: z.number(),
  }),
  ArmFailureSchema,
])
export type GoldenV1 = z.infer<typeof GoldenV1Schema>

/**
 * The v2 column. `gateVerdict` has no v1 counterpart - the v1 test path stops
 * before the approval triggers and the four post-generation checks - so it is
 * recorded and rendered for v2 alone and never as a comparison.
 */
export const GoldenV2Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    messages: z.array(z.string()),
    stateKey: z.string(),
    /** null when generation failed before the gate ran. */
    gateVerdict: z.enum(['send', 'queue', 'block']).nullable(),
    gateMatched: z.array(z.string()),
    promptVersion: z.string(),
    durationMs: z.number(),
  }),
  ArmFailureSchema,
])
export type GoldenV2 = z.infer<typeof GoldenV2Schema>
