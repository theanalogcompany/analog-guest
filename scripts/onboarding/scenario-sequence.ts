// TAC-481. DB/SDK-touching half — see scenario-sequence-pure.ts for the
// pure helpers, the module-split rationale, and the full design comment.
// Re-exports the pure surface so callers (scripts/run-guest-scenario.ts) can
// import everything from this one file, matching the ingest-response-review
// split's convention.
export {
  appendTurnToHistory,
  buildSeedHistory,
  deriveReceivedBody,
  SEED_LINE_DELIVERIES,
  SeedLineSchema,
  ScenarioSequenceSchema,
  toScenarioSheetRow,
  type ScenarioSequence,
  type SeedLine,
  type SequenceTurnResult,
} from './scenario-sequence-pure'

import { runScenario } from './run-test-scenarios'
import { appendTurnToHistory, buildSeedHistory, deriveReceivedBody, toScenarioSheetRow } from './scenario-sequence-pure'
import type { ScenarioSequence, SequenceTurnResult } from './scenario-sequence-pure'

export interface RunScenarioSequenceInput {
  sequence: ScenarioSequence
  venueId: string
  guestId: string
  now?: Date
}

/**
 * Runs every turn of a sequence in order against the REAL per-turn pipeline
 * (runScenario), threading a synthesized conversation history between turns
 * so a later turn sees what the guest actually experienced earlier — not
 * just what was drafted. Never throws: runScenario itself never throws, and
 * this function adds no further failure modes of its own.
 */
export async function runScenarioSequence(input: RunScenarioSequenceInput): Promise<SequenceTurnResult[]> {
  const { sequence, venueId, guestId } = input
  const now = input.now ?? new Date()
  let history = buildSeedHistory(sequence.seed, now)
  const results: SequenceTurnResult[] = []

  for (const turn of sequence.turns) {
    const result = await runScenario({
      scenario: toScenarioSheetRow(turn),
      venueId,
      guestId,
      priorMessages: history,
    })
    const receivedBody = deriveReceivedBody(result)
    history = appendTurnToHistory(history, turn, result, new Date())
    results.push({ result, receivedBody })
  }

  return results
}
