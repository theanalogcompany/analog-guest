import type { SemanticCheckOutcome } from './semantic-check'
import type { PolicyRow, PolicySet } from './schema'

// The decision table: structural facts + semantic probabilities × policy
// rows -> one dispatch verdict. Pure, synchronous, no model and no DB - the
// turn runner calls runSemanticCheck and hands the outcome in.
//
// Verdict severity: block > queue > send. `notify` policies never change the
// verdict; they accumulate into `notifications` and the caller fires the
// events (observability never changes control flow, but a silent degrade
// needs an event - .claude/rules/errors-as-values.md).
//
// FAILURE DIRECTION when the semantic check is unavailable: per-policy
// `onCheckFailure`, SCOPED by risk surface. A fail-closed policy only forces
// a queue when the draft shows a reason to distrust it - declared actions or
// tripwire text (currency, digits, URLs). A clean no-action draft sails on a
// Jev outage: holding every reply because a vendor hiccuped is the
// coalescing lesson (a guest silenced by infrastructure is a worse, newly
// invented failure), while a draft already talking numbers is exactly the
// one the dead check existed to read.

export interface GateInput {
  draftMessages: string[]
  /** Action types the generation declared (lib/ai/v2/actions.ts). */
  declaredActionTypes: string[]
  semantic: SemanticCheckOutcome
  policySet: PolicySet
  /** The guest's graph state key, for condition scoping. */
  stateKey: string
  /** Active situations this turn (complaint, opt_out_request, ...). */
  situations: string[]
}

export interface MatchedPolicy {
  policyKey: string
  label: string
  /** The verdict this policy demanded; matched[0] (review_reason) sorts by it. */
  then: 'queue' | 'block' | 'notify'
  /** For semantic matches: the raw P(yes) that crossed the threshold. */
  probability?: number
  /** True when matched by the failure path, not a judgment. */
  checkUnavailable?: boolean
}

export interface GateDecision {
  verdict: 'send' | 'queue' | 'block'
  /** Policies that forced the verdict, strongest first - review_reason comes from [0]. */
  matched: MatchedPolicy[]
  /** notify-policy hits; the caller fires one event per entry. */
  notifications: MatchedPolicy[]
  /** Set when the semantic check failed; the caller fires the degrade event. */
  semanticCheckError?: string
}

/**
 * Situations no policy row may act on. TCPA: a guest who asks to stop must
 * get the confirmation, so no configuration - stored, seeded, or hand-written
 * - may route an opt-out turn to a human who might not be looking. Enforced
 * HERE, not in any UI, for the same reason v1 enforced POLICY_EXEMPT_CATEGORIES
 * in the resolver: hand-editing stored policy is a normal workflow, and an
 * exclusion guarded only by a rendering decision is not guarded.
 */
export const POLICY_EXEMPT_SITUATIONS: readonly string[] = ['opt_out_request']

/**
 * Tripwire text: the cheap structural signal that a draft is talking about
 * the things fail-closed policies guard - money, quantities, links.
 */
export function hasTripwireText(messages: readonly string[]): boolean {
  const joined = messages.join('\n')
  return /[0-9$€£%]|https?:\/\/|www\./i.test(joined)
}

function conditionsApply(
  row: PolicyRow,
  input: GateInput,
  activeSituations: readonly string[],
): boolean {
  const c = row.conditions
  if (c === undefined) return true
  if (c.states !== undefined && c.states.length > 0) {
    if (!c.states.includes(input.stateKey)) return false
  }
  if (c.situations !== undefined && c.situations.length > 0) {
    if (!c.situations.some((s) => activeSituations.includes(s))) return false
  }
  return true
}

export function decideDispatch(input: GateInput): GateDecision {
  const matched: MatchedPolicy[] = []
  const notifications: MatchedPolicy[] = []
  let verdict: GateDecision['verdict'] = 'send'
  let semanticCheckError: string | undefined

  const escalate = (to: 'queue' | 'block') => {
    if (to === 'block' || verdict === 'send') verdict = to
  }

  const record = (row: PolicyRow, hit: Omit<MatchedPolicy, 'then'>) => {
    const full = { ...hit, then: row.then }
    if (row.then === 'notify') {
      notifications.push(full)
      return
    }
    matched.push(full)
    escalate(row.then)
  }

  const semanticProbabilities = input.semantic.ok
    ? input.semantic.probabilities
    : undefined
  const semanticUnavailable = semanticProbabilities === undefined
  if (!input.semantic.ok) semanticCheckError = input.semantic.error

  const distrusted =
    input.declaredActionTypes.length > 0 || hasTripwireText(input.draftMessages)

  // The exempt strip: detection still reports these situations (the trace
  // shows them), but no policy row can match on one.
  const activeSituations = input.situations.filter(
    (s) => !POLICY_EXEMPT_SITUATIONS.includes(s),
  )

  for (const row of input.policySet.policies) {
    if (!conditionsApply(row, input, activeSituations)) continue

    if (row.detection.kind === 'structural') {
      if (input.declaredActionTypes.includes(row.detection.action))
        record(row, { policyKey: row.key, label: row.label })
      continue
    }

    if (row.detection.kind === 'always') {
      record(row, { policyKey: row.key, label: row.label })
      continue
    }

    if (semanticUnavailable) {
      if (
        row.onCheckFailure === 'closed' &&
        distrusted &&
        row.then !== 'notify'
      )
        record(row, {
          policyKey: row.key,
          label: row.label,
          checkUnavailable: true,
        })
      continue
    }

    const p = semanticProbabilities?.[row.key]
    // A policy the check never answered is a contract violation upstream;
    // runSemanticCheck already fails the whole outcome, so an undefined here
    // means the row was added after the check ran. Treat as unavailable.
    if (p === undefined) {
      if (
        row.onCheckFailure === 'closed' &&
        distrusted &&
        row.then !== 'notify'
      )
        record(row, {
          policyKey: row.key,
          label: row.label,
          checkUnavailable: true,
        })
      continue
    }
    if (p >= row.detection.threshold)
      record(row, { policyKey: row.key, label: row.label, probability: p })
  }

  // Block beats queue; within a verdict tier, structural (certain) beats
  // semantic (probabilistic), higher probability beats lower. The sort keys
  // on `then`, so matched[0] is always a policy that demanded the verdict.
  matched.sort((a, b) => {
    if (a.then !== b.then) return a.then === 'block' ? -1 : 1
    const aStructural = a.probability === undefined && !a.checkUnavailable
    const bStructural = b.probability === undefined && !b.checkUnavailable
    if (aStructural !== bStructural) return aStructural ? -1 : 1
    return (b.probability ?? 0) - (a.probability ?? 0)
  })

  return { verdict, matched, notifications, semanticCheckError }
}
