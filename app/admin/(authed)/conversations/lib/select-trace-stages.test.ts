import { describe, expect, it } from 'vitest'
import type { ApiTraceWithFullDetails } from '@/lib/observability'
import { selectTraceStages } from './select-trace-stages'

// Build a synthetic ApiTraceWithFullDetails with the agent pipeline's six
// stages. We don't need a full ApiTrace shape — selectTraceStages reads only
// .name and .observations, so the cast is safe and keeps the fixture small.
type Obs = ApiTraceWithFullDetails['observations'][number]

function obs(id: string, name: string, parentId: string | null = null): Obs {
  return {
    id,
    name,
    parentObservationId: parentId,
    type: 'SPAN',
    startTime: '2026-04-30T00:00:00Z',
    level: 'DEFAULT',
    // Other ApiObservation fields default to nullable/optional. Cast is
    // narrower than the type but safe for what selectTraceStages reads.
  } as unknown as Obs
}

function makeTrace(name: string | null, observations: Obs[]): ApiTraceWithFullDetails {
  return {
    id: 'tr_test',
    timestamp: '2026-04-30T00:00:00Z',
    name,
    observations,
    scores: [],
    htmlPath: '/trace/tr_test',
    latency: 1.2,
    totalCost: 0,
  } as unknown as ApiTraceWithFullDetails
}

describe('selectTraceStages', () => {
  it('orders stages by canonical pipeline order regardless of observation order', () => {
    // Observations in shuffled order; selector must return canonical order.
    const trace = makeTrace('agent.inbound', [
      obs('o5', 'send'),
      obs('o3', 'retrieve'),
      obs('o1', 'context_build'),
      obs('o4', 'generate'),
      obs('oK', 'retrieve_knowledge'),
      obs('o2', 'classify'),
    ])
    const result = selectTraceStages(trace)
    expect(result.rootName).toBe('agent.inbound')
    expect(result.stages.map((s) => s.name)).toEqual([
      'context_build',
      'classify',
      'retrieve',
      'retrieve_knowledge',
      'generate',
      'send',
    ])
  })

  it('places retrieve_knowledge between retrieve and generate when present', () => {
    // Regression guard: retrieve_knowledge previously fell into `other` and
    // rendered after `send` because it was missing from KNOWN_STAGE_ORDER.
    const trace = makeTrace('agent.inbound', [
      obs('o1', 'context_build'),
      obs('o2', 'classify'),
      obs('o3', 'retrieve'),
      obs('oK', 'retrieve_knowledge'),
      obs('o4', 'generate'),
      obs('o5', 'send'),
    ])
    const result = selectTraceStages(trace)
    const order = result.stages.map((s) => s.name)
    const retrieveIdx = order.indexOf('retrieve')
    const knowledgeIdx = order.indexOf('retrieve_knowledge')
    const generateIdx = order.indexOf('generate')
    expect(retrieveIdx).toBeGreaterThan(-1)
    expect(knowledgeIdx).toBeGreaterThan(-1)
    expect(generateIdx).toBeGreaterThan(-1)
    expect(retrieveIdx).toBeLessThan(knowledgeIdx)
    expect(knowledgeIdx).toBeLessThan(generateIdx)
    // Not bucketed into `other` — that path renders after `send`.
    expect(result.other.map((o) => o.name)).not.toContain('retrieve_knowledge')
  })

  it('omits retrieve_knowledge when the trace lacks it (followup with day_* trigger)', () => {
    // shouldRetrieveKnowledge gates day_* off; the trace just doesn't
    // contain a retrieve_knowledge span. Selector should not emit it.
    const trace = makeTrace('agent.followup', [
      obs('o1', 'context_build'),
      obs('o3', 'retrieve'),
      obs('o4', 'generate'),
      obs('o5', 'send'),
    ])
    const result = selectTraceStages(trace)
    expect(result.stages.map((s) => s.name)).toEqual([
      'context_build',
      'retrieve',
      'generate',
      'send',
    ])
  })

  it('packs generate.attempt_N children into the generate stage in numeric order', () => {
    const trace = makeTrace('agent.inbound', [
      obs('gen', 'generate'),
      obs('a3', 'generate.attempt_3', 'gen'),
      obs('a1', 'generate.attempt_1', 'gen'),
      obs('a2', 'generate.attempt_2', 'gen'),
    ])
    const result = selectTraceStages(trace)
    const generate = result.stages.find((s) => s.name === 'generate')
    expect(generate).toBeDefined()
    expect(generate!.attempts?.map((a) => a.id)).toEqual(['a1', 'a2', 'a3'])
  })

  it('tolerates missing stages — followup has no classify', () => {
    const trace = makeTrace('agent.followup', [
      obs('o1', 'context_build'),
      obs('o3', 'retrieve'),
      obs('o4', 'generate'),
      obs('o5', 'send'),
    ])
    const result = selectTraceStages(trace)
    expect(result.rootName).toBe('agent.followup')
    expect(result.stages.map((s) => s.name)).toEqual([
      'context_build',
      'retrieve',
      'generate',
      'send',
    ])
  })

  it('buckets unknown top-level observations into `other`', () => {
    const trace = makeTrace('agent.inbound', [
      obs('o1', 'context_build'),
      obs('oZ', 'unexpected_new_stage'),
    ])
    const result = selectTraceStages(trace)
    expect(result.stages.map((s) => s.name)).toEqual(['context_build'])
    expect(result.other.map((o) => o.name)).toEqual(['unexpected_new_stage'])
  })

  it('defaults rootName to agent.inbound when trace.name is null', () => {
    const result = selectTraceStages(makeTrace(null, []))
    expect(result.rootName).toBe('agent.inbound')
    expect(result.stages).toEqual([])
    expect(result.other).toEqual([])
  })
})
