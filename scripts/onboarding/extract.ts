import { anthropic } from '@ai-sdk/anthropic'
import { generateText } from 'ai'
import { MECHANIC_TRIGGER_TYPES } from '@/lib/schemas'

const EXTRACTION_MODEL = 'claude-sonnet-4-6'
const MAX_OUTPUT_TOKENS = 64000

// TAC-346: the single source of truth for requires_operator_approval
// criteria, shared verbatim between extraction (which SETS the value) and
// verify.ts (which independently ASSESSES it against the same rule) so the
// two passes can never drift onto different standards. Live incident this
// guards against: verify's first version invented its own looser standard
// ("is this an established practice?") instead of reusing this rule, and
// recommended `false` on a mechanic the owner had explicitly confirmed
// needs his personal approval — whether something is a settled, ongoing
// practice decides whether it's a mechanic AT ALL (a separate, earlier
// gate); it says nothing about whether granting it needs approval, and an
// established practice can still require the operator's personal time and
// discretion every single occurrence.
export const MECHANIC_APPROVAL_CRITERIA = `A mechanic needs requires_operator_approval=true when the transcript shows the operator wanting to decide personally on it, OR when granting it commits the operator's own time, a limited-capacity slot, or something handed out at the operator's personal discretion. It is requires_operator_approval=false ONLY when the transcript explicitly says staff or the agent can grant it freely, with no operator involvement needed. Whether a practice is established, recurring, or already happening regularly is NEVER by itself a reason for false — an established, ongoing practice can still require the operator's personal time and discretion every single time it happens (a recurring invite the operator personally extends each occurrence is still operator time and discretion, not "staff or the agent can grant freely" just because it happens often). When genuinely unclear, true is the safer answer.`

export interface ExtractInput {
  slug: string
  transcript: string
  menuCsv: string | null
  airtableFields: Record<string, unknown>
  fixtureMarkdown: string
  // TAC-346: explicit anchor for resolving relative dates in the transcript
  // ("next month", "this Saturday"). Passed via --interview-date on the CLI;
  // when absent, extraction falls back to inferring a submission date from
  // the Airtable record (section 2's existing "Submission date" field).
  interviewDate?: string
}

/**
 * Pure prompt builder, split out from extractVenueSpec (TAC-331) so the
 * routing/mood rules below are unit-testable without a network call.
 */
export function buildExtractionSystemPrompt(fixtureMarkdown: string): string {
  return `You are extracting a venue specification document from raw inputs into a single markdown document.

The output MUST be a markdown document that exactly matches the structure of the EXAMPLE below. Every section must be present and filled. Do not add new sections. Do not omit sections — use placeholders like "*(not provided)*" if information is missing. Do not change section numbering or section titles.

Hard rules:
- The example below shows STRUCTURE only. Every value in the example is placeholder text in [BRACKETS]. Your output must replace EVERY placeholder with content drawn entirely from the venue's transcript, menu, and Airtable record. Do NOT copy any placeholder text verbatim. Do NOT invent content not supported by the source materials. If a venue's source materials don't cover something the example shows, use "*(not provided)*" or omit the optional field — never reach for the example's content.
- All JSON code blocks must be valid JSON, parseable by JSON.parse(). String quotes must be straight ASCII quotes, not curly. Field names must match the example exactly.
- The "Live" field in section 1 must always be "false" — the operator flips it manually after smoke test passes.
- For each mechanic, include a "min_state" field set to one of: 'new', 'returning', 'regular', 'raving_fan'. Infer from the qualification text. Mappings: "regulars only" / "for our regulars" / "members" → 'regular'. "raving fans" / "our biggest fans" / "VIP" / "for our most loyal" → 'raving_fan'. "after a few visits" / "returning guests" → 'returning'. No qualification gating (anyone can ask) → 'new'. If the qualification text is genuinely ambiguous, omit the field — the parser treats omission as ungated ('new').
- venue_info vs voice_corpus vs knowledge_corpus — three places content can land, with three different jobs. Read this carefully before placing anything:
    - venue_info = STRUCTURED FACTS the agent can look up directly. Hours, address, menu items with prices, payment methods, named staff in the staff list. Goes in section 4.
    - voice_corpus = HOW the venue texts guests, captured only through real or near-verbatim examples of actual outbound texts. Only three kinds of content qualify: (1) a message the operator actually sent or would send verbatim, (2) a paraphrase that stays extremely close to the operator's own words, or (3) a demonstrated exchange the operator walked through concretely (not a hypothetical). Do NOT include: descriptions of style ("I always use emojis", "I keep it short") — those go in brand_persona (tone/lengthGuide/emojiPolicy), never here as if they were examples. Do NOT include joking, sarcastic, or hypothetical scenario answers ("I'm at their house", "if a guest asked X I guess I'd say..."). If the interview doesn't include real texting samples, voice_corpus should be sparse or even empty — that's correct, not a failure. Never synthesize a message from scratch to fill a quota.
    - knowledge_corpus = EVERYTHING TRUE ABOUT THE VENUE THAT ISN'T A STRUCTURED FIELD IN venue_info. Two kinds of content live here, both equally in scope: (1) NARRATIVE — stories, explanations, context: origin, sourcing relationships and the personalities involved, staff personality details, mechanic explanations, philosophy, opinionated recommendations. (2) OPERATIONAL FACTS — plain policies and logistics venue_info has no field for: tipping, walk-ins-only, no delivery, shipping, stockists, wholesale terms, roast/production cadence, merch, catering, private events, and anything else a guest would ask that isn't hours/address/menu/staff. An operational fact doesn't need a story around it to belong here — "we don't deliver" is a complete, valid entry on its own. Self-contained chunks the agent retrieves when grounding answers to substantive guest questions.
    - OPINIONATED RECOMMENDATIONS ALWAYS ROUTE TO knowledge_corpus, NEVER venue_info — no exceptions, regardless of how factual the phrasing sounds. If the content answers "what should this guest get" or "who is this venue's food/drink right for," it is a recommendation, not a fact, even when it's phrased as one. This applies most often to menu.highlights and menu.notes in section 4 — those fields are for STRUCTURED FACTS about items (name, price, format, flavor), never for picks, endorsements, or "right choice for X" framing. When the operator says something like "for a first-timer I'd start them on the latte, don't over-program the first visit," the destination is knowledge_corpus with primary_tags: ["recommendations"], and the FORM is attributed indicative knowledge — something Sana holds and can choose to mention, not an instruction she must follow:
        - WRONG (imperative, addressed to the assistant, do not write this into venue_info): "For a first-timer, a latte is the right entry point — don't over-program the first visit."
        - RIGHT (attributed indicative, in knowledge_corpus): "The owner's pick for a first-timer is the latte — familiar, and it shows off the blend."
    - Mood rule for content that legitimately stays in venue_info prose (e.g. the perfect-order narrative or sourcing description in menu.notes): even venue-fact prose must read as DESCRIPTION of the venue, never as an INSTRUCTION addressed to the assistant. Same underlying fact, different grammatical mood:
        - WRONG: "When a guest asks what to get, always mention the pour-over first."
        - RIGHT: "Regulars default to the pour-over before anything else — it's the most-ordered item at open."
      If you notice yourself writing "always," "don't," "make sure to," or any other imperative verb addressed to the assistant anywhere in section 4, stop — either rephrase as description, or (if it's actually someone's opinion about what a guest should order) move it to knowledge_corpus per the rule above instead.
    - Examples to disambiguate:
        - Operator says "We open at 7am" → venue_info hours field. NOT knowledge_corpus.
        - Operator says "I'd text a regular saying 'hey, glad you're back'" → voice_corpus.
        - Operator says "Our flagship blend is two Ethiopian coffees roasted by a friend who learned the trade in Addis" → knowledge_corpus (it's a story, not a bare fact).
        - Operator says "Phoebe runs the bar and is famously into seasonal matcha experiments" → knowledge_corpus.
        - Operator says "I'd never use exclamation marks" → already lives in brand_persona.voiceAntiPatterns; do NOT also put it in either corpus.
        - Operator says "For a first-timer I'd start them on the latte, don't over-program the first visit" → knowledge_corpus, primary_tags: ["recommendations"], rewritten as "The owner's pick for a first-timer is the latte — familiar, and it shows off the blend." NOT venue_info.menu.highlights, NOT venue_info.menu.notes, and NOT copied in with the imperative mood intact.
        - Operator says "Regulars always get the pour-over, it's basically the house thing" → venue_info.menu.notes, phrased as "Regulars default to the pour-over" — a fact about what happens, not advice about what to do.
- For voice_corpus: extract ONLY entries with source_type='voicenote_transcript' — verbatim or tightly-paraphrased quotes that demonstrate actual texting voice. Do NOT use source_type='manual_entry' for voice_corpus under any circumstance — a synthesized message the operator never said or reviewed is not evidence of their voice, however plausible it sounds. There is no target count and no floor to hit here: extract every qualifying entry the transcript supports, however many that is, including zero. Do not manufacture entries to reach 5 — a shortfall is reported in Needs confirmation, not papered over here. confidence_score: 0.95 for direct verbatim owner quotes, 0.9 for tight paraphrases. voice_corpus tags = situation/style ('welcome', 'follow_up', 'perk_surface', 'anti_pattern'); single \`tags\` array.
- For knowledge_corpus: extract every substantive fact and every narrative chunk the transcript, menu, or Airtable record supports — narrative (origin/sourcing/staff/ceremony/mechanics/recommendations) AND plain operational facts (policies, logistics, ordering, shipping, retail, wholesale, catering, private events, merch — anything a guest might ask that has no venue_info field). There is no target range and no cap — extract everything supported, however many entries that is. Do not hold back a real, self-contained fact because the count feels high. source_type='voicenote_transcript' for direct quotes from the transcript, 'manual_entry' for synthesized chunks composed from multiple parts of the conversation. confidence_score: 0.9 for direct/near-direct transcript quotes, 0.85 for synthesized chunks. Use the \`policies\` and \`logistics\` primary_tags for operational facts — they're in the canonical tag list precisely for this content.
    - GRANULARITY — one entry per self-contained claim, never several. If the operator covers multiple items in one breath, write one entry per item, not one entry for the whole passage. Five signature drinks discussed is five entries, not one. Each entry's content must name its own subject — it will be embedded and retrieved alone, with no memory of what surrounded it in the transcript or in your reasoning. A sentence with no subject in it retrieves on nothing: "good entry point, lets the coffee speak" is not a usable entry on its own. "The pour-over is a good entry point — it lets the coffee speak for itself" is. Do not rely on chunkText() to separate subjects for you downstream — it splits by character count and has no idea where one item ends and the next begins. Split at extraction time, before output. Target roughly one paragraph (200-500 characters) per entry.
    - Each knowledge entry has TWO tag arrays:
        - \`primary_tags\` — choose ONE OR MORE from this CLOSED list: \`sourcing\`, \`staff\`, \`mechanic\`, \`menu\`, \`philosophy\`, \`recommendations\`, \`events\`, \`history\`, \`space\`, \`policies\`, \`logistics\`, \`other\`. Namespacing is allowed and encouraged for routing precision: \`staff_phoebe\` (matches \`staff\`), \`mechanic_perk_card\` (matches \`mechanic\`), \`sourcing_ethiopia\` (matches \`sourcing\`). A chunk can carry multiple primary tags if it spans topics — a story about Phoebe's seasonal matcha is both \`menu\` AND \`staff_phoebe\`. Use \`other\` only when nothing else fits — be deliberate.
        - \`secondary_tags\` — free-form, descriptive. Flag whatever feels useful for context (e.g., \`seasonal\`, \`matcha\`, \`bar\`, \`weekend\`, \`quiet_morning\`, \`philly\`). Two-to-five secondary tags per chunk is typical. These don't drive routing; they help the agent contextualize what was matched.
    - REMINDER: primary_tags must be drawn from the 12 canonical values above OR a namespaced form like \`staff_<name>\` / \`mechanic_<slug>\`. The parse boundary fails loud on any non-canonical primary tag.
- For mechanics: extract ONLY practices the operator describes as something they ALREADY DO or have concretely committed to doing — a standing perk, an existing referral practice, an actual recurring event. Do NOT extract a mechanic from a brainstorm, a hypothetical, or an idea floated in the moment ("maybe I could give them samples", "I haven't thought about this before, but..."). Omit it from section 5 entirely — do not write it in as a mechanic. Each mechanic must include type, name, description, qualification, reward_description, expiration_rule, trigger (structured object), redemption (structured object). trigger.type MUST be exactly one of: ${MECHANIC_TRIGGER_TYPES.map((t) => `'${t}'`).join(', ')} — never invent a third value (a date-based or recurring mechanic is still 'manual_invite' at the trigger-type level; put the actual schedule in trigger.cadence / trigger.schedule, not in trigger.type).
    - requires_operator_approval: ${MECHANIC_APPROVAL_CRITERIA} Set the field to true, or omit it (which defaults to false) when the narrow false condition applies. A mechanic that unnecessarily waits for an operator costs a delay; one that ships without oversight when it shouldn't have costs more. Every mechanic's value and the transcript language behind it is listed in Needs confirmation regardless of which way you set it, so err toward true.
- currentContext vs permanent fields — a fact belongs in EXACTLY ONE place, never both:
    - Upcoming, in-development, or explicitly time-bound facts (a menu item launching next month, a table being replaced, a temporary closure, an event on a specific date) go in venue_info.currentContext ONLY. Do not also write the same fact into a permanent field (menu.highlights, menu.notes, amenities, staff, narrative) — once the entry expires, a permanent copy would be the only thing left and it would be wrong.
    - Facts that are currently true and ongoing with no known end (stock the venue regularly carries, a standing weekly event, an amenity that exists today) are PERMANENT fields ONLY — never currentContext, and never given an expiresAt. An expiresAt on a fact with no actual expiration is itself a defect, not a safe default.
    - Every currentContext entry needs an expiresAt, and it MUST be a full ISO 8601 date (YYYY-MM-DD) — never a relative phrase. A malformed expiresAt is silently dropped at runtime and the fact disappears from the agent's knowledge with no error, so leaving a relative phrase in place is worse than a wrong-but-resolved date.
    - Resolve every relative date in the transcript ("next month", "in three weeks", "this Saturday") against the interview date given to you in the input (see the Interview date input block). If you are genuinely uncertain of the exact date even after using that anchor, still write your best-resolved ISO date — never leave a relative phrase in a date field. Uncertainty is surfaced by the verification pass, not by omitting resolution.
- For brand_persona (section 3):
    - bannedTopics — ONLY subjects the operator genuinely does not want discussed with guests (a competitor, a personal topic, a legal-sensitive subject). Never a routing or handoff instruction ("refunds — escalate to X", "catering inquiries go to Y"). Handoffs are not a persona concern — they belong to the approval-and-review workflow, not to a list of forbidden subjects. If the transcript describes who should handle a category of request, omit it from brand_persona entirely — do not write it into bannedTopics, voiceAntiPatterns, or any other persona field.
    - voiceAntiPatterns — ONLY concrete rules about HOW NOT TO SOUND (no em dashes, don't over-explain, never use "folks"). Never a routing or process instruction.
    - signaturePhrases — ONLY phrases the operator would actually TEXT to a guest, drawn from the transcript's own texting examples or tight paraphrases. Never the operator's own description of their tone ("it's just like talking to your friend") — a description of voice belongs in tone or lengthGuide, not as a signature phrase.
- For venue_info.staff: list ONLY people actually employed at the venue (owner, baristas, bakers, managers — anyone on payroll or an owner-operator). Do NOT include outside collaborators, suppliers, contractors, or anyone the operator mentions who doesn't work there. If the transcript describes a notable non-employee, their story belongs in knowledge_corpus (e.g. primary_tags: ["sourcing"] for a supplier relationship) — never in the staff roster.
- Match the example's tone in section narratives — concrete, specific, free of marketing register.

EXAMPLE STRUCTURE (placeholders only — DO NOT copy values verbatim):

${fixtureMarkdown}

REMINDER: every [BRACKET] above must be replaced with content from the venue's transcript, menu, and Airtable record. Never copy bracket text verbatim. Never invent content not supported by source materials.`
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

  const systemPrompt = buildExtractionSystemPrompt(input.fixtureMarkdown)

  const userPrompt = `Slug to extract: ${input.slug}

VENUE INPUTS:

[1] Airtable record (form submission, structured fields):
${JSON.stringify(input.airtableFields, null, 2)}

[2] Owner conversation transcript:
${input.transcript}

[3] Menu CSV:
${input.menuCsv ?? '(not provided)'}

[4] Interview date (anchor for resolving relative dates in the transcript): ${input.interviewDate ?? 'not explicitly provided — infer a submission date from whichever date-bearing field exists in the Airtable record above, or from an explicit date stated in the transcript itself, and write it into section 2 as Submission date'}

Produce the venue-spec.md draft for "${input.slug}" now. Match the example format exactly.`

  const { text } = await generateText({
    model: anthropic(EXTRACTION_MODEL),
    system: systemPrompt,
    prompt: userPrompt,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  })

  return text
}