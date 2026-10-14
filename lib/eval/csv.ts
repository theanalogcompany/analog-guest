// RFC 4180 CSV serialization. One definition, for every export that puts
// agent replies in a spreadsheet.
//
// WHY IT IS ITS OWN MODULE. The quoting matters more than it looks: a reply
// contains commas, apostrophes and - because both engines emit a string array
// of bubbles - newlines once those are joined. A hand-rolled join on commas
// shifts every column right of the first comma in a reply, and the file still
// opens in Sheets looking plausible. That is one rule, and a second copy of it
// is a second chance to get it wrong in a file nobody re-reads.
//
// Pure: no DB, no React, no Next. A caller owns its own column list and its
// own cell values; this owns the bytes.

/**
 * Quote one field. ALWAYS quoting rather than only-when-needed: these files
 * are read by humans in a spreadsheet and by nothing else, so uniform quoting
 * costs a few bytes and removes a class of "it worked until a reply contained
 * a comma" bug. Embedded quotes double, per RFC 4180.
 */
export function quoteCsvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/**
 * Header row then one row per record, in `columns` order.
 *
 * The column list drives BOTH the header and every cell lookup, so a column
 * added to the list without a value in the row type fails `tsc` at the call
 * site rather than silently exporting an empty column.
 *
 * CRLF and a trailing newline: RFC 4180's line ending, and the one Excel wants
 * on every platform.
 */
export function toCsv<K extends string>(
  columns: readonly K[],
  rows: ReadonlyArray<Record<K, string>>,
): string {
  const header = columns.map(quoteCsvField).join(',')
  const body = rows.map((row) =>
    columns.map((column) => quoteCsvField(row[column])).join(','),
  )
  return [header, ...body].join('\r\n') + '\r\n'
}

/**
 * A download filename carrying the code state and the instant it describes.
 *
 * Both of those are the point rather than decoration: two exports of different
 * runs can never collide in a downloads folder, and a file that has been
 * sitting on someone's desktop for a week still says which commit produced the
 * replies in it. `nocommit` is the honest value where there is no deployment
 * sha - a pass run from a local dev server - and never a guess.
 */
export function csvFilename(
  prefix: string,
  input: { gitSha: string | null; startedAt: string },
): string {
  const sha = input.gitSha ? input.gitSha.slice(0, 7) : 'nocommit'
  const stamp = input.startedAt.replace(/[:.]/g, '-').slice(0, 19)
  return `${prefix}-${sha}-${stamp}.csv`
}

/**
 * The leading byte-order mark Excel needs to read a file as UTF-8 rather than
 * as the local codepage. Without it a curly apostrophe in a reply - and the
 * voice pack is full of them - renders as mojibake.
 *
 * Applied by the route that serves the file, never by the serializers, so
 * `toCsv` stays plain CSV.
 */
export const CSV_UTF8_BOM = '﻿'
