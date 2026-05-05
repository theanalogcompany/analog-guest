import { anthropic } from '@ai-sdk/anthropic'
import { generateText } from 'ai'

const EXTRACTION_MODEL = 'claude-sonnet-4-6'
const MAX_OUTPUT_TOKENS = 8000

export interface ExtractInput {
  slug: string
  transcript: string
  menuCsv: string | null
  airtableFields: Record<string, unknown>
  fixtureMarkdown: string
}

/**
 * Single Claude call producing a venue-spec markdown draft. The output
 * format is enforced by including the gold-standard fixture as a few-shot
 * example with hard rules. The returned string is what gets written back to
 * Drive as 06-{slug}-venue-spec-draft.md.
 */
export async function extractVenueSpec(input: ExtractInput): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Missing env var: ANTHROPIC_API_KEY')
  }

  const systemPrompt = `You are extracting a venue specification document from raw inputs into a single markdown document.

The output MUST be a markdown document that exactly matches the structure of the EXAMPLE below. Every section must be present and filled. Do not add new sections. Do not omit sections — use placeholders like "*(not provided)*" if information is missing. Do not change section numbering or section titles.

Hard rules:
- The example below shows STRUCTURE only. Every value in the example is placeholder text in [BRACKETS]. Your output must replace EVERY placeholder with content drawn entirely from the venue's transcript, menu, and Airtable record. Do NOT copy any placeholder text verbatim. Do NOT invent content not supported by the source materials. If a venue's source materials don't cover something the example shows, use "*(not provided)*" or omit the optional field — never reach for the example's content.
- All JSON code blocks must be valid JSON, parseable by JSON.parse(). String quotes must be straight ASCII quotes, not curly. Field names must match the example exactly.
- The "Live" field in section 1 must always be "false" — the operator flips it manually after smoke test passes.
- For each mechanic, include a "min_state" field set to one of: 'new', 'returning', 'regular', 'raving_fan'. Infer from the qualification text. Mappings: "regulars only" / "for our regulars" / "members" → 'regular'. "raving fans" / "our biggest fans" / "VIP" / "for our most loyal" → 'raving_fan'. "after a few visits" / "returning guests" → 'returning'. No qualification gating (anyone can ask) → 'new'. If the qualification text is genuinely ambiguous, omit the field — the parser treats omission as ungated ('new').
- voice_corpus vs knowledge_corpus — these are two separate sections with two different jobs. Read this carefully before extracting either:
    - voice_corpus = HOW the venue texts guests. Texting exemplars, demonstrated tone, signature phrases the operator showed they'd use in a message. If the interview doesn't include real texting samples, voice_corpus should be sparse — that's correct, not a failure. Do not pad with paraphrased "voice-flavored" content that's really factual.
    - knowledge_corpus = WHAT IS TRUE about the venue. Origin story, sourcing relationships, staff personalities, mechanic explanations, philosophy, recommendations. Self-contained chunks the agent retrieves when grounding answers to substantive guest questions.
    - Examples to disambiguate:
        - Operator says "I'd text a regular saying 'hey, glad you're back'" → voice_corpus.
        - Operator says "Our flagship blend is two Ethiopian coffees" → knowledge_corpus.
        - Operator says "Rayan tells customers the truth about what to order" → knowledge_corpus.
        - Operator says "I'd never use exclamation marks" → already lives in brand_persona.voiceAntiPatterns; do NOT also put it in either corpus.
    - Tags differ by purpose: voice_corpus tags = situation/style ('welcome', 'follow_up', 'perk_surface', 'anti_pattern'). knowledge_corpus tags = topic ('sourcing', 'staff_<name>', 'ceremony', 'mechanic_<slug>', etc.).
- For voice_corpus: extract 5-12 entries. Lean LOW (5-7) when the transcript has no real texting examples, HIGHER (8-12) only when the operator demonstrated actual messages or specific phrasing. source_type='voicenote_transcript' for direct verbatim quotes that depict texting voice, 'manual_entry' for synthesized illustrations. confidence_score: 0.95 for direct verbatim owner quotes, 0.9 for paraphrased, 0.85 for synthesized illustrations.
- For knowledge_corpus: extract 8-25 substantive narrative chunks covering origin/sourcing/staff/ceremony/mechanics/recommendations from the transcript and Airtable record. Range depends on transcript depth — deeper interviews yield more entries. source_type='voicenote_transcript' for direct quotes from the transcript, 'manual_entry' for synthesized chunks composed from multiple parts of the conversation. Tags should be topical (sourcing, staff_<name>, ceremony, mechanic_<slug>, philosophy, recommendations, etc.), not situational. confidence_score: 0.9 for direct/near-direct transcript quotes, 0.85 for synthesized chunks.
- For mechanics: extract from explicit operator descriptions in the transcript. Each must include type, name, description, qualification, reward_description, expiration_rule, trigger (structured object), redemption (structured object).
- Match the example's tone in section narratives — concrete, specific, free of marketing register.

EXAMPLE STRUCTURE (placeholders only — DO NOT copy values verbatim):

${input.fixtureMarkdown}

REMINDER: every [BRACKET] above must be replaced with content from the venue's transcript, menu, and Airtable record. Never copy bracket text verbatim. Never invent content not supported by source materials.`

  const userPrompt = `Slug to extract: ${input.slug}

VENUE INPUTS:

[1] Airtable record (form submission, structured fields):
${JSON.stringify(input.airtableFields, null, 2)}

[2] Owner conversation transcript:
${input.transcript}

[3] Menu CSV:
${input.menuCsv ?? '(not provided)'}

Produce the venue-spec.md draft for "${input.slug}" now. Match the example format exactly.`

  const { text } = await generateText({
    model: anthropic(EXTRACTION_MODEL),
    system: systemPrompt,
    prompt: userPrompt,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  })

  return text
}