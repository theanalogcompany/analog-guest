import { describe, expect, it } from 'vitest'
import {
  type BrandPersona,
  BrandPersonaSchema,
  type VenueInfo,
  VenueInfoSchema,
} from '../schemas'
import { composePrompt } from './compose-prompt'
import type { GenerateMessageInput, KnowledgeCorpusChunk } from './types'

function makePersona(): BrandPersona {
  return BrandPersonaSchema.parse({
    tone: 'warm and direct',
    formality: 'casual',
    speakerFraming: 'venue',
    emojiPolicy: 'never',
    lengthGuide: 'short — 1-2 sentences',
  })
}

function makeVenueInfo(): VenueInfo {
  return VenueInfoSchema.parse({
    address: { line1: '1 Test St', city: 'Test', region: 'CA', postalCode: '94000' },
  })
}

function makeInput(
  overrides: Partial<GenerateMessageInput> = {},
): GenerateMessageInput {
  return {
    category: 'reply',
    persona: makePersona(),
    venueInfo: makeVenueInfo(),
    ragChunks: [],
    runtime: {},
    ...overrides,
  }
}

const exampleChunk: KnowledgeCorpusChunk = {
  id: 'k1',
  text: 'flagship blend story',
  sourceType: 'voicenote_transcript',
  primaryTags: ['sourcing'],
  secondaryTags: ['ethiopia'],
  relevanceScore: 0.7,
}

describe('composePrompt — knowledge block rendering (TAC-242)', () => {
  it('OMITS the ## Venue knowledge block when knowledgeChunks is undefined', () => {
    // undefined = retrieval was gated off (e.g., day_* cron). The block
    // should not appear at all.
    const { systemPrompt } = composePrompt(makeInput({ knowledgeChunks: undefined }))
    expect(systemPrompt).not.toContain('## Venue knowledge')
  })

  it('RENDERS the no-match block when knowledgeChunks is an empty array', () => {
    // [] = retrieval ran but matched nothing. The agent should know it
    // lacked grounding so R9 (admit uncertainty) fires reliably.
    const { systemPrompt } = composePrompt(makeInput({ knowledgeChunks: [] }))
    expect(systemPrompt).toContain('## Venue knowledge')
    expect(systemPrompt).toContain('No specific venue knowledge matched this query')
  })

  it('RENDERS chunks with their primary/secondary tag lines when non-empty', () => {
    const { systemPrompt } = composePrompt(
      makeInput({ knowledgeChunks: [exampleChunk] }),
    )
    expect(systemPrompt).toContain('## Venue knowledge')
    expect(systemPrompt).toContain('[primary: sourcing]')
    expect(systemPrompt).toContain('[secondary: ethiopia]')
    expect(systemPrompt).toContain('> flagship blend story')
    // Non-empty path does not render the no-match framing.
    expect(systemPrompt).not.toContain('No specific venue knowledge matched this query')
  })
})

// ---------------------------------------------------------------------------
// TAC-314: assertions scoped to the ASSEMBLED prompt, not the constant.
// ---------------------------------------------------------------------------
//
// The defect class this guards against: a rule exists, its unit test is green,
// and it never renders on the turn that needed it. TAC-313's price scoping
// lived in NEW_QUESTION_INSTRUCTIONS with a passing test while the price
// leaked on a `reply` turn — the test was scoped to the wrong layer, and green
// was a stronger signal than absent. These tests check the string the model
// actually receives.

// The three categories from the TAC-314 UAT table: the two that failed and the
// one that passed. The promoted rules must render on ALL of them.
const UAT_CATEGORIES = ['reply', 'recommendation_request', 'new_question'] as const

function systemPromptFor(category: (typeof UAT_CATEGORIES)[number]): string {
  return composePrompt(makeInput({ category })).systemPrompt
}

describe('composePrompt — promoted universal rules render on every category (TAC-314)', () => {
  it.each(UAT_CATEGORIES)('price scoping (R17) renders for %s', (category) => {
    expect(systemPromptFor(category)).toContain(
      'Price is not part of an answer unless the guest asked',
    )
  })

  it.each(UAT_CATEGORIES)('nearby-places carve-out (R18) renders for %s', (category) => {
    expect(systemPromptFor(category)).toContain(
      "speak with the same confidence you'd use about the menu",
    )
  })

  it.each(UAT_CATEGORIES)('mirroring (R19) and length authority (R20) render for %s', (category) => {
    const prompt = systemPromptFor(category)
    expect(prompt).toContain('Match the register and length of what the guest sent')
    expect(prompt).toContain('only authority on how long a message should be')
  })

  it('category instructions still render after the universal block, per assembly order', () => {
    // The layering TAC-314 legislates for: universal rules render, then the
    // category block. Position is the whole reason the strip mattered — a
    // form directive in the later block outranks everything above it.
    const prompt = systemPromptFor('recommendation_request')
    const universalIdx = prompt.indexOf('# Universal voice rules')
    const categoryIdx = prompt.indexOf(
      '## Category-specific instructions: recommendation_request',
    )
    expect(universalIdx).toBeGreaterThan(-1)
    expect(categoryIdx).toBeGreaterThan(universalIdx)
  })

  it('the assembled prompt carries no length directive after the category heading', () => {
    // End-to-end statement of the governing principle: whatever renders after
    // the category heading — the most proximate text the model reads — must
    // not carry a length or sentence-count prescription.
    for (const category of UAT_CATEGORIES) {
      const prompt = systemPromptFor(category)
      const tail = prompt.slice(prompt.indexOf('## Category-specific instructions:'))
      expect(tail).not.toMatch(
        /keep it short|short sentences? total|one short (line|message)|stay short|at or below the length/i,
      )
    }
  })
})
