import { generateObject } from 'ai'
import { z } from 'zod'
import { getGenerationModel } from '@/lib/ai/client'
import type { AIResult } from '@/lib/ai/types'
import { openMoves, type GuestProfile, type InteractionMemory } from './profile'
import type { RelationshipGraph } from './schema'
import type { StateFacts } from './state'
import { frontier, requiresAssessor, validateAssessorPick } from './state'

// The post-turn assessor: ONE call, after the reply is dispatched, never in
// the guest's latency path. It reads the full exchange and returns the three
// kinds of maintenance v2 moved off the generation schema (decision 0009):
// state judgment, profile updates, interaction-memory updates - plus routing
// flags (crisis among them; there is no dedicated crisis classifier in v2).
//
// The assessor PROPOSES, code DISPOSES: its state pick is validated against
// the hard-predicate frontier (validateAssessorPick) and hysteresis is
// applied by the caller across turns. Its profile updates land through the
// schemas in profile.ts. Fails as a value; a failed assessment skips the
// turn's maintenance - the next turn re-reads the whole exchange anyway.

// v1.1.0: canonical profile-field vocabulary added (near-miss keys never
// closed a move).
// v1.2.0: memory entries tag the open move they pursued (moveKey), so the
// open-moves render can show each aim's own attempt history.
export const ASSESSOR_PROMPT_VERSION = 'assessor-v1.2.0'
export const ASSESSOR_MAX_OUTPUT_TOKENS = 1_200

// reasoning FIRST: structured output generates fields in declaration order,
// and a verdict declared before the analysis is produced before the analysis
// (the verifier-family lesson, lib/ai/CLAUDE.md).
const AssessorOutputSchema = z.object({
  reasoning: z.string(),
  /** '' = stay. Validated against the frontier; an invalid pick is dropped. */
  statePick: z.string(),
  profileFieldUpdates: z.array(
    z.object({ field: z.string(), value: z.string() }),
  ),
  newFacts: z.array(z.string()),
  memoryEntries: z.array(
    z.object({
      kind: z.enum(['question_asked', 'suggestion_made', 'exchange_note']),
      note: z.string(),
      /** The open move this entry pursued; '' when none. Required string: free against the 24-optional cap. */
      moveKey: z.string(),
    }),
  ),
  /** Outcome updates for existing memory entries, matched by note text. */
  memoryOutcomes: z.array(z.object({ note: z.string(), outcome: z.string() })),
  flags: z.array(z.enum(['crisis', 'complaint', 'opt_out_request'])),
})
export type AssessorOutput = z.infer<typeof AssessorOutputSchema>

export interface AssessorInput {
  graph: RelationshipGraph
  facts: StateFacts
  currentStateKey: string
  profile: GuestProfile
  memory: InteractionMemory
  /** The exchange: recent turns plus this turn's inbound and the sent reply. */
  transcript: string
  now: Date
}

export interface AssessorResult {
  output: AssessorOutput
  /** The pick after frontier validation; null = no transition proposed. */
  validatedStateKey: string | null
  promptVersion: string
}

export async function runAssessor(
  input: AssessorInput,
): Promise<AIResult<AssessorResult>> {
  const reachable = frontier(input.graph, input.facts)
  const assessorStates = reachable.filter(requiresAssessor)

  const stateMenu = reachable
    .map((s) => {
      const gated = requiresAssessor(s) ? ' (requires your judgment)' : ''
      return `- ${s.key}${gated}: ${s.objective}. ${s.mission}`
    })
    .join('\n')

  // The graph's moves close on EXACT profile field keys (closedWhen). The
  // model must be told that vocabulary or it writes near-misses - caught
  // live: it recorded `name` while learn_name closes on `first_name`, so the
  // move never closed for anyone.
  const canonicalFields = [
    ...new Set(
      input.graph.moves.flatMap((m) => m.closedWhen.map((c) => c.profileField)),
    ),
  ]

  const openMoveKeys = openMoves(
    input.graph,
    input.currentStateKey,
    input.profile,
  ).map((m) => m.key)

  const system =
    `You maintain the relationship records for a hospitality venue's messaging agent. ` +
    `You read one exchange between the venue and a guest and return record updates. ` +
    `Be conservative: record only what the exchange actually shows. Never invent. ` +
    `For statePick: the guest is currently in "${input.currentStateKey}". ` +
    `Propose a different state ONLY if the conversation itself shows the relationship is there` +
    (assessorStates.length > 0
      ? ` - the candidates requiring your judgment are: ${assessorStates.map((s) => s.key).join(', ')}.`
      : `. No judgment-gated state is reachable right now, so statePick should be "".`) +
    ` Reachable states:\n${stateMenu}\n` +
    `For profileFieldUpdates: snake_case keys. When a fact fits one of these canonical fields, use that EXACT key` +
    (canonicalFields.length > 0 ? ` - ${canonicalFields.join(', ')}` : '') +
    ` - a near-miss key leaves the record permanently open. Invent a new key only for facts none of them fit. ` +
    `For memoryEntries: record each question the venue asked and each suggestion it made this turn, short and factual. ` +
    `When an entry pursued one of the currently open aims, set moveKey to that aim's key` +
    (openMoveKeys.length > 0 ? ` - ${openMoveKeys.join(', ')}` : '') +
    `; otherwise moveKey is "". ` +
    `For memoryOutcomes: if the guest's message answers or responds to an earlier open entry, record the outcome. ` +
    `For flags: crisis = self-harm or medical emergency signals (prefer flagging when genuinely ambiguous); ` +
    `complaint = the guest reports a bad experience; opt_out_request = the guest asks to stop hearing from the venue.`

  const user =
    `Current profile fields: ${JSON.stringify(input.profile.fields)}\n` +
    `Open memory entries (no outcome yet): ${JSON.stringify(
      input.memory.entries
        .filter((e) => e.outcome === undefined)
        .map((e) => e.note),
    )}\n\nThe exchange:\n${input.transcript}`

  try {
    const { object } = await generateObject({
      model: getGenerationModel(),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      schema: AssessorOutputSchema,
      maxOutputTokens: ASSESSOR_MAX_OUTPUT_TOKENS,
      temperature: 0.2,
    })

    const pick = object.statePick.trim()
    let validatedStateKey: string | null = null
    if (pick.length > 0 && pick !== input.currentStateKey) {
      validatedStateKey =
        validateAssessorPick(input.graph, input.facts, pick)?.key ?? null
      if (validatedStateKey === null)
        console.warn(`[assessor] pick "${pick}" rejected: outside the frontier`)
    }

    return {
      ok: true,
      data: {
        output: object,
        validatedStateKey,
        promptVersion: ASSESSOR_PROMPT_VERSION,
      },
    }
  } catch (e) {
    return {
      ok: false,
      error: `assessor failed: ${e instanceof Error ? e.message : String(e)}`,
      errorCode: 'assessor_failed',
    }
  }
}

/** Apply an assessor output to the stored shapes. Pure; the caller persists. */
export function applyAssessment(
  profile: GuestProfile,
  memory: InteractionMemory,
  output: AssessorOutput,
  now: Date,
): { profile: GuestProfile; memory: InteractionMemory } {
  const fields = { ...profile.fields }
  for (const u of output.profileFieldUpdates.slice(0, 10)) {
    if (u.field.trim().length > 0 && u.value.trim().length > 0)
      fields[u.field.trim()] = u.value.trim()
  }
  const facts = [
    ...profile.facts,
    ...output.newFacts.slice(0, 10).map((fact) => ({
      fact,
      learnedAt: now.toISOString(),
      source: 'assessor' as const,
    })),
  ].slice(-40)

  const entries = memory.entries.map((e) => {
    if (e.outcome !== undefined) return e
    const match = output.memoryOutcomes.find((o) => o.note === e.note)
    return match ? { ...e, outcome: match.outcome } : e
  })
  for (const n of output.memoryEntries.slice(0, 6)) {
    const moveKey = n.moveKey.trim()
    entries.push({
      kind: n.kind,
      note: n.note,
      at: now.toISOString(),
      ...(moveKey.length > 0 ? { moveKey } : {}),
    })
  }

  return {
    profile: { fields, facts },
    memory: { entries: entries.slice(-60) },
  }
}
