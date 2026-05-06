import type { ApiTraceWithFullDetails } from '@/lib/observability'

// Pure projection of a Langfuse trace into the linear stage stack the trace
// panel renders. THE-201's UI is locked to the agent pipeline shape (matches
// THE-200's span tree), so we walk observations by name rather than by
// arbitrary parent/child traversal.
//
// Returns:
//   - rootName: 'agent.inbound' | 'agent.followup' | string (other roots
//     bucket as their literal name)
//   - stages: ordered array of { name, observation, attempts? }
//   - other: any top-level observation we didn't recognize (shouldn't
//     happen for current pipeline — included so a future stage doesn't
//     silently disappear from the panel before this code is updated)
//
// "Top-level" = parentObservationId equals the root trace observation, OR is
// null/undefined. The Langfuse SDK can model both shapes depending on how
// the trace was constructed; we accept either.

export type TraceObservation = ApiTraceWithFullDetails['observations'][number]

export interface TraceStage {
  name: string                     // 'context_build' | 'classify' | 'retrieve' | 'retrieve_knowledge' | 'generate' | 'send' | <unknown>
  observation: TraceObservation
  attempts?: TraceObservation[]    // generate.attempt_N children, ordered by name suffix
}

export interface SelectedTraceStages {
  rootName: string                 // 'agent.inbound' | 'agent.followup' | other
  stages: TraceStage[]
  other: TraceObservation[]        // top-level observations that don't match any known stage
}

// retrieve_knowledge sits between retrieve (voice) and generate per the agent
// pipeline. It's gated by shouldRetrieveKnowledge in lib/agent/stages.ts —
// always fires for inbound; for followups, only on event/manual triggers and
// skips for day_* cron triggers. Absent from the trace simply means the gate
// was off; the selector tolerates the missing stage like any other.
const KNOWN_STAGE_ORDER = [
  'context_build',
  'classify',
  'retrieve',
  'retrieve_knowledge',
  'generate',
  'send',
] as const

const ATTEMPT_PREFIX = 'generate.attempt_'

export function selectTraceStages(trace: ApiTraceWithFullDetails): SelectedTraceStages {
  const observations = trace.observations ?? []
  const byId = new Map<string, TraceObservation>()
  for (const obs of observations) byId.set(obs.id, obs)

  // Top-level = either no parent, or parent is the trace itself (langfuse
  // sometimes models the trace's root span as parent of all children).
  const topLevel = observations.filter((obs) => {
    if (!obs.parentObservationId) return true
    return !byId.has(obs.parentObservationId)
  })

  // Match known stages by exact name. Multiple matches keep the first (deterministic
  // by observation order).
  const stages: TraceStage[] = []
  const used = new Set<string>()
  for (const name of KNOWN_STAGE_ORDER) {
    const match = topLevel.find((obs) => obs.name === name)
    if (!match) continue
    used.add(match.id)
    const stage: TraceStage = { name, observation: match }
    if (name === 'generate') {
      // Find generate.attempt_N children by parentObservationId === generate.id.
      // Sort by numeric suffix so attempt_2 appears after attempt_1 even if
      // observations arrive out of order.
      const attempts = observations
        .filter((o) => o.parentObservationId === match.id && o.name?.startsWith(ATTEMPT_PREFIX))
        .sort((a, b) => extractAttemptIndex(a.name) - extractAttemptIndex(b.name))
      if (attempts.length > 0) stage.attempts = attempts
    }
    stages.push(stage)
  }

  const other = topLevel.filter((obs) => !used.has(obs.id))

  // Root name lives on the trace itself; default to 'agent.inbound' so a
  // missing/empty name still renders something sensible.
  const rootName = (trace.name ?? 'agent.inbound') as string
  return { rootName, stages, other }
}

function extractAttemptIndex(name: string | null | undefined): number {
  if (!name || !name.startsWith(ATTEMPT_PREFIX)) return Number.MAX_SAFE_INTEGER
  const tail = name.slice(ATTEMPT_PREFIX.length)
  const n = Number.parseInt(tail, 10)
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER
}
