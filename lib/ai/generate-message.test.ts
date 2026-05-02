import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Relative imports — vitest doesn't pick up Next's `@/*` alias under our setup.
import { BrandPersonaSchema, VenueInfoSchema, type BrandPersona, type VenueInfo } from '../schemas'
import { generateMessage } from './generate-message'
import type { GenerateMessageInput } from './types'

// Mock the AI SDK + the model client so no real Anthropic call goes out.
// `generateObject` is the only entry point lib/ai/generate-message.ts uses.
// `NoObjectGeneratedError.isInstance` is referenced in the catch path but
// never reached by these tests (we never throw from the mock).
const generateObjectMock = vi.fn()
vi.mock('ai', () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
  NoObjectGeneratedError: { isInstance: () => false },
}))
vi.mock('./client', () => ({
  getGenerationModel: () => 'mock-model',
}))

// Minimal valid input. Schemas fill defaults — only required fields specified.
function makePersona(overrides: Partial<BrandPersona> = {}): BrandPersona {
  return BrandPersonaSchema.parse({
    tone: 'warm and direct',
    formality: 'casual',
    speakerFraming: 'venue',
    emojiPolicy: 'never',
    lengthGuide: 'short — 1-2 sentences',
    ...overrides,
  })
}

function makeVenueInfo(overrides: Partial<VenueInfo> = {}): VenueInfo {
  return VenueInfoSchema.parse({
    address: { line1: '1 Test St', city: 'Test', region: 'CA', postalCode: '94000' },
    ...overrides,
  })
}

function makeInput(): GenerateMessageInput {
  return {
    category: 'reply',
    persona: makePersona(),
    venueInfo: makeVenueInfo(),
    ragChunks: [
      { id: 'c1', text: 'sample voice corpus chunk', sourceType: 'sample_text' },
    ],
    runtime: {
      inboundMessage: 'hi',
      today: {
        isoDate: '2026-05-02',
        dayOfWeek: 'Saturday',
        venueLocalTime: '10:00',
        venueTimezone: 'America/Los_Angeles',
      },
    },
  }
}

// Each test re-arms generateObjectMock with a queue of responses, one per
// expected loop iteration. Mock returns are wrapped in { object } to match
// the AI SDK's return shape.
function queueResponses(...objs: Array<{ body: string; voiceFidelity: number; reasoning: string }>) {
  generateObjectMock.mockReset()
  for (const o of objs) {
    generateObjectMock.mockResolvedValueOnce({ object: o })
  }
}

describe('generateMessage — dash regex check (THE-225)', () => {
  beforeEach(() => {
    generateObjectMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes through a clean body on the first attempt', async () => {
    queueResponses({
      body: 'we close at 11. come by anytime.',
      voiceFidelity: 0.85,
      reasoning: 'matches venue voice',
    })

    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return // type narrow

    expect(r.data.attempts).toBe(1)
    expect(r.data.dashViolationPersisted).toBe(false)
    // No regen feedback was needed → no per-attempt prompt override.
    expect(r.data.attemptHistory[0].userPromptOverride).toBeUndefined()
    expect(generateObjectMock).toHaveBeenCalledTimes(1)
  })

  it('regenerates when a body with an em dash passes fidelity', async () => {
    queueResponses(
      {
        body: 'we close at 11 — come by anytime',
        voiceFidelity: 0.9,
        reasoning: 'first try',
      },
      {
        body: 'we close at 11. come by anytime.',
        voiceFidelity: 0.88,
        reasoning: 'rewritten without dash',
      },
    )

    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.data.attempts).toBe(2)
    expect(r.data.body).toBe('we close at 11. come by anytime.')
    expect(r.data.dashViolationPersisted).toBe(false)

    // Second attempt's prompt should carry the dash-rewrite directive
    // appended to the parent userPrompt.
    const secondCallPrompt = generateObjectMock.mock.calls[1][0].prompt as string
    expect(secondCallPrompt).toContain(
      'Your previous attempt contained a dash character (— or –)',
    )

    // The override should be recorded on attempt 2 only.
    expect(r.data.attemptHistory[0].userPromptOverride).toBeUndefined()
    expect(r.data.attemptHistory[1].userPromptOverride).toBe(secondCallPrompt)
  })

  it('regenerates when a body with an en dash passes fidelity', async () => {
    queueResponses(
      {
        body: 'iced isn\'t on the menu – only hot',
        voiceFidelity: 0.9,
        reasoning: 'first try',
      },
      {
        body: 'iced isn\'t on the menu. only hot.',
        voiceFidelity: 0.85,
        reasoning: 'rewritten',
      },
    )

    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.attempts).toBe(2)
    expect(r.data.dashViolationPersisted).toBe(false)
  })

  it('does NOT include dash feedback when fidelity-only retry happens', async () => {
    // First attempt: clean text, low fidelity → retry on fidelity grounds, no
    // dash directive should be appended for the second attempt.
    queueResponses(
      {
        body: 'sure thing',
        voiceFidelity: 0.4,
        reasoning: 'too generic',
      },
      {
        body: 'yeah, of course',
        voiceFidelity: 0.85,
        reasoning: 'better',
      },
    )

    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.data.attempts).toBe(2)
    expect(r.data.dashViolationPersisted).toBe(false)
    // Second attempt's prompt should equal the parent prompt (no dash
    // directive carried forward) — assert by checking the directive is
    // absent and that no override was recorded on the second attempt.
    const secondCallPrompt = generateObjectMock.mock.calls[1][0].prompt as string
    expect(secondCallPrompt).not.toContain('Your previous attempt contained a dash character')
    expect(r.data.attemptHistory[1].userPromptOverride).toBeUndefined()
  })

  it('ships final body anyway when MAX_ATTEMPTS exhausted with persistent dash', async () => {
    // All three attempts return em-dash bodies. Loop runs to completion;
    // the final body is returned with dashViolationPersisted=true so the
    // orchestrator can fire the PostHog event without blocking the send.
    queueResponses(
      { body: 'a — b', voiceFidelity: 0.85, reasoning: '1' },
      { body: 'c — d', voiceFidelity: 0.86, reasoning: '2' },
      { body: 'e — f', voiceFidelity: 0.87, reasoning: '3' },
    )

    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.data.attempts).toBe(3)
    expect(r.data.body).toBe('e — f')
    expect(r.data.dashViolationPersisted).toBe(true)
    // All three attempts should be in history. Attempts 2 and 3 carry the
    // override (because the prior attempt tripped the dash check).
    expect(r.data.attemptHistory).toHaveLength(3)
    expect(r.data.attemptHistory[0].userPromptOverride).toBeUndefined()
    expect(r.data.attemptHistory[1].userPromptOverride).toContain(
      'Your previous attempt contained a dash character',
    )
    expect(r.data.attemptHistory[2].userPromptOverride).toContain(
      'Your previous attempt contained a dash character',
    )
  })

  it('clears dash feedback after a clean attempt (no stale carry-forward)', async () => {
    // Attempt 1: dash, low fidelity.
    // Attempt 2: clean, low fidelity — dash regex passes but fidelity fails.
    //            Loop continues; the dash feedback should NOT be re-appended
    //            for attempt 3 because attempt 2's body is clean.
    // Attempt 3: clean, high fidelity.
    queueResponses(
      { body: 'a — b', voiceFidelity: 0.4, reasoning: '1' },
      { body: 'a b', voiceFidelity: 0.5, reasoning: '2' },
      { body: 'a, b', voiceFidelity: 0.85, reasoning: '3' },
    )

    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.data.attempts).toBe(3)
    expect(r.data.dashViolationPersisted).toBe(false)

    // Attempt 2 should have the dash directive (because attempt 1 had a dash).
    const secondCallPrompt = generateObjectMock.mock.calls[1][0].prompt as string
    expect(secondCallPrompt).toContain('Your previous attempt contained a dash character')
    // Attempt 3 should NOT have the dash directive (attempt 2 was clean).
    const thirdCallPrompt = generateObjectMock.mock.calls[2][0].prompt as string
    expect(thirdCallPrompt).not.toContain('Your previous attempt contained a dash character')
    expect(r.data.attemptHistory[2].userPromptOverride).toBeUndefined()
  })
})

describe('generateMessage — basic shape', () => {
  beforeEach(() => {
    generateObjectMock.mockReset()
  })

  it('returns invalid_input on malformed input', async () => {
    // @ts-expect-error — intentionally invalid
    const r = await generateMessage(null)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('invalid_input')
  })

  it('exposes promptVersion v1.2.0 on a successful result', async () => {
    queueResponses({ body: 'hi', voiceFidelity: 0.9, reasoning: 'ok' })
    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.promptVersion).toBe('v1.2.0')
  })
})
