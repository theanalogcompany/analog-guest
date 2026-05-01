import { describe, expect, it } from 'vitest'
import type { ApiTraceWithFullDetails } from '@/lib/observability'
import { extractRecognition } from './extract-recognition'

// Synthetic trace with the THE-216 context_build content shape. We only set
// fields the extractor reads; the rest of ApiTraceWithFullDetails is cast.
type Obs = ApiTraceWithFullDetails['observations'][number]

function makeContextBuildObs(output: unknown): Obs {
  return {
    id: 'obs-context',
    name: 'context_build',
    parentObservationId: null,
    type: 'SPAN',
    startTime: '2026-04-30T00:00:00Z',
    level: 'DEFAULT',
    output,
  } as unknown as Obs
}

function makeTrace(observations: Obs[]): ApiTraceWithFullDetails {
  return {
    id: 'tr_test',
    timestamp: '2026-04-30T00:00:00Z',
    name: 'agent.inbound',
    observations,
    scores: [],
    htmlPath: '/trace/tr_test',
    latency: 1.2,
    totalCost: 0,
  } as unknown as ApiTraceWithFullDetails
}

const FULL_OUTPUT = {
  recognitionState: 'regular',
  recognitionScore: 70,
  mechanicCount: 4,
  recentMessageCount: 30,
  content: {
    signals: [
      { signal: 'recency', normalized: 84, weight: 0.25, contribution: 21 },
      { signal: 'visitFrequency', normalized: 65, weight: 0.2, contribution: 13 },
      { signal: 'engagementEvents', normalized: 13, weight: 0.15, contribution: 2 },
      { signal: 'moneySpent', normalized: 50, weight: 0.1, contribution: 5 },
      { signal: 'responseRate', normalized: 95, weight: 0.3, contribution: 29 },
      { signal: 'percentMenuExplored', normalized: 0, weight: 0, contribution: 0 },
      { signal: 'referrals', normalized: 0, weight: 0, contribution: 0 },
    ],
    multipliers: { distance: 1, consistency: 1, total: 1 },
  },
}

describe('extractRecognition — happy path', () => {
  it('returns state, score, and signals in source-of-truth order', () => {
    const trace = makeTrace([makeContextBuildObs(FULL_OUTPUT)])
    const result = extractRecognition(trace)
    expect(result).not.toBeNull()
    if (!result) throw new Error('expected non-null')
    expect(result.state).toBe('regular')
    expect(result.score).toBe(70)
    expect(result.signals.map((s) => s.signal)).toEqual([
      'recency',
      'visitFrequency',
      'engagementEvents',
      'moneySpent',
      'responseRate',
      'percentMenuExplored',
      'referrals',
    ])
    expect(result.signals[0]).toEqual({
      signal: 'recency',
      normalized: 84,
      weight: 0.25,
      contribution: 21,
    })
  })

  it('falls back to summing contributions when recognitionScore is missing', () => {
    const noScore = { ...FULL_OUTPUT, recognitionScore: undefined }
    const trace = makeTrace([makeContextBuildObs(noScore)])
    const result = extractRecognition(trace)
    expect(result?.score).toBe(70) // 21 + 13 + 2 + 5 + 29 + 0 + 0 = 70
  })
})

describe('extractRecognition — null cases', () => {
  it('returns null when trace has no context_build observation', () => {
    const trace = makeTrace([])
    expect(extractRecognition(trace)).toBeNull()
  })

  it('returns null when context_build output is missing', () => {
    const trace = makeTrace([makeContextBuildObs(null)])
    expect(extractRecognition(trace)).toBeNull()
  })

  it('returns null when output.content.signals is missing', () => {
    const trace = makeTrace([
      makeContextBuildObs({ recognitionState: 'regular', recognitionScore: 70, content: {} }),
    ])
    expect(extractRecognition(trace)).toBeNull()
  })

  it('returns null when signals array is empty after filtering', () => {
    const trace = makeTrace([
      makeContextBuildObs({
        recognitionState: 'regular',
        recognitionScore: 70,
        content: { signals: [{ /* no signal field */ }] },
      }),
    ])
    expect(extractRecognition(trace)).toBeNull()
  })
})

describe('extractRecognition — defensive parsing', () => {
  it('coerces non-finite numbers to 0 instead of dropping the row', () => {
    const trace = makeTrace([
      makeContextBuildObs({
        recognitionState: 'new',
        recognitionScore: 0,
        content: {
          signals: [{ signal: 'recency', normalized: NaN, weight: null, contribution: 'oops' }],
        },
      }),
    ])
    const result = extractRecognition(trace)
    expect(result?.signals[0]).toEqual({
      signal: 'recency',
      normalized: 0,
      weight: 0,
      contribution: 0,
    })
  })

  it('falls back state to "unknown" when output.recognitionState is malformed', () => {
    const trace = makeTrace([
      makeContextBuildObs({
        recognitionScore: 0,
        content: { signals: [{ signal: 'recency', normalized: 0, weight: 0, contribution: 0 }] },
      }),
    ])
    const result = extractRecognition(trace)
    expect(result?.state).toBe('unknown')
  })
})
