import { describe, expect, it } from 'vitest'
import {
  buildMergedMetaEntries,
  scenarioRowToValues,
  valuesToScenarioRow,
} from './merge-scenario-sheet-serialize'
import { stampFreshRows } from './merge-scenario-sheet-pure'
import type { Scenario, ScenarioSheetRow } from './scenario-schema'

const baseScenario = (overrides: Partial<Scenario> = {}): Scenario => ({
  sample_id: 'venue_topic:story:1',
  topic: 'story_and_sourcing',
  category: 'venue_topic',
  mode: 'graded',
  guest_state: 'new',
  scenario: 'asks about bean origin',
  inbound_message: 'where do your beans come from',
  expected_failure: null,
  scenario_source: 'venue_topic',
  expected_facts: ['sourced from a farm in Guatemala', 'family-run since 1998'],
  forbidden_claims: ['organic certified'],
  source_row_ids: ['kc-1', 'kc-2'],
  expected_route: 'unknown',
  expected_behavior: '',
  ...overrides,
})

describe('scenarioRowToValues / valuesToScenarioRow round-trip', () => {
  const HEADER = [
    'id',
    'topic',
    'category',
    'mode',
    'guest_state',
    'message',
    'key_facts',
    'expected_route',
    'expected_behavior',
    'notes',
    'exclude',
    'origin',
    'generated_hash',
    'scenario_source',
    'forbidden_claims',
    'source_row_ids',
    'expected_failure',
    'scenario_description',
  ]

  it('round-trips a generated row exactly', () => {
    const [row] = stampFreshRows([baseScenario()])
    const values = scenarioRowToValues(row)
    const parsed = valuesToScenarioRow(HEADER, values)
    expect(parsed).toEqual(row)
  })

  it('round-trips an owner-edited row with exclude=true and notes set', () => {
    const [base] = stampFreshRows([baseScenario()])
    const edited: ScenarioSheetRow = { ...base, exclude: true, notes: 'keeping this, seems fine' }
    const values = scenarioRowToValues(edited)
    const parsed = valuesToScenarioRow(HEADER, values)
    expect(parsed).toEqual(edited)
  })

  it('round-trips a null expected_failure as empty string and back to null', () => {
    const [row] = stampFreshRows([baseScenario({ expected_failure: null })])
    const parsed = valuesToScenarioRow(HEADER, scenarioRowToValues(row))
    expect(parsed?.expected_failure).toBeNull()
  })

  it('preserves a non-null expected_failure', () => {
    const [row] = stampFreshRows([baseScenario({ expected_failure: 'known gap: no hours listed' })])
    const parsed = valuesToScenarioRow(HEADER, scenarioRowToValues(row))
    expect(parsed?.expected_failure).toBe('known gap: no hours listed')
  })

  it('tolerates reordered columns by keying off the header row', () => {
    const [row] = stampFreshRows([baseScenario()])
    const values = scenarioRowToValues(row)
    const shuffledHeader = [...HEADER].reverse()
    const shuffledValues = [...values].reverse()
    const parsed = valuesToScenarioRow(shuffledHeader, shuffledValues)
    expect(parsed).toEqual(row)
  })

  it('returns null and does not throw on an unparseable row', () => {
    const badHeader = ['id', 'topic']
    const badValues = ['', '']
    expect(valuesToScenarioRow(badHeader, badValues)).toBeNull()
  })
})

describe('buildMergedMetaEntries', () => {
  it('appends new ids and keeps existing ones not touched this run', () => {
    const existing = [{ id: 'old-1', topic: 't1', message: 'm1' }]
    const [freshRow] = stampFreshRows([baseScenario({ sample_id: 'new-1' })])
    const merged = buildMergedMetaEntries(existing, [freshRow])
    expect(merged.map((m) => m.id).sort()).toEqual(['new-1', 'old-1'])
  })

  it('overwrites an existing meta entry when the same id is written again', () => {
    const existing = [{ id: 'a', topic: 'old-topic', message: 'old message' }]
    const [freshRow] = stampFreshRows([
      baseScenario({ sample_id: 'a', topic: 'new-topic', inbound_message: 'new message' }),
    ])
    const merged = buildMergedMetaEntries(existing, [freshRow])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toEqual({ id: 'a', topic: 'new-topic', message: 'new message' })
  })
})
