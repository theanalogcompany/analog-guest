import { describe, expect, it } from 'vitest'
import { parseReviewSheet, SHEET_HEADERS } from './ingest-response-review-pure'
import { buildOwnerReviewRows, rowsToCsv } from './owner-review-sheet'
import type { GradedScenario } from './scorecard'
import type { ScenarioSheetRow } from './scenario-schema'

function scenario(overrides: Partial<ScenarioSheetRow> = {}): ScenarioSheetRow {
  return {
    sample_id: 'id-1',
    topic: 'menu_drinks',
    category: 'venue_topic',
    mode: 'graded',
    guest_state: 'new',
    scenario: 'guest asks about the oat milk latte',
    inbound_message: 'do you have oat milk?',
    expected_failure: null,
    scenario_source: 'venue_topic',
    expected_facts: [],
    forbidden_claims: [],
    source_row_ids: [],
    expected_route: 'send',
    expected_behavior: '',
    origin: 'generated',
    generated_hash: 'h',
    exclude: false,
    notes: '',
    ...overrides,
  }
}

function graded(overrides: Partial<GradedScenario> & { scenarioOverrides?: Partial<ScenarioSheetRow> } = {}): GradedScenario {
  const { scenarioOverrides, ...rest } = overrides
  return {
    scenario: scenario(scenarioOverrides),
    result: {
      sampleId: 'id-1',
      topic: 'menu_drinks',
      category: 'venue_topic',
      scenarioSource: 'venue_topic',
      mode: 'graded',
      guestState: 'new',
      inboundMessage: 'do you have oat milk?',
      expectedRoute: 'send',
      expectedBehavior: '',
      outcome: 'sent',
      replyBody: 'Yep, oat milk is available.',
      voiceFidelity: 0.85,
      route: 'send',
      triggers: [],
      primaryTrigger: null,
      wouldBlankBody: false,
      errorMessage: null,
      elapsedMs: 100,
      retrievedVoiceExamples: [],
      retrievedKnowledge: [],
    },
    deterministicVoice: { pass: true, findings: [] },
    llmGrade: {
      promptVersion: 'v1',
      knowledgeVerdict: 'correct',
      knowledgeReason: '',
      knowledgeQuote: '',
      voiceVerdict: 'pass',
      voiceReason: '',
      voiceQuote: '',
      expectedBehaviorVerdict: 'not_applicable',
      expectedBehaviorReason: '',
      inputTokens: 100,
      outputTokens: 50,
      model: 'claude-haiku-4-5-20251001',
    },
    routing: { verdict: 'pass', expectedRoute: 'send', actualRoute: 'send' },
    ...rest,
  }
}

describe('buildOwnerReviewRows', () => {
  it('header row matches SHEET_HEADERS exactly', () => {
    const rows = buildOwnerReviewRows([], '2026-09-11T18:42:00.000Z')
    expect(rows[0]).toEqual([...SHEET_HEADERS])
  })

  it('leaves verdict/edited_message/comment blank', () => {
    const rows = buildOwnerReviewRows([graded()], '2026-09-11T18:42:00.000Z')
    const idx = (col: (typeof SHEET_HEADERS)[number]) => SHEET_HEADERS.indexOf(col)
    const dataRow = rows[1]
    expect(dataRow[idx('verdict')]).toBe('')
    expect(dataRow[idx('edited_message')]).toBe('')
    expect(dataRow[idx('comment')]).toBe('')
  })

  it('maps scenario and result fields into the correct columns', () => {
    const rows = buildOwnerReviewRows([graded()], '2026-09-11T18:42:00.000Z')
    const idx = (col: (typeof SHEET_HEADERS)[number]) => SHEET_HEADERS.indexOf(col)
    const dataRow = rows[1]
    expect(dataRow[idx('sample_id')]).toBe('id-1')
    expect(dataRow[idx('run_date')]).toBe('2026-09-11T18:42:00.000Z')
    expect(dataRow[idx('category')]).toBe('venue_topic')
    expect(dataRow[idx('guest_state')]).toBe('new')
    expect(dataRow[idx('scenario')]).toBe('guest asks about the oat milk latte')
    expect(dataRow[idx('inbound_message')]).toBe('do you have oat milk?')
    expect(dataRow[idx('generated_message')]).toBe('Yep, oat milk is available.')
    expect(dataRow[idx('voice_fidelity')]).toBe('0.85')
  })

  it('renders a null voice_fidelity as an empty cell, not "null"', () => {
    const g = graded({ result: { ...graded().result, voiceFidelity: null } })
    const rows = buildOwnerReviewRows([g], '2026-09-11T18:42:00.000Z')
    const idx = SHEET_HEADERS.indexOf('voice_fidelity')
    expect(rows[1][idx]).toBe('')
  })
})

describe('rowsToCsv + parseReviewSheet round trip', () => {
  it('round-trips plain fields', () => {
    const rows = buildOwnerReviewRows([graded()], '2026-09-11T18:42:00.000Z')
    const parsed = parseReviewSheet(rowsToCsv(rows))
    expect(parsed).toHaveLength(1)
    expect(parsed[0].sample_id).toBe('id-1')
    expect(parsed[0].generated_message).toBe('Yep, oat milk is available.')
    expect(parsed[0].verdict).toBe('')
  })

  it('round-trips a generated_message containing a comma, a double quote, and a newline', () => {
    const tricky = 'It\'s "the best," honestly.\nCome try it.'
    const g = graded({ result: { ...graded().result, replyBody: tricky } })
    const rows = buildOwnerReviewRows([g], '2026-09-11T18:42:00.000Z')
    const parsed = parseReviewSheet(rowsToCsv(rows))
    expect(parsed[0].generated_message).toBe(tricky)
  })

  it('round-trips multiple rows without cross-contamination', () => {
    const a = graded({ scenarioOverrides: { sample_id: 'a' }, result: { ...graded().result, sampleId: 'a', replyBody: 'reply, with comma' } })
    const b = graded({ scenarioOverrides: { sample_id: 'b' }, result: { ...graded().result, sampleId: 'b', replyBody: 'plain reply' } })
    const rows = buildOwnerReviewRows([a, b], '2026-09-11T18:42:00.000Z')
    const parsed = parseReviewSheet(rowsToCsv(rows))
    expect(parsed).toHaveLength(2)
    expect(parsed[0].sample_id).toBe('a')
    expect(parsed[0].generated_message).toBe('reply, with comma')
    expect(parsed[1].sample_id).toBe('b')
    expect(parsed[1].generated_message).toBe('plain reply')
  })
})
