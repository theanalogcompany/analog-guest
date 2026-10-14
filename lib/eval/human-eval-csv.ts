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
// BUILDING THE ROWS LIVES HERE, NOT IN THE EXPORT ROUTE. Two callers need the
// identical file: the submit route, which writes it once into the pass
// (migration 087) before the replies are cleared, and the export route, which
// serves what was stored - or builds it the same way for a pass that has no
// stored copy. A second mapping would let the file a pass was judged against
// differ from the file served for an older one, in a column nobody would
// think to compare.
//
// Pure module: no DB, no React, no Next. The quoting is `./csv.ts`, shared
// with the golden set's export.

import { csvFilename, toCsv } from './csv'
import { goldenInputCells } from './golden-csv'
import { unblind, type HumanEvalArm } from './human-eval'
import type { GoldenQuestion, GoldenV1, GoldenV2 } from '@/lib/schemas/golden'

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

/**
 * One stored row, as both callers already hold it.
 *
 * STRUCTURAL, so this module stays pure: the admin surface's own unit shape
 * satisfies it without `lib/` importing anything out of `app/`. The two
 * answers are nullable for the two reasons the page distinguishes - a column
 * that would not parse, and a submitted pass whose replies were cleared -
 * and neither may render as a reply.
 */
export interface HumanEvalCsvUnit {
  questionKey: string
  /** Null for an orphan: the question left the set after the pass. */
  question: GoldenQuestion | null
  aArm: HumanEvalArm
  v1: GoldenV1 | null
  v2: GoldenV2 | null
  aVerdict: 'pass' | 'fail' | null
  bVerdict: 'pass' | 'fail' | null
  preference: 'a' | 'b' | 'neither' | null
  note: string
  generatedAt: string
  judgedAt: string | null
}

/**
 * The pass as CSV rows, in the order given.
 *
 * EVERY GENERATED ROW, judged or not, with the unjudged ones carrying empty
 * verdict cells. Filtering them would make a half-finished pass read as a
 * complete one over a smaller set, and the row count is how a reader knows
 * which they have.
 *
 * A row whose answers are no longer stored is not a row this should ever be
 * asked to build - the file was written while they were still there, and the
 * export route refuses rather than serving one full of empty reply cells. The
 * cells below say `UNREADABLE stored column` for a null answer, which is true
 * of the only case that reaches here.
 */
export function humanEvalCsvRows(
  units: readonly HumanEvalCsvUnit[],
): HumanEvalCsvRow[] {
  return units.map((unit) => {
    const input = goldenInputCells(unit.question)
    // The one definition of "what this A/B answer says about the engines"
    // (lib/eval/human-eval.ts), so the file and the page cannot disagree
    // about which engine won a row.
    const read = unblind(unit)
    return {
      question_key: unit.questionKey,
      group: unit.question?.group ?? 'orphan',
      question: unit.question?.question ?? '(question no longer in the set)',
      history: input.history,
      inbound: input.inbound,
      media: input.media,
      v1_reply:
        unit.v1 === null
          ? 'UNREADABLE stored column'
          : unit.v1.ok
            ? unit.v1.bubbles.join('\n')
            : '',
      v2_reply:
        unit.v2 === null
          ? 'UNREADABLE stored column'
          : unit.v2.ok
            ? unit.v2.messages.join('\n')
            : '',
      shown_as_a: unit.aArm,
      a_verdict: unit.aVerdict ?? '',
      b_verdict: unit.bVerdict ?? '',
      v1_verdict: read.v1Verdict ?? '',
      v2_verdict: read.v2Verdict ?? '',
      better: read.better ?? '',
      why: unit.note,
      v1_substitute: unit.v1?.ok ? (unit.v1.substitute ?? '') : '',
      v2_gate: unit.v2?.ok ? (unit.v2.gateVerdict ?? '') : '',
      v1_ms: unit.v1 === null ? '' : String(unit.v1.durationMs),
      v2_ms: unit.v2 === null ? '' : String(unit.v2.durationMs),
      v1_error:
        unit.v1 !== null && !unit.v1.ok
          ? `${unit.v1.stage}: ${unit.v1.error}`
          : '',
      v2_error:
        unit.v2 !== null && !unit.v2.ok
          ? `${unit.v2.stage}: ${unit.v2.error}`
          : '',
      generated_at: unit.generatedAt,
      judged_at: unit.judgedAt ?? '',
    }
  })
}

/** `human-eval-<sha>-<started>.csv`. The naming rule is `./csv.ts`. */
export function humanEvalCsvFilename(input: {
  gitSha: string | null
  startedAt: string
}): string {
  return csvFilename('human-eval', input)
}
