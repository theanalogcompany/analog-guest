import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MECHANIC_TRIGGER_TYPES } from '@/lib/schemas'
import { buildExtractionSystemPrompt, MECHANIC_APPROVAL_CRITERIA } from './extract'

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

describe('venue-spec-example.md fixture (TAC-346 regression canaries)', () => {
  // Mechanic 1's trigger.type placeholder used to list "date_match" as an
  // example value alongside the two real canonical ones — it was never a
  // valid MECHANIC_TRIGGER_TYPES member, and the fixture had been teaching
  // the model a fake third trigger type. Guard against reintroducing it.
  it('contains no "date_match" vocabulary', () => {
    expect(fixtureMarkdown).not.toContain('date_match')
  })

  // Voice corpus Entry 7 used to be a manual_entry "SYNTHESIZED VOICE
  // EXAMPLE" — exactly the padding-via-synthesis pattern this ticket
  // removes. Scoped to the voice_corpus section specifically, since
  // knowledge_corpus's Entry 3 legitimately uses manual_entry.
  it('contains no manual_entry source_type inside the voice_corpus section', () => {
    const start = fixtureMarkdown.indexOf('## 6. voice_corpus')
    const end = fixtureMarkdown.indexOf('## 7. knowledge_corpus')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const voiceCorpusSection = fixtureMarkdown.slice(start, end)
    expect(voiceCorpusSection).not.toContain('"source_type": "manual_entry"')
  })

  it('the Pre-seed validation checklist section has been removed (superseded by Needs confirmation)', () => {
    expect(fixtureMarkdown).not.toContain('Pre-seed validation checklist')
  })

  it('models two operational-fact knowledge_corpus entries tagged policies and logistics', () => {
    expect(fixtureMarkdown).toContain('"primary_tags": ["policies"]')
    expect(fixtureMarkdown).toContain('"primary_tags": ["logistics"]')
  })

  it('models requires_operator_approval on Mechanic 1 and omits it from Mechanic 2', () => {
    const mechanic1Start = fixtureMarkdown.indexOf('### Mechanic 1')
    const mechanic2Start = fixtureMarkdown.indexOf('### Mechanic 2')
    const mechanic2End = fixtureMarkdown.indexOf('> Notes on the new fields')
    expect(fixtureMarkdown.slice(mechanic1Start, mechanic2Start)).toContain('"requires_operator_approval": true')
    expect(fixtureMarkdown.slice(mechanic2Start, mechanic2End)).not.toContain('requires_operator_approval')
  })
})

// UAT round 1 (Le Mil's): an 8-entry voice_corpus with zero real texting
// voice cleared the raw-count floor. Part of the fix is the fixture itself —
// a 9-example corpus shaped as origin/mission/menu-quote content (the exact
// shapes the new voice-qualification check disqualifies: interview
// monologue, describing the business) kept teaching extraction to write
// that. Cut to 3 guest-addressed text entries. Revision (owner decision):
// voice also comes from short spoken lines to a guest, not only texts —
// added a 4th entry modeling that shape.
describe('venue-spec-example.md fixture — voice_corpus is guest-facing (UAT round 1 fix + revision)', () => {
  function voiceCorpusSection(): string {
    const start = fixtureMarkdown.indexOf('## 6. voice_corpus')
    const end = fixtureMarkdown.indexOf('## 7. knowledge_corpus')
    return fixtureMarkdown.slice(start, end)
  }

  it('has exactly 4 entries, not 9', () => {
    const matches = voiceCorpusSection().match(/^### Entry \d+/gm) ?? []
    expect(matches).toHaveLength(4)
  })

  it('every entry is framed as addressed TO a guest, not about the business', () => {
    const section = voiceCorpusSection()
    expect(section).toContain('welcoming a guest back')
    expect(section).toContain("answering a guest's question")
    expect(section).toContain("after a guest's visit")
    // Regression canary: none of the removed origin/mission/menu-quote
    // framing (interview-register content the new check disqualifies)
    // should reappear here.
    expect(section).not.toContain('origin/identity flavor')
    expect(section).not.toContain('framing of why the venue exists')
  })

  it('models a short spoken line to a guest, distinct from a text message', () => {
    const section = voiceCorpusSection()
    expect(section).toContain('SHORT SPOKEN LINE')
    expect(section).toContain('across the counter')
    expect(section).toContain('Not a text message — a line of spoken voice')
  })

  it('does not contain the pre-fix vocabulary teaching extraction to model interview monologue as voice_corpus', () => {
    const section = voiceCorpusSection()
    expect(section).not.toContain('operator on how they actually talk')
    expect(section).not.toContain('a behind-the-scenes detail or obsession')
  })
})

// UAT round 1 finding 2 (Le Mil's): the changing table and Bombay sandwich
// were duplicated into permanent fields as well as currentContext. The
// amenities.notes placeholder's own "equipment status" example was itself
// an invitation to write exactly that pattern.
describe('venue-spec-example.md fixture — permanent-field placement fixes (UAT round 1 fix)', () => {
  it('amenities.notes placeholder no longer suggests "equipment status" (currentContext keeping it as its own example is correct — that IS the right home for it)', () => {
    const start = fixtureMarkdown.indexOf('### amenities')
    const end = fixtureMarkdown.indexOf('### menu.highlights')
    expect(fixtureMarkdown.slice(start, end)).not.toContain('equipment status')
  })

  it('section 7 intro covers operational facts, not narrative only', () => {
    const start = fixtureMarkdown.indexOf('## 7. knowledge_corpus')
    const end = fixtureMarkdown.indexOf('### Entry 1', start)
    const intro = fixtureMarkdown.slice(start, end)
    expect(intro).toContain('OPERATIONAL FACTS')
    expect(intro).toContain('policies and logistics venue_info has no field for')
  })
})

describe('buildExtractionSystemPrompt (TAC-346)', () => {
  const prompt = buildExtractionSystemPrompt(fixtureMarkdown)

  it('bans manual_entry and padding for voice_corpus', () => {
    expect(prompt).toContain('Do NOT use source_type=\'manual_entry\' for voice_corpus under any circumstance')
    expect(prompt).toContain('Do not manufacture entries to reach 5')
  })

  it('bans joking, sarcastic, or hypothetical scenario answers in voice_corpus', () => {
    expect(prompt).toContain('Do NOT include joking, sarcastic, or hypothetical scenario answers')
  })

  // Revision to change A (owner decision): voice comes from how the
  // operator talks to guests generally, not only from texts.
  it('accepts short spoken lines addressed to a guest as qualifying voice_corpus content', () => {
    expect(prompt).toContain('a short SPOKEN line addressed to a guest')
    expect(prompt).toContain('something the operator would plausibly say to a guest across the counter')
    expect(prompt).toContain('Texting-specific conventions (length, emojis, tone) already live in brand_persona')
  })

  it('still bans long narrative/reflective passages and lines addressed to the interviewer in voice_corpus', () => {
    expect(prompt).toContain('Do NOT include long narrative or reflective passages about the business\'s history, mission, or sourcing')
    expect(prompt).toContain('the operator explaining a perk or policy TO THE INTERVIEWER rather than saying it TO a guest')
  })

  it('removes the 8-25 knowledge_corpus cap and covers operational facts', () => {
    expect(prompt).not.toContain('8-25 substantive narrative chunks')
    expect(prompt).toContain('There is no target range and no cap')
    expect(prompt).toContain('EVERYTHING TRUE ABOUT THE VENUE THAT ISN\'T A STRUCTURED FIELD IN venue_info')
  })

  it('states the currentContext-vs-permanent exclusivity rule and the ISO-only expiresAt rule', () => {
    expect(prompt).toContain('a fact belongs in EXACTLY ONE place, never both')
    expect(prompt).toContain('it MUST be a full ISO 8601 date (YYYY-MM-DD) — never a relative phrase')
  })

  it('resolves relative dates against the interview date input, never leaving a relative phrase unresolved', () => {
    expect(prompt).toContain('Resolve every relative date in the transcript')
    expect(prompt).toContain('never leave a relative phrase in a date field')
  })

  it('bans routing/handoff instructions in persona fields without naming Needs confirmation as a destination', () => {
    expect(prompt).toContain('Never a routing or handoff instruction')
    expect(prompt).toContain('omit it from brand_persona entirely')
    // Change #2: extraction should never be told a category of content
    // "belongs in" Needs confirmation — it should just omit it. Needs
    // confirmation is populated by the separate verification pass.
    expect(prompt).not.toMatch(/belongs (in|to) Needs confirmation/)
  })

  it('bans brainstormed mechanics without naming Needs confirmation as a destination', () => {
    expect(prompt).toContain('Do NOT extract a mechanic from a brainstorm')
    expect(prompt).toContain('Omit it from section 5 entirely')
  })

  it('restricts staff roster to employees only', () => {
    expect(prompt).toContain('list ONLY people actually employed at the venue')
  })

  it('constrains trigger.type to the canonical MECHANIC_TRIGGER_TYPES values, imported not hand-copied', () => {
    for (const t of MECHANIC_TRIGGER_TYPES) {
      expect(prompt).toContain(`'${t}'`)
    }
    expect(prompt).toContain('never invent a third value')
  })

  it('states the requires_operator_approval bias-toward-true rule', () => {
    expect(prompt).toContain('When genuinely unclear, true is the safer answer')
  })

  // TAC-346 fix: the approval criteria must come from the shared constant,
  // not a hand-typed duplicate that could drift from verify.ts's copy.
  it('embeds the shared MECHANIC_APPROVAL_CRITERIA constant verbatim', () => {
    expect(prompt).toContain(MECHANIC_APPROVAL_CRITERIA)
  })
})
