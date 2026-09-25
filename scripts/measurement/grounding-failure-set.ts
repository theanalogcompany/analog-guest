// TAC-501 follow-on: the grounding failure set.
//
// WHAT THIS IS FOR. The stated goal is to RETIRE the verifiers. A verifier can
// only be retired on evidence that the generator stopped needing it, which is
// a generation-side question: given this inbound and this venue context, does
// the model still produce the claim? A verifier-replay fixture
// (fixtures/prose-promise-replies.json) grades the CHECK against fixed bodies
// and structurally cannot answer that — it holds the body constant, which is
// exactly the variable under test here. Hence a separate set, not a second arm
// on the existing one.
//
// The cases are re-synthesised from production `verify_grounding` flags plus
// the TAC-501 fabrication. Surface detail is changed and the failure SHAPE is
// preserved, because this repo is public and no production message body may
// appear in it.
//
// This module is the schema and the loader only. It makes no model calls and
// has no I/O beyond reading its own fixture, so it is unit-testable and cheap
// to import from a runner, a report, or a test.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * The failure shapes, as a closed set.
 *
 * Closed on purpose. A free-text shape field would let the next case invent a
 * near-synonym of an existing shape, and the per-shape reproduction counts —
 * the thing that tells you WHICH failure a prompt change moved — would quietly
 * stop being comparable across runs. Adding a genuinely new shape should be a
 * deliberate edit here, visible in a diff.
 */
export const FAILURE_SHAPES = [
  'asserting_absence',
  'inferred_availability',
  'unsupported_commitment',
  'contradicts_explicit_policy',
  'unsupported_colour',
  'misread_guest_history',
  'fabricated_contact_detail',
  'verifier_false_positive',
] as const
export type FailureShape = (typeof FAILURE_SHAPES)[number]

export const GroundingFailureCaseSchema = z
  .object({
    id: z.string().regex(/^gf-\d{2}$/),
    shape: z.enum(FAILURE_SHAPES),
    category: z.string().min(1),
    inbound: z.string().min(1),
    /** What the venue context does and does not contain. The runner composes from this. */
    premise: z.string().min(1),
    /** What production actually produced, synthesised. Narrative only — never asserted against. */
    observed_claim: z.string().min(1),
    /**
     * Free-text claims a correct reply must not make, judged by MEANING.
     * Deliberately the same semantics as `ScenarioSchema.forbidden_claims` so a
     * case can be lifted into the owner-facing scenario sheet unchanged.
     */
    forbidden_claims: z.array(z.string()),
    expected_behavior: z.string().min(1),
    /**
     * What a CORRECT verifier says about the production body.
     *
     * 'clean' marks a negative control — the reply was right and the verifier
     * flagged it anyway. Keeping those in the set is load-bearing: a set made
     * only of cases where the verifier was correct would bias every
     * retire-the-verifier decision toward keeping it.
     */
    verdict_expected: z.enum(['flagged', 'clean']),
    note: z.string().optional(),
  })
  .strict()

export type GroundingFailureCase = z.infer<typeof GroundingFailureCaseSchema>

export const GroundingFailureSetSchema = z
  .object({
    source: z.string().min(1),
    note: z.string().min(1),
    purpose: z.string().min(1),
    runnerContract: z.record(z.string(), z.string()),
    shapes: z.record(z.string(), z.string()),
    cases: z.array(GroundingFailureCaseSchema).min(1),
  })
  .strict()

export type GroundingFailureSet = z.infer<typeof GroundingFailureSetSchema>

export const GROUNDING_FAILURE_SET_PATH = join(
  __dirname,
  'fixtures',
  'grounding-failures.json',
)

/** Parse and validate the fixture. Throws with Zod's path on any violation. */
export function loadGroundingFailureSet(
  path: string = GROUNDING_FAILURE_SET_PATH,
): GroundingFailureSet {
  return GroundingFailureSetSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
}

/**
 * Cases whose reproduction is what a fix has to move.
 *
 * The negative controls are excluded: a `clean` case reproducing is the set
 * working, not a failure, and folding the two into one number is how a
 * reproduction rate starts lying.
 */
export function reproducibleCases(set: GroundingFailureSet): GroundingFailureCase[] {
  return set.cases.filter((c) => c.verdict_expected === 'flagged')
}

/** Negative controls — the cases where the verifier, not the generator, was wrong. */
export function negativeControls(set: GroundingFailureSet): GroundingFailureCase[] {
  return set.cases.filter((c) => c.verdict_expected === 'clean')
}

/** Case counts per shape, for the per-shape reporting the runner contract requires. */
export function countByShape(cases: GroundingFailureCase[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const c of cases) counts[c.shape] = (counts[c.shape] ?? 0) + 1
  return counts
}
