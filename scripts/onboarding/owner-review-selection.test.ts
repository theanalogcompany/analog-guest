import { describe, expect, it } from 'vitest'
import {
  classifyOwnerReviewSituation,
  isExcludedFromOwnerReview,
  OWNER_REVIEW_FINAL_CAP,
  pickDiverseForOwnerReview,
  selectOwnerReviewCandidates,
  selectOwnerReviewFinal,
} from './owner-review-selection'
import type { GradedScenario } from './scorecard'
import type { GuestState, ScenarioSheetRow } from './scenario-schema'

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

describe('isExcludedFromOwnerReview', () => {
  it('excludes adversarial scenario_source', () => {
    expect(isExcludedFromOwnerReview({ category: 'adversarial_prompt_injection', scenario_source: 'adversarial' })).toBe(true)
  })
  it('excludes adversarial_safety_critical category even if scenario_source differs', () => {
    expect(isExcludedFromOwnerReview({ category: 'adversarial_safety_critical', scenario_source: 'venue_topic' })).toBe(true)
  })
  it('excludes unanswerable via scenario_source or category', () => {
    expect(isExcludedFromOwnerReview({ category: 'unanswerable', scenario_source: 'unanswerable' })).toBe(true)
    expect(isExcludedFromOwnerReview({ category: 'something_else', scenario_source: 'unanswerable' })).toBe(true)
  })
  it('does not exclude ordinary content', () => {
    expect(isExcludedFromOwnerReview({ category: 'venue_topic', scenario_source: 'venue_topic' })).toBe(false)
    expect(isExcludedFromOwnerReview({ category: 'mechanic', scenario_source: 'mechanic' })).toBe(false)
    expect(isExcludedFromOwnerReview({ category: 'complaint_mild', scenario_source: 'complaint' })).toBe(false)
  })
})

describe('classifyOwnerReviewSituation', () => {
  it('classifies mechanic scenarios as perk_request via exact signal', () => {
    expect(classifyOwnerReviewSituation({ topic: 'anything', category: 'mechanic', scenario_source: 'mechanic' })).toBe('perk_request')
  })
  it('classifies complaint scenarios via exact signal', () => {
    expect(classifyOwnerReviewSituation({ topic: 'anything', category: 'complaint_severe', scenario_source: 'complaint' })).toBe(
      'complaint',
    )
  })
  it('classifies via topic/category keywords for greeting/recommendation/menu_question', () => {
    expect(classifyOwnerReviewSituation({ topic: 'greeting_and_welcome', category: 'venue_topic', scenario_source: 'venue_topic' })).toBe(
      'greeting',
    )
    expect(
      classifyOwnerReviewSituation({ topic: 'what should i order', category: 'venue_topic', scenario_source: 'venue_topic' }),
    ).toBe('recommendation')
    expect(classifyOwnerReviewSituation({ topic: 'menu_dietary', category: 'venue_topic', scenario_source: 'venue_topic' })).toBe(
      'menu_question',
    )
  })
  it('falls back to other when nothing matches', () => {
    expect(classifyOwnerReviewSituation({ topic: 'wifi_password', category: 'venue_topic', scenario_source: 'venue_topic' })).toBe(
      'other',
    )
  })
})

describe('pickDiverseForOwnerReview', () => {
  interface Item {
    id: string
    situation: 'greeting' | 'recommendation' | 'menu_question' | 'complaint' | 'perk_request' | 'other'
    state: GuestState
  }
  const describe_ = (i: Item) => ({ sampleId: i.id, situation: i.situation, guestState: i.state })

  it('is deterministic given the same input twice', () => {
    const items: Item[] = [
      { id: 'c', situation: 'other', state: 'new' },
      { id: 'a', situation: 'menu_question', state: 'regular' },
      { id: 'b', situation: 'other', state: 'returning' },
    ]
    const first = pickDiverseForOwnerReview(items, describe_, 10).map((i) => i.id)
    const second = pickDiverseForOwnerReview([...items].reverse(), describe_, 10).map((i) => i.id)
    expect(first).toEqual(second)
  })

  it('respects the cap', () => {
    const items: Item[] = Array.from({ length: 50 }, (_, i) => ({
      id: `id-${i}`,
      situation: 'other',
      state: 'new',
    }))
    expect(pickDiverseForOwnerReview(items, describe_, 10)).toHaveLength(10)
  })

  it('returns everything when fewer items than cap exist', () => {
    const items: Item[] = [
      { id: 'a', situation: 'greeting', state: 'new' },
      { id: 'b', situation: 'other', state: 'regular' },
    ]
    expect(pickDiverseForOwnerReview(items, describe_, 30)).toHaveLength(2)
  })

  it('gives every named situation at least one pick when each has candidates and cap allows it', () => {
    const items: Item[] = [
      { id: 'g1', situation: 'greeting', state: 'new' },
      { id: 'r1', situation: 'recommendation', state: 'new' },
      { id: 'm1', situation: 'menu_question', state: 'new' },
      { id: 'c1', situation: 'complaint', state: 'new' },
      { id: 'p1', situation: 'perk_request', state: 'new' },
      ...Array.from({ length: 20 }, (_, i) => ({ id: `o${i}`, situation: 'other' as const, state: 'new' as const })),
    ]
    const picked = pickDiverseForOwnerReview(items, describe_, 10).map((i) => i.id)
    expect(picked).toEqual(expect.arrayContaining(['g1', 'r1', 'm1', 'c1', 'p1']))
  })

  it('interleaves guest states within a bucket so state variety survives a quota cap', () => {
    const items: Item[] = [
      { id: 'n1', situation: 'menu_question', state: 'new' },
      { id: 'n2', situation: 'menu_question', state: 'new' },
      { id: 'n3', situation: 'menu_question', state: 'new' },
      { id: 'r1', situation: 'menu_question', state: 'regular' },
    ]
    // cap=1 named quota bucket picks the first of the interleaved order,
    // which should prefer state variety over exhausting 'new' first.
    const picked = pickDiverseForOwnerReview(items, describe_, 2).map((i) => i.id)
    expect(picked).toContain('r1')
  })

  it('backfills from other buckets once named situations are exhausted', () => {
    const items: Item[] = [
      { id: 'g1', situation: 'greeting', state: 'new' },
      ...Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, situation: 'other' as const, state: 'new' as const })),
    ]
    const picked = pickDiverseForOwnerReview(items, describe_, 5)
    expect(picked).toHaveLength(5)
    expect(picked.map((i) => i.id)).toContain('g1')
  })
})

describe('selectOwnerReviewCandidates', () => {
  it('excludes banned scenarios before selecting', () => {
    const rows = [
      scenario({ sample_id: 'a', category: 'adversarial_safety_critical', scenario_source: 'adversarial' }),
      scenario({ sample_id: 'b', category: 'unanswerable', scenario_source: 'unanswerable' }),
      scenario({ sample_id: 'c', category: 'venue_topic', scenario_source: 'venue_topic' }),
    ]
    const picked = selectOwnerReviewCandidates(rows, 10).map((r) => r.sample_id)
    expect(picked).toEqual(['c'])
  })
})

describe('selectOwnerReviewFinal', () => {
  it('excludes scenarios with no reply body', () => {
    const g = graded({ result: { ...graded().result, replyBody: null } })
    expect(selectOwnerReviewFinal([g])).toHaveLength(0)
  })

  it('excludes dropped-route scenarios (TAC-308 knowledge-gap protection)', () => {
    const g = graded({ result: { ...graded().result, route: 'drop' } })
    expect(selectOwnerReviewFinal([g])).toHaveLength(0)
  })

  it('excludes scenarios whose body would be blanked in production (TAC-309)', () => {
    const g = graded({ result: { ...graded().result, wouldBlankBody: true } })
    expect(selectOwnerReviewFinal([g])).toHaveLength(0)
  })

  it('excludes scenarios that failed knowledge or routing grading', () => {
    const knowledgeFail = graded({ llmGrade: { ...graded().llmGrade, knowledgeVerdict: 'wrong' } })
    const routingFail = graded({ routing: { verdict: 'fail', expectedRoute: 'send', actualRoute: 'queue' } })
    expect(selectOwnerReviewFinal([knowledgeFail])).toHaveLength(0)
    expect(selectOwnerReviewFinal([routingFail])).toHaveLength(0)
  })

  it('includes scenarios with not_applicable knowledge/routing verdicts (null is not a failure)', () => {
    const g = graded({
      llmGrade: { ...graded().llmGrade, knowledgeVerdict: 'not_applicable' },
      routing: { verdict: 'not_applicable', expectedRoute: 'unknown', actualRoute: 'send' },
    })
    expect(selectOwnerReviewFinal([g])).toHaveLength(1)
  })

  it('caps at OWNER_REVIEW_FINAL_CAP', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      graded({ scenarioOverrides: { sample_id: `id-${i}` }, result: { ...graded().result, sampleId: `id-${i}` } }),
    )
    expect(selectOwnerReviewFinal(rows)).toHaveLength(OWNER_REVIEW_FINAL_CAP)
  })
})
