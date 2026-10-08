// The golden set's CSV export: one row per question, v1's answer beside v2's.
//
// RFC 4180 quoting, which matters more than it looks here: a reply contains
// commas, apostrophes and - because the model emits `messages: string[]` -
// newlines once the bubbles are joined. A hand-rolled join on commas would
// shift every column right of the first comma in a reply, and the file would
// still open in Sheets looking plausible.
//
// Pure module: no DB, no React, no Next. The export route formats rows it has
// already loaded, so the serializer is testable on its own and the one
// definition of what a golden-set CSV contains.

/** Column order, and the header row. */
export const GOLDEN_CSV_COLUMNS = [
  'question_key',
  'group',
  'question',
  'v1_reply',
  'v2_reply',
  'v1_category',
  'v1_recognition_state',
  'v1_substitute',
  'v2_state',
  'v2_gate',
  'v2_gate_matched',
  'v1_ms',
  'v2_ms',
  'v1_error',
  'v2_error',
] as const

export type GoldenCsvRow = Record<(typeof GOLDEN_CSV_COLUMNS)[number], string>

/**
 * Quote a field. Always quoting rather than only-when-needed: the file is
 * read by humans in a spreadsheet and by nothing else, so uniform quoting
 * costs a few bytes and removes a class of "it worked until a reply contained
 * a comma" bug. Embedded quotes double, per RFC 4180.
 */
function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export function goldenRowsToCsv(rows: readonly GoldenCsvRow[]): string {
  const header = GOLDEN_CSV_COLUMNS.map(quote).join(',')
  const body = rows.map((row) =>
    GOLDEN_CSV_COLUMNS.map((column) => quote(row[column])).join(','),
  )
  // CRLF and a trailing newline: RFC 4180's line ending, and the one Excel
  // wants on every platform.
  return [header, ...body].join('\r\n') + '\r\n'
}

/**
 * The download filename. Carries the short sha and the run's start instant,
 * so two exports of different runs can never collide in a downloads folder -
 * and so a file that has been sitting on someone's desktop still says which
 * commit produced it.
 */
export function goldenCsvFilename(input: {
  gitSha: string | null
  startedAt: string
}): string {
  const sha = input.gitSha ? input.gitSha.slice(0, 7) : 'nocommit'
  const stamp = input.startedAt.replace(/[:.]/g, '-').slice(0, 19)
  return `golden-${sha}-${stamp}.csv`
}
