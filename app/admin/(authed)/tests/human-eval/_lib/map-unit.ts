import {
  GoldenV1Schema,
  GoldenV2Schema,
  type GoldenQuestion,
} from '@/lib/schemas/golden'
import {
  HumanEvalPreferenceSchema,
  HumanEvalVerdictSchema,
  type HumanEvalArm,
} from '@/lib/eval/human-eval'
import { GOLDEN_QUESTIONS } from '@/lib/eval/golden-set'
import type { HumanEvalUnitView } from './types'

// One `human_eval_units` row to the shape the page renders.
//
// SHARED BY THE LOADER AND EVERY WRITE ROUTE. The routes answer with the row
// they just wrote so the client re-renders from storage rather than from an
// optimistic guess, which means four call sites map this row - and four copies
// would be four chances for one of them to read a verdict column differently
// from the page that shows it.
//
// The two answer columns are read through their schemas and never through raw
// SQL paths (lib/schemas/golden.ts). A column that will not parse becomes
// `null` plus a `parseError` the page renders: a silently empty reply reads as
// "the engine said nothing", which is a different and false claim about a
// reply a human is about to judge.

const BY_KEY = new Map<string, GoldenQuestion>(
  GOLDEN_QUESTIONS.map((q) => [q.key, q]),
)

/** The row shape every caller selects. Structural, so the select is explicit. */
export interface HumanEvalUnitRow {
  id: string
  question_key: string
  a_arm: string
  v1: unknown
  v2: unknown
  a_verdict: string | null
  b_verdict: string | null
  preference: string | null
  note: string | null
  generated_at: string
  judged_at: string | null
  revealed_at: string | null
}

export function unitViewFromRow(row: HumanEvalUnitRow): HumanEvalUnitView {
  const v1 = GoldenV1Schema.safeParse(row.v1)
  const v2 = GoldenV2Schema.safeParse(row.v2)
  const aVerdict = HumanEvalVerdictSchema.safeParse(row.a_verdict)
  const bVerdict = HumanEvalVerdictSchema.safeParse(row.b_verdict)
  const preference = HumanEvalPreferenceSchema.safeParse(row.preference)
  return {
    id: row.id,
    questionKey: row.question_key,
    // Null is an ORPHAN: the question was reworded or removed after the pass.
    // Surfaced rather than dropped - the verdict was still given.
    question: BY_KEY.get(row.question_key) ?? null,
    // The CHECK constraint allows nothing else, so anything else is a row
    // written outside this code. 'v1' rather than a throw, with the mismatch
    // visible in `parseError` below.
    aArm: (row.a_arm === 'v1' || row.a_arm === 'v2'
      ? row.a_arm
      : 'v1') as HumanEvalArm,
    v1: v1.success ? v1.data : null,
    v2: v2.success ? v2.data : null,
    parseError:
      [
        v1.success ? null : `v1: ${v1.error.issues[0]?.message ?? 'invalid'}`,
        v2.success ? null : `v2: ${v2.error.issues[0]?.message ?? 'invalid'}`,
        row.a_arm === 'v1' || row.a_arm === 'v2'
          ? null
          : `a_arm: '${row.a_arm}' is not an arm - the A column is showing v1 as a fallback and the scramble for this row cannot be trusted`,
      ]
        .filter((s): s is string => s !== null)
        .join('; ') || null,
    aVerdict: aVerdict.success ? aVerdict.data : null,
    bVerdict: bVerdict.success ? bVerdict.data : null,
    preference: preference.success ? preference.data : null,
    note: row.note ?? '',
    generatedAt: row.generated_at,
    judgedAt: row.judged_at,
    revealedAt: row.revealed_at,
  }
}

/**
 * Rows in GOLDEN_QUESTIONS order, orphans last.
 *
 * Shared by the page loader and the CSV export so a pass reads down the file
 * the way it reads down the screen - a reader comparing the two should not
 * have to re-sort either.
 */
export function sortUnitsByQuestionOrder(
  units: readonly HumanEvalUnitView[],
): HumanEvalUnitView[] {
  const order = new Map(GOLDEN_QUESTIONS.map((q, i) => [q.key, i]))
  return [...units].sort(
    (a, b) =>
      (order.get(a.questionKey) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(b.questionKey) ?? Number.MAX_SAFE_INTEGER),
  )
}

/** The columns `unitViewFromRow` reads, for a `select()`. One definition. */
export const HUMAN_EVAL_UNIT_COLUMNS =
  'id, question_key, a_arm, v1, v2, a_verdict, b_verdict, preference, note, generated_at, judged_at, revealed_at'
