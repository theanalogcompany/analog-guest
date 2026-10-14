// The blind human evaluation: what the rater is asked, and how an answer
// about A and B becomes an answer about v1 and v2.
//
// THE RATER NEVER JUDGES "v1" OR "v2". They judge A and B, in a per-question
// random order, with nothing on screen saying which engine wrote which. So
// that is what is stored (migration 083) - a_verdict, b_verdict, a preference
// over A and B - and this module is the ONE place that reads it back the other
// way. Two copies of that mapping is two chances for the page and the CSV to
// disagree about which engine won a row, which would be a disagreement about
// the only output this surface has.
//
// Pure: no DB, no SDK, no clock. The page, the write routes and the export all
// import from here.

import { z } from 'zod'
import { GOLDEN_QUESTIONS } from '@/lib/eval/golden-set'
import { goldenTurnFor } from '@/lib/eval/golden-turn'
import type { GoldenQuestion } from '@/lib/schemas/golden'

/** Which engine was shown in a column. */
export const HUMAN_EVAL_ARMS = ['v1', 'v2'] as const
export type HumanEvalArm = (typeof HUMAN_EVAL_ARMS)[number]

/**
 * One reply's verdict. TWO VALUES AND NO THIRD: a reply the rater has not
 * looked at yet is `null` - absent - rather than a "skip" verdict, because an
 * unjudged row must not be countable as either outcome.
 */
export const HumanEvalVerdictSchema = z.enum(['pass', 'fail'])
export type HumanEvalVerdict = z.infer<typeof HumanEvalVerdictSchema>

/**
 * Which reply was better. `neither` is a real answer - both bad, or genuinely
 * level - and is distinct from null, which is "not answered".
 */
export const HumanEvalPreferenceSchema = z.enum(['a', 'b', 'neither'])
export type HumanEvalPreference = z.infer<typeof HumanEvalPreferenceSchema>

/**
 * Is there anything to adjudicate on this row?
 *
 * ONE DEFINITION, read by the form (which shows the preference control) and by
 * the write schema (which refuses a preference without one). Two copies would
 * let the UI collect an answer the route then silently dropped.
 *
 * With both replies passing there is nothing to pick between for the purposes
 * of this pass - the question being answered is "did v2 regress", and two
 * acceptable replies are not a regression (owner-ruled). A free-text note is
 * still allowed on such a row, because "both fine, B reads better" is worth
 * recording and costs nothing.
 */
export function needsPreference(
  aVerdict: HumanEvalVerdict | null,
  bVerdict: HumanEvalVerdict | null,
): boolean {
  return aVerdict === 'fail' || bVerdict === 'fail'
}

/**
 * One row's judgment, as the rater gave it. The WHOLE object goes over the
 * wire on every write - every field, including the nulls - rather than a patch
 * of what changed: the admin write boundary validates whole objects
 * (app/admin/CLAUDE.md), and a per-field patch here would let a flipped
 * verdict leave behind a preference that no longer has anything to adjudicate.
 */
export const HumanEvalJudgmentSchema = z
  .object({
    aVerdict: HumanEvalVerdictSchema.nullable(),
    bVerdict: HumanEvalVerdictSchema.nullable(),
    preference: HumanEvalPreferenceSchema.nullable(),
    /**
     * Why. The most valuable field here: a pass rate says v2 regressed, this
     * says what about it did. Capped because it is free text arriving from a
     * browser, generously because it is the column someone will paste a
     * paragraph into.
     */
    note: z.string().max(4000),
    /**
     * The rater asked to see which engine wrote which. One-way: the server
     * stamps `revealed_at` once and never clears it, so `false` on a later
     * write cannot un-reveal a row and make a late verdict look blind.
     */
    revealed: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (
      value.preference !== null &&
      !needsPreference(value.aVerdict, value.bVerdict)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preference'],
        message:
          'a preference is only asked for when a reply has failed - send null when both pass',
      })
  })
export type HumanEvalJudgment = z.infer<typeof HumanEvalJudgmentSchema>

/**
 * The judgment a stored row represents - the inverse of writing one.
 *
 * ONE DEFINITION, because the surface needs to layer an unsaved click over a
 * stored row and then send the whole object: building that starting point by
 * hand at each call site is how a field gets forgotten and silently reverts to
 * null on the next write.
 */
export function judgmentFromUnit(unit: {
  aVerdict: HumanEvalVerdict | null
  bVerdict: HumanEvalVerdict | null
  preference: HumanEvalPreference | null
  note: string
  revealedAt: string | null
}): HumanEvalJudgment {
  return {
    aVerdict: unit.aVerdict,
    bVerdict: unit.bVerdict,
    preference: unit.preference,
    note: unit.note,
    revealed: unit.revealedAt !== null,
  }
}

/**
 * The questions a blind pass can use: the ones BOTH engines can be asked.
 *
 * `goldenTurnFor` is the authority, the same function the measurement harness
 * and the prompt lab ask - so this queue cannot drift from what v2 is actually
 * capable of being handed. A scenario only one engine can answer has no pair
 * to scramble: showing it would put a reply in column A and a labelled gap in
 * column B, which identifies the arm and is not a comparison.
 */
export function humanEvalQuestions(
  questions: readonly GoldenQuestion[] = GOLDEN_QUESTIONS,
): GoldenQuestion[] {
  return questions.filter((q) => goldenTurnFor(q).skip === null)
}

/**
 * The scenarios a blind pass leaves out, and why - the exact complement of
 * `humanEvalQuestions`.
 *
 * RENDERED BY THE PAGE, never silently dropped. A pass over 58 of the set's 62
 * scenarios presented as "the golden set" reads as complete coverage, which is
 * the false-absolute-claim failure the admin loaders are warned about.
 */
export function humanEvalExcluded(
  questions: readonly GoldenQuestion[] = GOLDEN_QUESTIONS,
): Array<{ key: string; question: string; reason: string }> {
  return questions.flatMap((q) => {
    const { skip } = goldenTurnFor(q)
    if (skip === null) return []
    return [
      {
        key: q.key,
        question: q.question,
        reason: `${skip.stage}: ${skip.error}`,
      },
    ]
  })
}

/**
 * The judgment as a statement about the engines.
 *
 * `better` is 'v1' | 'v2' | 'neither' | null, where null means the question
 * was not asked (both replies passed) or not answered yet. The caller must not
 * collapse those two into "no preference" - one is a row where there was
 * nothing to adjudicate, the other is an incomplete row.
 */
export function unblind(unit: {
  aArm: HumanEvalArm
  aVerdict: HumanEvalVerdict | null
  bVerdict: HumanEvalVerdict | null
  preference: HumanEvalPreference | null
}): {
  v1Verdict: HumanEvalVerdict | null
  v2Verdict: HumanEvalVerdict | null
  better: HumanEvalArm | 'neither' | null
} {
  const aIsV1 = unit.aArm === 'v1'
  return {
    v1Verdict: aIsV1 ? unit.aVerdict : unit.bVerdict,
    v2Verdict: aIsV1 ? unit.bVerdict : unit.aVerdict,
    better:
      unit.preference === null
        ? null
        : unit.preference === 'neither'
          ? 'neither'
          : unit.preference === 'a'
            ? unit.aArm
            : aIsV1
              ? 'v2'
              : 'v1',
  }
}
