import { describe, expect, it } from 'vitest'
import {
  appendTurnToHistory,
  buildSeedHistory,
  deriveReceivedBody,
  toScenarioSheetRow,
} from './scenario-sequence-pure'
import type { Scenario } from './scenario-schema'
import type { ScenarioResult } from './run-test-scenarios'

function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    sample_id: 'turn-1',
    topic: 'orders',
    category: 'personal_history_question',
    mode: 'graded',
    guest_state: 'new',
    scenario: 'guest asks what they ordered',
    inbound_message: 'what did i ask?',
    expected_failure: null,
    scenario_source: 'edge_case',
    expected_facts: [],
    forbidden_claims: [],
    source_row_ids: [],
    expected_route: 'send',
    expected_behavior: '',
    ...overrides,
  }
}

function makeResult(overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    sampleId: 'turn-1',
    topic: 'orders',
    category: 'personal_history_question',
    scenarioSource: 'edge_case',
    mode: 'graded',
    guestState: 'new',
    inboundMessage: 'what did i ask?',
    expectedRoute: 'send',
    expectedBehavior: '',
    outcome: 'sent',
    replyBody: 'you asked about your last order',
    voiceFidelity: 0.9,
    route: 'send',
    triggers: [],
    primaryTrigger: null,
    wouldBlankBody: false,
    errorMessage: null,
    elapsedMs: 100,
    retrievedVoiceExamples: [],
    retrievedKnowledge: [],
    ...overrides,
  }
}

describe('toScenarioSheetRow', () => {
  it('fills the sheet-merge provenance fields with fixed literals', () => {
    const row = toScenarioSheetRow(makeScenario())
    expect(row.origin).toBe('owner')
    expect(row.generated_hash).toBe('')
    expect(row.exclude).toBe(false)
    expect(row.notes).toBe('')
    expect(row.sample_id).toBe('turn-1')
  })
})

describe('buildSeedHistory', () => {
  it('produces an empty array for an empty seed', () => {
    expect(buildSeedHistory([], new Date('2026-09-18T12:00:00.000Z'))).toEqual([])
  })

  it('orders seed lines oldest-first, strictly before `now`, each with the given direction/body/delivery', () => {
    const now = new Date('2026-09-18T12:00:00.000Z')
    const history = buildSeedHistory(
      [
        { direction: 'outbound', body: 'still tracking that down, sorry for the wait.', delivery: 'delivered' },
        { direction: 'inbound', body: 'tracking what?', delivery: 'delivered' },
      ],
      now,
    )
    expect(history).toHaveLength(2)
    expect(history[0].body).toBe('still tracking that down, sorry for the wait.')
    expect(history[1].body).toBe('tracking what?')
    expect(history[0].createdAt.getTime()).toBeLessThan(history[1].createdAt.getTime())
    expect(history[1].createdAt.getTime()).toBeLessThan(now.getTime())
  })
})

describe('deriveReceivedBody', () => {
  it('returns the reply body when the outcome is sent', () => {
    expect(deriveReceivedBody(makeResult({ outcome: 'sent', replyBody: 'hi there' }))).toBe('hi there')
  })

  it('returns null for queued, dropped, refused, and failed outcomes', () => {
    for (const outcome of ['queued', 'dropped', 'refused', 'failed'] as const) {
      expect(deriveReceivedBody(makeResult({ outcome, replyBody: 'drafted but not delivered' }))).toBeNull()
    }
  })
})

describe('appendTurnToHistory', () => {
  const now = new Date('2026-09-18T12:00:00.000Z')

  it('always appends the guest inbound as delivered', () => {
    const history = appendTurnToHistory([], makeScenario(), makeResult({ outcome: 'dropped', replyBody: null }), now)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ direction: 'inbound', body: 'what did i ask?', delivery: 'delivered' })
  })

  it('appends a delivered outbound reply on a sent outcome', () => {
    const history = appendTurnToHistory([], makeScenario(), makeResult({ outcome: 'sent', replyBody: 'you asked X' }), now)
    expect(history).toHaveLength(2)
    expect(history[1]).toMatchObject({ direction: 'outbound', body: 'you asked X', delivery: 'delivered' })
  })

  it('appends an awaiting_review outbound with the drafted body on a queued outcome', () => {
    const history = appendTurnToHistory(
      [],
      makeScenario(),
      makeResult({ outcome: 'queued', replyBody: 'draft body', wouldBlankBody: false }),
      now,
    )
    expect(history[1]).toMatchObject({ direction: 'outbound', body: 'draft body', delivery: 'awaiting_review' })
  })

  it('blanks the awaiting_review body when wouldBlankBody is true (TAC-309 knowledge_gap cards)', () => {
    const history = appendTurnToHistory(
      [],
      makeScenario(),
      makeResult({ outcome: 'queued', replyBody: 'the model’s guess', wouldBlankBody: true }),
      now,
    )
    expect(history[1]).toMatchObject({ direction: 'outbound', body: '', delivery: 'awaiting_review' })
  })

  it('appends nothing on the venue side for dropped, refused, or failed outcomes — production leaves no row', () => {
    for (const outcome of ['dropped', 'refused', 'failed'] as const) {
      const history = appendTurnToHistory([], makeScenario(), makeResult({ outcome, replyBody: 'x' }), now)
      expect(history).toHaveLength(1) // inbound only
    }
  })

  it('preserves prior history and appends after it', () => {
    const prior = buildSeedHistory([{ direction: 'outbound', body: 'seed line', delivery: 'delivered' }], now)
    const history = appendTurnToHistory(prior, makeScenario(), makeResult({ outcome: 'sent', replyBody: 'reply' }), now)
    expect(history).toHaveLength(3)
    expect(history[0].body).toBe('seed line')
  })
})
