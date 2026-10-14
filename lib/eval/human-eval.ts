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
// THE PAGE NEVER UNBLINDS A ROW. There is no reveal: `unblind` is called by
// the CSV export and by nothing the rater can see, so "the verdicts in this
// pass were given blind" is a property of what the surface is able to render
// rather than a claim about how it was used. The earlier version offered a
// Reveal button gated on both verdicts plus a `revealed_at` stamp to audit it
// after the fact; not being able to unblind at all is the stronger guarantee
// and needs no audit column. `human_eval_units.revealed_at` survives in the
// schema carrying old passes' stamps and has no reader.
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
 * Is this row finished?
 *
 * BOTH VERDICTS, AND A COMMENT ONCE EITHER ONE FAILS. A fail is the only
 * output of this pass that costs anything to act on - "v2 regressed on 4 of
 * 58" is a number, and what regressed is the finding - so a failing row with
 * an empty `why` is a row that recorded the cheap half and threw away the
 * expensive one.
 *
 * NOT ENFORCED BY THE WRITE SCHEMA, deliberately. Every write carries the
 * whole judgment, so the click that marks A `fail` necessarily arrives with
 * an empty note; rejecting it at the route would mean the first click of a
 * failing row could not be saved at all, and a verdict that would not persist
 * is the one failure this surface cannot absorb. The row saves, renders as
 * incomplete, and the session bar counts how many still owe a comment.
 *
 * ENFORCED AT SUBMIT, which is where a rule like this can be enforced without
 * costing anyone a keystroke: `humanEvalCompleteness` below reads this per
 * row, the submit route refuses the pass on it, and an unsubmitted pass has
 * no CSV. So the requirement is not a message the rater can ignore.
 */
export function judgmentComplete(judgment: HumanEvalJudgment): boolean {
  if (judgment.aVerdict === null || judgment.bVerdict === null) return false
  if (!needsPreference(judgment.aVerdict, judgment.bVerdict)) return true
  return judgment.note.trim().length > 0
}

/**
 * What is in the way, in words, worst first.
 *
 * ONE WORDING for the disabled button and for the route's refusal, so a rater
 * who somehow reaches the route reads the sentence the button was already
 * showing them. Empty array means the pass is submittable.
 *
 * `broken` is not here: it blocks nothing, and listing it under "what is in
 * the way" would read as something the rater could fix by judging harder.
 */
export function humanEvalBlockers(
  completeness: HumanEvalCompleteness,
): string[] {
  const blockers: string[] = []
  if (completeness.ungenerated > 0)
    blockers.push(`${completeness.ungenerated} not generated`)
  if (completeness.unjudged > 0)
    blockers.push(`${completeness.unjudged} unjudged`)
  if (completeness.needComment > 0)
    blockers.push(`${completeness.needComment} need a comment`)
  return blockers
}

/**
 * Is there a pair here to judge at all?
 *
 * A row where either engine produced nothing is NOT judgeable: there is no
 * comparison, and a verdict on an error message is not a verdict on a reply.
 * The page withholds the form on one, and `humanEvalCompleteness` counts them
 * apart rather than demanding a verdict nobody could honestly give - a gate
 * nothing can satisfy is a gate that gets removed.
 *
 * Takes the parsed columns, so a row that would not parse (`null`) is not
 * judgeable either: what is on screen there is a parse error, not a reply.
 */
export function isUnitJudgeable(unit: {
  v1: { ok: boolean } | null
  v2: { ok: boolean } | null
}): boolean {
  return unit.v1 !== null && unit.v2 !== null && unit.v1.ok && unit.v2.ok
}

/** What is still in the way of submitting a pass. All four are counts. */
export interface HumanEvalCompleteness {
  /** Judgeable questions with no pair stored yet. */
  ungenerated: number
  /** Judgeable rows missing a verdict on one or both replies. */
  unjudged: number
  /** Judged rows where something failed and nothing was written down. */
  needComment: number
  /** Rows where an engine produced nothing. Reported, never blocking. */
  broken: number
  complete: boolean
}

/**
 * Can this pass be submitted, and if not, what is missing?
 *
 * ONE DEFINITION, read by the Submit button's label and by the submit route
 * that refuses the pass. Two copies would let the button say "ready" about a
 * pass the route then rejected - or worse, agree while counting different
 * things, which is the version nobody notices.
 *
 * EVERY JUDGEABLE QUESTION MUST BE GENERATED. A pass over 40 of the set's 58
 * is not the golden set, and a CSV of 40 rows named after the pass reads as
 * one (the same false-absolute-claim failure the admin loaders are warned
 * about). `ungenerated` is derived from the question count rather than from
 * the rows, because rows cannot report their own absence.
 *
 * ORPHANS COUNT. A row whose question was reworded since is still a reply a
 * human was shown and judged; dropping it from the gate would let a pass
 * submit with a verdict half-given on screen.
 */
export function humanEvalCompleteness(
  units: ReadonlyArray<{
    judgeable: boolean
    aVerdict: HumanEvalVerdict | null
    bVerdict: HumanEvalVerdict | null
    note: string
  }>,
  /** `humanEvalQuestions().length` - what a full pass covers. */
  judgeableQuestions: number,
  /** Rows stored against a question still in the set. Orphans excluded. */
  generatedInSet: number,
): HumanEvalCompleteness {
  let unjudged = 0
  let needComment = 0
  let broken = 0
  for (const unit of units) {
    if (!unit.judgeable) {
      broken += 1
      continue
    }
    const judgment = {
      aVerdict: unit.aVerdict,
      bVerdict: unit.bVerdict,
      preference: null,
      note: unit.note,
    }
    if (unit.aVerdict === null || unit.bVerdict === null) unjudged += 1
    else if (!judgmentComplete(judgment)) needComment += 1
  }
  const ungenerated = Math.max(0, judgeableQuestions - generatedInSet)
  return {
    ungenerated,
    unjudged,
    needComment,
    broken,
    complete: ungenerated === 0 && unjudged === 0 && needComment === 0,
  }
}

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
}): HumanEvalJudgment {
  return {
    aVerdict: unit.aVerdict,
    bVerdict: unit.bVerdict,
    preference: unit.preference,
    note: unit.note,
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
 *
 * AN OUTREACH TURN IS IN THE PASS. v2 composes one (v2.21.0) and v1 has its
 * own proactive path, so the pair exists - what was missing was the run route
 * carrying it, which it now does as `v1Arm: { mode: 'sandbox_followup' }`.
 * The one thing v1's arm needs that v2's does not is the TRIGGER, so a
 * proactive scenario without one still has no pair, and that is the only
 * reason left to drop one here (the set's own validator requires it, so this
 * guard should never fire - it is here because "should never" is what the
 * excluded list exists to make visible).
 */
export function humanEvalQuestions(
  questions: readonly GoldenQuestion[] = GOLDEN_QUESTIONS,
): GoldenQuestion[] {
  return questions.filter((q) => {
    const { turn, skip } = goldenTurnFor(q)
    if (skip !== null) return false
    return turn.outreach === undefined || q.followupTrigger !== undefined
  })
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
    const { turn, skip } = goldenTurnFor(q)
    if (skip !== null)
      return [
        {
          key: q.key,
          question: q.question,
          reason: `${skip.stage}: ${skip.error}`,
        },
      ]
    if (turn.outreach !== undefined && q.followupTrigger === undefined)
      return [
        {
          key: q.key,
          question: q.question,
          reason:
            'outreach turn with no follow-up trigger: v2 can write first off the history alone, v1 cannot - its proactive arm is driven by the trigger',
        },
      ]
    return []
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
