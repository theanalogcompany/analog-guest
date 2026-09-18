import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import {
  addGrade,
  addScenarioRun,
  newCostTracker,
  totalCostUsd,
  type CostTrackerState,
} from './onboarding/cost-tracker'
import { extractKnownContactData, gradeVoiceDeterministic } from './onboarding/grade-voice-deterministic'
import { gradeRouting } from './onboarding/grade-routing'
import { gradeScenario } from './onboarding/grade-scenario'
import { parseGuestScenarioArgs } from './onboarding/guest-scenario-args'
import { assertVenueGuard, loadBrandPersona, loadVenueContext } from './onboarding/load-venue-context'
import { checkCleanState, clearMessagingCredentials, countGuardrailState, diffGuardrailState } from './onboarding/preflight'
import { runScenario, seedSyntheticGuests, SYNTHETIC_PHONES, type ScenarioResult } from './onboarding/run-test-scenarios'
import { evaluateScenarioBar, evaluateSequenceBar, type ScenarioBarResult } from './onboarding/scenario-bar'
import { appendResult, defaultOutputPath, refuseExistingUnlessForced, writeHeader } from './onboarding/scenario-run-output'
import {
  deriveReceivedBody,
  runScenarioSequence,
  ScenarioSequenceSchema,
  toScenarioSheetRow,
  type ScenarioSequence,
} from './onboarding/scenario-sequence'
import { ScenarioSchema, type Scenario } from './onboarding/scenario-schema'

/**
 * TAC-481. Message-in/message-out QA harness: runs one or more guest turns
 * against a test venue's real agent pipeline (classify -> retrieve ->
 * generate -> grounding backstop -> approval gate, decision-only — never
 * persists, never dispatches, never pushes) and prints/records the model's
 * actual reply, graded against a pre-registered bar.
 *
 * Three input shapes, resolved from the --scenario JSON file's own shape:
 *   - a single scenario object          -> run once
 *   - an array of scenario objects      -> run independently (no shared
 *                                          history between them, matching
 *                                          how run-test-scenarios.ts already
 *                                          runs a sheet's rows)
 *   - { seed?, turns: [...] }           -> a SEQUENCE: one conversation for
 *                                          one guest, turns run in order
 *                                          with a synthesized history
 *                                          threaded between them (see
 *                                          scenario-sequence.ts)
 *
 * Cost: classify+generate ~$0.026/turn (Sonnet) + one Haiku grading call
 * ~$0.003/turn when the turn produced a reply to grade. ~$0.03/turn total.
 * A 10-turn run ~$0.30. See scenario-run-output for the header this writes
 * and CLAUDE.md's own cost accounting for this script.
 */

type ScenarioInput =
  | { kind: 'single'; scenarios: Scenario[] }
  | { kind: 'sequence'; sequence: ScenarioSequence }

function parseScenarioInput(raw: unknown): ScenarioInput {
  if (Array.isArray(raw)) {
    return { kind: 'single', scenarios: raw.map((s) => ScenarioSchema.parse(s)) }
  }
  if (raw !== null && typeof raw === 'object' && 'turns' in raw) {
    return { kind: 'sequence', sequence: ScenarioSequenceSchema.parse(raw) }
  }
  return { kind: 'single', scenarios: [ScenarioSchema.parse(raw)] }
}

function resolveGitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

interface GradedTurn {
  result: ScenarioResult
  receivedBody: string | null
  bar: ScenarioBarResult
  knowledgeVerdict: string
  voiceVerdict: string
  expectedBehaviorVerdict: string
  routingVerdict: string
}

async function main(): Promise<void> {
  const parsed = parseGuestScenarioArgs(process.argv)
  if (!parsed) {
    console.error(
      'Usage: npm run run-guest-scenario -- --venue <slug> --guest <new|returning|regular|raving_fan> --scenario <path> [--out <path>] [--force]',
    )
    process.exit(1)
  }
  const { venue, guest, scenario: scenarioPath, out, force } = parsed

  // ---- Guardrail 1: credential clearing, before anything else touches the pipeline ----
  clearMessagingCredentials()
  console.log('[run-guest-scenario] cleared Sendblue/APNs credentials from process.env')

  // ---- Venue guard (safety by construction, not convention: no override flag) ----
  const venueCtx = await loadVenueContext(venue)
  assertVenueGuard(venueCtx)
  console.log(
    `[run-guest-scenario] venue ${venueCtx.slug} (id=${venueCtx.venueId}, is_test=${venueCtx.isTest}, status=${venueCtx.status}) — guard passed`,
  )
  const persona = await loadBrandPersona(venueCtx.venueId)
  const knownContact = extractKnownContactData(venueCtx.venueInfo)

  // ---- Parse the scenario file ----
  const raw: unknown = JSON.parse(readFileSync(scenarioPath, 'utf8'))
  const input = parseScenarioInput(raw)
  const turnCount = input.kind === 'sequence' ? input.sequence.turns.length : input.scenarios.length
  const requestedTurns: Scenario[] = input.kind === 'sequence' ? input.sequence.turns : input.scenarios
  for (const t of requestedTurns) {
    if (t.guest_state !== guest) {
      console.error(
        `[run-guest-scenario] scenario "${t.sample_id}" has guest_state="${t.guest_state}", which does not match --guest ${guest}. Every turn in a run targets the one guest --guest names.`,
      )
      process.exit(1)
    }
  }
  console.log(
    `[run-guest-scenario] loaded ${turnCount} turn(s) from ${scenarioPath} (${input.kind === 'sequence' ? `sequence, ${input.sequence.seed.length} seed line(s)` : 'independent'})`,
  )

  // ---- Seed synthetic guests (idempotent — seeds all four states, we use one) ----
  const venueId = venueCtx.venueId
  const { guestIdsByState, outcomes } = await seedSyntheticGuests(venueId)
  const requested = outcomes.find((o) => o.state === guest)
  if (!requested?.matched) {
    console.error(
      `[run-guest-scenario] synthetic guest tuning mismatch for state "${guest}" (got ${requested?.computedState}, score ${requested?.computedScore}) — refusing to run against a guest that isn't in the band its scenarios assume. See CLAUDE.md's synthetic-guest tuning note.`,
    )
    process.exit(1)
  }
  const guestId = guestIdsByState[guest]
  console.log(`[run-guest-scenario] synthetic guest: ${guest} ${SYNTHETIC_PHONES[guest]} guestId=${guestId}`)

  // ---- Guardrail 2: clean-state preflight ----
  const hits = await checkCleanState(venueId, { [guest]: guestId }, { [guest]: SYNTHETIC_PHONES[guest] })
  if (hits.length > 0) {
    const listing = hits.map((h) => `  - ${h.state} (${h.phone}, guest=${h.guestId}): ${h.kind} — ${h.detail}`).join('\n')
    console.error(
      `[run-guest-scenario] clean-state preflight FAILED — this synthetic guest already has a pending draft or active commitment. Never auto-deleted. Resolve by hand in Supabase Studio, then rerun:\n${listing}`,
    )
    process.exit(1)
  }
  console.log('[run-guest-scenario] clean-state preflight: no pending drafts or active commitments')

  // ---- Guardrail 3: before counts ----
  const before = await countGuardrailState(venueId)

  // ---- Output file ----
  const outputPath = out ?? defaultOutputPath(new Date())
  refuseExistingUnlessForced(outputPath, force)
  writeHeader(outputPath, {
    promptVersion: PROMPT_VERSION,
    gitSha: resolveGitSha(),
    model: 'claude-sonnet-4-6',
    generatedAt: new Date().toISOString(),
    venueSlug: venueCtx.slug,
    guestState: guest,
  })
  console.log(`[run-guest-scenario] writing to ${outputPath}`)

  // ---- Run turns (decision-only) ----
  let results: ScenarioResult[]
  let receivedBodies: (string | null)[]
  if (input.kind === 'sequence') {
    const turnResults = await runScenarioSequence({ sequence: input.sequence, venueId, guestId })
    results = turnResults.map((t) => t.result)
    receivedBodies = turnResults.map((t) => t.receivedBody)
  } else {
    results = []
    for (const scenario of input.scenarios) {
      results.push(await runScenario({ scenario: toScenarioSheetRow(scenario), venueId, guestId }))
    }
    receivedBodies = results.map(deriveReceivedBody)
  }

  // ---- Guardrail 3b: after counts, fail loudly on any delta ----
  const after = await countGuardrailState(venueId)
  const deltas = diffGuardrailState(before, after)
  if (deltas.length > 0) {
    console.error(
      `[run-guest-scenario] GUARDRAIL VIOLATION — row counts changed during a decision-only run:\n${deltas.map((d) => `  - ${d}`).join('\n')}\nThis harness must never write to these tables. Investigate before trusting any result above.`,
    )
    process.exit(1)
  }
  console.log('[run-guest-scenario] after counts: unchanged (guardrail passed — zero delta on all four tables)')

  // ---- Grade + evaluate the bar, per turn ----
  let cost = newCostTracker()
  const graded: GradedTurn[] = []
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    cost = addScenarioRun(cost)
    const scenario = requestedTurns[i]
    const deterministic =
      result.replyBody !== null
        ? gradeVoiceDeterministic({
            replyBody: result.replyBody,
            category: scenario.category,
            emojiPolicy: persona.emojiPolicy,
            speakerFraming: persona.speakerFraming,
            speakerName: persona.speakerName,
            knownPhones: knownContact.phones,
            knownDomains: knownContact.domains,
          })
        : { pass: true, findings: [] }
    const scenarioSheetRow = toScenarioSheetRow(scenario)
    const llmGrade = await gradeScenario({
      scenario: scenarioSheetRow,
      replyBody: result.replyBody,
      outcome: result.outcome,
      persona,
      venueInfo: venueCtx.venueInfo,
      retrievedKnowledge: result.retrievedKnowledge,
      retrievedVoiceExamples: result.retrievedVoiceExamples,
    })
    if (llmGrade.model !== 'none') {
      cost = addGrade(cost, { inputTokens: llmGrade.inputTokens, outputTokens: llmGrade.outputTokens, model: llmGrade.model })
    }
    const routing = gradeRouting({ expectedRoute: scenario.expected_route, actualRoute: result.route })
    const bar = evaluateScenarioBar({ deterministic, grade: llmGrade, routing })

    const gradedTurn: GradedTurn = {
      result,
      receivedBody: receivedBodies[i],
      bar,
      knowledgeVerdict: llmGrade.knowledgeVerdict,
      voiceVerdict: deterministic.pass && llmGrade.voiceVerdict === 'pass' ? 'pass' : 'fail',
      expectedBehaviorVerdict: llmGrade.expectedBehaviorVerdict,
      routingVerdict: routing.verdict,
    }
    graded.push(gradedTurn)

    appendResult(outputPath, {
      sampleId: result.sampleId,
      turnIndex: i,
      outcome: result.outcome,
      route: result.route,
      primaryTrigger: result.primaryTrigger,
      replyBody: result.replyBody,
      receivedBody: gradedTurn.receivedBody,
      voiceFidelity: result.voiceFidelity,
      knowledgeVerdict: gradedTurn.knowledgeVerdict,
      voiceVerdict: gradedTurn.voiceVerdict,
      expectedBehaviorVerdict: gradedTurn.expectedBehaviorVerdict,
      routingVerdict: gradedTurn.routingVerdict,
      barPass: bar.pass,
      barFailures: bar.failures,
      elapsedMs: result.elapsedMs,
    })

    console.log(
      `[run-guest-scenario] turn ${i + 1}/${results.length} ${result.sampleId}: ${result.outcome}${
        result.route ? ` -> ${result.route}` : ''
      } bar=${bar.pass ? 'PASS' : 'FAIL'}`,
    )
    if (gradedTurn.receivedBody !== null) console.log(`    guest received: ${gradedTurn.receivedBody}`)
    else console.log('    guest received: (nothing this turn)')
    if (!bar.pass) for (const f of bar.failures) console.log(`    FAIL: ${f}`)
  }

  const overall = evaluateSequenceBar(graded.map((g) => g.bar))
  printCostReport(cost)
  console.log(`\n[run-guest-scenario] === ${overall.pass ? 'PASS' : 'FAIL'} (${graded.length} turn(s)) ===`)
  if (!overall.pass) {
    for (const f of overall.failures) console.log(`  - ${f}`)
  }
  console.log(`[run-guest-scenario] full record: ${outputPath}`)

  process.exit(overall.pass ? 0 : 1)
}

function printCostReport(cost: CostTrackerState): void {
  console.log(
    `\n[run-guest-scenario] cost: estimated (classify+generate) $${cost.estimatedUsd.toFixed(4)} + measured (grading) $${cost.measuredUsd.toFixed(4)} = $${totalCostUsd(cost).toFixed(4)}`,
  )
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e))
  process.exit(1)
})
