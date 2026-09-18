// TAC-481. Pure — no imports beyond types, vitest-safe with no SDK init.
//
// scorecard.ts computes three independent nullable-boolean axes
// (knowledgePassed / voicePassed / routingPassed) plus a separate
// expectedBehaviorVerdict, and aggregates them into per-topic pass RATES and
// a severity-sorted human review queue — deliberately, because that
// pipeline's job is surfacing what a human should look at, not gating a
// merge. TAC-481's AC3 ("the run reports pass or fail against that bar...
// rather than printing output for someone to eyeball") needs a single
// boolean per scenario. This is that collapse.
import type { DeterministicVoiceResult } from './grade-voice-deterministic'
import type { GradeScenarioResult } from './grade-scenario'
import type { RoutingGrade } from './grade-routing'

export interface ScenarioBarResult {
  pass: boolean
  failures: string[]
}

/**
 * Collapses one scenario's three-axis grade into a single pass/fail. Reuses
 * scorecard.ts's own pass/fail semantics for each axis rather than
 * redefining them — 'not_applicable' / 'correctly_declined' / 'correct' /
 * 'incomplete' all pass; only 'wrong' / 'invented' / 'should_have_declined'
 * fail knowledge.
 *
 * Known gap, stated rather than silently accepted: forbidden_claims are
 * passed to gradeScenario as prompt context but the grader has no dedicated
 * forbidden-claims verdict field — a violation is expected to surface as
 * knowledgeVerdict='wrong'/'invented' or expectedBehaviorVerdict='fail', the
 * same reliance the existing Stage 3 pipeline already has. Not widening
 * grade-scenario.ts's output schema here — it's shared production grading
 * code the onboarding pipeline depends on.
 */
export function evaluateScenarioBar(input: {
  deterministic: DeterministicVoiceResult
  grade: GradeScenarioResult
  routing: RoutingGrade
}): ScenarioBarResult {
  const { deterministic, grade, routing } = input
  const failures: string[] = []

  if (!deterministic.pass) {
    for (const f of deterministic.findings) {
      failures.push(`deterministic voice check failed (${f.check}): ${f.detail}`)
    }
    if (deterministic.findings.length === 0) {
      failures.push('deterministic voice check failed')
    }
  }
  if (grade.voiceVerdict !== 'pass') {
    failures.push(`voice grade: ${grade.voiceReason || 'failed'}`)
  }
  if (grade.knowledgeVerdict === 'wrong' || grade.knowledgeVerdict === 'invented' || grade.knowledgeVerdict === 'should_have_declined') {
    failures.push(`knowledge grade (${grade.knowledgeVerdict}): ${grade.knowledgeReason}`)
  }
  if (grade.expectedBehaviorVerdict === 'fail') {
    failures.push(`expected behavior: ${grade.expectedBehaviorReason}`)
  }
  if (routing.verdict === 'fail') {
    failures.push(`routing: expected "${routing.expectedRoute}", got "${routing.actualRoute}"`)
  }

  return { pass: failures.length === 0, failures }
}

/**
 * Combines the per-turn bars of a scenario SEQUENCE (scenario-sequence.ts)
 * into one pass/fail for the whole conversation. Callers prefix each turn's
 * ScenarioBarResult.failures with turn context (sampleId / index) before
 * passing them in — this function stays a plain fold so it has no opinion on
 * how a turn should be labeled.
 */
export function evaluateSequenceBar(turnBars: readonly ScenarioBarResult[]): ScenarioBarResult {
  const failures = turnBars.flatMap((b) => b.failures)
  return { pass: failures.length === 0, failures }
}
