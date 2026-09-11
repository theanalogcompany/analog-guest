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
])

const UnsupportedClaimSchema = z.object({
  section: z.string().min(1),
  claim: z.string().min(1),
  reason: UnsupportedClaimReasonSchema,
  sourceQuote: z.string().optional(),
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

Check for exactly five things:

1. UNSUPPORTED CLAIMS — any claim in the draft that isn't actually supported by the source materials. Four reasons, pick exactly one per claim:
   - not_in_source: nothing in the transcript, menu, or Airtable record supports this claim at all.
   - hedged_in_source: the source is uncertain or hedged ("I think", "maybe", "I believe") but the draft states it as settled fact.
   - generalized_beyond_source: the source describes something narrower or more conditional than what the draft claims (e.g. the source describes one occasion, the draft implies it always happens).
   - brainstorm_not_practice: the source describes an idea, a hypothetical, or something the operator was thinking out loud about, not something they actually do — and the draft nonetheless wrote it in as an established fact, mechanic, or practice.
   For each: the section it appears in, the claim as written, the reason, and the source quote it should have matched (omit sourceQuote only when nothing in the source is even related).

2. UNCOVERED ANSWERS — anything the operator stated in the transcript that no section of the draft captures. This explicitly includes: (a) hedged statements that got silently dropped rather than flagged, (b) brainstormed or hypothetical ideas the operator floated that were correctly NOT written in as mechanics (report these here as background even though correctly omitting them from section 5 was right), and (c) handoff or routing instructions the operator described — who should handle a category of guest request — that were correctly NOT written into brand_persona (report these here too — the fact that a category of request needs a human is worth the operator knowing about, even though it doesn't belong in a persona field). For each: the transcript quote and a short topic label.

3. MISSING INFORMATION — things the operator mentioned but never fully specified (e.g. referenced several named variations of something without ever naming them individually). For each: a topic and a description of what's missing.

4. DATES — every date that got resolved from a relative phrase in the transcript ("next month", "this Saturday") into an absolute value anywhere in the draft. For each: the section, the resolved date as written in the draft, the original source text it came from, and which anchor date was used to resolve it (report "none stated" if the draft's inputs didn't specify one). List every resolved date, not just ones you think are wrong — a human confirms all of them.

5. MECHANIC APPROVAL REVIEW — for every mechanic in section 5 of the draft, restate its requires_operator_approval value exactly as written (or false if the field is omitted), and independently assess what the transcript actually supports using the IDENTICAL criteria extraction is instructed to apply — do not invent your own standard: ${MECHANIC_APPROVAL_CRITERIA} Give a source quote for your assessment, or omit sourceQuote if nothing on-topic exists. Only set recommendedValue when your independent assessment genuinely disagrees with the value already in the draft — leave it unset when you agree or the transcript is silent on this mechanic. List every mechanic, regardless of whether anything else is flagged about it.

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
 * Pure markdown renderer for the `## Needs confirmation` section appended
 * to the draft. Unnumbered (not "## 11.") to match the ticket's own literal
 * heading and to read as visually distinct from the numbered 1-9 spec
 * sections — it's generated by a separate pass and never seeded.
 * parse-venue-spec.ts ignores it structurally (regex `h2s.find` per numbered
 * section name; nothing asserts every H2 is recognized) — already proven in
 * production by sections 8/9 being silently ignored today.
 *
 * Every subsection header always renders, even when empty, so a reviewer can
 * tell "checked, nothing found" from "not checked" — except Voice corpus,
 * which renders only when the count is below the floor.
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

  if (voiceCorpusCount < VOICE_CORPUS_FLOOR) {
    lines.push('')
    lines.push('### Voice corpus')
    lines.push(
      `- ${voiceCorpusCount} of ${VOICE_CORPUS_FLOOR} minimum real texting entries. Seeding will fail until at least ${VOICE_CORPUS_FLOOR} are present.`,
    )
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
