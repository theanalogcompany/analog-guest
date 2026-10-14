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
// THIS FILE IS THE ONLY PLACE A AND B ARE NAMED. The page has no reveal, so
// downloading the export is how anyone finds out which engine wrote which -
// which is what makes every verdict in a pass blind by construction, with no
// `revealed_at` audit column needed to say so.
//
// THERE IS A `media` COLUMN, because a scenario carrying a photo DOES reach a
// blind pass. It used not to - v2 had no media input - and this file said so;
// the claim outlived the media lane and then outlived the run route carrying
// it to both arms. A verdict about "guest sends a photo and nothing else" is
// not interpretable without the thing the guest sent, same as the history and
// the inbound beside it.
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
  // Left of the replies for the same reason as the two above: it is part of
  // what was asked. Blank on a text scenario, which is most of them.
  'media',
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
