import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildExtractionSystemPrompt, MECHANIC_APPROVAL_CRITERIA } from './extract'
import {
  buildVerifySystemPrompt,
  countVoiceCorpusEntries,
  formatNeedsConfirmationSection,
  VerifyResultSchema,
  type VerifyResult,
} from './verify'

const EMPTY_RESULT: VerifyResult = {
  promptVersion: 'v1.0.0',
  unsupportedClaims: [],
  uncoveredAnswers: [],
  missingInformation: [],
  resolvedDates: [],
  mechanicApprovalReview: [],
}

describe('VerifyResultSchema', () => {
  it('accepts a fully-populated result', () => {
    const populated: VerifyResult = {
      promptVersion: 'v1.0.0',
      unsupportedClaims: [
        { section: '4. venue_info', claim: 'x', reason: 'not_in_source', sourceQuote: 'y' },
      ],
      uncoveredAnswers: [{ transcriptQuote: 'a', topic: 'b' }],
      missingInformation: [{ topic: 'a', description: 'b' }],
      resolvedDates: [
        { section: '5. mechanics', resolvedDate: '2026-01-01', sourceText: 'next month', anchorUsed: '2025-12-01' },
      ],
      mechanicApprovalReview: [
        { mechanicName: 'Test Perk', draftValue: true, sourceQuote: 'quote', recommendedValue: false },
      ],
    }
    expect(VerifyResultSchema.parse(populated)).toEqual(populated)
  })

  it('accepts a fully-empty result via array defaults', () => {
    const parsed = VerifyResultSchema.parse({ promptVersion: 'v1.0.0' })
    expect(parsed).toEqual(EMPTY_RESULT)
  })

  it('rejects an unsupportedClaims reason outside the closed enum', () => {
    const result = VerifyResultSchema.safeParse({
      promptVersion: 'v1.0.0',
      unsupportedClaims: [{ section: 'x', claim: 'y', reason: 'made_up_reason' }],
    })
    expect(result.success).toBe(false)
  })
})

describe('formatNeedsConfirmationSection', () => {
  it('renders an explicit placeholder for every empty subsection, and omits Voice corpus when the count is at or above the floor', () => {
    const section = formatNeedsConfirmationSection(EMPTY_RESULT, 8)
    expect(section).toContain('## Needs confirmation')
    expect(section).toContain('### Unsupported claims\n*(none flagged)*')
    expect(section).toContain('### Uncovered transcript answers\n*(none)*')
    expect(section).toContain('### Missing information\n*(none)*')
    expect(section).toContain('### Dates requiring confirmation\n*(none)*')
    expect(section).toContain('### Mechanic approval values\n*(no mechanics found)*')
    expect(section).not.toContain('### Voice corpus')
  })

  it('renders the Voice corpus subsection only when the count is below the floor', () => {
    const below = formatNeedsConfirmationSection(EMPTY_RESULT, 3)
    expect(below).toContain('### Voice corpus')
    expect(below).toContain('3 of 5 minimum real texting entries')

    const atFloor = formatNeedsConfirmationSection(EMPTY_RESULT, 5)
    expect(atFloor).not.toContain('### Voice corpus')
  })

  it('renders unsupported claims, uncovered answers, missing information, and dates when populated', () => {
    const result: VerifyResult = {
      ...EMPTY_RESULT,
      unsupportedClaims: [
        { section: '4. venue_info > menu.notes', claim: 'a claim', reason: 'generalized_beyond_source', sourceQuote: 'a quote' },
      ],
      uncoveredAnswers: [{ transcriptQuote: 'an answer', topic: 'a topic' }],
      missingInformation: [{ topic: 'a topic', description: 'a description' }],
      resolvedDates: [
        { section: '5. mechanics', resolvedDate: '2026-03-01', sourceText: 'next month', anchorUsed: '2026-02-01' },
      ],
    }
    const section = formatNeedsConfirmationSection(result, 8)
    expect(section).toContain('**[4. venue_info > menu.notes]** "a claim" — generalized beyond source. Source: "a quote"')
    expect(section).toContain('- "an answer" — a topic')
    expect(section).toContain('- a description')
    expect(section).toContain('**[5. mechanics]** resolved to 2026-03-01 — source: "next month" (anchor: 2026-02-01)')
  })

  it('lists every mechanic regardless of whether anything else is flagged, with "none, defaulted" when unquoted', () => {
    const result: VerifyResult = {
      ...EMPTY_RESULT,
      mechanicApprovalReview: [
        { mechanicName: 'Mechanic A', draftValue: true, sourceQuote: 'wants to decide personally' },
        { mechanicName: 'Mechanic B', draftValue: false },
      ],
    }
    const section = formatNeedsConfirmationSection(result, 8)
    expect(section).toContain('- **Mechanic A**: requires_operator_approval = **true** — "wants to decide personally"')
    expect(section).toContain('- **Mechanic B**: requires_operator_approval = **false** — none, defaulted')
  })

  it('renders the mismatch marker only when recommendedValue is set and differs from draftValue', () => {
    const agreeing: VerifyResult = {
      ...EMPTY_RESULT,
      mechanicApprovalReview: [{ mechanicName: 'Agrees', draftValue: true, recommendedValue: true }],
    }
    expect(formatNeedsConfirmationSection(agreeing, 8)).not.toContain('⚠')

    const disagreeing: VerifyResult = {
      ...EMPTY_RESULT,
      mechanicApprovalReview: [{ mechanicName: 'Disagrees', draftValue: false, recommendedValue: true }],
    }
    const section = formatNeedsConfirmationSection(disagreeing, 8)
    expect(section).toContain('⚠ possible mismatch — transcript suggests true')
  })
})

describe('buildVerifySystemPrompt', () => {
  const prompt = buildVerifySystemPrompt()

  it('names all four unsupported-claim reason categories', () => {
    expect(prompt).toContain('not_in_source')
    expect(prompt).toContain('hedged_in_source')
    expect(prompt).toContain('generalized_beyond_source')
    expect(prompt).toContain('brainstorm_not_practice')
  })

  it('instructs reporting brainstormed mechanic ideas and handoff/routing statements under uncovered answers, not as a destination extraction should target', () => {
    expect(prompt).toContain('brainstormed or hypothetical ideas')
    expect(prompt).toContain('handoff or routing instructions')
  })

  it('instructs listing every mechanic regardless of whether anything else is flagged', () => {
    expect(prompt).toContain('List every mechanic, regardless of whether anything else is flagged about it.')
  })

  it('instructs listing every resolved date, not just disputed ones', () => {
    expect(prompt).toContain('List every resolved date, not just ones you think are wrong')
  })

  // TAC-346 change #7: verify's own worked examples must stay fully generic —
  // no venue-specific vocabulary from any real onboarded venue, matching the
  // TAC-331 leak-canary precedent for extract.ts's fixture.
  it('contains no venue-specific vocabulary from a real onboarded venue', () => {
    expect(prompt).not.toContain('Parle-G')
    expect(prompt).not.toContain('Spade')
    expect(prompt.toLowerCase()).not.toContain('le mil')
  })
})

// TAC-346 fix: verify's first version invented its own looser standard for
// mechanicApprovalReview ("is this an established practice?") instead of
// applying extraction's actual rule, and recommended `false` on a mechanic
// the owner had explicitly confirmed needs his personal approval — because
// the practice was established/recurring, which decides whether something
// is a mechanic at all, not whether granting it needs approval. Fixed by
// sharing MECHANIC_APPROVAL_CRITERIA verbatim between both prompts.
describe('buildVerifySystemPrompt — mechanic approval criteria (TAC-346 fix)', () => {
  const prompt = buildVerifySystemPrompt()

  it('embeds the exact same MECHANIC_APPROVAL_CRITERIA constant extract.ts uses', () => {
    expect(prompt).toContain(MECHANIC_APPROVAL_CRITERIA)
  })

  it('instructs applying the IDENTICAL criteria extraction uses, not an independently invented standard', () => {
    expect(prompt).toContain('IDENTICAL criteria extraction is instructed to apply')
  })

  it('states that an established, recurring, or ongoing practice is never by itself grounds for false', () => {
    expect(prompt).toContain('is NEVER by itself a reason for false')
  })

  // Canary: guards against reverting to the pre-fix instruction, which had
  // no explicit narrow-grounds-for-false statement and let the model reach
  // for "is this established?" as an implicit stand-in.
  it('does not reintroduce the pre-fix vague "decide personally" instruction with no narrow false condition', () => {
    expect(prompt).not.toContain(
      'give your own independent read of what the transcript says about whether the operator wants to decide personally',
    )
  })
})

describe('MECHANIC_APPROVAL_CRITERIA cross-file consistency (TAC-346 fix)', () => {
  it('is embedded verbatim in both buildExtractionSystemPrompt and buildVerifySystemPrompt', () => {
    const extractPrompt = buildExtractionSystemPrompt('')
    const verifyPrompt = buildVerifySystemPrompt()
    expect(extractPrompt).toContain(MECHANIC_APPROVAL_CRITERIA)
    expect(verifyPrompt).toContain(MECHANIC_APPROVAL_CRITERIA)
  })

  it('narrows false to the explicit staff-or-agent-can-grant-freely condition only', () => {
    expect(MECHANIC_APPROVAL_CRITERIA).toContain(
      'requires_operator_approval=false ONLY when the transcript explicitly says staff or the agent can grant it freely',
    )
  })

  it('rules out established/recurring/ongoing as grounds for false', () => {
    expect(MECHANIC_APPROVAL_CRITERIA).toContain('established, recurring, or already happening regularly is NEVER')
  })
})

describe('countVoiceCorpusEntries', () => {
  function draftWithVoiceCorpusEntries(n: number, trailingSection?: string): string {
    const entries = Array.from(
      { length: n },
      (_, i) => '```json\n' + JSON.stringify({ source_type: 'voicenote_transcript', content: `entry ${i}` }) + '\n```',
    ).join('\n\n')
    return ['## 5. mechanics', '', '## 6. voice_corpus', '', entries, '', trailingSection ?? ''].join('\n')
  }

  it('returns 0 when the draft has no voice_corpus entries', () => {
    expect(countVoiceCorpusEntries(draftWithVoiceCorpusEntries(0))).toBe(0)
  })

  it('counts a partial corpus below the floor', () => {
    expect(countVoiceCorpusEntries(draftWithVoiceCorpusEntries(3))).toBe(3)
  })

  it('counts exactly at the floor', () => {
    expect(countVoiceCorpusEntries(draftWithVoiceCorpusEntries(5))).toBe(5)
  })

  it('returns 0 when the "## 6. voice_corpus" heading is absent entirely', () => {
    expect(countVoiceCorpusEntries('## 5. mechanics\n\nno voice corpus section here')).toBe(0)
  })

  it('does not leak a knowledge_corpus json block into the voice_corpus count', () => {
    const draft = draftWithVoiceCorpusEntries(
      3,
      ['## 7. knowledge_corpus', '', '```json', JSON.stringify({ content: 'a knowledge chunk' }), '```'].join('\n'),
    )
    expect(countVoiceCorpusEntries(draft)).toBe(3)
  })
})

// TAC-346 change #7: check the schema's optional-field count against the
// TAC-300 tool-schema limit. Mirrors lib/ai/schema-budget.test.ts's counting
// algorithm (duplicated locally rather than imported — that file's helper
// isn't exported, and this schema is small enough that a shared extraction
// isn't worth doing for this ticket's scope).
describe('VerifyModelOutputSchema optional-field budget (TAC-300)', () => {
  const OPTIONAL_FIELD_BUDGET = 22

  type JsonSchemaNode = {
    properties?: Record<string, JsonSchemaNode>
    required?: string[]
    items?: JsonSchemaNode | JsonSchemaNode[]
    anyOf?: JsonSchemaNode[]
    oneOf?: JsonSchemaNode[]
    allOf?: JsonSchemaNode[]
  }

  function countOptionalsInJsonSchema(node: JsonSchemaNode): number {
    let count = 0
    if (node.properties) {
      const required = new Set(node.required ?? [])
      for (const [name, child] of Object.entries(node.properties)) {
        if (!required.has(name)) count += 1
        count += countOptionalsInJsonSchema(child)
      }
    }
    if (node.items) {
      const items = Array.isArray(node.items) ? node.items : [node.items]
      for (const item of items) count += countOptionalsInJsonSchema(item)
    }
    const unionBranches = node.anyOf ?? node.oneOf
    if (unionBranches && unionBranches.length > 0) {
      count += Math.max(...unionBranches.map(countOptionalsInJsonSchema))
    }
    if (node.allOf) {
      for (const branch of node.allOf) count += countOptionalsInJsonSchema(branch)
    }
    return count
  }

  it(`stays well below the ${OPTIONAL_FIELD_BUDGET}-field budget (Anthropic cap is 24) — the schema passed to generateObject has no promptVersion field`, () => {
    // Reconstruct the model-facing schema shape (VerifyModelOutputSchema is
    // not exported — promptVersion is stapled on after the call, per the
    // GeneratedMessageSchema precedent, so it must not count here).
    const modelFacingSchema = VerifyResultSchema.omit({ promptVersion: true })
    const jsonSchema = z.toJSONSchema(modelFacingSchema) as JsonSchemaNode
    const count = countOptionalsInJsonSchema(jsonSchema)
    expect(count).toBeLessThanOrEqual(OPTIONAL_FIELD_BUDGET)
    // Pinned, not just bounded — see lib/ai/schema-budget.test.ts's own
    // comment on why a silent drift toward the cap should be a deliberate
    // decision, not something a future field-add slides past unnoticed.
    // Empirically 4, not the top-level array count: z.toJSONSchema does not
    // exclude `.default([])` fields from `required` the way it does for
    // `.optional()` — only the four genuinely-optional leaf fields
    // (UnsupportedClaim.sourceQuote, ResolvedDate.anchorUsed,
    // MechanicApprovalReview.sourceQuote + recommendedValue) count.
    expect(count, 'optional-field count changed — recount and update deliberately if a field was added').toBe(4)
  })
})
