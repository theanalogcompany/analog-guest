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
  'boundary',
  'complaint',
] as const
export type GoldenGroup = (typeof GOLDEN_GROUPS)[number]

export const GoldenQuestionSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'kebab-case keys only'),
  group: z.enum(GOLDEN_GROUPS),
  /** The guest's message, verbatim. One turn: every question is a cold open. */
  question: z.string().min(1),
})
export type GoldenQuestion = z.infer<typeof GoldenQuestionSchema>

/**
 * An arm that did not produce a reply. One shape for both arms: a named stage
 * so "v1 errored here" never renders as "v1 said nothing", the message, and
 * how long it took before failing.
 */
const ArmFailureSchema = z.object({
  ok: z.literal(false),
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
    substitute: z
      .enum(['crisis_safety', 'media_only_card', 'opt_out_confirmation'])
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
