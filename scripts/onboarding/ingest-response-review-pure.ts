// Pure helpers for ingest-response-review (THE-178). Split out from
// ingest-response-review.ts so the test file's import chain doesn't transit
// through `lib/rag` and friends, which use `@/*` path aliases that vitest
// doesn't resolve at runtime.
//
// Anything in this file must remain free of @/... imports and DB-touching code.

import { parse as parseCsv } from 'csv-parse/sync'

// Locked column order. Header validation throws on mismatch.
export const SHEET_HEADERS = [
  'sample_id',
  'run_date',
  'category',
  'guest_state',
  'scenario',
  'inbound_message',
  'generated_message',
  'voice_fidelity',
  'verdict',
  'edited_message',
  'comment',
] as const

type ColName = (typeof SHEET_HEADERS)[number]
export type ReviewRow = Record<ColName, string>

export type RowKind = 'approve' | 'expected_failure' | 'edit' | 'rule' | 'edit_and_rule'

export interface CorpusEntrySummary {
  sample_id: string
  category: string
  inbound_message: string
  generated_message: string
  edited_message: string
}

export interface BuildSubsectionInput {
  timestampIso: string
  newAntiPatterns: string[]
  newCorpusEntries: CorpusEntrySummary[]
  sourceFileName: string
}

/**
 * Parse the 08-response-review gsheet's CSV export. Validates header order
 * exactly against SHEET_HEADERS — operators rearranging columns in the gsheet
 * will surface here as a clear error.
 */
export function parseReviewSheet(csv: string): ReviewRow[] {
  const matrix = parseCsv(csv, {
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
  }) as string[][]
  if (matrix.length === 0) {
    throw new Error('parseReviewSheet: csv is empty (no header row, no data)')
  }
  const headers = matrix[0]
  for (let i = 0; i < SHEET_HEADERS.length; i++) {
    if (headers[i] !== SHEET_HEADERS[i]) {
      throw new Error(
        `parseReviewSheet: header mismatch at column ${i + 1}: expected "${SHEET_HEADERS[i]}", got "${headers[i] ?? '(missing)'}"`,
      )
    }
  }
  const rows: ReviewRow[] = []
  for (let i = 1; i < matrix.length; i++) {
    const cells = matrix[i]
    const row = {} as ReviewRow
    for (let j = 0; j < SHEET_HEADERS.length; j++) {
      row[SHEET_HEADERS[j]] = cells[j] ?? ''
    }
    rows.push(row)
  }
  return rows
}

/**
 * Branch a row into its action kind. Order matters:
 *   1. expected_failure: prefix on comment → skip entirely
 *   2. empty verdict → approve (skip), regardless of comment content
 *   3. verdict=edit + rule: prefix on comment → both actions
 *   4. verdict=edit alone → corpus ingestion
 *   5. verdict=approve + rule: prefix → anti-pattern only
 *   6. anything else (verdict=approve alone, etc.) → no-op
 *
 * Empty verdict means the operator hasn't finished reviewing the row;
 * half-finished review state shouldn't propagate rules or edits to the
 * persona. Rule and edit ingestion both require an explicit verdict.
 */
export function classifyRow(row: ReviewRow): RowKind {
  if (/^expected_failure:/i.test(row.comment)) return 'expected_failure'
  const verdict = row.verdict.trim().toLowerCase()
  if (verdict === '') return 'approve'
  const isEdit = verdict === 'edit'
  const isRule = /^rule:/i.test(row.comment)
  if (isEdit && isRule) return 'edit_and_rule'
  if (isEdit) return 'edit'
  if (isRule) return 'rule'
  return 'approve'
}

/**
 * The literal anti-pattern string stored in voiceAntiPatterns. Per spec the
 * "rule:" prefix is preserved as a lineage marker. Outer whitespace is
 * trimmed; internal text is left intact (operators write the rules
 * thoughtfully and we don't second-guess capitalization or punctuation).
 */
export function rulePayloadFromComment(comment: string): string {
  return comment.trim()
}

/**
 * Lowercase + collapse whitespace + trim. Used only for dedupe equality
 * comparisons against existing voiceAntiPatterns. Both sides are normalized
 * the same way; the stored string remains as-typed.
 */
export function normalizeForCompare(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function tagsForRow(row: ReviewRow): string[] {
  return ['phase_5_review', row.category, row.guest_state].filter((t) => t.length > 0)
}

/**
 * Build the dated subsection body. Format locked per the user spec — the
 * "Anti-patterns added" block, "Voice corpus additions (N rows)" block, and
 * the trailing "Source:" line. Each major block is omitted when its
 * collection is empty (e.g. only rules added, no corpus rows: skip the
 * corpus block).
 */
export function buildPhase5Subsection(input: BuildSubsectionInput): string {
  const blocks: string[] = [`### ${input.timestampIso}`]

  if (input.newAntiPatterns.length > 0) {
    const lines = input.newAntiPatterns.map((r) => `- ${r}`).join('\n')
    blocks.push(`**Anti-patterns added to \`voiceAntiPatterns\`:**\n\n${lines}`)
  }

  if (input.newCorpusEntries.length > 0) {
    const entryLines = input.newCorpusEntries
      .map((e) =>
        [
          `- \`${e.sample_id}\` — ${e.category}`,
          `  - inbound: "${e.inbound_message}"`,
          `  - generated: "${e.generated_message}"`,
          `  - edited: "${e.edited_message}"`,
        ].join('\n'),
      )
      .join('\n\n')
    blocks.push(
      `**Voice corpus additions (${input.newCorpusEntries.length} rows):**\n\n${entryLines}`,
    )
  }

  blocks.push(`**Source:** \`${input.sourceFileName}\` (gsheet)`)

  return blocks.join('\n\n')
}

/**
 * Append the dated subsection to the existing 06-markdown. Two paths:
 *
 *   (a) No existing "## Phase 5 review additions" header: append a fresh
 *       section with leading "---" separator, then the section header, then
 *       the dated subsection.
 *   (b) Existing section: insert a new dated subsection at the end of the
 *       section (just before the next "## " H2 or EOF), separated from prior
 *       subsections by "---".
 *
 * Always append, never replace. Subsections stay in chronological order.
 */
export function appendPhase5Section(
  existing: string,
  subsection: string,
): { newMarkdown: string; alreadyHadSection: boolean } {
  const sectionRe = /^## Phase 5 review additions[ \t]*$/m
  const match = sectionRe.exec(existing)

  if (!match) {
    const trimmed = existing.replace(/\s+$/, '')
    const newMarkdown = `${trimmed}\n\n---\n\n## Phase 5 review additions\n\n${subsection}\n`
    return { newMarkdown, alreadyHadSection: false }
  }

  // Find the boundary: next "## " H2 after our section, or EOF.
  const sectionContentStart = match.index + match[0].length
  const after = existing.slice(sectionContentStart)
  const nextH2Re = /\n## /
  const nextH2 = nextH2Re.exec(after)

  const insertionAbsolute = nextH2 ? sectionContentStart + nextH2.index : existing.length

  const before = existing.slice(0, insertionAbsolute).replace(/\s+$/, '')
  const tail = existing.slice(insertionAbsolute)

  const separator = '\n\n---\n\n'
  const tailPrefix = tail.length === 0 ? '\n' : tail.startsWith('\n\n') ? '' : '\n\n'
  const newMarkdown = `${before}${separator}${subsection}${tailPrefix}${tail}`
  return { newMarkdown, alreadyHadSection: true }
}