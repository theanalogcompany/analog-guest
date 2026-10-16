// Zod schemas for the regression tables' JSONB fields (migration 069).
// Read regression_run_units.* through these, never raw SQL paths. NOT
// LLM-output schemas - .min()/.max() are fine.
//
// RegressionScenarioSchema no longer parses database rows: scenario
// definitions are a code literal in lib/eval/regression-scenarios.ts, and
// `regression_scenarios` is an enabled-only overlay (migration 077, decision
// 0011). It stays here as the shape `RegressionScenario` is inferred from,
// and `validateScenarioSet` runs it over that array at harness startup to
// catch what tsc cannot - a bad key, an empty script, a ninth turn. Do not
// go looking for a row parse; there is deliberately none.

import { z } from 'zod'

export const RegressionScenarioSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'kebab-case keys only'),
  /** Why this scenario exists - the lesson it guards, human-readable. */
  lesson: z.string().min(1),
  /** The guest's messages, oldest first; one runTurn per entry. */
  script: z.array(z.string().min(1)).min(1).max(8),
  /** Bar: assessor moveKey tags that count as pursuit. Empty = no move bar. */
  target: z.array(z.string().min(1)).default([]),
  /** Bar: the assessor must have captured this first_name by the final turn. */
  expectFirstName: z.string().nullable().default(null),
  /** Ceiling: the FIRST reply must not carry a learn_name tag. */
  noTurnOneNameAsk: z.boolean().default(false),
  /**
   * Bar: some reply bubble must contain this substring (case-insensitive).
   * Exists so a gate assertion cannot pass vacuously: a sample whose reply
   * never mentions the thing under test tested nothing (harness convention
   * #9 - state when an arm cannot differ, void rather than read).
   */
  expectReplyContains: z.string().nullable().default(null),
  /** Ceiling: the policy gate must not match any of these policy keys. */
  forbidPolicyKeys: z.array(z.string().min(1)).default([]),
  /**
   * Bar: the policy gate must match at least one of these keys on some turn.
   * The mirror of forbidPolicyKeys, and the non-vacuity guard to prefer over
   * expectReplyContains whenever the thing under test is "was this turn
   * recognised as X" rather than "did the reply contain a specific fact".
   * A gate key is a discrete tag the policy registry owns, so unlike a word
   * it cannot be paraphrased away by a correct reply or produced by a model
   * being agreeable (scripts/CLAUDE.md #7).
   */
  expectPolicyKeys: z.array(z.string().min(1)).default([]),
  /**
   * What the guest sent BESIDES words, stated rather than stored - the sandbox
   * guest these scenarios run as has no rows for the media lane to read
   * (`declaredTurnMedia`, lib/relationship/turn-media.ts).
   *
   * `arrival` is the two shapes a photo actually arrives in, and they are
   * different turns rather than a flag on one:
   *   `with-text`  it rides the LAST scripted message - the guest typed and
   *                attached in one go.
   *   `alone`      an EXTRA final turn with no words at all, which is how
   *                every one of Le Mil's 120 attachments arrived.
   *
   * It is a field here and not an extra `script` entry because a script entry
   * is a non-empty string by construction, and a media-only turn has no
   * string. Loosening that would let an empty inbound into every scenario.
   */
  media: z
    .object({
      mediaUrls: z.array(z.string().url()).min(1).optional(),
      kind: z
        .enum(['photo', 'gif', 'video', 'voice_note', 'other', 'unknown'])
        .optional(),
      /** As if the describe step had run and written this. */
      description: z.string().min(1).optional(),
      nameableItems: z.array(z.string().min(1)).default([]),
      storyReply: z.boolean().default(false),
      arrival: z.enum(['with-text', 'alone']).default('with-text'),
    })
    .optional(),
  /**
   * Ceiling: no reply may quote a price or name a charge (v2.23.0).
   *
   * Set it on a scenario whose script asks nothing about cost. The detector is
   * `mentionsPrice` in `lib/eval/price-detector.ts` - the SAME function
   * `scripts/measurement/price-discretion.ts` scores its rate with, so the
   * harness that tuned the copy and the ceiling that protects it cannot
   * disagree about what a volunteered price is.
   *
   * A CEILING AND NOT A BAR, even though the measurement behind it is a rate.
   * The rate exists to compare arms across eight questions; here the question
   * is only "did this come back", and the measured rate after the fix is 0/80.
   * Any hit is therefore news, not noise.
   *
   * NOT A GLOBAL TELL, deliberately, which is the one thing to get right if
   * this is ever widened: a reply quoting a price is CORRECT whenever the
   * guest asked what something costs, so a tell in `EMITTED_TELLS` would
   * breach every scenario that answers a price question properly.
   */
  forbidVolunteeredPrice: z.boolean().default(false),
  /**
   * Ceiling: the final turn must send NOTHING - no bubbles at all.
   *
   * The only guard that can express v2.20.0's opt-out rule, because every
   * other one here reads the text of a reply and the correct reply has no
   * text. A tell cannot do it either: tells match substrings in bubbles, and
   * what is forbidden here is a bubble of ANY content.
   *
   * A CEILING, not a bar, and it is checked before the bars for the usual
   * reason - whatever the model said instead, it said it to a guest who asked
   * to be left alone, and that is not a rate.
   */
  expectEmptyReply: z.boolean().default(false),
  enabled: z.boolean().default(true),
})
export type RegressionScenario = z.infer<typeof RegressionScenarioSchema>

export const RegressionBreachSchema = z.object({
  tell: z.string(),
  sample: z.number(),
  turn: z.number(),
  bubble: z.string(),
  /** voice_corpus row ids whose text shares a window with the bubble. */
  attributedTo: z.array(z.string()),
})
export type RegressionBreach = z.infer<typeof RegressionBreachSchema>

export const RegressionTurnSchema = z.object({
  inbound: z.string(),
  reply: z.array(z.string()),
  tagged: z.array(z.string()),
  /** Policy keys the gate matched on this turn. Default covers units stored before 070. */
  gateMatched: z.array(z.string()).default([]),
})

export const RegressionSampleSchema = z.object({
  disqualified: z.string().nullable(),
  pursued: z.boolean(),
  firstName: z.string().nullable(),
  turnOneNameAsk: z.boolean(),
  breaches: z.array(RegressionBreachSchema),
  /** Per-turn judge scores, tested axes only. */
  judgeScores: z.array(z.record(z.string(), z.number())),
  judgeFailures: z.number(),
  turns: z.array(RegressionTurnSchema),
})
export type RegressionSample = z.infer<typeof RegressionSampleSchema>

/** regression_runs.verdicts - scenario key to its stored verdict line. */
export const RegressionVerdictsSchema = z.record(z.string(), z.string())
