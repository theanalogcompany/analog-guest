import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildExtractionSystemPrompt } from './extract'

const fixtureMarkdown = readFileSync(resolve(__dirname, 'fixtures/venue-spec-example.md'), 'utf-8')

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
