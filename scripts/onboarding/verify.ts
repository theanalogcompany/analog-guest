import { anthropic } from '@ai-sdk/anthropic'
import { generateObject } from 'ai'
import { z } from 'zod'
import { MECHANIC_APPROVAL_CRITERIA, type ExtractInput } from './extract'

const VERIFY_MODEL = 'claude-sonnet-4-6'
const MAX_OUTPUT_TOKENS = 8000
const VERIFY_TEMPERATURE = 0.3

// Independent of extract.ts's own versioning (extract.ts has none — it emits
// free markdown via generateText, not a schema-wrapped object). Same
// independence rationale as EXTRACT_REPORTED_ORDER_PROMPT_VERSION /
// CLASSIFY_INTENTION_PROMPTS_PROMPT_VERSION documented in CLAUDE.md: this
// never touches extraction's own contract, so it version-bumps on its own
// schedule.
export const VERIFY_PROMPT_VERSION = 'v1.0.0'

// Mirrors parse-venue-spec.ts's hard floor (line ~456) — kept in sync by eye,
// not by import, since that file is out of scope for this ticket. Used only
// to decide whether the "Voice corpus" subsection of Needs confirmation
// renders; the real enforcement stays in parse-venue-spec.ts at seed time.
const VOICE_CORPUS_FLOOR = 5

export interface VerifyInput extends Omit<ExtractInput, 'fixtureMarkdown'> {
  draftMarkdown: string
}

const UnsupportedClaimReasonSchema = z.enum([
  'not_in_source',
  'hedged_in_source',
  'generalized_beyond_source',
  'brainstorm_not_practice',
  'experiment_not_final',
])

const UnsupportedClaimSchema = z.object({
  section: z.string().min(1),
  claim: z.string().min(1),
  reason: UnsupportedClaimReasonSchema,
  sourceQuote: z.string().optional(),
})

const VoiceQualificationReasonSchema = z.enum([
  'style_description',
  'joking_or_hypothetical',
  'interview_monologue',
  'describes_perk_or_policy',
])

const VoiceDisqualificationSchema = z.object({
  source: z.enum(['voice_corpus', 'signaturePhrase']),
  location: z.string().min(1),
  content: z.string().min(1),
  reason: VoiceQualificationReasonSchema,
})

const PlacementViolationSchema = z.object({
  section: z.string().min(1),
  claim: z.string().min(1),
  sourceQuote: z.string().min(1),
})

const UncoveredAnswerSchema = z.object({
  transcriptQuote: z.string().min(1),
  topic: z.string().min(1),
})

const MissingInformationSchema = z.object({
  topic: z.string().min(1),
  description: z.string().min(1),
})

const ResolvedDateSchema = z.object({
  section: z.string().min(1),
  resolvedDate: z.string().min(1),
  sourceText: z.string().min(1),
  anchorUsed: z.string().optional(),
})

const MechanicApprovalReviewSchema = z.object({
  mechanicName: z.string().min(1),
  draftValue: z.boolean(),
  sourceQuote: z.string().optional(),
  recommendedValue: z.boolean().optional(),
})

// Schema passed to generateObject — the model's own output shape.
// promptVersion is stapled onto the result in code (see runVerification),
// mirroring GeneratedMessageSchema's pattern (lib/ai/generate-message.ts):
// the model never emits its own prompt_version, since it's a static
// constant, not something worth spending an output field on.
const VerifyModelOutputSchema = z.object({
  unsupportedClaims: z.array(UnsupportedClaimSchema).default([]),
  uncoveredAnswers: z.array(UncoveredAnswerSchema).default([]),
  missingInformation: z.array(MissingInformationSchema).default([]),
  resolvedDates: z.array(ResolvedDateSchema).default([]),
  mechanicApprovalReview: z.array(MechanicApprovalReviewSchema).default([]),
  voiceDisqualifications: z.array(VoiceDisqualificationSchema).default([]),
  placementViolations: z.array(PlacementViolationSchema).default([]),
})

export const VerifyResultSchema = VerifyModelOutputSchema.extend({
  promptVersion: z.string(),
})

export type VerifyResult = z.infer<typeof VerifyResultSchema>

/**
 * Pure prompt builder — no fixture, no per-venue content. Verify reasons
 * over the same raw materials extraction had (transcript, menu, Airtable)
 * plus the draft, so its own worked examples must stay fully generic — never
 * venue-specific vocabulary — per the TAC-331 leak-canary precedent: a
 * phrase here that echoes one real venue's language risks bleeding into an
 * unrelated future venue's Needs confirmation output.
 */
export function buildVerifySystemPrompt(): string {
  return `You are verifying a venue-spec markdown draft against the raw materials it was extracted from: an owner interview transcript, a menu CSV, and an Airtable intake record. The draft was produced by a separate extraction pass and may contain mistakes. Your job is to find them — you do NOT rewrite the draft, you only report structured flags.

CRITICAL — every quote field you fill in (sourceQuote, sourceText, or any other quoted evidence) MUST be copied verbatim from the SOURCE MATERIALS ONLY: the transcript, the menu CSV, or the Airtable record. NEVER quote the draft under verification, even when the draft's own wording looks like it could be a quote. Quoting the draft's own invented claim back as its "source" is exactly the mistake this pass exists to catch, not commit — it makes an unsupported claim look supported to whoever reads Needs confirmation. If nothing in the source materials is even related to a claim, omit the quote field (where optional) rather than filling it with text from the draft.

Check for exactly seven things:

1. UNSUPPORTED CLAIMS — any claim in the draft that isn't actually supported by the source materials. Five reasons, pick exactly one per claim:
   - not_in_source: nothing in the transcript, menu, or Airtable record supports this claim at all.
   - hedged_in_source: the source is uncertain or hedged ("I think", "maybe", "I believe") but the draft states it as settled fact.
   - generalized_beyond_source: the source describes something narrower or more conditional than what the draft claims (e.g. the source describes one occasion, the draft implies it always happens).
   - brainstorm_not_practice: the source describes an idea, a hypothetical, or something the operator was thinking out loud about, not something they actually do — and the draft nonetheless wrote it in as an established fact, mechanic, or practice.
   - experiment_not_final: the source describes an early version, an experiment, or an inspiration for something (an ingredient list, a recipe, a formulation) — not the finished, current version — and the draft states the early details as if they were final.
   For each: the section it appears in, the claim as written, the reason, and the source quote it should have matched (omit sourceQuote only when nothing in the source is even related).

   Pay particular attention to ingredient lists and recipe details in menu.highlights (section 4) and knowledge_corpus (section 7): if the source ties specific ingredients or a recipe only to an earlier version, an experiment, or an inspiration, and the draft states them as the current/final recipe, that is experiment_not_final, not a pass.

2. UNCOVERED ANSWERS — anything the operator stated in the transcript that no section of the draft captures. This explicitly includes: (a) hedged statements that got silently dropped rather than flagged, (b) brainstormed or hypothetical ideas the operator floated that were correctly NOT written in as mechanics (report these here as background even though correctly omitting them from section 5 was right), and (c) handoff or routing instructions the operator described — who should handle a category of guest request — that were correctly NOT written into brand_persona (report these here too — the fact that a category of request needs a human is worth the operator knowing about, even though it doesn't belong in a persona field). For each: the transcript quote and a short topic label.

3. MISSING INFORMATION — things the operator mentioned but never fully specified (e.g. referenced several named variations of something without ever naming them individually). For each: a topic and a description of what's missing.

4. DATES — every date that got resolved from a relative phrase in the transcript ("next month", "this Saturday") into an absolute value anywhere in the draft. For each: the section, the resolved date as written in the draft, the original source text it came from, and which anchor date was used to resolve it (report "none stated" if the draft's inputs didn't specify one). List every resolved date, not just ones you think are wrong — a human confirms all of them.

5. MECHANIC APPROVAL REVIEW — for every mechanic in section 5 of the draft, restate its requires_operator_approval value exactly as written (or false if the field is omitted), and independently assess what the transcript actually supports using the IDENTICAL criteria extraction is instructed to apply — do not invent your own standard: ${MECHANIC_APPROVAL_CRITERIA} Give a source quote for your assessment, or omit sourceQuote if nothing on-topic exists. Only set recommendedValue when your independent assessment genuinely disagrees with the value already in the draft — leave it unset when you agree or the transcript is silent on this mechanic. List every mechanic, regardless of whether anything else is flagged about it.

6. VOICE QUALIFICATION — evaluate every voice_corpus entry (section 6) and every brand_persona.signaturePhrases entry (section 3) against this rule: a qualifying entry is EITHER (a) a real or near-verbatim TEXT the operator actually sent, or would send, to a guest, OR (b) a short SPOKEN line addressed to a guest — second person, or something the operator would plausibly say to a guest across the counter (a recommendation, an invitation, a house rule said warmly, a one-line explanation), one or two sentences, trimmed of filler. Voice is captured from how the operator talks to guests generally, not only from texts. Disqualify an entry for exactly one of these reasons:
   - style_description: it describes HOW the operator communicates ("I always use emojis", "I keep it short") rather than showing an actual line said or written.
   - joking_or_hypothetical: it's a joke, a hypothetical scenario answer, or a made-up example, not something the operator described as real.
   - interview_monologue: it's a LONG narrative or reflective passage about the business's history, mission, or sourcing, OR a line addressed to the INTERVIEWER about the business — not a short line addressed to a guest. A short guest-addressed line qualifies even though it was said during the interview; what disqualifies it is length/register and WHO it's addressed to, not the setting it was said in. Example: "come by on a slow morning and try the pour-over, it's better when we're not slammed" (a short second-person recommendation) qualifies. "We started this place because I wanted Indian beans to have their own place in a cafe, and it took years to get the sourcing right" (a multi-sentence account of how the business started, addressed to the interviewer) does not — that belongs in knowledge_corpus.
   - describes_perk_or_policy: it explains what a perk or policy IS to the interviewer, rather than saying it to a guest.
   Report every disqualified entry with its source, location, the flagged content, and the reason. Do NOT disqualify an entry for needing light cleanup — a genuine line with some surrounding filler still qualifies once trimmed; only disqualify entries that don't meet either qualifying shape at all. List every disqualification you find.

7. PERMANENT-FIELD PLACEMENT — check every permanent field (venue_info EXCLUDING currentContext, and knowledge_corpus) for a fact that is upcoming, in-development, or not-yet-true according to the transcript (a menu item that hasn't launched, an amenity not yet installed, an event with no confirmed date). Flag it if it appears in a permanent field. Do NOT flag the reverse: a fact that IS currently true and also happens to appear in currentContext is harmless and not a defect — only the direction where a not-yet-true fact sits in a permanent field is wrong, because once the matching currentContext entry expires, the permanent copy is the only thing left and it will be wrong. For each violation: the section/field where it wrongly appears, the claim as stated there, and the transcript quote establishing it hasn't happened yet.

Ground every flag in an actual quote or a specific absence — do not speculate beyond what the source materials say.`
}

function buildVerifyUserPrompt(input: VerifyInput): string {
  return `Slug: ${input.slug}

SOURCE MATERIALS:

[1] Airtable record (form submission, structured fields):
${JSON.stringify(input.airtableFields, null, 2)}

[2] Owner conversation transcript:
${input.transcript}

[3] Menu CSV:
${input.menuCsv ?? '(not provided)'}

[4] Interview date (anchor for resolving relative dates in the transcript): ${input.interviewDate ?? 'not explicitly provided — infer from whichever date-bearing field exists in the Airtable record above, or from an explicit date stated in the transcript itself'}

DRAFT TO VERIFY:

${input.draftMarkdown}

Verify this draft against the source materials above per your instructions.`
}

/**
 * Mechanically counts \`\`\`json\`\`\` blocks under the "## 6. voice_corpus"
 * heading, stopping at the next H2. Arithmetic, not judgment — deliberately
 * NOT delegated to the model, same split as the deterministic
 * comp-regex-backstop vs. model-self-flag elsewhere in this repo. Mirrors
 * splitByHeading's generic "## " boundary detection in parse-venue-spec.ts
 * (not reused directly — that file stays untouched per this ticket's scope).
 */
export function countVoiceCorpusEntries(draftMarkdown: string): number {
  const headingRe = /^##\s+(.+?)\s*$/gm
  const headings: Array<{ index: number; title: string }> = []
  let m: RegExpExecArray | null
  while ((m = headingRe.exec(draftMarkdown)) !== null) {
    headings.push({ index: m.index, title: m[1] })
  }

  let sectionStart = -1
  let sectionEnd = draftMarkdown.length
  for (let i = 0; i < headings.length; i++) {
    if (/^6\.\s*voice_corpus/i.test(headings[i].title)) {
      sectionStart = headings[i].index
      sectionEnd = i + 1 < headings.length ? headings[i + 1].index : draftMarkdown.length
      break
    }
  }
  if (sectionStart === -1) return 0

  const sectionText = draftMarkdown.slice(sectionStart, sectionEnd)
  const jsonBlockRe = /```json\s*\n[\s\S]*?\n```/g
  return (sectionText.match(jsonBlockRe) ?? []).length
}

function renderMechanicLine(m: VerifyResult['mechanicApprovalReview'][number]): string {
  const quote = m.sourceQuote ? `"${m.sourceQuote}"` : 'none, defaulted'
  const mismatch =
    m.recommendedValue !== undefined && m.recommendedValue !== m.draftValue
      ? ` (⚠ possible mismatch — transcript suggests ${m.recommendedValue})`
      : ''
  return `- **${m.mechanicName}**: requires_operator_approval = **${m.draftValue}** — ${quote}${mismatch}`
}

/**
 * Order-preserving dedupe by `location`, keeping the first occurrence.
 * Guards the qualifying-count math (and the rendered list) against a
 * duplicate report of the same entry pushing the count below reality.
 */
function dedupeByLocation<T extends { location: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const item of items) {
    if (seen.has(item.location)) continue
    seen.add(item.location)
    result.push(item)
  }
  return result
}

function renderVoiceDisqualificationLine(d: VerifyResult['voiceDisqualifications'][number]): string {
  return `- **[${d.location}]** (${d.source}): ${d.reason.replace(/_/g, ' ')} — "${d.content}"`
}

/**
 * Pure markdown renderer for the `## Needs confirmation` section appended
 * to the draft. Unnumbered (not "## 11.") to match the ticket's own literal
 * heading and to read as visually distinct from the numbered 1-9 spec
 * sections — it's generated by a separate pass and never seeded.
 * parse-venue-spec.ts ignores it structurally (regex `h2s.find` per numbered
 * section name; nothing asserts every H2 is recognized) — already proven in
 * production by sections 8/9 being silently ignored today.
 *
 * Every subsection header always renders, even when empty, so a reviewer can
 * tell "checked, nothing found" from "not checked" — except "Voice corpus &
 * signature phrases", which renders only when the qualifying count (raw code
 * count minus deduped voice_corpus-sourced disqualifications) is below the
 * floor, or when any disqualification exists at all (visibility even when
 * the corpus still clears the floor).
 */
export function formatNeedsConfirmationSection(result: VerifyResult, voiceCorpusCount: number): string {
  const lines: string[] = []
  lines.push('## Needs confirmation')
  lines.push('')
  lines.push(
    '*Generated by the verification pass. Not seeded — resolve each item above before running `npm run seed-venue`.*',
  )
  lines.push('')

  lines.push('### Unsupported claims')
  if (result.unsupportedClaims.length === 0) {
    lines.push('*(none flagged)*')
  } else {
    for (const c of result.unsupportedClaims) {
      const quote = c.sourceQuote ? ` Source: "${c.sourceQuote}"` : ''
      lines.push(`- **[${c.section}]** "${c.claim}" — ${c.reason.replace(/_/g, ' ')}.${quote}`)
    }
  }
  lines.push('')

  lines.push('### Permanent-field placement')
  if (result.placementViolations.length === 0) {
    lines.push('*(none)*')
  } else {
    for (const p of result.placementViolations) {
      lines.push(`- **[${p.section}]** "${p.claim}" — source: "${p.sourceQuote}"`)
    }
  }
  lines.push('')

  lines.push('### Uncovered transcript answers')
  if (result.uncoveredAnswers.length === 0) {
    lines.push('*(none)*')
  } else {
    for (const a of result.uncoveredAnswers) {
      lines.push(`- "${a.transcriptQuote}" — ${a.topic}`)
    }
  }
  lines.push('')

  lines.push('### Missing information')
  if (result.missingInformation.length === 0) {
    lines.push('*(none)*')
  } else {
    for (const m of result.missingInformation) {
      lines.push(`- ${m.description}`)
    }
  }
  lines.push('')

  lines.push('### Dates requiring confirmation')
  if (result.resolvedDates.length === 0) {
    lines.push('*(none)*')
  } else {
    for (const d of result.resolvedDates) {
      const anchor = d.anchorUsed ? ` (anchor: ${d.anchorUsed})` : ''
      lines.push(`- **[${d.section}]** resolved to ${d.resolvedDate} — source: "${d.sourceText}"${anchor}`)
    }
  }
  lines.push('')

  lines.push('### Mechanic approval values')
  if (result.mechanicApprovalReview.length === 0) {
    lines.push('*(no mechanics found)*')
  } else {
    for (const m of result.mechanicApprovalReview) {
      lines.push(renderMechanicLine(m))
    }
  }

  // Qualifying count = raw code-counted entries minus voice_corpus-sourced
  // disqualifications (deduped by location so a duplicate report can't push
  // the count below reality). signaturePhrase disqualifications never
  // subtract — signaturePhrases aren't gated by the voice_corpus floor.
  const voiceCorpusDisqualifications = dedupeByLocation(
    result.voiceDisqualifications.filter((d) => d.source === 'voice_corpus'),
  )
  const signaturePhraseDisqualifications = result.voiceDisqualifications.filter(
    (d) => d.source === 'signaturePhrase',
  )
  const qualifyingVoiceCount = Math.max(0, voiceCorpusCount - voiceCorpusDisqualifications.length)

  if (qualifyingVoiceCount < VOICE_CORPUS_FLOOR || result.voiceDisqualifications.length > 0) {
    lines.push('')
    lines.push('### Voice corpus & signature phrases')
    if (qualifyingVoiceCount < VOICE_CORPUS_FLOOR) {
      lines.push(
        `- ${qualifyingVoiceCount} of ${VOICE_CORPUS_FLOOR} minimum real texting entries. Seeding will fail until at least ${VOICE_CORPUS_FLOOR} are present.`,
      )
    }
    for (const d of [...voiceCorpusDisqualifications, ...signaturePhraseDisqualifications]) {
      lines.push(renderVoiceDisqualificationLine(d))
    }
  }

  return lines.join('\n')
}

async function attemptVerification(input: VerifyInput) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Missing env var: ANTHROPIC_API_KEY')
  }
  const { object } = await generateObject({
    model: anthropic(VERIFY_MODEL),
    system: buildVerifySystemPrompt(),
    prompt: buildVerifyUserPrompt(input),
    schema: VerifyModelOutputSchema,
    temperature: VERIFY_TEMPERATURE,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  })
  return object
}

/**
 * Runs the verification pass with one retry on failure (network error or
 * schema-validation failure inside generateObject). Throws if both attempts
 * fail — the caller (scripts/extract-venue-spec.ts) writes nothing to Drive
 * on catch and exits non-zero. Every 06 in Drive must have passed
 * verification; a failed verify is not a degraded-but-usable draft.
 */
export async function runVerification(input: VerifyInput): Promise<VerifyResult> {
  try {
    const object = await attemptVerification(input)
    return { ...object, promptVersion: VERIFY_PROMPT_VERSION }
  } catch (firstError) {
    console.warn(
      `[verify] first attempt failed (${firstError instanceof Error ? firstError.message : String(firstError)}), retrying once...`,
    )
    const object = await attemptVerification(input)
    return { ...object, promptVersion: VERIFY_PROMPT_VERSION }
  }
}
