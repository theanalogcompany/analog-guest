import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const generateObjectMock = vi.fn()
vi.mock('ai', () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}))
vi.mock('@/lib/ai/client', () => ({
  getGenerationModel: () => 'mock-model',
}))

import { classifyCritique } from './classify-critique'

beforeEach(() => {
  generateObjectMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('classifyCritique', () => {
  it('returns edit_only without ruleText when the model says so', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { kind: 'edit_only', reasoning: 'one-shot' },
    })

    const result = await classifyCritique({
      critique: 'wrong perk',
      badResponse: 'we have iced',
      goodResponse: 'we have hot only today',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.kind).toBe('edit_only')
      expect(result.data.ruleText).toBeUndefined()
    }
  })

  it('returns edit_and_rule with ruleText when the model promotes it', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        kind: 'edit_and_rule',
        ruleText: 'no marketing flourishes',
        reasoning: 'general pattern',
      },
    })

    const result = await classifyCritique({
      critique: 'too eager',
      badResponse: 'Hi! So glad...',
      goodResponse: 'morning',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.kind).toBe('edit_and_rule')
      expect(result.data.ruleText).toBe('no marketing flourishes')
    }
  })

  it('returns ok=false when the model throws', async () => {
    generateObjectMock.mockRejectedValueOnce(new Error('schema mismatch'))

    const result = await classifyCritique({
      critique: 'x',
      badResponse: 'y',
      goodResponse: 'z',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('schema mismatch')
  })
})
