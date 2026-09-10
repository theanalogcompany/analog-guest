import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildExtractionSystemPrompt } from './extract'

const fixtureMarkdown = readFileSync(resolve(__dirname, 'fixtures/venue-spec-example.md'), 'utf-8')
const venueInfoSchemaSource = readFileSync(resolve(__dirname, '../../lib/schemas/venue-info.ts'), 'utf-8')

describe('venue-spec-example.md fixture (TAC-342 regression canary)', () => {
  // v03 of the onboarding question set renumbered "operating reality" from
  // section 9 to section 12, stranding the fixture's currentContext.source
  // example at a section that no longer exists. Guard against reintroducing
  // a section-numbered provenance string in either the fixture or the schema
  // docstring that documents it.
  it('contains no "interview_section_9" vocabulary', () => {
    expect(fixtureMarkdown).not.toContain('interview_section_9')
  })

  it('uses the semantic "interview_operating_reality" provenance string', () => {
    expect(fixtureMarkdown).toContain('interview_operating_reality')
  })

  it('VenueContextNoteSchema docstring contains no "interview_section_9" vocabulary', () => {
    expect(venueInfoSchemaSource).not.toContain('interview_section_9')
  })
})

describe('venue-spec-example.md fixture (TAC-331 regression canary)', () => {
  // The live bad string at Mock Sextant Coffee Roasters was
  // "Latte — $6.75 — first-timer pick; ..." — traced back to this fixture's
  // own menu.highlights placeholder using that exact vocabulary as an "e.g."
  // hint, which the model echoed verbatim into extraction output. Guard
  // against reintroducing either phrase anywhere in the fixture.
  it('contains no "first-timer pick" vocabulary', () => {
    expect(fixtureMarkdown).not.toContain('first-timer pick')
  })

  it('contains no "perfect-order anchor" vocabulary', () => {
    expect(fixtureMarkdown).not.toContain('perfect-order anchor')
  })

  it('models an opinionated-recommendation knowledge_corpus entry with the recommendations tag', () => {
    expect(fixtureMarkdown).toContain('"primary_tags": ["recommendations"]')
  })
})

describe('buildExtractionSystemPrompt (TAC-331)', () => {
  const prompt = buildExtractionSystemPrompt(fixtureMarkdown)

  it('routes opinionated recommendations to knowledge_corpus, never venue_info', () => {
    expect(prompt).toContain('OPINIONATED RECOMMENDATIONS ALWAYS ROUTE TO knowledge_corpus, NEVER venue_info')
  })

  it('states the mood rule for prescriptive content that stays in venue_info', () => {
    expect(prompt).toContain('Mood rule for content that legitimately stays in venue_info prose')
  })

  it('includes the worked latte example in attributed indicative form', () => {
    expect(prompt).toContain("The owner's pick for a first-timer is the latte")
  })

  it('embeds the fixture markdown verbatim as the example structure', () => {
    expect(prompt).toContain(fixtureMarkdown)
  })
})

describe('buildExtractionSystemPrompt (TAC-343 Phase 0 — knowledge_corpus granularity)', () => {
  const prompt = buildExtractionSystemPrompt(fixtureMarkdown)

  it('states the one-entry-per-self-contained-claim granularity rule', () => {
    expect(prompt).toContain('one entry per self-contained claim')
  })

  it('instructs splitting a multi-item passage into multiple entries, not one', () => {
    expect(prompt).toContain('Five signature drinks discussed is five entries, not one')
  })

  it('requires each entry to name its own subject', () => {
    expect(prompt).toContain("entry's content must name its own subject")
  })

  it('warns against relying on chunkText() to separate subjects downstream', () => {
    expect(prompt).toContain('chunkText()')
  })
})

describe('venue-spec-example.md fixture (TAC-343 Phase 0 — granularity)', () => {
  it('documents the granularity rule inline in section 7', () => {
    expect(fixtureMarkdown).toContain('one entry per self-contained claim')
  })
})
