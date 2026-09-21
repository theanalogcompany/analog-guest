// Markdown renderer for the knowledge dedup report. Pure: types only, no
// clients, no I/O. Split from load-venue-knowledge-pure.ts to keep both
// readable; the load-bearing decision logic lives there and is unit-tested,
// this is presentation.

import type {
  Distribution,
  Proposal,
  SpecificsDiff,
  SplitSafetyFinding,
  Specifics,
  SuggestedVerdict,
} from './load-venue-knowledge-pure'

export type EntryKind = 'existing' | 'replacement' | 'proposal'

export interface Neighbour {
  label: string
  kind: EntryKind
  score: number
  content: string
}

export interface ProposalResult {
  proposal: Proposal
  /** Top-N in the POST-LOAD corpus (untouched existing + replacements + new). */
  neighbours: Neighbour[]
  /** Replacements only: top-N among untouched existing rows. */
  existingNeighbours: Neighbour[]
  /** Against the top post-load neighbour. */
  diff: SpecificsDiff | null
  specifics: Specifics
  suggested: SuggestedVerdict
}

export interface ReportInput {
  venueSlug: string
  venueId: string
  generatedAt: string
  gitSha: string | null
  embeddingModel: string
  inputPath: string
  existingCount: number
  proposalCount: number
  newCount: number
  replaceCount: number
  control: Distribution
  band: number
  results: ProposalResult[]
  replacementTargets: Array<{ rowId: string; id: string; oldContent: string; newContent: string }>
  rulingEightRows: Array<{ id: string; label: string; content: string }>
  bareDomainExistingRows: Array<{ id: string; content: string }>
  splitFindings: SplitSafetyFinding[]
  textDefects: string[]
}

function fmt(n: number): string {
  return n.toFixed(4)
}

function specificsLine(diff: SpecificsDiff): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(diff.onlyLeft)) {
    if (v && v.length > 0) parts.push(`only in proposal — ${k}: ${v.join(', ')}`)
  }
  for (const [k, v] of Object.entries(diff.onlyRight)) {
    if (v && v.length > 0) parts.push(`only in neighbour — ${k}: ${v.join(', ')}`)
  }
  if (parts.length === 0) parts.push('no differing specifics')
  const flag = diff.numericDivergence
    ? `  \n  **numeric divergence** (shared numeric tokens: ${diff.sharedNumericCount})`
    : ''
  return parts.map((p) => `  - ${p}`).join('\n') + flag
}

function neighbourBlock(n: Neighbour, idx: number): string {
  return [
    `  ${idx + 1}. **${fmt(n.score)}** — \`${n.label}\` *(${n.kind})*`,
    `     > ${n.content.replace(/\n+/g, ' ')}`,
  ].join('\n')
}

export function renderReport(input: ReportInput): string {
  const L: string[] = []

  L.push(`# Le Mil's knowledge load — duplicate check`)
  L.push('')
  L.push(`Read-only. No rows were written.`)
  L.push('')
  L.push('| | |')
  L.push('|---|---|')
  L.push(`| venue | \`${input.venueSlug}\` (\`${input.venueId}\`) |`)
  L.push(`| generated | ${input.generatedAt} |`)
  L.push(`| git sha | ${input.gitSha ?? '(not a repo)'} |`)
  L.push(`| input | \`${input.inputPath}\` |`)
  L.push(`| embedding model | ${input.embeddingModel} |`)
  L.push(`| existing entries | ${input.existingCount} |`)
  L.push(`| proposals | ${input.proposalCount} (${input.newCount} new, ${input.replaceCount} replace) |`)
  L.push('')

  // ── threshold ────────────────────────────────────────────────────────────
  L.push('## 1. Threshold calibration')
  L.push('')
  L.push(
    'The band below is **not** a duplicate test. It selects which pairs get read. ' +
      'Cosine cannot see contradiction: "16th century" and "17th century" score ~0.98, ' +
      'and so do "$17" and "$19". Disagreement is the test, and it is applied by reading.',
  )
  L.push('')
  L.push(
    `**Control distribution: existing-vs-existing.** All ${input.control.count} pairs among the ` +
      `${input.existingCount} entries already live at this venue. These coexist happily today, ` +
      `so this distribution is what "similar but fine" actually looks like in this corpus — ` +
      `rather than a number picked in advance.`,
  )
  L.push('')
  L.push('| stat | score |')
  L.push('|---|---|')
  L.push(`| min | ${fmt(input.control.min)} |`)
  L.push(`| p50 | ${fmt(input.control.p50)} |`)
  L.push(`| p90 | ${fmt(input.control.p90)} |`)
  L.push(`| p95 | ${fmt(input.control.p95)} |`)
  L.push(`| **p99 (band)** | **${fmt(input.control.p99)}** |`)
  L.push(`| max | ${fmt(input.control.max)} |`)
  L.push('')
  L.push('Histogram (bucket 0.05):')
  L.push('')
  L.push('```')
  const peak = Math.max(...input.control.histogram.map((h) => h.count))
  for (const h of input.control.histogram) {
    const bar = '#'.repeat(Math.max(1, Math.round((h.count / peak) * 50)))
    L.push(`${h.lo.toFixed(2)}-${h.hi.toFixed(2)} ${String(h.count).padStart(5)} ${bar}`)
  }
  L.push('```')
  L.push('')
  L.push(
    `**Band = p99 of the control = ${fmt(input.band)}.** A proposal whose nearest post-load ` +
      `neighbour scores at or above this is flagged for reading. p99 rather than max because the ` +
      `control's own top pairs are the existing corpus's closest-related entries, and those are ` +
      `exactly the shape a genuine near-duplicate would take.`,
  )
  L.push('')

  // ── summary ──────────────────────────────────────────────────────────────
  const counts = new Map<SuggestedVerdict, number>()
  for (const r of input.results) counts.set(r.suggested, (counts.get(r.suggested) ?? 0) + 1)
  L.push('## 2. Suggested verdicts')
  L.push('')
  L.push('`DUPLICATE` is never auto-suggested — dropping an entry costs the venue a fact, so it needs a reading.')
  L.push('')
  L.push('| suggested | count |')
  L.push('|---|---|')
  for (const v of ['REPLACES', 'CONFLICT_CANDIDATE', 'BORDERLINE', 'NEW'] as SuggestedVerdict[]) {
    L.push(`| ${v} | ${counts.get(v) ?? 0} |`)
  }
  L.push('')
  const flagged = input.results.filter((r) => r.suggested === 'CONFLICT_CANDIDATE' || r.suggested === 'BORDERLINE')
  if (flagged.length > 0) {
    L.push('Flagged for reading, by descending top score:')
    L.push('')
    for (const r of [...flagged].sort((a, b) => (b.neighbours[0]?.score ?? 0) - (a.neighbours[0]?.score ?? 0))) {
      L.push(
        `- **${r.proposal.row_id}** ${fmt(r.neighbours[0]?.score ?? 0)} vs \`${r.neighbours[0]?.label ?? '-'}\` — ${r.suggested}`,
      )
    }
    L.push('')
  }

  // ── ruling 8 ─────────────────────────────────────────────────────────────
  L.push('## 3. Ruling 8 — full text of the existing rows behind P03 and P04')
  L.push('')
  for (const row of input.rulingEightRows) {
    L.push(`### ${row.label} — \`${row.id}\``)
    L.push('')
    L.push(`> ${row.content}`)
    L.push('')
  }

  // ── ruling 9 ─────────────────────────────────────────────────────────────
  L.push('## 4. Ruling 9 — does bare "lemils.com" trip anything?')
  L.push('')
  L.push(
    `**Already live.** ${input.bareDomainExistingRows.length} existing Le Mil's entries contain a ` +
      `bare domain today, and have since 2026-09-11. This load does not introduce the pattern.`,
  )
  L.push('')
  for (const row of input.bareDomainExistingRows) {
    L.push(`- \`${row.id}\` — ${row.content}`)
  }
  L.push('')
  L.push(
    `**Splitter check (measured, not read).** Every proposal body containing a bare domain was run ` +
      `through the real \`resolveDispatchBubbles\` with the coin forced to split, and each domain ` +
      `checked for survival inside a single bubble.`,
  )
  L.push('')
  if (input.splitFindings.length === 0) {
    L.push('Result: **no domain was broken across a bubble boundary.**')
  } else {
    L.push('Result: **domains broken across bubbles:**')
    for (const f of input.splitFindings) {
      L.push(`- ${f.rowId}: \`${f.brokenToken}\` split across ${JSON.stringify(f.bubbles)}`)
    }
  }
  L.push('')

  // ── replacements ─────────────────────────────────────────────────────────
  L.push('## 5. Replacements')
  L.push('')
  L.push(
    'For each: the row being replaced, the replacement, and the nearest **untouched existing** ' +
      'entries — the "does anything else also need replacing" question.',
  )
  L.push('')
  for (const t of input.replacementTargets) {
    const r = input.results.find((x) => x.proposal.row_id === t.rowId)
    L.push(`### ${t.rowId} → \`${t.id}\``)
    L.push('')
    L.push(`**Current:**`)
    L.push(`> ${t.oldContent}`)
    L.push('')
    L.push(`**Replacement:**`)
    L.push(`> ${t.newContent}`)
    L.push('')
    if (r && r.existingNeighbours.length > 0) {
      L.push('Nearest untouched existing entries:')
      L.push('')
      L.push(r.existingNeighbours.map((n, i) => neighbourBlock(n, i)).join('\n'))
      L.push('')
    }
  }

  // ── per-proposal detail ──────────────────────────────────────────────────
  L.push('## 6. Every proposal')
  L.push('')
  for (const r of input.results) {
    const p = r.proposal
    const top = r.neighbours[0]
    L.push(`### ${p.row_id} — ${r.suggested}${top ? ` (top ${fmt(top.score)})` : ''}`)
    L.push('')
    L.push(
      `\`action: ${p.action}\` · \`primary: ${p.primary_tags.join(', ')}\` · ` +
        `\`secondary: ${p.secondary_tags.join(', ')}\` · \`source_ref: ${p.source_ref}\``,
    )
    if (p.note.length > 0) L.push(`\n*note:* ${p.note}`)
    L.push('')
    L.push(`> ${p.content}`)
    L.push('')
    if (r.neighbours.length === 0) {
      L.push('No neighbours.')
    } else {
      L.push('Nearest in the post-load corpus:')
      L.push('')
      L.push(r.neighbours.map((n, i) => neighbourBlock(n, i)).join('\n'))
      L.push('')
      if (r.diff) {
        L.push('Specifics vs the nearest:')
        L.push('')
        L.push(specificsLine(r.diff))
      }
    }
    L.push('')
  }

  // ── defects ──────────────────────────────────────────────────────────────
  L.push('## 7. Text defects')
  L.push('')
  if (input.textDefects.length === 0) {
    L.push('None found by the automated checks (URL present, double punctuation, em/en dash, empty fields, non-canonical tag).')
  } else {
    for (const d of input.textDefects) L.push(`- ${d}`)
  }
  L.push('')

  return L.join('\n')
}
