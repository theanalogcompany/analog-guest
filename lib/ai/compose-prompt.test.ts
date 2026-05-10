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
