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
