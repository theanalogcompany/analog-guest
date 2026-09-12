import { SHEET_HEADERS } from './ingest-response-review-pure'
import type { GradedScenario } from './scorecard'

/**
 * TAC-347 Stage 4. Serializes the `--owner-review` selection into the
 * exact row shape `parseReviewSheet` (ingest-response-review-pure.ts)
 * expects, so `ingest-response-review` works against this export unchanged.
 *
 * Header comes from SHEET_HEADERS, imported rather than hand-duplicated —
 * same discipline CLAUDE.md calls out for MECHANIC_TRIGGER_TYPES et al.
 * `verdict` / `edited_message` / `comment` are always blank: this sheet is
 * the INPUT to the owner's Phase 5 review, not a completed one.
 */

export function buildOwnerReviewRows(selected: readonly GradedScenario[], runDateIso: string): string[][] {
  const rows: string[][] = [[...SHEET_HEADERS]]
  for (const g of selected) {
    rows.push([
      g.scenario.sample_id,
      runDateIso,
      g.scenario.category,
      g.scenario.guest_state,
      g.scenario.scenario,
      g.scenario.inbound_message,
      g.result.replyBody ?? '',
      g.result.voiceFidelity !== null ? g.result.voiceFidelity.toFixed(2) : '',
      '', // verdict — owner fills in during Phase 5 review
      '', // edited_message — owner fills in only when editing
      '', // comment — owner adds rule:/expected_failure: prefixed notes
    ])
  }
  return rows
}

function needsCsvQuoting(field: string): boolean {
  return field.includes(',') || field.includes('"') || field.includes('\n') || field.includes('\r')
}

function toCsvField(field: string): string {
  if (!needsCsvQuoting(field)) return field
  return `"${field.replace(/"/g, '""')}"`
}

/** RFC4180 CSV encoding. Row separator is a bare \n; a literal newline inside a field stays intact via quoting. */
export function rowsToCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(toCsvField).join(',')).join('\n')
}
