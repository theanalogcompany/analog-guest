import { describe, expect, it } from 'vitest'
import { parseVenueSpec } from './parse-venue-spec'

// Minimum-valid spec body: sections 1-6 stubbed with the smallest content the
// parser accepts. Section 7 is templated by the caller so each test can vary
// it. Tests are hermetic — they don't read the fixture file, since fixtures
// drift over time.
function buildSpec(section7: string): string {
  return [
    '## 1. Venue identification',
    '',
    '- **Slug:** test-venue',
    '- **Name:** Test Venue',
    '- **Timezone:** America/Los_Angeles',
    '',
    '## 2. Airtable intake',
    '',
    '- **Address Line 1:** 123 Main St',
    '- **City:** Testville',
    '- **State:** CA',
    '- **Postal Code:** 90210',
    '',
    '## 3. brand_persona',
    '',
    '```json',
    JSON.stringify(
      {
        tone: 'warm',
        formality: 'warm',
        speakerFraming: 'venue',
        emojiPolicy: 'never',
        lengthGuide: 'short, conversational',
      },
      null,
      2,
    ),
    '```',
    '',
    '## 4. venue_info',
    '',
    '## 5. mechanics',
    '',
    '```json',
    JSON.stringify(
      { type: 'perk', name: 'Test Perk', trigger: { type: 'manual' } },
      null,
      2,
    ),
    '```',
    '',
    '## 6. voice_corpus',
    '',
    ...Array.from({ length: 5 }, (_, i) =>
      [
        '```json',
        JSON.stringify({
          source_type: 'manual_entry',
          content: `voice exemplar ${i + 1}`,
          tags: ['welcome'],
          confidence_score: 0.9,
        }),
        '```',
        '',
      ].join('\n'),
    ),
    section7,
  ].join('\n')
}

describe('parseVenueSpec — knowledge_corpus', () => {
  it('parses multiple valid entries with topical tags', () => {
    const section7 = [
      '## 7. knowledge_corpus',
      '',
      '```json',
      JSON.stringify({
        source_type: 'voicenote_transcript',
        content: 'Our flagship blend is two Ethiopian coffees roasted by a friend.',
        tags: ['sourcing', 'ethiopia'],
        confidence_score: 0.9,
      }),
      '```',
      '',
      '```json',
      JSON.stringify({
        source_type: 'manual_entry',
        content: 'The Joey is offered to regulars on quiet weekday afternoons.',
        tags: ['mechanic_the_joey', 'explanation'],
        confidence_score: 0.85,
      }),
      '```',
    ].join('\n')

    const parsed = parseVenueSpec(buildSpec(section7))

    expect(parsed.knowledgeCorpus).toHaveLength(2)
    expect(parsed.knowledgeCorpus[0]).toMatchObject({
      source_type: 'voicenote_transcript',
      tags: ['sourcing', 'ethiopia'],
      confidence_score: 0.9,
    })
    expect(parsed.knowledgeCorpus[1].tags).toEqual(['mechanic_the_joey', 'explanation'])
  })

  it('returns an empty array when section 7 is absent (older specs)', () => {
    const parsed = parseVenueSpec(buildSpec(''))
    expect(parsed.knowledgeCorpus).toEqual([])
    // The other sections still parse as expected — knowledge_corpus is purely additive.
    expect(parsed.voiceCorpus).toHaveLength(5)
    expect(parsed.mechanics).toHaveLength(1)
  })

  it('throws on a knowledge_corpus entry missing a required field', () => {
    const section7 = [
      '## 7. knowledge_corpus',
      '',
      '```json',
      JSON.stringify({ source_type: 'manual_entry', tags: ['sourcing'] }),
      '```',
    ].join('\n')

    expect(() => parseVenueSpec(buildSpec(section7))).toThrow(
      /knowledge_corpus entry invalid/,
    )
  })
})
