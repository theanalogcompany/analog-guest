// The blind human evaluation's CSV export: one row per judged question, with
// both the raw A/B record and its unblinded reading.
//
// BOTH, deliberately. `shown_as_a`, `a_verdict` and `b_verdict` are what the
// rater actually did, in the order they saw it - the primary record, and the
// only thing that can be audited for a scramble that was not random.
// `v1_verdict`, `v2_verdict` and `better` are that same answer read as a
// statement about the engines, which is what anyone analysing the file wants
// to pivot on. Deriving the second set here rather than leaving it to a
// spreadsheet formula means the one definition in `human-eval.ts` is what the
// file carries.
//
// NO `media` COLUMN, and that is not an omission: a scenario carrying an
// attachment is one only v1 can answer, so it never reaches a blind pass at
// all (`humanEvalQuestions`). A column that is empty in every row of every
// export would read as "no scenario had media".
//
// Pure module: no DB, no React, no Next. The quoting is `./csv.ts`, shared
// with the golden set's export.

import { csvFilename, toCsv } from './csv'

/**
 * Column order, and the header row.
 *
 * `history` and `inbound` sit LEFT of the replies for the reason the golden
 * export gives: a reply read without the input it answered is not
 * interpretable, and a verdict about such a reply even less so.
 */
export const HUMAN_EVAL_CSV_COLUMNS = [
  'question_key',
  'group',
  'question',
  'history',
  'inbound',
  'v1_reply',
  'v2_reply',
  // What the rater was shown, and what they said about it.
  'shown_as_a',
  'a_verdict',
  'b_verdict',
  // The same answer, unblinded (lib/eval/human-eval.ts).
  'v1_verdict',
  'v2_verdict',
  'better',
  'why',
  'v1_substitute',
  'v2_gate',
  'v1_ms',
  'v2_ms',
  'v1_error',
  'v2_error',
  'generated_at',
  'judged_at',
  'revealed_at',
  /**
   * 'yes' when the row's most recent verdict was written AFTER the rater
   * unblinded it, 'no' when it was blind, blank when the row was never
   * revealed or never judged.
   *
   * THE REASON THIS COLUMN EXISTS. "These labels were blind" is a claim a
   * surface can make and nothing can contradict - and an unfalsifiable claim
   * is what stops anyone looking. Reveal is gated behind both verdicts being
   * in, and this says whether the rater then changed their mind knowing the
   * answer. A pass of 58 'no' rows is evidence; a column of blanks and 'yes'es
   * is a different and much weaker thing, and the file has to be able to say
   * which it is.
   */
  'verdict_after_reveal',
] as const

export type HumanEvalCsvRow = Record<
  (typeof HUMAN_EVAL_CSV_COLUMNS)[number],
  string
>

export function humanEvalRowsToCsv(rows: readonly HumanEvalCsvRow[]): string {
  return toCsv(HUMAN_EVAL_CSV_COLUMNS, rows)
}

/** `human-eval-<sha>-<started>.csv`. The naming rule is `./csv.ts`. */
export function humanEvalCsvFilename(input: {
  gitSha: string | null
  startedAt: string
}): string {
  return csvFilename('human-eval', input)
}
