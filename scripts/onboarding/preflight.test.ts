import { describe, expect, it } from 'vitest'
import { diffGuardrailState, type GuardrailCounts } from './preflight-pure'

const base: GuardrailCounts = { messages: 10, guestCommitments: 2, guestStates: 4, engagementEvents: 8 }

describe('diffGuardrailState', () => {
  it('returns empty when nothing changed', () => {
    expect(diffGuardrailState(base, { ...base })).toEqual([])
  })

  it('reports a single changed table with its delta', () => {
    const after = { ...base, messages: 11 }
    const deltas = diffGuardrailState(base, after)
    expect(deltas).toEqual(['messages: 10 -> 11 (delta 1)'])
  })

  it('reports every table that changed, not just the first', () => {
    const after = { ...base, messages: 11, guestCommitments: 3 }
    const deltas = diffGuardrailState(base, after)
    expect(deltas).toHaveLength(2)
    expect(deltas).toEqual(
      expect.arrayContaining(['messages: 10 -> 11 (delta 1)', 'guestCommitments: 2 -> 3 (delta 1)']),
    )
  })

  it('reports a negative delta if a count decreased', () => {
    const after = { ...base, guestCommitments: 1 }
    expect(diffGuardrailState(base, after)).toEqual(['guestCommitments: 2 -> 1 (delta -1)'])
  })
})
