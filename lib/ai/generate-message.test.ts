import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Relative imports — vitest doesn't pick up Next's `@/*` alias under our setup.
import { BrandPersonaSchema, VenueInfoSchema, type BrandPersona, type VenueInfo } from '../schemas'
import { generateMessage, replaceDashes, VOICE_FIDELITY_INSTRUCTION } from './generate-message'
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

/**
 * The user prompt sent on attempt `n` (0-indexed).
 *
 * generateMessage sends `messages`, not `system` + `prompt`, so the cache
 * breakpoint can sit between the venue-stable and per-message system blocks.
 * The user turn is the last entry; these assertions only ever care about it.
 */
function userPromptOnCall(n: number): string {
  const { messages } = generateObjectMock.mock.calls[n][0] as {
    messages: { role: string; content: string }[]
  }
  const last = messages[messages.length - 1]
  if (last.role !== 'user') {
    throw new Error(`call ${n}: expected a trailing user message, got ${last.role}`)
  }
  return last.content
}

/** The two system blocks sent on attempt `n` (0-indexed), in order. */
function systemBlocksOnCall(n: number): {
  role: string
  content: string
  providerOptions?: Record<string, unknown>
}[] {
  const { messages } = generateObjectMock.mock.calls[n][0] as {
    messages: {
      role: string
      content: string
      providerOptions?: Record<string, unknown>
    }[]
  }
  return messages.filter((m) => m.role === 'system')
}

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
    channel: 'text',
    runtime: {
      inboundMessage: 'hi',
      today: {
        isoDate: '2026-05-02',
        dayOfWeek: 'Saturday',
        venueLocalTime: '10:00',
        venueTimezone: 'America/Los_Angeles',
        calendar: [
          { weekday: 'Mon', monthDay: 'Jan 5' },
          { weekday: 'Tue', monthDay: 'Jan 6' },
          { weekday: 'Wed', monthDay: 'Jan 7' },
        ],
      },
    },
  }
}

// Each test re-arms generateObjectMock with a queue of responses, one per
// expected loop iteration. Mock returns are wrapped in { object } to match
// the AI SDK's return shape. TAC-212: the new Zod schema requires
// `requiresOperatorApproval` + `approvalReason` on every generation; we
// default them to (false, '') here so existing call sites stay terse and
// the tests that focus on the flag explicitly pass them. TAC-296: the schema
// also now requires `contextUpdate` on every emission — default to {} so
// existing tests don't drown in boilerplate.
function queueResponses(
  ...objs: Array<{
    body: string
    voiceFidelity: number
    reasoning: string
    requiresOperatorApproval?: boolean
    approvalReason?: string
    contextUpdate?: { structured?: unknown; observation?: string }
  }>
) {
  generateObjectMock.mockReset()
  for (const o of objs) {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        requiresOperatorApproval: false,
        approvalReason: '',
        contextUpdate: {},
        ...o,
      },
    })
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

  it('substitutes an em dash in place, spending no extra attempt', async () => {
    queueResponses({
      body: 'we close at 11 — come by anytime',
      voiceFidelity: 0.9,
      reasoning: 'first try',
    })

    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return

    // The whole point of the substitution: one generation call, not two.
    expect(r.data.attempts).toBe(1)
    expect(generateObjectMock).toHaveBeenCalledTimes(1)
    expect(r.data.body).toBe('we close at 11, come by anytime')
    expect(r.data.dashViolationPersisted).toBe(false)
    // Nothing was fed back, so no per-attempt prompt override was recorded.
    expect(r.data.attemptHistory[0].userPromptOverride).toBeUndefined()
  })

  it('substitutes an en dash in place, spending no extra attempt', async () => {
    queueResponses({
      body: 'iced isn\'t on the menu – only hot',
      voiceFidelity: 0.9,
      reasoning: 'first try',
    })

    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.attempts).toBe(1)
    expect(r.data.body).toBe('iced isn\'t on the menu, only hot')
    expect(r.data.dashViolationPersisted).toBe(false)
  })

  it('substitutes an unspaced dash to the same shape as a spaced one', async () => {
    queueResponses({
      body: 'dandelion root—in tonic',
      voiceFidelity: 0.9,
      reasoning: 'first try',
    })

    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.body).toBe('dandelion root, in tonic')
  })

  it('leaves no trailing comma when the dash ends the body', async () => {
    queueResponses({
      body: 'we close at 11 —',
      voiceFidelity: 0.9,
      reasoning: 'first try',
    })

    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.body).toBe('we close at 11')
  })

  it('does not double the comma when a dash follows existing comma punctuation', async () => {
    queueResponses({
      body: 'sure, — we close at 11',
      voiceFidelity: 0.9,
      reasoning: 'first try',
    })

    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.body).toBe('sure, we close at 11')
  })

  it('still regenerates on low fidelity even when a dash was substituted', async () => {
    // The substitution removes the dash as a REASON to retry; it must not
    // suppress a retry the other checks would have caused anyway.
    queueResponses(
      {
        body: 'sure thing — yeah',
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
    // Attempt 1's recorded body is the substituted one, not the raw model text.
    expect(r.data.attemptHistory[0].body).toBe('sure thing, yeah')
    expect(r.data.body).toBe('yeah, of course')
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
    const secondCallPrompt = userPromptOnCall(1)
    expect(secondCallPrompt).not.toContain('do not use a dash character')
    expect(r.data.attemptHistory[1].userPromptOverride).toBeUndefined()
  })

  it('never lets a dash persist, however many attempts the other checks cost', async () => {
    // REPLACES 'ships final body anyway when MAX_ATTEMPTS exhausted with
    // persistent dash'. A persistent dash is no longer reachable: every
    // attempt's body is substituted as it arrives, so the loop can run to
    // MAX_ATTEMPTS for OTHER reasons and still ship a dash-free body.
    //
    // All three attempts here come back with a dash AND low fidelity, so
    // fidelity is what drives the loop to exhaustion.
    queueResponses(
      { body: 'a — b', voiceFidelity: 0.4, reasoning: '1' },
      { body: 'c — d', voiceFidelity: 0.4, reasoning: '2' },
      { body: 'e — f', voiceFidelity: 0.4, reasoning: '3' },
    )

    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.data.attempts).toBe(3)
    expect(r.data.body).toBe('e, f')
    expect(r.data.dashViolationPersisted).toBe(false)
    // Every recorded attempt is substituted, not just the shipped one.
    expect(r.data.attemptHistory.map((a) => a.body)).toEqual(['a, b', 'c, d', 'e, f'])
  })

  it('never puts a dash constraint in a regen prompt', async () => {
    // REPLACES 'KEEPS the dash constraint after a clean attempt'. The sticky
    // mechanism it pinned is still live and still tested — by the self-talk
    // and unverified-URL cases below, which remain regeneration-driven. The
    // dash is simply no longer one of its inputs, so it must never appear.
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

    for (let i = 0; i < generateObjectMock.mock.calls.length; i++) {
      expect(userPromptOnCall(i)).not.toContain('dash character')
    }
    for (const attempt of r.data.attemptHistory) {
      expect(attempt.userPromptOverride ?? '').not.toContain('dash character')
    }
  })

  it('states every retained constraint as a standing rule, never as a report on the last attempt', async () => {
    // A sticky directive worded as feedback ("your previous attempt contained
    // a dash") becomes a FALSE STATEMENT the moment it outlives the attempt it
    // describes — which, once sticky, is every attempt after the first one it
    // appears in. So the wording is part of the mechanism, not presentation.
    queueResponses(
      { body: 'a — b', voiceFidelity: 0.4, reasoning: '1' },
      { body: 'a b', voiceFidelity: 0.5, reasoning: '2' },
      { body: 'a, b', voiceFidelity: 0.85, reasoning: '3' },
    )
    await generateMessage(makeInput())
    for (const call of generateObjectMock.mock.calls) {
      const prompt = (call[0] as { messages: { role: string; content: string }[] })
        .messages.at(-1)!.content
      expect(prompt).not.toContain('Your previous attempt')
      expect(prompt).not.toContain('previous attempt contained')
      expect(prompt).not.toContain('Rewrite')
    }
  })
})

describe('generateMessage — self-talk check (TAC-355)', () => {
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
    if (!r.ok) return

    expect(r.data.attempts).toBe(1)
    expect(r.data.selfTalkViolationPersisted).toBe(false)
  })

  it('regenerates when a body contains self-talk and passes fidelity', async () => {
    // The literal TAC-355 failing reply shape (le-mils-coffee-010).
    queueResponses(
      {
        body: "made with chicory and dandelion root — actually wait, no dashes. chicory and dandelion root extract.",
        voiceFidelity: 0.9,
        reasoning: 'first try',
      },
      {
        body: 'made with chicory and dandelion root extract.',
        voiceFidelity: 0.88,
        reasoning: 'rewritten',
      },
    )

    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.data.attempts).toBe(2)
    expect(r.data.body).toBe('made with chicory and dandelion root extract.')
    expect(r.data.selfTalkViolationPersisted).toBe(false)

    const secondCallPrompt = userPromptOnCall(1)
    expect(secondCallPrompt).toContain(
      'any reference to your own instructions',
    )
  })

  it('does NOT include self-talk feedback when fidelity-only retry happens', async () => {
    queueResponses(
      { body: 'sure thing', voiceFidelity: 0.4, reasoning: 'too generic' },
      { body: 'yeah, of course', voiceFidelity: 0.85, reasoning: 'better' },
    )

    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.data.selfTalkViolationPersisted).toBe(false)
    const secondCallPrompt = userPromptOnCall(1)
    expect(secondCallPrompt).not.toContain('any reference to your own instructions')
  })

  it('MUST NOT ship silently — persists selfTalkViolationPersisted=true when MAX_ATTEMPTS exhausted', async () => {
    // All three attempts leak self-talk. generateMessage itself still
    // returns the final body (it never refuses) — the "never send" behavior
    // this ticket requires is enforced one layer up, by
    // lib/agent/stages.ts's SELF_TALK_DETECTED trigger reading this flag.
    queueResponses(
      { body: 'as an AI I should say a', voiceFidelity: 0.85, reasoning: '1' },
      { body: 'as an AI I should say b', voiceFidelity: 0.86, reasoning: '2' },
      { body: 'as an AI I should say c', voiceFidelity: 0.87, reasoning: '3' },
    )

    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.data.attempts).toBe(3)
    expect(r.data.body).toBe('as an AI I should say c')
    expect(r.data.selfTalkViolationPersisted).toBe(true)
  })

  it('substitutes the dash and regenerates for the self-talk, when one attempt trips both', async () => {
    // The motivating incident for TAC-355 tripped both at once. They are now
    // handled by different mechanisms in the same pass: the dash is rewritten
    // in place, the self-talk still costs an attempt. Only the self-talk
    // constraint reaches the retry prompt.
    queueResponses(
      {
        body: 'chicory — actually wait, no dashes',
        voiceFidelity: 0.9,
        reasoning: 'first try',
      },
      {
        body: 'chicory, nutmeg, and dandelion root extract',
        voiceFidelity: 0.88,
        reasoning: 'rewritten',
      },
    )

    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.data.attempts).toBe(2)
    expect(r.data.dashViolationPersisted).toBe(false)
    expect(r.data.selfTalkViolationPersisted).toBe(false)
    // Attempt 1's dash was substituted before the self-talk check read it.
    expect(r.data.attemptHistory[0].body).toBe('chicory, actually wait, no dashes')

    const secondCallPrompt = userPromptOnCall(1)
    expect(secondCallPrompt).not.toContain('dash character')
    expect(secondCallPrompt).toContain('any reference to your own instructions')
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

  // TAC-495: a missing channel smuggled past the type by a cast must fail as
  // a value, never quietly become the SMS copy. Null is a real answer (the
  // channel is unknown) and generates normally.
  it('returns invalid_input when channel is missing or not a channel, before calling the model', async () => {
    for (const channel of [undefined, 'sms', 'Instagram']) {
      const r = await generateMessage({ ...makeInput(), channel } as unknown as GenerateMessageInput)
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.error).toBe('invalid_input')
    }
    expect(generateObjectMock).not.toHaveBeenCalled()
  })

  it('accepts a null channel', async () => {
    queueResponses({ body: 'hi', voiceFidelity: 0.9, reasoning: 'ok' })
    const r = await generateMessage({ ...makeInput(), channel: null })
    expect(r.ok).toBe(true)
  })

  it('exposes promptVersion v1.66.0 on a successful result', async () => {
    queueResponses({ body: 'hi', voiceFidelity: 0.9, reasoning: 'ok' })
    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.promptVersion).toBe('v1.66.0')
  })
})

describe('generateMessage — operator-approval self-flag (TAC-212)', () => {
  beforeEach(() => {
    generateObjectMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('threads requiresOperatorApproval=true + approvalReason through to the result', async () => {
    queueResponses({
      body: "anyway, that one's on us",
      voiceFidelity: 0.9,
      reasoning: 'comp for the burnt latte',
      requiresOperatorApproval: true,
      approvalReason: 'drafted a comp for the burnt latte',
    })
    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.requiresOperatorApproval).toBe(true)
    expect(r.data.approvalReason).toBe('drafted a comp for the burnt latte')
  })

  it('defaults to requiresOperatorApproval=false + empty approvalReason on benign drafts', async () => {
    queueResponses({
      body: 'yeah, oat and almond.',
      voiceFidelity: 0.9,
      reasoning: 'simple yes/no answer',
    })
    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.requiresOperatorApproval).toBe(false)
    expect(r.data.approvalReason).toBe('')
  })

  it('carries the per-attempt flag values through attemptHistory', async () => {
    queueResponses(
      {
        body: 'first try',
        voiceFidelity: 0.5,
        reasoning: 'low fidelity',
        requiresOperatorApproval: false,
        approvalReason: '',
      },
      {
        body: 'second try with a comp',
        voiceFidelity: 0.85,
        reasoning: 'comp added',
        requiresOperatorApproval: true,
        approvalReason: 'drafted a complimentary refill',
      },
    )
    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.attemptHistory).toHaveLength(2)
    expect(r.data.attemptHistory[0].requiresOperatorApproval).toBe(false)
    expect(r.data.attemptHistory[0].approvalReason).toBe('')
    expect(r.data.attemptHistory[1].requiresOperatorApproval).toBe(true)
    expect(r.data.attemptHistory[1].approvalReason).toBe('drafted a complimentary refill')
  })
})

// ---------------------------------------------------------------------------
// Emoji directive violation flag (TAC-362)
// ---------------------------------------------------------------------------

describe('generateMessage — emojiDirectiveViolated (TAC-362)', () => {
  beforeEach(() => {
    generateObjectMock.mockReset()
  })

  function inputWithDirective(
    emojiDirective: 'none' | 'allowed' | undefined,
  ): GenerateMessageInput {
    const base = makeInput()
    return { ...base, runtime: { ...base.runtime, emojiDirective } }
  }

  it("flags a body that carries an emoji on a 'none' turn", async () => {
    queueResponses({
      body: 'we close at 3 😊',
      voiceFidelity: 0.85,
      reasoning: 'clean',
    })
    const r = await generateMessage(inputWithDirective('none'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.emojiDirectiveViolated).toBe(true)
    // Observation only — the body SHIPS unmodified. A post-generation body
    // mutation would be this repo's first on the generation path, and the
    // measured violation rate is 0 in 240 responses.
    expect(r.data.body).toBe('we close at 3 😊')
  })

  it("does not flag a clean body on a 'none' turn", async () => {
    queueResponses({ body: 'we close at 3', voiceFidelity: 0.85, reasoning: 'clean' })
    const r = await generateMessage(inputWithDirective('none'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.emojiDirectiveViolated).toBe(false)
  })

  // 'allowed' is permission, so an emoji there is the directive being obeyed,
  // not violated. A flag that fired on both branches would make the PostHog
  // event meaningless.
  it("never flags on an 'allowed' turn, emoji or not", async () => {
    queueResponses({ body: 'we close at 3 😊', voiceFidelity: 0.85, reasoning: 'clean' })
    const withEmoji = await generateMessage(inputWithDirective('allowed'))
    expect(withEmoji.ok).toBe(true)
    if (!withEmoji.ok) return
    expect(withEmoji.data.emojiDirectiveViolated).toBe(false)
  })

  it('never flags when no directive was issued', async () => {
    queueResponses({ body: 'we close at 3 😊', voiceFidelity: 0.85, reasoning: 'clean' })
    const r = await generateMessage(inputWithDirective(undefined))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.emojiDirectiveViolated).toBe(false)
  })

  // One message, one coin. composePrompt runs once before the regen loop, so
  // every attempt shares the same directive — a flip re-drawn per attempt
  // would let a retry silently change the rules mid-message.
  it('applies one directive across every regen attempt', async () => {
    // Low fidelity on attempt 1 is what drives the retry here. It used to be a
    // dash, which no longer costs an attempt — the directive this test is
    // about is unaffected either way, it just needs the loop to run twice.
    queueResponses(
      { body: 'we close at 11, come by 😊', voiceFidelity: 0.4, reasoning: 'too generic' },
      { body: 'we close at 11. come by 😊', voiceFidelity: 0.88, reasoning: 'better' },
    )
    const r = await generateMessage(inputWithDirective('none'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.attempts).toBe(2)
    const prompts = generateObjectMock.mock.calls.map(
      (_c: unknown[], i: number) => userPromptOnCall(i),
    )
    expect(prompts).toHaveLength(2)
    // Both attempts carry the identical (single) emoji instruction.
    for (const p of prompts) {
      expect(p).toContain('No emoji in this message.')
      expect(p).not.toContain('An emoji is welcome')
    }
    expect(r.data.emojiDirectiveViolated).toBe(true)
  })
})

describe('generateMessage — unverified URL check (TAC-509)', () => {
  const LISTED = 'https://lemils.com/products/le-mils-budan-bold'

  function inputWithLinks(links: unknown): GenerateMessageInput {
    return { ...makeInput(), venueInfo: makeVenueInfo({ links } as Partial<VenueInfo>) }
  }

  it('sends a listed link unchanged, in one attempt', async () => {
    queueResponses({ body: `Grab it at ${LISTED}`, voiceFidelity: 0.9, reasoning: 'r' })
    const r = await generateMessage(
      inputWithLinks([{ label: 'Budan beans', url: LISTED }]),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.attempts).toBe(1)
    expect(r.data.body).toBe(`Grab it at ${LISTED}`)
    expect(r.data.unverifiedUrls).toEqual([])
  })

  it('regenerates on a one-character variant and clears when the retry is right', async () => {
    const off = 'https://lemils.com/products/le-mils-budan-bolds'
    queueResponses(
      { body: `Grab it at ${off}`, voiceFidelity: 0.9, reasoning: 'r' },
      { body: `Grab it at ${LISTED}`, voiceFidelity: 0.9, reasoning: 'r' },
    )
    const r = await generateMessage(
      inputWithLinks([{ label: 'Budan beans', url: LISTED }]),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.attempts).toBe(2)
    expect(r.data.unverifiedUrls).toEqual([])
  })

  it('quotes the offending link back in the regen feedback', async () => {
    const off = 'https://lemils.com/products/nope'
    queueResponses(
      { body: `Try ${off}`, voiceFidelity: 0.9, reasoning: 'r' },
      { body: 'Come by and ask at the counter.', voiceFidelity: 0.9, reasoning: 'r' },
    )
    await generateMessage(inputWithLinks([{ label: 'Budan beans', url: LISTED }]))
    const secondPrompt = userPromptOnCall(1)
    expect(secondPrompt).toContain(off)
    expect(secondPrompt).toContain('## Links')
  })

  it('MUST NOT ship silently — persists unverifiedUrls when MAX_ATTEMPTS is exhausted', async () => {
    const off = 'https://lemils.com/products/invented'
    queueResponses(
      { body: `Try ${off}`, voiceFidelity: 0.9, reasoning: 'r' },
      { body: `Try ${off}`, voiceFidelity: 0.9, reasoning: 'r' },
      { body: `Try ${off}`, voiceFidelity: 0.9, reasoning: 'r' },
    )
    const r = await generateMessage(
      inputWithLinks([{ label: 'Budan beans', url: LISTED }]),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.attempts).toBe(3)
    expect(r.data.unverifiedUrls).toEqual([off])
  })

  it('holds a link that is present in retrieved knowledge but not on the list', async () => {
    // The allowlist is curated, never derived. A chunk mentioning a link
    // earns it nothing.
    const fromKnowledge = 'https://lemils.com/blogs/blog/so-whats-chicory'
    queueResponses(
      { body: `Read ${fromKnowledge}`, voiceFidelity: 0.9, reasoning: 'r' },
      { body: `Read ${fromKnowledge}`, voiceFidelity: 0.9, reasoning: 'r' },
      { body: `Read ${fromKnowledge}`, voiceFidelity: 0.9, reasoning: 'r' },
    )
    const input: GenerateMessageInput = {
      ...inputWithLinks([{ label: 'Budan beans', url: LISTED }]),
      knowledgeChunks: [
        {
          id: 'k1',
          text: `Our chicory explainer lives at ${fromKnowledge}`,
          sourceType: 'synthesized',
          primaryTags: ['history'],
          secondaryTags: [],
        },
      ],
    }
    const r = await generateMessage(input)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.unverifiedUrls).toEqual([fromKnowledge])
  })

  it('holds any link when the list is empty, and when it is missing entirely', async () => {
    for (const links of [[], undefined]) {
      queueResponses(
        { body: `Try ${LISTED}`, voiceFidelity: 0.9, reasoning: 'r' },
        { body: `Try ${LISTED}`, voiceFidelity: 0.9, reasoning: 'r' },
        { body: `Try ${LISTED}`, voiceFidelity: 0.9, reasoning: 'r' },
      )
      const r = await generateMessage(inputWithLinks(links))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.data.unverifiedUrls).toEqual([LISTED])
    }
  })

  it('never fires on a bare domain, even with no list', async () => {
    queueResponses({
      body: 'You can order on lemils.com any time.',
      voiceFidelity: 0.9,
      reasoning: 'r',
    })
    const r = await generateMessage(inputWithLinks(undefined))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.attempts).toBe(1)
    expect(r.data.unverifiedUrls).toEqual([])
  })

  it('keeps the link constraint on attempt 3, and a dash never reopens the loop', async () => {
    // THE DEVICE FAILURE, 2026-09-21. Le Mil's draft 6a047b0c was held with
    // `unverified_url` AND shipped an em dash in the same body.
    //
    // The dash half of that incident is now structurally impossible: every
    // body is substituted on arrival, so attempt 3 cannot "put a dash back".
    // What still needs pinning is the other half — the LINK constraint has to
    // stay sticky across an attempt that did not re-trip it.
    //
    // Attempt 1: dash + an unlisted link.
    // Attempt 2: no dash, link still wrong — the loop continues for the LINK.
    // Attempt 3: same link, still wrong.
    const off = 'https://lemils.com/products/invented'
    queueResponses(
      { body: `Try ${off} — it is great.`, voiceFidelity: 0.9, reasoning: '1' },
      { body: `Try ${off}, it is great.`, voiceFidelity: 0.9, reasoning: '2' },
      { body: `Try ${off}, it is great.`, voiceFidelity: 0.9, reasoning: '3' },
    )
    const r = await generateMessage(inputWithLinks([{ label: 'Budan beans', url: LISTED }]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.attempts).toBe(3)
    expect(r.data.dashViolationPersisted).toBe(false)

    const prompts = generateObjectMock.mock.calls.map(
      (_c: unknown[], i: number) => userPromptOnCall(i),
    )
    // The link constraint is carried on both retries, including attempt 3.
    expect(prompts[1]).toContain(off)
    expect(prompts[2]).toContain(off)
    // The dash never becomes a directive on any attempt.
    expect(prompts[1]).not.toContain('dash character')
    expect(prompts[2]).not.toContain('dash character')
  })

  it('names a link flagged on an earlier attempt alongside one invented later', async () => {
    // The URL constraint accumulates rather than replacing, so a model that
    // swaps one wrong link for another is told both are unapproved.
    const first = 'https://lemils.com/products/invented-one'
    const second = 'https://lemils.com/products/invented-two'
    queueResponses(
      { body: `Try ${first}`, voiceFidelity: 0.9, reasoning: '1' },
      { body: `Try ${second}`, voiceFidelity: 0.9, reasoning: '2' },
      { body: `Try ${second}`, voiceFidelity: 0.9, reasoning: '3' },
    )
    await generateMessage(inputWithLinks([{ label: 'Budan beans', url: LISTED }]))
    const thirdPrompt = userPromptOnCall(2)
    expect(thirdPrompt).toContain(first)
    expect(thirdPrompt).toContain(second)
  })

  it('composes URL feedback alongside self-talk on one attempt, with the dash substituted', async () => {
    const off = 'https://lemils.com/products/nope'
    queueResponses(
      { body: `Try ${off} — actually wait, no dashes.`, voiceFidelity: 0.9, reasoning: 'r' },
      { body: 'Come by and ask at the counter.', voiceFidelity: 0.9, reasoning: 'r' },
    )
    await generateMessage(inputWithLinks([{ label: 'Budan beans', url: LISTED }]))
    const secondPrompt = userPromptOnCall(1)
    // The two regeneration-driven checks still compose.
    expect(secondPrompt).toContain('self-correction')
    expect(secondPrompt).toContain(off)
    // The dash is not one of them any more.
    expect(secondPrompt).not.toContain('dash character')
  })

  it('reconciles a single trailing slash against the stored list', async () => {
    queueResponses({ body: 'see https://lemils.com', voiceFidelity: 0.9, reasoning: 'r' })
    const r = await generateMessage(
      inputWithLinks([{ label: 'Homepage', url: 'https://lemils.com/' }]),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.attempts).toBe(1)
    expect(r.data.unverifiedUrls).toEqual([])
  })
})

describe('generateMessage — the regen loop has no groundedness check (TAC-501)', () => {
  beforeEach(() => {
    generateObjectMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // The live incident (2026-09-20): a guest asked "can i just call you
  // instead?" at a venue with no phone number configured. Attempt 1 scored
  // 0.62 — below MIN_VOICE_FIDELITY (0.7) — and answered without inventing
  // anything. That score alone triggered a retry. Attempt 2 scored 0.72 and
  // invented a phone number the first attempt never mentioned:
  // attemptScores: [0.62, 0.72] is the model's own recorded trace.
  //
  // Ruled 2026-09-21 (question 1: B): this loop stays exactly as it is —
  // the grounding check on the FINAL body (lib/agent/stages.ts's
  // verifyGroundingStage) is the single enforcement point, and effort goes
  // into hardening that gate rather than adding a check here. This test
  // documents the behavior the ruling accepted rather than proposing to fix
  // it: nothing inside the loop compares a retry's claims against the
  // attempt it replaced, because there is no such check to trip. The retry
  // is judged on fidelity, dash, self-talk and unverified-link checks only —
  // none of them can see a fact the first attempt never made, because none
  // of them look at the first attempt's body at all once a new one exists.
  it('accepts a regen that introduces a fact absent from the first attempt, when nothing else flags it', async () => {
    const firstAttempt = "I don't always catch calls right away, what's on your mind?"
    const secondAttempt =
      "yeah, here's the number: 415-735-5428. though I'll be honest, I don't always catch calls right away. what's on your mind?"
    queueResponses(
      {
        body: firstAttempt,
        voiceFidelity: 0.62,
        reasoning: 'too generic, below the regen floor',
      },
      {
        body: secondAttempt,
        voiceFidelity: 0.72,
        reasoning: 'more specific and direct',
      },
    )

    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.data.attempts).toBe(2)
    expect(r.data.attemptScores).toEqual([0.62, 0.72])
    // The regen ships as-is: nothing intercepts the fact the second attempt
    // introduced.
    expect(r.data.body).toBe(secondAttempt)

    // Confirms WHY nothing intercepted it: the retry was fidelity-only.
    // None of the three checks that DO compose regen feedback (dash,
    // self-talk, unverified link) ever fired, so the second call carried no
    // instruction of any kind — the model was never told what the first
    // attempt said, let alone asked to stay consistent with it.
    const secondCallPrompt = userPromptOnCall(1)
    expect(secondCallPrompt).not.toContain('do not use a dash character')
    expect(secondCallPrompt).not.toContain('any reference to your own instructions')
    expect(secondCallPrompt).not.toContain('is not a link')
    expect(secondCallPrompt).not.toContain('are not links')
    expect(r.data.attemptHistory[1].userPromptOverride).toBeUndefined()
  })
})

describe('generateMessage — prompt cache breakpoint', () => {
  beforeEach(() => {
    generateObjectMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('NO DRIFT: the system blocks rejoin to exactly the systemPrompt on the result', () => {
    // r.data.systemPrompt is what the Langfuse trace records and what every
    // measurement script replays. If the blocks actually sent ever diverge
    // from it, the traces stop describing the request that was made.
    queueResponses({ body: 'we close at 11', voiceFidelity: 0.9, reasoning: 'r' })
    return generateMessage(makeInput()).then((r) => {
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const blocks = systemBlocksOnCall(0)
      expect(blocks).toHaveLength(2)
      expect(blocks.map((b) => b.content).join('\n\n')).toBe(r.data.systemPrompt)
    })
  })

  it('marks the first system block ephemeral and leaves the second unmarked', async () => {
    queueResponses({ body: 'we close at 11', voiceFidelity: 0.9, reasoning: 'r' })
    await generateMessage(makeInput())

    const [stable, volatile] = systemBlocksOnCall(0)
    // ttl '1h' rather than the 5m default is a measured choice, not a
    // formality: pilot inter-message gaps put only ~60% of messages inside a
    // 5m window and ~82% inside an hour. Pinned so a "tidy up the default"
    // edit has to argue with the traffic data in generate-message.ts.
    expect(stable.providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
    })
    // Marking the volatile block too would write a fresh entry every message
    // and read none — the write premium with none of the benefit.
    expect(volatile.providerOptions).toBeUndefined()
  })

  it('spends exactly one of the four available breakpoints', async () => {
    // Anthropic allows at most 4 cache_control breakpoints per request.
    // Nothing here needs more than one, and a second added carelessly is how
    // that budget gets silently consumed.
    queueResponses({ body: 'we close at 11', voiceFidelity: 0.9, reasoning: 'r' })
    await generateMessage(makeInput())

    const { messages } = generateObjectMock.mock.calls[0][0] as {
      messages: { providerOptions?: Record<string, unknown> }[]
    }
    const marked = messages.filter((m) => m.providerOptions !== undefined)
    expect(marked).toHaveLength(1)
  })

  it('sends a byte-identical prefix on every attempt of one call', async () => {
    // Within a single generateMessage the retries differ only in the USER
    // turn. If a retry rebuilt the prefix differently, attempt 2 would miss
    // the entry attempt 1 just wrote — the regen path is exactly where
    // caching should pay the most.
    // A self-talk retry, because that is the case where the user turn DOES
    // change: a fidelity-only retry appends no feedback and re-sends a
    // byte-identical request (see regenFeedback staying null in the loop).
    queueResponses(
      { body: 'sure thing, as an AI I should say', voiceFidelity: 0.9, reasoning: 'self-talk' },
      { body: 'yeah, of course', voiceFidelity: 0.9, reasoning: 'better' },
    )
    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.attempts).toBe(2)

    expect(systemBlocksOnCall(1)[0].content).toBe(systemBlocksOnCall(0)[0].content)
    expect(systemBlocksOnCall(1)[0].providerOptions).toEqual(
      systemBlocksOnCall(0)[0].providerOptions,
    )
    // The user turn is what carries the retry feedback, so it must differ.
    expect(userPromptOnCall(1)).not.toBe(userPromptOnCall(0))
  })

  it('keeps the voice-fidelity instruction last, where it has always been', async () => {
    // THE-160's instruction is appended after the category block. Moving it
    // into the cached prefix would be a silent prompt change, so its position
    // is pinned rather than left to the reader of the composition code.
    queueResponses({ body: 'we close at 11', voiceFidelity: 0.9, reasoning: 'r' })
    const r = await generateMessage(makeInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const [stable, volatile] = systemBlocksOnCall(0)
    expect(volatile.content.endsWith(VOICE_FIDELITY_INSTRUCTION)).toBe(true)
    expect(stable.content).not.toContain(VOICE_FIDELITY_INSTRUCTION)
  })
})

describe('replaceDashes — the edge cases probing found', () => {
  // These are unit tests on the pure function rather than loop tests, because
  // each is about the SUBSTITUTION itself and none needs a generation. Every
  // one was found by running the function over adversarial inputs, not by
  // reading it — the first version passed every loop test above while getting
  // all three of these wrong.

  it('leaves a dash INSIDE a url alone', () => {
    // The dangerous one. replaceDashes runs BEFORE findUnverifiedUrls, so a
    // mangled URL is what gets allowlist-checked: the model would be blamed,
    // and the draft queued, for a link it got right.
    const body = 'grab it at https://example.com/beans/a—b today'
    expect(replaceDashes(body)).toBe(body)
  })

  it('still substitutes prose on either side of a url', () => {
    // The inverse of the above — skipping URLs must not disable the whole
    // substitution for any body that happens to contain a link.
    expect(replaceDashes('yes — see https://example.com/x — anytime')).toBe(
      'yes, see https://example.com/x, anytime',
    )
  })

  it('never opens a body on a comma', () => {
    expect(replaceDashes('— leading')).toBe('leading')
    expect(replaceDashes('—a')).toBe('a')
  })

  it('REFUSES to empty a non-empty body', () => {
    // A body that is only a dash would substitute to nothing. An empty body is
    // refused downstream by sendMessage's message_must_have_content guard, so
    // it cannot ship blank — but the guest would get silence and a red alert
    // instead of a reply, which is strictly worse than the dash. Keeping the
    // original lets dashViolationPersisted fire, which is what that flag is
    // for.
    expect(replaceDashes('—')).toBe('—')
    expect(replaceDashes(' — ')).toBe(' — ')
    expect(replaceDashes('–')).toBe('–')
  })

  it('handles several dashes in one body', () => {
    expect(replaceDashes('a — b — c')).toBe('a, b, c')
  })

  it('leaves an ascii double-hyphen alone', () => {
    // Not in DASH_REGEX's set and never was. Pinned so a future "tidy up the
    // dash handling" edit does not quietly widen the substitution to prose
    // the R3 voice rule permits.
    expect(replaceDashes('--')).toBe('--')
  })

  it('is idempotent', () => {
    // The loop applies it once per attempt and the final body is recomputed
    // by dashViolationPersisted. A non-idempotent transform would drift a
    // body that survived more than one pass.
    const once = replaceDashes('we close at 11 — come by anytime')
    expect(replaceDashes(once)).toBe(once)
  })

  it('leaves a clean body byte-identical', () => {
    // The overwhelmingly common case: ~99% of bodies have no dash at all, and
    // this function runs on every one of them.
    const clean = "we close at 11. come by anytime, we'd love to see you!"
    expect(replaceDashes(clean)).toBe(clean)
  })
})
