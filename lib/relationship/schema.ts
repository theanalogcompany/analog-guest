import { z } from 'zod'

// The relationship graph: the v2 replacement for both the recognition state
// bands (lib/recognition) and the intention definitions
// (lib/agent/intentions) - see docs/decisions/0009-relationship-engine-v2.md
// and this directory's CLAUDE.md for the architecture.
//
// A graph is VERSIONED DATA, one row per version in `relationship_graphs`
// (migration 067), exactly one `active` row per venue. The eval loop iterates
// graphs by writing draft rows and promoting them; code never hardcodes a
// state or move key.
//
// This schema parses DB JSONB, not LLM output, so the THE-157 ban on
// .min()/.max() does not apply here.
//
// Failure direction, per .claude/rules/errors-as-values.md:
//   - live boundary (agent run): parseRelationshipGraph falls OPEN to the
//     default graph - a malformed stored graph must not take down every agent
//     run for the venue. The degrade logs; the caller fires the event.
//   - offline boundary (seeding, promotion): use RelationshipGraphSchema
//     directly and fail CLOSED, loudly.

/**
 * The predicate vocabulary: the CLOSED set of observable conditions graph
 * data may compose. Graph rows reference these; they can rewire and reword,
 * never invent semantics. A new predicate kind is a code change here plus a
 * reader in state derivation (phase 2), and the discriminated union means an
 * unknown kind fails the parse rather than silently passing.
 *
 * `assessor_judgment` is the soft-signal hook: the state is reachable only
 * when the post-turn assessor, reading the conversation, judges the
 * relationship is there. Hard predicates bound the frontier; the assessor
 * chooses within it. It can never promote past a failed hard predicate.
 */
export const StatePredicateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('visit_count_at_least'),
    count: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('reply_count_at_least'),
    count: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('days_since_last_contact_at_most'),
    days: z.number().positive(),
  }),
  z.object({ kind: z.literal('assessor_judgment') }),
])
export type StatePredicate = z.infer<typeof StatePredicateSchema>

const keySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'state and move keys are snake_case slugs')

/**
 * One node: a stage of the relationship.
 *
 * `mission` is PROMPT-FACING - it renders verbatim into the situation brief
 * as the agent's aim while the guest sits in this state. Wording changes are
 * guest-facing-copy changes under the plan gate: verbatim in the plan, wait
 * for approval.
 *
 * `requires` is the hard frontier, ANDed. The guest's reachable states are
 * those whose `requires` all hold; the assessor picks within that frontier
 * (with hysteresis - phase 2, lib/relationship/state.ts). An empty list means
 * always reachable; exactly one state (`initialState`) is where every guest
 * starts.
 *
 * `rank` orders states for "at least" comparisons (mechanic eligibility kept
 * the isStateAtLeast semantics). Gaps of 10, like the old intention
 * priorities, so inserting needs no renumbering.
 */
export const GraphStateSchema = z.object({
  key: keySchema,
  /** Operator-facing name ("First contact"). */
  label: z.string().min(1),
  /** The one-line objective ("Establish presence"). Operator-facing. */
  objective: z.string().min(1),
  /** Prompt-facing: the agent's aim in this state. */
  mission: z.string().min(1),
  rank: z.number().int().nonnegative(),
  requires: z.array(StatePredicateSchema),
})
export type GraphState = z.infer<typeof GraphStateSchema>

/**
 * One edge: a move that opens when the guest reaches `homeState` and stays
 * open at every later state until closed (states are cumulative stages, not
 * silos - openMoves in profile.ts, measured by first-contact-replay). Moves
 * render into the situation brief as PARALLEL ACTIVE AIMS the model pursues
 * at its own judgment of the moment ("what you're trying to learn at this
 * stage"), each annotated with its own attempt history from move-linked
 * memory. There is no gate, window, brake or prompted-once machinery in v2
 * - the interaction memory gives the model the facts those mechanisms
 * enforced, and the judge's working_the_room axis prices both failure
 * directions (decision 0009).
 *
 * `closedWhen` lists profile fields whose presence makes the move moot (the
 * guest's name is on file, so learn_name never renders again). Profile
 * fields are an open vocabulary, so a field name nothing ever writes simply
 * never matches and the move STAYS OPEN - stale graph data degrades to an
 * extra line in the brief, never a crash and never a silent closure.
 */
export const GraphMoveSchema = z.object({
  key: keySchema,
  homeState: keySchema,
  /** Prompt-facing: the aim, phrased as an intention ("Learn their name, early - ..."). */
  goal: z.string().min(1),
  closedWhen: z.array(z.object({ profileField: z.string().min(1) })),
})
export type GraphMove = z.infer<typeof GraphMoveSchema>

export const RelationshipGraphSchema = z
  .object({
    states: z.array(GraphStateSchema).min(1),
    moves: z.array(GraphMoveSchema),
    initialState: keySchema,
  })
  .superRefine((graph, ctx) => {
    const stateKeys = new Set<string>()
    for (const state of graph.states) {
      if (stateKeys.has(state.key))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate state key "${state.key}"`,
        })
      stateKeys.add(state.key)
    }
    const ranks = new Set<number>()
    for (const state of graph.states) {
      if (ranks.has(state.rank))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate state rank ${state.rank} - ranks order states and must be distinct`,
        })
      ranks.add(state.rank)
    }
    if (!stateKeys.has(graph.initialState))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `initialState "${graph.initialState}" is not a defined state`,
      })
    const moveKeys = new Set<string>()
    for (const move of graph.moves) {
      if (moveKeys.has(move.key))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate move key "${move.key}"`,
        })
      moveKeys.add(move.key)
      if (!stateKeys.has(move.homeState))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `move "${move.key}" homes on unknown state "${move.homeState}"`,
        })
    }
  })
export type RelationshipGraph = z.infer<typeof RelationshipGraphSchema>

/** `fellBack` is the discriminant: this parse never fails, it degrades. */
export type ParseGraphResult =
  | { graph: RelationshipGraph; fellBack: false }
  | { graph: RelationshipGraph; fellBack: true; error: string }

/**
 * Parse a stored graph at the LIVE boundary. Falls OPEN to `fallback`
 * (normally DEFAULT_RELATIONSHIP_GRAPH) on a malformed value - a bad stored
 * row must never take down a venue's agent runs. `fellBack: true` tells the
 * caller to fire the degrade event; a silent degrade is invisible by
 * construction.
 */
export function parseRelationshipGraph(
  value: unknown,
  fallback: RelationshipGraph,
): ParseGraphResult {
  const parsed = RelationshipGraphSchema.safeParse(value)
  if (parsed.success) return { graph: parsed.data, fellBack: false }
  console.warn(
    `[relationship-graph] malformed stored graph, falling back to default: ${parsed.error.message}`,
  )
  return { graph: fallback, fellBack: true, error: parsed.error.message }
}

/**
 * True when `current` meets or exceeds `min`, by rank, within one graph.
 * The v2 successor of lib/recognition/state-bands.ts isStateAtLeast, with the
 * same posture: an unknown `min` logs and returns false (drops the gated
 * item), a missing `min` is ungated.
 */
export function isStateAtLeast(
  graph: RelationshipGraph,
  currentKey: string,
  minKey: string | null | undefined,
): boolean {
  if (!minKey) return true
  const current = graph.states.find((s) => s.key === currentKey)
  const min = graph.states.find((s) => s.key === minKey)
  if (current === undefined || min === undefined) {
    console.warn(
      `[relationship-graph] isStateAtLeast against unknown state (current="${currentKey}", min="${minKey}") - treating as ineligible`,
    )
    return false
  }
  return current.rank >= min.rank
}
