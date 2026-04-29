import { describe, expect, it } from 'vitest'
// Import from -pure to keep the test's import chain free of @/* aliases that
// vitest can't resolve (the non-pure module imports lib/rag, which transitively
// uses @/*).
import {
  appendPhase5Section,
  buildPhase5Subsection,
  classifyRow,
  normalizeForCompare,
  parseReviewSheet,
  type ReviewRow,
  rulePayloadFromComment,
  tagsForRow,
} from './ingest-response-review-pure'

const baseRow = (overrides: Partial<ReviewRow> = {}): ReviewRow => ({
  sample_id: 'mock-001',
  run_date: '2026-04-28T17:00:00Z',
  category: 'menu_fact',
  guest_state: 'new',
  scenario: 'first-time guest asks about milk',
  inbound_message: 'do you have oat milk?',
  generated_message: 'yeah, oat and almond.',
  voice_fidelity: '0.92',
  verdict: 'approve',
  edited_message: '',
  comment: '',
  ...overrides,
})

describe('classifyRow', () => {
  it('returns expected_failure when comment starts with expected_failure:', () => {
    expect(classifyRow(baseRow({ comment: 'expected_failure: THE-170' }))).toBe('expected_failure')
  })

  it('expected_failure takes priority over verdict=edit and rule:', () => {
    expect(
      classifyRow(
        baseRow({
          verdict: 'edit',
          edited_message: 'something',
          comment: 'expected_failure: THE-170. rule: avoid sourcing detail',
        }),
      ),
    ).toBe('expected_failure')
  })

  it('returns edit_and_rule when verdict=edit and comment starts with rule:', () => {
    expect(
      classifyRow(
        baseRow({
          verdict: 'edit',
          edited_message: 'a corrected message',
          comment: 'rule: be terse',
        }),
      ),
    ).toBe('edit_and_rule')
  })

  it('returns edit when only verdict=edit', () => {
    expect(classifyRow(baseRow({ verdict: 'edit', edited_message: 'fix' }))).toBe('edit')
  })

  it('returns rule when only comment has rule: prefix', () => {
    expect(classifyRow(baseRow({ comment: 'rule: avoid em-dashes' }))).toBe('rule')
  })

  it('returns approve when verdict=approve', () => {
    expect(classifyRow(baseRow({ verdict: 'approve' }))).toBe('approve')
  })

  it('returns approve when verdict is empty (operator left blank)', () => {
    expect(classifyRow(baseRow({ verdict: '' }))).toBe('approve')
  })

  it('returns approve when verdict is empty even with rule: comment (half-reviewed → skip)', () => {
    expect(
      classifyRow(baseRow({ verdict: '', comment: 'rule: be terse' })),
    ).toBe('approve')
  })

  it('verdict matching is case-insensitive', () => {
    expect(classifyRow(baseRow({ verdict: 'Edit', edited_message: 'x' }))).toBe('edit')
  })

  it('rule: prefix matching is case-insensitive', () => {
    expect(classifyRow(baseRow({ comment: 'Rule: be terse' }))).toBe('rule')
  })
})

describe('rulePayloadFromComment', () => {
  it('preserves the literal rule: prefix and trims whitespace', () => {
    expect(rulePayloadFromComment("  rule: don't use em-dashes  ")).toBe(
      "rule: don't use em-dashes",
    )
  })
})

describe('normalizeForCompare', () => {
  it('lowercases, collapses whitespace, trims', () => {
    expect(normalizeForCompare('  Rule:   Avoid  EM-Dashes  ')).toBe('rule: avoid em-dashes')
  })

  it('treats whitespace-different rules as equivalent', () => {
    expect(normalizeForCompare('rule: be   terse')).toBe(normalizeForCompare('rule: be terse'))
  })
})

describe('tagsForRow', () => {
  it('always includes phase_5_review plus category and guest_state', () => {
    expect(tagsForRow(baseRow({ category: 'menu_fact', guest_state: 'regular' }))).toEqual([
      'phase_5_review',
      'menu_fact',
      'regular',
    ])
  })

  it('omits empty fields', () => {
    expect(tagsForRow(baseRow({ category: '', guest_state: 'new' }))).toEqual([
      'phase_5_review',
      'new',
    ])
  })
})

describe('parseReviewSheet', () => {
  const goodHeader =
    'sample_id,run_date,category,guest_state,scenario,inbound_message,generated_message,voice_fidelity,verdict,edited_message,comment'

  it('parses a sheet with header + data rows into typed objects', () => {
    const csv = `${goodHeader}\nmock-001,2026-04-28T17:00:00Z,menu_fact,new,test,hi,hey,0.9,approve,,`
    const rows = parseReviewSheet(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0].sample_id).toBe('mock-001')
    expect(rows[0].verdict).toBe('approve')
  })

  it('throws on header mismatch with helpful column-index detail', () => {
    const csv = 'sample_id,run_date,wrong_column,guest_state,scenario,inbound_message,generated_message,voice_fidelity,verdict,edited_message,comment\n'
    expect(() => parseReviewSheet(csv)).toThrow(/column 3.*expected "category".*got "wrong_column"/)
  })

  it('handles quoted fields with embedded commas and newlines', () => {
    const csv = `${goodHeader}\nmock-001,2026-04-28T17:00:00Z,menu_fact,new,"a, comma scenario",hi,"hey,\nthere",0.9,edit,"the edit, with comma",rule: be terse`
    const rows = parseReviewSheet(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0].inbound_message).toBe('hi')
    expect(rows[0].generated_message).toBe('hey,\nthere')
    expect(rows[0].edited_message).toBe('the edit, with comma')
    expect(rows[0].comment).toBe('rule: be terse')
  })

  it('returns empty array when the sheet has only the header row', () => {
    expect(parseReviewSheet(goodHeader)).toEqual([])
  })
})

describe('buildPhase5Subsection', () => {
  it('renders all three blocks when both anti-patterns and corpus entries are present', () => {
    const out = buildPhase5Subsection({
      timestampIso: '2026-04-28T17:42:00Z',
      newAntiPatterns: ['rule: be terse', "rule: don't use em-dashes"],
      newCorpusEntries: [
        {
          sample_id: 'mock-001',
          category: 'menu_fact',
          inbound_message: 'do you have oat?',
          generated_message: 'yeah we have oat and almond.',
          edited_message: 'yeah.',
        },
      ],
      sourceFileName: '08-mock-central-perk-response-review',
    })
    expect(out).toContain('### 2026-04-28T17:42:00Z')
    expect(out).toContain('**Anti-patterns added to `voiceAntiPatterns`:**')
    expect(out).toContain('- rule: be terse')
    expect(out).toContain("- rule: don't use em-dashes")
    expect(out).toContain('**Voice corpus additions (1 rows):**')
    expect(out).toContain('- `mock-001` — menu_fact')
    expect(out).toContain('  - inbound: "do you have oat?"')
    expect(out).toContain('  - generated: "yeah we have oat and almond."')
    expect(out).toContain('  - edited: "yeah."')
    expect(out).toContain('**Source:** `08-mock-central-perk-response-review` (gsheet)')
  })

  it('omits anti-patterns block when none added', () => {
    const out = buildPhase5Subsection({
      timestampIso: '2026-04-28T17:42:00Z',
      newAntiPatterns: [],
      newCorpusEntries: [
        {
          sample_id: 'mock-001',
          category: 'menu_fact',
          inbound_message: 'a',
          generated_message: 'b',
          edited_message: 'c',
        },
      ],
      sourceFileName: '08-foo',
    })
    expect(out).not.toContain('Anti-patterns added')
    expect(out).toContain('Voice corpus additions')
  })

  it('omits corpus block when no corpus entries', () => {
    const out = buildPhase5Subsection({
      timestampIso: '2026-04-28T17:42:00Z',
      newAntiPatterns: ['rule: be terse'],
      newCorpusEntries: [],
      sourceFileName: '08-foo',
    })
    expect(out).toContain('Anti-patterns added')
    expect(out).not.toContain('Voice corpus additions')
  })
})

describe('appendPhase5Section', () => {
  const subsection = '### 2026-04-28T17:42:00Z\n\n**Source:** `08-foo` (gsheet)'

  it('creates a new section with leading separator when none exists', () => {
    const existing = '# Venue Spec\n\nSome content.\n'
    const { newMarkdown, alreadyHadSection } = appendPhase5Section(existing, subsection)
    expect(alreadyHadSection).toBe(false)
    expect(newMarkdown).toContain('# Venue Spec\n\nSome content.\n\n---\n\n## Phase 5 review additions\n\n### 2026-04-28T17:42:00Z')
  })

  it('appends inside existing section with --- separator before the new subsection', () => {
    const existing =
      '# Spec\n\n## Phase 5 review additions\n\n### 2026-04-27T10:00:00Z\n\n**Source:** `08-foo` (gsheet)\n'
    const { newMarkdown, alreadyHadSection } = appendPhase5Section(existing, subsection)
    expect(alreadyHadSection).toBe(true)
    // First subsection comes before second.
    expect(newMarkdown.indexOf('2026-04-27')).toBeLessThan(newMarkdown.indexOf('2026-04-28'))
    expect(newMarkdown).toContain('---\n\n### 2026-04-28T17:42:00Z')
  })

  it('inserts before the next H2 when one follows the section', () => {
    const existing =
      '# Spec\n\n## Phase 5 review additions\n\n### 2026-04-27T10:00:00Z\n\n**Source:** `08-foo` (gsheet)\n\n## 9. Revision history\n\n- v01\n'
    const { newMarkdown } = appendPhase5Section(existing, subsection)
    expect(newMarkdown.indexOf('### 2026-04-28')).toBeLessThan(newMarkdown.indexOf('## 9. Revision history'))
  })

  it('only matches an exact "## Phase 5 review additions" header line', () => {
    // A heading that starts the same way but isn't exactly the section header
    // should not be treated as the section.
    const existing = '# Spec\n\n## Phase 5 review additions and notes\n\nbody\n'
    const { alreadyHadSection } = appendPhase5Section(existing, subsection)
    expect(alreadyHadSection).toBe(false)
  })
})