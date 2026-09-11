import { describe, expect, it } from 'vitest'
import {
  buildReviewList,
  computeTopicPassRates,
  knowledgePassed,
  routingPassed,
  sampleForGraderSpotCheck,
  sampleForVoiceRead,
  voicePassed,
  type GradedScenario,
} from './scorecard'
import type { ScenarioSheetRow } from './scenario-schema'

function scenario(overrides: Partial<ScenarioSheetRow> = {}): ScenarioSheetRow {
  return {
    sample_id: 'id-1',
    topic: 'menu_drinks',
    category: 'venue_topic',
    mode: 'graded',
    guest_state: 'new',
    scenario: 'test scenario',
    inbound_message: 'hi',
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
      inboundMessage: 'hi',
      expectedRoute: 'send',
      expectedBehavior: '',
      outcome: 'sent',
      replyBody: 'a reply',
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

describe('pass predicates', () => {
  it('knowledgePassed is null for not_applicable', () => {
    const g = graded({ llmGrade: { ...graded().llmGrade, knowledgeVerdict: 'not_applicable' } })
    expect(knowledgePassed(g)).toBeNull()
  })

  it('knowledgePassed is true for correct and correctly_declined', () => {
    expect(knowledgePassed(graded({ llmGrade: { ...graded().llmGrade, knowledgeVerdict: 'correct' } }))).toBe(true)
    expect(knowledgePassed(graded({ llmGrade: { ...graded().llmGrade, knowledgeVerdict: 'correctly_declined' } }))).toBe(true)
  })

  it('knowledgePassed is false for wrong/invented/incomplete/should_have_declined', () => {
    for (const v of ['wrong', 'invented', 'incomplete', 'should_have_declined'] as const) {
      expect(knowledgePassed(graded({ llmGrade: { ...graded().llmGrade, knowledgeVerdict: v } }))).toBe(false)
    }
  })

  it('voicePassed requires both deterministic and LLM voice to pass', () => {
    expect(voicePassed(graded())).toBe(true)
    expect(
      voicePassed(graded({ deterministicVoice: { pass: false, findings: [{ check: 'dash', detail: 'x' }] } })),
    ).toBe(false)
    expect(voicePassed(graded({ llmGrade: { ...graded().llmGrade, voiceVerdict: 'fail' } }))).toBe(false)
  })

  it('routingPassed is null for not_applicable', () => {
    expect(
      routingPassed(graded({ routing: { verdict: 'not_applicable', expectedRoute: 'unknown', actualRoute: null } })),
    ).toBeNull()
  })
})

describe('computeTopicPassRates', () => {
  it('computes a 100% pass rate for an all-passing topic', () => {
    const rates = computeTopicPassRates([graded(), graded({ scenarioOverrides: { sample_id: 'id-2' } })])
    expect(rates).toHaveLength(1)
    expect(rates[0].topic).toBe('menu_drinks')
    expect(rates[0].total).toBe(2)
    expect(rates[0].knowledgePassRate).toBe(1)
    expect(rates[0].voicePassRate).toBe(1)
    expect(rates[0].routingPassRate).toBe(1)
  })

  it('splits by topic and computes independent rates', () => {
    const passing = graded({ scenarioOverrides: { topic: 'a', sample_id: 'a1' } })
    const failing = graded({
      scenarioOverrides: { topic: 'b', sample_id: 'b1' },
      llmGrade: { ...graded().llmGrade, knowledgeVerdict: 'wrong' },
    })
    const rates = computeTopicPassRates([passing, failing])
    const a = rates.find((r) => r.topic === 'a')!
    const b = rates.find((r) => r.topic === 'b')!
    expect(a.knowledgePassRate).toBe(1)
    expect(b.knowledgePassRate).toBe(0)
  })

  it('reports null knowledgePassRate when every scenario in the topic is not_applicable', () => {
    const g = graded({ llmGrade: { ...graded().llmGrade, knowledgeVerdict: 'not_applicable' } })
    const rates = computeTopicPassRates([g])
    expect(rates[0].knowledgePassRate).toBeNull()
  })
})

describe('buildReviewList', () => {
  it('is empty when everything passes', () => {
    expect(buildReviewList([graded()])).toEqual([])
  })

  it('ranks an unapproved mechanic commitment above everything, including an expected_behavior fail', () => {
    const behaviorFail = graded({
      scenarioOverrides: { sample_id: 'safety-1' },
      llmGrade: { ...graded().llmGrade, expectedBehaviorVerdict: 'fail', expectedBehaviorReason: 'missed 988' },
    })
    const unapproved = graded({
      scenarioOverrides: { sample_id: 'mechanic-1', scenario_source: 'mechanic', expected_route: 'queue' },
      result: { ...graded().result, route: 'send' },
      routing: { verdict: 'fail', expectedRoute: 'queue', actualRoute: 'send' },
    })
    const list = buildReviewList([behaviorFail, unapproved])
    expect(list.map((i) => i.sampleId)).toEqual(['mechanic-1', 'safety-1'])
    expect(list[0].severity).toBe('unapproved_commitment')
  })

  it('does not double-count an unapproved commitment as a plain routing_fail too', () => {
    const unapproved = graded({
      scenarioOverrides: { sample_id: 'mechanic-1', scenario_source: 'mechanic', expected_route: 'queue' },
      result: { ...graded().result, route: 'send' },
      routing: { verdict: 'fail', expectedRoute: 'queue', actualRoute: 'send' },
    })
    const list = buildReviewList([unapproved])
    expect(list).toHaveLength(1)
  })

  it('a mechanic scenario that correctly queued is not flagged as an unapproved commitment', () => {
    const correct = graded({
      scenarioOverrides: { sample_id: 'mechanic-1', scenario_source: 'mechanic', expected_route: 'queue' },
      result: { ...graded().result, route: 'queue' },
      routing: { verdict: 'pass', expectedRoute: 'queue', actualRoute: 'queue' },
    })
    expect(buildReviewList([correct])).toEqual([])
  })

  it('ranks an expected_behavior fail at the top severity, above invented facts', () => {
    const invented = graded({
      scenarioOverrides: { sample_id: 'invented-1' },
      llmGrade: { ...graded().llmGrade, knowledgeVerdict: 'invented' },
    })
    const behaviorFail = graded({
      scenarioOverrides: { sample_id: 'safety-1' },
      llmGrade: { ...graded().llmGrade, expectedBehaviorVerdict: 'fail', expectedBehaviorReason: 'missed 988' },
    })
    const list = buildReviewList([invented, behaviorFail])
    expect(list.map((i) => i.sampleId)).toEqual(['safety-1', 'invented-1'])
    expect(list[0].severity).toBe('expected_behavior_fail')
  })

  it('sorts invented facts above voice failures', () => {
    const voiceFail = graded({
      scenarioOverrides: { sample_id: 'voice-1' },
      deterministicVoice: { pass: false, findings: [{ check: 'dash', detail: 'has a dash' }] },
    })
    const invented = graded({
      scenarioOverrides: { sample_id: 'invented-1' },
      llmGrade: { ...graded().llmGrade, knowledgeVerdict: 'invented' },
    })
    const list = buildReviewList([voiceFail, invented])
    expect(list.map((i) => i.sampleId)).toEqual(['invented-1', 'voice-1'])
  })

  it('caps the review list at maxItems', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      graded({
        scenarioOverrides: { sample_id: `voice-${i}` },
        deterministicVoice: { pass: false, findings: [{ check: 'dash', detail: 'x' }] },
      }),
    )
    expect(buildReviewList(many, 3)).toHaveLength(3)
  })
})

describe('sampleForVoiceRead', () => {
  it('never exceeds the requested count', () => {
    const items = Array.from({ length: 30 }, (_, i) => graded({ scenarioOverrides: { sample_id: `id-${i}` } }))
    expect(sampleForVoiceRead(items, 20)).toHaveLength(20)
  })

  it('returns fewer than requested when there are not enough scenarios with a reply', () => {
    const items = [graded(), graded({ scenarioOverrides: { sample_id: 'id-2' }, result: { ...graded().result, replyBody: null } })]
    expect(sampleForVoiceRead(items, 20)).toHaveLength(1)
  })

  it('spreads across topics before repeating within one topic', () => {
    const items = [
      ...Array.from({ length: 5 }, (_, i) => graded({ scenarioOverrides: { topic: 'a', sample_id: `a-${i}` } })),
      graded({ scenarioOverrides: { topic: 'b', sample_id: 'b-0' } }),
    ]
    const sample = sampleForVoiceRead(items, 2)
    const topics = sample.map((g) => g.scenario.topic)
    expect(topics).toContain('a')
    expect(topics).toContain('b')
  })
})

describe('sampleForGraderSpotCheck', () => {
  it('never exceeds the requested count', () => {
    const items = Array.from({ length: 30 }, (_, i) => graded({ scenarioOverrides: { sample_id: `id-${i}` } }))
    expect(sampleForGraderSpotCheck(items, 10)).toHaveLength(10)
  })

  it('is deterministic for a fixed seed', () => {
    const items = Array.from({ length: 30 }, (_, i) => graded({ scenarioOverrides: { sample_id: `id-${i}` } }))
    const a = sampleForGraderSpotCheck(items, 10, 42).map((g) => g.scenario.sample_id)
    const b = sampleForGraderSpotCheck(items, 10, 42).map((g) => g.scenario.sample_id)
    expect(a).toEqual(b)
  })
})
