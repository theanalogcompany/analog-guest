import { describe, expect, it } from 'vitest'
import { parseVenueSpec } from './parse-venue-spec'

// Minimum-valid spec body: sections 1-6 stubbed with the smallest content the
// parser accepts. Section 7 is templated by the caller so each test can vary
// it. Tests are hermetic — they don't read the fixture file, since fixtures
// drift over time.
function buildSpec(section7: string, section4Extra = ''): string {
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
    section4Extra,
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

describe('parseVenueSpec — knowledge_corpus (TAC-242)', () => {
  it('parses entries with primary_tags + secondary_tags', () => {
    const section7 = [
      '## 7. knowledge_corpus',
      '',
      '```json',
      JSON.stringify({
        source_type: 'voicenote_transcript',
        content: 'Our flagship blend is two Ethiopian coffees roasted by a friend.',
        primary_tags: ['sourcing'],
        secondary_tags: ['ethiopia', 'roaster'],
        confidence_score: 0.9,
      }),
      '```',
      '',
      '```json',
      JSON.stringify({
        source_type: 'manual_entry',
        content: 'The Joey is offered to regulars on quiet weekday afternoons.',
        primary_tags: ['mechanic_the_joey'],
        secondary_tags: ['explanation'],
        confidence_score: 0.85,
      }),
      '```',
    ].join('\n')

    const parsed = parseVenueSpec(buildSpec(section7))

    expect(parsed.knowledgeCorpus).toHaveLength(2)
    expect(parsed.knowledgeCorpus[0]).toMatchObject({
      source_type: 'voicenote_transcript',
      primary_tags: ['sourcing'],
      secondary_tags: ['ethiopia', 'roaster'],
      confidence_score: 0.9,
    })
    expect(parsed.knowledgeCorpus[1].primary_tags).toEqual(['mechanic_the_joey'])
    expect(parsed.knowledgeCorpus[1].secondary_tags).toEqual(['explanation'])
  })

  it('accepts a chunk with multiple primary_tags spanning topics', () => {
    const section7 = [
      '## 7. knowledge_corpus',
      '',
      '```json',
      JSON.stringify({
        source_type: 'voicenote_transcript',
        content: "Phoebe's seasonal matcha experiments draw the morning regulars.",
        primary_tags: ['menu', 'staff_phoebe'],
        secondary_tags: ['seasonal', 'matcha'],
        confidence_score: 0.9,
      }),
      '```',
    ].join('\n')

    const parsed = parseVenueSpec(buildSpec(section7))
    expect(parsed.knowledgeCorpus[0].primary_tags).toEqual(['menu', 'staff_phoebe'])
  })

  it('defaults primary_tags + secondary_tags to [] when omitted', () => {
    const section7 = [
      '## 7. knowledge_corpus',
      '',
      '```json',
      JSON.stringify({
        source_type: 'manual_entry',
        content: 'A bare entry with neither tag array.',
        confidence_score: 0.85,
      }),
      '```',
    ].join('\n')

    const parsed = parseVenueSpec(buildSpec(section7))
    expect(parsed.knowledgeCorpus[0].primary_tags).toEqual([])
    expect(parsed.knowledgeCorpus[0].secondary_tags).toEqual([])
  })

  it('throws fail-loud on a non-canonical primary_tag', () => {
    const section7 = [
      '## 7. knowledge_corpus',
      '',
      '```json',
      JSON.stringify({
        source_type: 'voicenote_transcript',
        content: 'something',
        primary_tags: ['personality'],
        secondary_tags: [],
        confidence_score: 0.9,
      }),
      '```',
    ].join('\n')

    expect(() => parseVenueSpec(buildSpec(section7))).toThrow(/non-canonical/)
  })

  it('returns an empty array when section 7 is absent (older specs)', () => {
    const parsed = parseVenueSpec(buildSpec(''))
    expect(parsed.knowledgeCorpus).toEqual([])
    expect(parsed.voiceCorpus).toHaveLength(5)
    expect(parsed.mechanics).toHaveLength(1)
  })

  it('throws on a knowledge_corpus entry missing a required field', () => {
    const section7 = [
      '## 7. knowledge_corpus',
      '',
      '```json',
      JSON.stringify({ source_type: 'manual_entry', primary_tags: ['sourcing'] }),
      '```',
    ].join('\n')

    expect(() => parseVenueSpec(buildSpec(section7))).toThrow(
      /knowledge_corpus entry invalid/,
    )
  })
})

describe('parseVenueSpec — staff[].notes routing (TAC-343 Phase 0)', () => {
  function withStaff(staffEntries: Array<Record<string, unknown>>): string {
    const section4Extra = [
      '### staff',
      '',
      '```json',
      JSON.stringify(staffEntries),
      '```',
      '',
    ].join('\n')
    return buildSpec('', section4Extra)
  }

  it('routes non-empty staff notes into a staff_<slug> knowledge_corpus entry instead of dropping them', () => {
    const parsed = parseVenueSpec(
      withStaff([
        {
          name: 'Phoebe Chen',
          role: 'Bar lead',
          notes: 'Runs seasonal matcha experiments; been here since 2019.',
        },
      ]),
    )

    // The flattened roster string is unchanged — notes never widen venue_info.staff.
    expect(parsed.venueInfo.staff).toEqual(['Phoebe Chen — Bar lead'])

    const staffChunk = parsed.knowledgeCorpus.find((c) =>
      c.primary_tags.includes('staff_phoebe_chen'),
    )
    expect(staffChunk).toBeDefined()
    expect(staffChunk?.content).toContain('Runs seasonal matcha experiments')
    expect(staffChunk?.secondary_tags).toContain('staff_notes')
  })

  it('does not synthesize a chunk when notes is empty or absent', () => {
    const parsed = parseVenueSpec(withStaff([{ name: 'Sam', role: 'Owner' }]))

    expect(parsed.venueInfo.staff).toEqual(['Sam — Owner'])
    expect(
      parsed.knowledgeCorpus.filter((c) => c.primary_tags.some((t) => t.startsWith('staff_'))),
    ).toHaveLength(0)
  })

  it('still synthesizes a chunk per staff member with notes, alongside extraction-authored entries', () => {
    const section4Extra = [
      '### staff',
      '',
      '```json',
      JSON.stringify([
        { name: 'Phoebe', role: 'Bar lead', notes: 'Seasonal matcha experiments.' },
        { name: 'Sam', role: 'Owner', notes: '' },
      ]),
      '```',
      '',
    ].join('\n')
    const section7 = [
      '## 7. knowledge_corpus',
      '',
      '```json',
      JSON.stringify({
        source_type: 'voicenote_transcript',
        content: 'Our flagship blend is two Ethiopian coffees roasted by a friend.',
        primary_tags: ['sourcing'],
        secondary_tags: ['ethiopia'],
        confidence_score: 0.9,
      }),
      '```',
    ].join('\n')

    const parsed = parseVenueSpec(buildSpec(section7, section4Extra))

    expect(parsed.knowledgeCorpus).toHaveLength(2)
    expect(parsed.knowledgeCorpus.some((c) => c.primary_tags.includes('sourcing'))).toBe(true)
    expect(parsed.knowledgeCorpus.some((c) => c.primary_tags.includes('staff_phoebe'))).toBe(true)
  })
})

describe('parseVenueSpec — Needs confirmation section (TAC-346)', () => {
  const section7 = [
    '## 7. knowledge_corpus',
    '',
    '```json',
    JSON.stringify({
      source_type: 'voicenote_transcript',
      content: 'Some knowledge chunk.',
      primary_tags: ['other'],
      secondary_tags: [],
      confidence_score: 0.9,
    }),
    '```',
  ].join('\n')

  // Includes prose, a bullet list, AND a stray ```json``` fenced block
  // inside it — simulating the case where the verification pass's own
  // Needs-confirmation prose happens to contain example-shaped JSON. If
  // extractJsonBlocks were ever scoped globally instead of per-matched-
  // section, this stray block would leak into knowledgeCorpus.
  const needsConfirmationSection = [
    '',
    '## Needs confirmation',
    '',
    '*Generated by the verification pass.*',
    '',
    '### Mechanic approval values',
    '- **Test Perk**: requires_operator_approval = **false** — none, defaulted',
    '',
    '### Unsupported claims',
    '```json',
    JSON.stringify({ section: '4. venue_info', claim: 'a claim', reason: 'not_in_source' }),
    '```',
  ].join('\n')

  it('ignores a trailing Needs confirmation section entirely, including one containing a stray json block', () => {
    const withoutSection = parseVenueSpec(buildSpec(section7))
    const withSection = parseVenueSpec(buildSpec(section7 + needsConfirmationSection))
    expect(withSection).toEqual(withoutSection)
    expect(withSection.knowledgeCorpus).toHaveLength(1)
  })
})
