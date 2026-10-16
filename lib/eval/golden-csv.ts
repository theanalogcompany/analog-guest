// The golden set's CSV export: one row per question, v1's answer beside v2's.
//
// The RFC 4180 quoting lives in `./csv.ts` - shared with the human-evaluation
// export, because both put the same replies in a spreadsheet and one of them
// getting the quoting right is not enough.
//
// Pure module: no DB, no React, no Next. The export route formats rows it has
// already loaded, so the serializer is testable on its own and the one
// definition of what a golden-set CSV contains.

import { csvFilename, toCsv } from './csv'
import type { GoldenQuestion } from '@/lib/schemas/golden'

/**
 * Column order, and the header row. SEVEN COLUMNS (owner-ruled 2026-10-15).
 *
 * `history`, `inbound` and `media` sit LEFT of the two replies on purpose:
 * they are what the engines were given, and an answer read without them is
 * not interpretable. "no record on my end, I only know what you tell me" is
 * correct or a miss depending entirely on whether the transcript mentions an
 * order. `inbound` is also the only honest record of a burst, and now the only
 * record of the question at all - `question_key`, `group` and `question` were
 * among the eleven columns cut, and `inbound` carries that text for every
 * scenario that does not override it.
 *
 * WHAT WENT, so nobody reads the cut as data that stopped being recorded: v1's
 * category, recognition state and substitute; v2's state, gate verdict and
 * matched rows; and both error columns. All of it is still in `golden_runs`
 * and on the page - this is the spreadsheet's shape, not the record's.
 *
 * THE ERROR COLUMNS ARE THE ONE CUT WITH A CONSEQUENCE, and it is handled
 * rather than accepted: a failed arm used to leave `v1_reply` empty with the
 * reason in `v1_error`, so dropping the reason would turn a failure into a
 * blank cell reading as "the engine said nothing" - the false claim the
 * export's own comment warns about. The reason now goes in the reply cell,
 * prefixed, so a failure is never silent and never mistaken for a reply.
 */
export const GOLDEN_CSV_COLUMNS = [
  'history',
  'inbound',
  'media',
  'v1_reply',
  'v2_reply',
  'v1_ms',
  'v2_ms',
] as const

export type GoldenCsvRow = Record<(typeof GOLDEN_CSV_COLUMNS)[number], string>

/**
 * What the engines were GIVEN, as three cells: the authored prior turns, the
 * turn's own messages, and any attachment links.
 *
 * SHARED BY BOTH EXPORTS - the golden set's and the human evaluation's - for
 * the same reason `GoldenTranscript` is shared by the two pages that render
 * them: these are the columns that make an answer interpretable, and two
 * copies would let one export quietly stop recording a burst's real messages
 * while the other still did.
 *
 * A null question is an ORPHAN KEY: it was reworded or removed after the run,
 * so its transcript is genuinely unknown rather than empty. Said so, never
 * rendered as a cold open it may not have been.
 */
export function goldenInputCells(question: GoldenQuestion | null): {
  history: string
  inbound: string
  media: string
} {
  if (question === null)
    return {
      history: '(unknown - question no longer in the set)',
      inbound: '',
      media: '',
    }
  return {
    history: (question.history ?? [])
      .map((t) => `${t.role === 'user' ? 'guest' : 'venue'}: ${t.text}`)
      .join('\n'),
    inbound: (question.messages ?? [question.question]).join('\n'),
    media: question.mediaUrls?.join('\n') ?? '',
  }
}

export function goldenRowsToCsv(rows: readonly GoldenCsvRow[]): string {
  return toCsv(GOLDEN_CSV_COLUMNS, rows)
}

/** `golden-<sha>-<started>.csv`. The naming rule is `./csv.ts`. */
export function goldenCsvFilename(input: {
  gitSha: string | null
  startedAt: string
}): string {
  return csvFilename('golden', input)
}
