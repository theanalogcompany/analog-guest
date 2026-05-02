import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Relative imports — vitest doesn't pick up Next's `@/*` alias under our setup.
import { classifyMessage } from './classify-message'

// Mock the AI SDK and the model client so no real Anthropic call goes out.
const generateObjectMock = vi.fn()
vi.mock('ai', () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
}))
vi.mock('./client', () => ({
  getClassificationModel: () => 'mock-model',
}))

// Reach back into the module under test for its private prompt + schema for
// keyword/round-trip assertions. Done via dynamic import so the mocks above
// apply.
async function loadModuleInternals() {
  // The real module hides CLASSIFY_SYSTEM_PROMPT and ClassifiedMessageSchema
  // as module-locals (no exports). We assert behavior through classifyMessage
  // (the model sees CLASSIFY_SYSTEM_PROMPT verbatim, so we can spy on the
  // `system` arg) and via the round-trip the model's output goes through
  // (which exercises ClassifiedMessageSchema).
  return import('./classify-message')
}

describe('CLASSIFY_SYSTEM_PROMPT — category list', () => {
  afterEach(() => {
    generateObjectMock.mockReset()
  })

  beforeEach(async () => {
    await loadModuleInternals()
    generateObjectMock.mockResolvedValue({
      object: {
        category: 'reply',
        classifierConfidence: 0.9,
        reasoning: 'noop',
      },
    })
  })

  // We assert the system-prompt contents by capturing the `system` argument
  // passed to generateObject on a single call. Cleaner than reaching into
  // module-private state.
  async function getCapturedSystemPrompt(): Promise<string> {
    await classifyMessage({ inboundBody: 'hi' })
    const callArgs = generateObjectMock.mock.calls[0]?.[0] as
      | { system?: string }
      | undefined
    expect(callArgs?.system).toBeDefined()
    return callArgs!.system as string
  }

  it('lists every pre-existing category with its definition', async () => {
    const prompt = await getCapturedSystemPrompt()
    for (const name of [
      'welcome',
      'follow_up',
      'reply',
      'new_question',
      'opt_out',
      'perk_unlock',
      'event_invite',
      'manual',
    ]) {
      expect(prompt).toContain(`- ${name}:`)
    }
  })

  it('lists acknowledgment with sign-off / closing examples (THE-228 fix)', async () => {
    const prompt = await getCapturedSystemPrompt()
    expect(prompt).toContain('- acknowledgment:')
    expect(prompt).toContain('signing off')
    expect(prompt).toContain('see you tomorrow')
  })

  it('lists comp_complaint with quality-issue framing (THE-228)', async () => {
    const prompt = await getCapturedSystemPrompt()
    expect(prompt).toContain('- comp_complaint:')
    expect(prompt).toContain('quality issue')
    expect(prompt).toContain('muffin was stale')
  })

  it('lists mechanic_request with hold/perk/event examples (THE-228)', async () => {
    const prompt = await getCapturedSystemPrompt()
    expect(prompt).toContain('- mechanic_request:')
    expect(prompt).toContain('venue mechanic')
    expect(prompt).toContain('hold the couch')
  })

  it('lists recommendation_request with what-to-order framing (THE-228)', async () => {
    const prompt = await getCapturedSystemPrompt()
    expect(prompt).toContain('- recommendation_request:')
    expect(prompt).toContain('recommendation')
    expect(prompt).toContain('what\'s good here')
    expect(prompt).toContain('Distinct from new_question')
  })

  it('lists casual_chatter with small-talk framing (THE-228)', async () => {
    const prompt = await getCapturedSystemPrompt()
    expect(prompt).toContain('- casual_chatter:')
    expect(prompt).toContain('small talk')
    expect(prompt).toContain('Distinct from reply')
  })

  it('includes the disambiguation paragraph (THE-228 Q4)', async () => {
    const prompt = await getCapturedSystemPrompt()
    expect(prompt).toContain('When a message could fit multiple categories')
    expect(prompt).toContain('comp_complaint even if phrased as a reply')
    expect(prompt).toContain('opinion-shaped')
    expect(prompt).toContain('Use manual only when the message genuinely needs operator attention')
  })

  it('keeps the confidence-scale anchor block', async () => {
    const prompt = await getCapturedSystemPrompt()
    expect(prompt).toContain('DECIMAL between 0.0 and 1.0')
    expect(prompt).toContain('0.7 = clear category')
  })
})

describe('classifyMessage — schema accepts new categories', () => {
  beforeEach(() => {
    generateObjectMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // For each new category, mock the model to return that category and assert
  // classifyMessage round-trips it through ClassifiedMessageSchema without
  // schema rejection. If the schema enum is missing the value, generateObject
  // would throw a NoObjectGeneratedError-equivalent and classifyMessage would
  // return ok:false.
  for (const cat of [
    'comp_complaint',
    'mechanic_request',
    'recommendation_request',
    'casual_chatter',
  ] as const) {
    it(`accepts category=${cat}`, async () => {
      generateObjectMock.mockResolvedValueOnce({
        object: { category: cat, classifierConfidence: 0.9, reasoning: 'mock' },
      })
      const r = await classifyMessage({ inboundBody: 'sample' })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.data.category).toBe(cat)
      expect(r.data.classifierConfidence).toBe(0.9)
      expect(r.data.promptVersion).toBe('v1.3.0')
    })
  }
})

describe('classifyMessage — basic shape', () => {
  beforeEach(() => {
    generateObjectMock.mockReset()
  })

  it('rejects empty inboundBody as invalid_input', async () => {
    const r = await classifyMessage({ inboundBody: '' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('invalid_input')
    // The model should never have been called.
    expect(generateObjectMock).not.toHaveBeenCalled()
  })
})
