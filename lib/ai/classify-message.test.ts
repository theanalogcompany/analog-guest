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
        crisisSafety: false,
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

  it('lists every inbound classifier category with its definition', async () => {
    const prompt = await getCapturedSystemPrompt()
    for (const name of [
      'reply',
      'new_question',
      'opt_out',
      'manual',
      'acknowledgment',
      'comp_complaint',
      'mechanic_request',
      'recommendation_request',
      'casual_chatter',
      'personal_history_question',
      'perk_inquiry',
      'event_question',
      'unknown',
    ]) {
      expect(prompt).toContain(`- ${name}:`)
    }
  })

  it('does not list outbound-only categories in the inbound classifier prompt', async () => {
    const prompt = await getCapturedSystemPrompt()
    // welcome / follow_up / perk_unlock / event_invite are outbound triggers,
    // not inbound classifications. They remain in MessageCategory for outbound
    // paths but the classifier should never return them.
    expect(prompt).not.toMatch(/^- welcome:/m)
    expect(prompt).not.toMatch(/^- follow_up:/m)
    expect(prompt).not.toMatch(/^- perk_unlock:/m)
    expect(prompt).not.toMatch(/^- event_invite:/m)
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

  it('lists personal_history_question with own-history framing (THE-233)', async () => {
    const prompt = await getCapturedSystemPrompt()
    expect(prompt).toContain('- personal_history_question:')
    expect(prompt).toContain('own past interactions with the venue')
    expect(prompt).toContain('what did I get last time')
    expect(prompt).toContain('do you remember me')
  })

  it('includes the disambiguation paragraph (THE-228 Q4)', async () => {
    const prompt = await getCapturedSystemPrompt()
    expect(prompt).toContain('When a message could fit multiple categories')
    expect(prompt).toContain('comp_complaint even if phrased as a reply')
    expect(prompt).toContain('opinion-shaped')
    // v1.10.0: rephrased to distinguish manual (operator's eyes needed) from
    // unknown (no clear path to respond). The previous wording was conflating
    // the two.
    expect(prompt).toContain('Use manual only when the message contains content that genuinely needs an operator\'s eyes')
  })

  it('includes the personal-history disambiguation clause (THE-233)', async () => {
    const prompt = await getCapturedSystemPrompt()
    expect(prompt).toContain(
      'Personal-history questions ("what did I get last time", "do you remember me") route to personal_history_question, NOT to manual or new_question.',
    )
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
    'personal_history_question',
    'perk_inquiry',
    'event_question',
    'unknown',
  ] as const) {
    it(`accepts category=${cat}`, async () => {
      generateObjectMock.mockResolvedValueOnce({
        object: { category: cat, classifierConfidence: 0.9, reasoning: 'mock', crisisSafety: false },
      })
      const r = await classifyMessage({ inboundBody: 'sample' })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.data.category).toBe(cat)
      expect(r.data.classifierConfidence).toBe(0.9)
      expect(r.data.promptVersion).toBe('v1.44.0')
    })
  }
})

describe('CLASSIFY_SYSTEM_PROMPT — new inbound categories (v1.10.0)', () => {
  beforeEach(() => {
    generateObjectMock.mockReset()
    generateObjectMock.mockResolvedValue({
      object: {
        category: 'reply',
        classifierConfidence: 0.9,
        reasoning: 'noop',
        crisisSafety: false,
      },
    })
  })

  async function getCapturedSystemPrompt(): Promise<string> {
    await classifyMessage({ inboundBody: 'hi' })
    const callArgs = generateObjectMock.mock.calls[0]?.[0] as
      | { system?: string }
      | undefined
    expect(callArgs?.system).toBeDefined()
    return callArgs!.system as string
  }

  it('lists perk_inquiry with asking-about-system framing', async () => {
    const prompt = await getCapturedSystemPrompt()
    expect(prompt).toContain('- perk_inquiry:')
    expect(prompt).toContain('what they unlock')
    expect(prompt).toContain('Distinct from mechanic_request')
  })

  it('lists event_question with asking-about-events framing', async () => {
    const prompt = await getCapturedSystemPrompt()
    expect(prompt).toContain('- event_question:')
    expect(prompt).toContain("when's the next open mic")
  })

  it('lists unknown with catch-all framing', async () => {
    const prompt = await getCapturedSystemPrompt()
    expect(prompt).toContain('- unknown:')
    expect(prompt).toContain('does not fit any other category cleanly')
  })

  it('updated disambiguation distinguishes manual from unknown', async () => {
    const prompt = await getCapturedSystemPrompt()
    expect(prompt).toContain('Use unknown only when the message genuinely doesn\'t fit')
    expect(prompt).toContain('genuinely needs an operator\'s eyes')
  })
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

// ---------------------------------------------------------------------------
// v1.11.0: classifier surface improvements (TAC-240).
// ---------------------------------------------------------------------------

// Capture the user prompt arg passed to generateObject. Mirrors the existing
// getCapturedSystemPrompt pattern but reads `prompt` instead of `system`.
async function getCapturedUserPrompt(): Promise<string> {
  const callArgs = generateObjectMock.mock.calls[0]?.[0] as
    | { prompt?: string }
    | undefined
  expect(callArgs?.prompt).toBeDefined()
  return callArgs!.prompt as string
}

describe('classifyMessage — recent conversation rendering (v1.11.0)', () => {
  beforeEach(() => {
    generateObjectMock.mockReset()
    generateObjectMock.mockResolvedValue({
      object: { category: 'reply', classifierConfidence: 0.9, reasoning: 'noop', crisisSafety: false },
    })
  })

  it('renders recent conversation block when recentMessages provided', async () => {
    const now = Date.now()
    await classifyMessage({
      inboundBody: 'do you have oat milk?',
      recentMessages: [
        { direction: 'inbound', body: 'hi', createdAt: new Date(now - 5 * 60_000) },
        { direction: 'outbound', body: "hey, what's up", createdAt: new Date(now - 4 * 60_000) },
      ],
    })
    const prompt = await getCapturedUserPrompt()
    expect(prompt).toContain('Recent conversation (most recent at the bottom):')
    expect(prompt).toContain('[guest, 5 minutes ago] hi')
    expect(prompt).toContain("[venue, 4 minutes ago] hey, what's up")
  })

  it('omits recent conversation block when recentMessages is empty', async () => {
    await classifyMessage({
      inboundBody: 'hi',
      recentMessages: [],
    })
    const prompt = await getCapturedUserPrompt()
    expect(prompt).not.toContain('Recent conversation')
  })

  it('omits recent conversation block when recentMessages is undefined', async () => {
    await classifyMessage({ inboundBody: 'hi' })
    const prompt = await getCapturedUserPrompt()
    expect(prompt).not.toContain('Recent conversation')
  })
})

describe('classifyMessage — guest state rendering (v1.11.0)', () => {
  beforeEach(() => {
    generateObjectMock.mockReset()
    generateObjectMock.mockResolvedValue({
      object: { category: 'reply', classifierConfidence: 0.9, reasoning: 'noop', crisisSafety: false },
    })
  })

  it('renders Guest relationship line when guestState is provided', async () => {
    await classifyMessage({ inboundBody: 'hi', guestState: 'regular' })
    const prompt = await getCapturedUserPrompt()
    expect(prompt).toContain('Guest relationship: regular')
  })

  it('omits Guest relationship line when guestState is undefined', async () => {
    await classifyMessage({ inboundBody: 'hi' })
    const prompt = await getCapturedUserPrompt()
    expect(prompt).not.toContain('Guest relationship:')
  })
})

describe('classifyMessage — temperature (v1.11.0)', () => {
  beforeEach(() => {
    generateObjectMock.mockReset()
    generateObjectMock.mockResolvedValue({
      object: { category: 'reply', classifierConfidence: 0.9, reasoning: 'noop', crisisSafety: false },
    })
  })

  it('passes temperature=0.2 to generateObject', async () => {
    await classifyMessage({ inboundBody: 'hi' })
    const callArgs = generateObjectMock.mock.calls[0]?.[0] as
      | { temperature?: number }
      | undefined
    expect(callArgs?.temperature).toBe(0.2)
  })
})

describe('classifyMessage — inbound truncation (v1.11.0)', () => {
  beforeEach(() => {
    generateObjectMock.mockReset()
    generateObjectMock.mockResolvedValue({
      object: { category: 'reply', classifierConfidence: 0.9, reasoning: 'noop', crisisSafety: false },
    })
  })

  it('truncates the category-facing block at 1000 chars before classification', async () => {
    const longBody = 'a'.repeat(1500)
    await classifyMessage({ inboundBody: longBody })
    const prompt = await getCapturedUserPrompt()
    // The category-facing block is exactly 1000 chars + the truncation
    // suffix — not the full 1500-char body. (TAC-348: the full body DOES
    // still reach the model, in a separate crisis-check block asserted
    // below — this test is scoped to the category-facing block only.)
    expect(prompt).toContain(
      `Inbound message from guest:\n"${'a'.repeat(1000)} [...truncated]"`,
    )
  })

  it('does not truncate inbound under 1000 chars', async () => {
    const normalBody = 'do you have oat milk?'
    await classifyMessage({ inboundBody: normalBody })
    const prompt = await getCapturedUserPrompt()
    expect(prompt).toContain(normalBody)
    expect(prompt).not.toContain('[...truncated]')
  })

  // TAC-348 (code review follow-up): the category cap above must not
  // silently drop crisis-relevant text past char 1000 — see the dedicated
  // 'crisis-check bypass of the classifier length cap' describe block for
  // the full behavior. This test only pins the co-existence: truncated
  // category block + untruncated (up to the second cap) crisis-check block,
  // in the same prompt, for the same call.
  it('still carries the full body in a separate crisis-check block even though the category block truncates', async () => {
    const longBody = 'a'.repeat(1500)
    await classifyMessage({ inboundBody: longBody })
    const prompt = await getCapturedUserPrompt()
    expect(prompt).toContain('crisisSafety determination ONLY')
    expect(prompt).toContain(`"${'a'.repeat(1500)}"`)
  })
})

describe('CLASSIFY_SYSTEM_PROMPT — outbound exclusion reinforcement (v1.11.0)', () => {
  beforeEach(() => {
    generateObjectMock.mockReset()
    generateObjectMock.mockResolvedValue({
      object: { category: 'reply', classifierConfidence: 0.9, reasoning: 'noop', crisisSafety: false },
    })
  })

  it('explicitly notes welcome / follow_up / perk_unlock / event_invite are absent', async () => {
    await classifyMessage({ inboundBody: 'hi' })
    const callArgs = generateObjectMock.mock.calls[0]?.[0] as
      | { system?: string }
      | undefined
    const prompt = callArgs?.system as string
    expect(prompt).toContain('welcome, follow_up, perk_unlock, and event_invite')
    expect(prompt).toContain('venue-initiated outbound triggers')
    expect(prompt).toContain('Never select them when classifying an inbound')
  })
})

// ---------------------------------------------------------------------------
// TAC-348: crisisSafety detection, independent of category.
// ---------------------------------------------------------------------------

describe('CLASSIFY_SYSTEM_PROMPT — crisisSafety instruction (TAC-348)', () => {
  beforeEach(() => {
    generateObjectMock.mockReset()
    generateObjectMock.mockResolvedValue({
      object: { category: 'reply', classifierConfidence: 0.9, reasoning: 'noop', crisisSafety: false },
    })
  })

  it('describes self-harm/suicidal ideation as a trigger', async () => {
    await classifyMessage({ inboundBody: 'hi' })
    const callArgs = generateObjectMock.mock.calls[0]?.[0] as { system?: string } | undefined
    const prompt = callArgs?.system as string
    expect(prompt).toContain('crisisSafety')
    expect(prompt).toContain('Self-harm or suicidal ideation')
  })

  it('describes an immediate medical emergency as a trigger', async () => {
    await classifyMessage({ inboundBody: 'hi' })
    const callArgs = generateObjectMock.mock.calls[0]?.[0] as { system?: string } | undefined
    const prompt = callArgs?.system as string
    expect(prompt).toContain('immediate medical emergency or physical danger')
  })

  it('guards against hyperbole false positives with named examples', async () => {
    await classifyMessage({ inboundBody: 'hi' })
    const callArgs = generateObjectMock.mock.calls[0]?.[0] as { system?: string } | undefined
    const prompt = callArgs?.system as string
    expect(prompt).toContain('this coffee is to die for')
    expect(prompt).toContain('dying to try this place')
  })

  it('states the field is independent of category', async () => {
    await classifyMessage({ inboundBody: 'hi' })
    const callArgs = generateObjectMock.mock.calls[0]?.[0] as { system?: string } | undefined
    const prompt = callArgs?.system as string
    expect(prompt).toContain('Separately from category, set crisisSafety')
    expect(prompt).toContain('regardless of what category you picked')
  })

  it('biases ambiguous cases toward true (false negatives are the worse failure)', async () => {
    await classifyMessage({ inboundBody: 'hi' })
    const callArgs = generateObjectMock.mock.calls[0]?.[0] as { system?: string } | undefined
    const prompt = callArgs?.system as string
    expect(prompt).toContain('prefer true')
  })
})

// ---------------------------------------------------------------------------
// TAC-348 (code review follow-up): crisisSafety must not be defeated by the
// classifier's 1000-char category cap on a long, escalating message.
// ---------------------------------------------------------------------------

describe('classifyMessage — crisis-check bypass of the classifier length cap (TAC-348)', () => {
  beforeEach(() => {
    generateObjectMock.mockReset()
    generateObjectMock.mockResolvedValue({
      object: { category: 'reply', classifierConfidence: 0.9, reasoning: 'noop', crisisSafety: false },
    })
  })

  it('adds no extra prompt block for a body under the classification cap', async () => {
    await classifyMessage({ inboundBody: 'a normal short message' })
    const prompt = await getCapturedUserPrompt()
    expect(prompt).not.toContain('crisisSafety determination ONLY')
  })

  it('appends the full untruncated body in a dedicated block when the body exceeds the cap', async () => {
    // 1500 chars: past MAX_CLASSIFIER_INPUT_CHARS (1000), well under
    // MAX_CRISIS_CHECK_INPUT_CHARS (4000) — the crisis-check block should
    // carry the text in full, unlike the category-facing block above it.
    const longBody = `${'a'.repeat(1050)} I don't want to be here anymore ${'b'.repeat(400)}`
    await classifyMessage({ inboundBody: longBody })
    const prompt = await getCapturedUserPrompt()
    expect(prompt).toContain('crisisSafety determination ONLY')
    // The crisis-relevant phrase sits past the 1000-char category cutoff —
    // it must still reach the model somewhere in the prompt.
    expect(prompt).toContain("I don't want to be here anymore")
  })

  it('caps the crisis-check block itself at MAX_CRISIS_CHECK_INPUT_CHARS on a pathologically long body', async () => {
    const veryLongBody = 'a'.repeat(10_000)
    await classifyMessage({ inboundBody: veryLongBody })
    const prompt = await getCapturedUserPrompt()
    expect(prompt).toContain('crisisSafety determination ONLY')
    expect(prompt).toContain(' [...truncated]')
    // The crisis-check block itself is bounded, not unbounded.
    expect(prompt).not.toContain('a'.repeat(4001))
  })
})

describe('classifyMessage — crisisSafety round-trip (TAC-348)', () => {
  beforeEach(() => {
    generateObjectMock.mockReset()
  })

  it('threads crisisSafety=true through to the returned result', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        category: 'casual_chatter',
        classifierConfidence: 0.8,
        reasoning: 'mock',
        crisisSafety: true,
      },
    })
    const r = await classifyMessage({ inboundBody: "I don't see the point of anything anymore" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.crisisSafety).toBe(true)
    // Independent of category — the classifier still picked a normal category.
    expect(r.data.category).toBe('casual_chatter')
  })

  it('threads crisisSafety=false through to the returned result', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        category: 'reply',
        classifierConfidence: 0.9,
        reasoning: 'mock',
        crisisSafety: false,
      },
    })
    const r = await classifyMessage({ inboundBody: 'sounds good, thanks' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.crisisSafety).toBe(false)
  })
})
