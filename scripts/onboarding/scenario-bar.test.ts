import { describe, expect, it } from 'vitest'
import { evaluateScenarioBar, evaluateSequenceBar } from './scenario-bar'
import type { DeterministicVoiceResult } from './grade-voice-deterministic'
import type { GradeScenarioResult } from './grade-scenario'
import type { RoutingGrade } from './grade-routing'

function makeGrade(overrides: Partial<GradeScenarioResult> = {}): GradeScenarioResult {
  return {
    promptVersion: 'grade-scenario-v3',
    knowledgeVerdict: 'correct',
    knowledgeReason: '',
    knowledgeQuote: '',
    voiceVerdict: 'pass',
    voiceReason: '',
    voiceQuote: '',
    expectedBehaviorVerdict: 'not_applicable',
    expectedBehaviorReason: '',
    inputTokens: 0,
    outputTokens: 0,
    model: 'claude-haiku-4-5-20251001',
    ...overrides,
  }
}

function makeDeterministic(overrides: Partial<DeterministicVoiceResult> = {}): DeterministicVoiceResult {
  return { pass: true, findings: [], ...overrides }
}

function makeRouting(overrides: Partial<RoutingGrade> = {}): RoutingGrade {
  return { verdict: 'pass', expectedRoute: 'send', actualRoute: 'send', ...overrides }
}

describe('evaluateScenarioBar', () => {
  it('passes when every axis is clean', () => {
    const result = evaluateScenarioBar({ deterministic: makeDeterministic(), grade: makeGrade(), routing: makeRouting() })
    expect(result).toEqual({ pass: true, failures: [] })
  })

  it('passes when knowledge is not_applicable, correctly_declined, correct, or incomplete', () => {
    for (const v of ['not_applicable', 'correctly_declined', 'correct', 'incomplete'] as const) {
      const result = evaluateScenarioBar({
        deterministic: makeDeterministic(),
        grade: makeGrade({ knowledgeVerdict: v }),
        routing: makeRouting(),
      })
      expect(result.pass).toBe(true)
    }
  })

  it('fails on a deterministic voice violation and names each finding', () => {
    const result = evaluateScenarioBar({
      deterministic: makeDeterministic({
        pass: false,
        findings: [{ check: 'dash', detail: 'em dash found' } as never],
      }),
      grade: makeGrade(),
      routing: makeRouting(),
    })
    expect(result.pass).toBe(false)
    expect(result.failures).toEqual(['deterministic voice check failed (dash): em dash found'])
  })

  it('fails on an LLM voice verdict of fail', () => {
    const result = evaluateScenarioBar({
      deterministic: makeDeterministic(),
      grade: makeGrade({ voiceVerdict: 'fail', voiceReason: 'too long' }),
      routing: makeRouting(),
    })
    expect(result.pass).toBe(false)
    expect(result.failures).toEqual(['voice grade: too long'])
  })

  it('fails on knowledgeVerdict wrong, invented, or should_have_declined', () => {
    for (const v of ['wrong', 'invented', 'should_have_declined'] as const) {
      const result = evaluateScenarioBar({
        deterministic: makeDeterministic(),
        grade: makeGrade({ knowledgeVerdict: v, knowledgeReason: 'fabricated a detail' }),
        routing: makeRouting(),
      })
      expect(result.pass).toBe(false)
      expect(result.failures).toEqual([`knowledge grade (${v}): fabricated a detail`])
    }
  })

  it('fails on expectedBehaviorVerdict fail', () => {
    const result = evaluateScenarioBar({
      deterministic: makeDeterministic(),
      grade: makeGrade({ expectedBehaviorVerdict: 'fail', expectedBehaviorReason: 'missed the 988 reference' }),
      routing: makeRouting(),
    })
    expect(result.pass).toBe(false)
    expect(result.failures).toEqual(['expected behavior: missed the 988 reference'])
  })

  it('fails on a routing mismatch', () => {
    const result = evaluateScenarioBar({
      deterministic: makeDeterministic(),
      grade: makeGrade(),
      routing: makeRouting({ verdict: 'fail', expectedRoute: 'queue', actualRoute: 'send' }),
    })
    expect(result.pass).toBe(false)
    expect(result.failures).toEqual(['routing: expected "queue", got "send"'])
  })

  it('passes when routing is not_applicable', () => {
    const result = evaluateScenarioBar({
      deterministic: makeDeterministic(),
      grade: makeGrade(),
      routing: makeRouting({ verdict: 'not_applicable', actualRoute: null }),
    })
    expect(result.pass).toBe(true)
  })

  it('combines failures across every failing axis at once', () => {
    const result = evaluateScenarioBar({
      deterministic: makeDeterministic({ pass: false, findings: [{ check: 'dash', detail: 'em dash found' } as never] }),
      grade: makeGrade({ knowledgeVerdict: 'invented', knowledgeReason: 'made up a price', expectedBehaviorVerdict: 'fail', expectedBehaviorReason: 'missed the safety line' }),
      routing: makeRouting({ verdict: 'fail', expectedRoute: 'queue', actualRoute: 'send' }),
    })
    expect(result.pass).toBe(false)
    expect(result.failures).toHaveLength(4)
  })
})

describe('evaluateSequenceBar', () => {
  it('passes when every turn passes', () => {
    const result = evaluateSequenceBar([{ pass: true, failures: [] }, { pass: true, failures: [] }])
    expect(result).toEqual({ pass: true, failures: [] })
  })

  it('fails and concatenates failures when any turn fails', () => {
    const result = evaluateSequenceBar([
      { pass: true, failures: [] },
      { pass: false, failures: ['turn 2: invented a fact'] },
      { pass: false, failures: ['turn 3: em dash'] },
    ])
    expect(result.pass).toBe(false)
    expect(result.failures).toEqual(['turn 2: invented a fact', 'turn 3: em dash'])
  })

  it('passes on an empty sequence', () => {
    expect(evaluateSequenceBar([])).toEqual({ pass: true, failures: [] })
  })
})
