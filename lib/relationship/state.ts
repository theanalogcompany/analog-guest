import type { GraphState, RelationshipGraph, StatePredicate } from './schema'

// State derivation: which graph state a guest is in, from observable facts.
// Pure - no DB access. The caller (turn runner, phase 3) loads facts and the
// open guest_relationship_states row and persists any transition this returns.
//
// TWO DECIDERS, ONE BOUNDARY. Hard predicates bound the FRONTIER - the set of
// states whose non-assessor requirements hold. Deterministic resolution moves
// a guest freely among hard-only states (a second recorded visit IS
// `returning`; no judgment involved). States that carry an
// `assessor_judgment` predicate are reachable ONLY via an assessor pick, and
// the pick is validated against the frontier here: the assessor can never
// promote past a failed hard predicate. Hysteresis (requiring the pick on two
// consecutive turns) is NOT YET IMPLEMENTED anywhere - it belongs to the
// phase 6 persistence wiring, where consecutive turns exist as rows; today a
// single validated pick is adopted. This module validates a single pick.

export interface StateFacts {
  /** Recorded visits for this guest at this venue (raw transaction rows). */
  visitCount: number
  /** Lifetime inbound message count at this venue. */
  replyCount: number
  /** Null when the guest has never been contacted. */
  daysSinceLastContact: number | null
}

/** Whether one hard predicate holds. `assessor_judgment` is never evaluated here. */
function hardPredicateHolds(p: StatePredicate, facts: StateFacts): boolean {
  switch (p.kind) {
    case 'visit_count_at_least':
      return facts.visitCount >= p.count
    case 'reply_count_at_least':
      return facts.replyCount >= p.count
    case 'days_since_last_contact_at_most':
      return (
        facts.daysSinceLastContact !== null &&
        facts.daysSinceLastContact <= p.days
      )
    case 'assessor_judgment':
      // Not a hard predicate; handled by requiresAssessor + the pick path.
      return true
  }
}

export function requiresAssessor(state: GraphState): boolean {
  return state.requires.some((p) => p.kind === 'assessor_judgment')
}

/** Every state whose hard predicates all hold, in rank order. */
export function frontier(
  graph: RelationshipGraph,
  facts: StateFacts,
): GraphState[] {
  return [...graph.states]
    .sort((a, b) => a.rank - b.rank)
    .filter((s) => s.requires.every((p) => hardPredicateHolds(p, facts)))
}

export interface ResolvedState {
  stateKey: string
  decidedBy: 'deterministic'
  /** Plain-English audit trail for the guest_relationship_states row. */
  evidence: string[]
}

/**
 * Deterministic resolution for one turn, given the guest's current state (or
 * null for a brand-new guest).
 *
 * - ADVANCE: the highest-ranked hard-only state in the frontier wins when it
 *   outranks the current state. Assessor-gated states are never entered here.
 * - STICKY: a current state that is assessor-gated and still inside the
 *   frontier is kept - deterministic resolution never undoes an assessor
 *   promotion whose hard floor still holds.
 * - REGRESS: a current state whose own hard predicates no longer hold drops
 *   to the highest reachable hard-only state. (The seed graph's predicates
 *   are monotone, so regression is inert until a graph uses
 *   days_since_last_contact - the code supports it so graph data can.)
 */
export function resolveDeterministicState(
  graph: RelationshipGraph,
  facts: StateFacts,
  currentKey: string | null,
): ResolvedState {
  const open = frontier(graph, facts)
  const hardOnly = open.filter((s) => !requiresAssessor(s))
  // The initial state has `requires: []`, so hardOnly is never empty for a
  // well-formed graph; the fallback guards a stored graph that gated its own
  // initial state.
  const ceiling =
    hardOnly.length > 0
      ? hardOnly[hardOnly.length - 1]
      : graph.states.find((s) => s.key === graph.initialState)!

  const current =
    currentKey === null
      ? undefined
      : graph.states.find((s) => s.key === currentKey)

  if (current === undefined) {
    return {
      stateKey: ceiling.key,
      decidedBy: 'deterministic',
      evidence: [
        currentKey === null
          ? `no prior state; entering at "${ceiling.key}"`
          : `stored state "${currentKey}" is not in the active graph; re-entering at "${ceiling.key}"`,
        factsEvidence(facts),
      ],
    }
  }

  const currentStillOpen = open.some((s) => s.key === current.key)
  if (!currentStillOpen) {
    return {
      stateKey: ceiling.key,
      decidedBy: 'deterministic',
      evidence: [
        `hard requirements for "${current.key}" no longer hold; regressing to "${ceiling.key}"`,
        factsEvidence(facts),
      ],
    }
  }

  if (ceiling.rank > current.rank) {
    return {
      stateKey: ceiling.key,
      decidedBy: 'deterministic',
      evidence: [
        `advanced from "${current.key}": requirements for "${ceiling.key}" now hold`,
        factsEvidence(facts),
      ],
    }
  }

  return {
    stateKey: current.key,
    decidedBy: 'deterministic',
    evidence: [`"${current.key}" unchanged`, factsEvidence(facts)],
  }
}

/**
 * Validate an assessor's pick against the frontier. `null` means the pick is
 * rejected and the caller keeps the deterministic resolution - the assessor
 * chooses WITHIN the frontier, never defines it.
 */
export function validateAssessorPick(
  graph: RelationshipGraph,
  facts: StateFacts,
  pickKey: string,
): GraphState | null {
  const picked = frontier(graph, facts).find((s) => s.key === pickKey)
  return picked ?? null
}

function factsEvidence(facts: StateFacts): string {
  return `facts: visits=${facts.visitCount}, replies=${facts.replyCount}, daysSinceContact=${facts.daysSinceLastContact ?? 'never'}`
}
