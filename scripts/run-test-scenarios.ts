import {
  addGrade,
  addScenarioRun,
  newCostTracker,
  totalCostUsd,
  wouldExceedCap,
  type CostTrackerState,
} from './onboarding/cost-tracker'
import { mapWithConcurrency } from './onboarding/concurrency'
import {
  ensureTabExists,
  findByPrefix,
  findVenueFolder,
  getDrive,
  getSheets,
  GSHEET_MIME,
  listVenueFiles,
  pruneTabsByPrefix,
  writeSheetFile,
  writeTabValues,
} from './onboarding/drive'
import { gradeScenario } from './onboarding/grade-scenario'
import { extractKnownContactData, gradeVoiceDeterministic } from './onboarding/grade-voice-deterministic'
import { gradeRouting } from './onboarding/grade-routing'
import { assertVenueGuard, loadBrandPersona, loadVenueContext } from './onboarding/load-venue-context'
import { filterRunnableScenarios, loadExistingSheet } from './onboarding/merge-scenario-sheet'
import { buildOwnerReviewRows, rowsToCsv } from './onboarding/owner-review-sheet'
import { selectOwnerReviewCandidates, selectOwnerReviewFinal } from './onboarding/owner-review-selection'
import { checkCleanState, clearMessagingCredentials, countGuardrailState, diffGuardrailState } from './onboarding/preflight'
import { buildReportRows } from './onboarding/report-sheet'
import { runScenario, seedSyntheticGuests, SYNTHETIC_PHONES, type ScenarioResult } from './onboarding/run-test-scenarios'
import { buildRunRows, type RunRow } from './onboarding/run-sheet'
import type { ScenarioSheetRow } from './onboarding/scenario-schema'
import {
  buildReviewList,
  computeTopicPassRates,
  sampleForGraderSpotCheck,
  sampleForVoiceRead,
  type GradedScenario,
} from './onboarding/scorecard'
import { buildTimestampedTabName } from './onboarding/tab-retention'

const SHEET_NAME_PREFIX = '07-'
const DEFAULT_CONCURRENCY = 4
const REPORT_TAB_PREFIX = 'Report'
const RUN_TAB_PREFIX = 'Run'
// Each run writes its own timestamped Report/Run tab (see tab-retention.ts)
// rather than reusing one tab — a single reused tab meant every run silently
// destroyed the previous run's result set (a 455-scenario run was lost this
// way). Keep the most recent TAB_RETENTION_COUNT of each; older ones are
// pruned after the new tab is written.
const TAB_RETENTION_COUNT = 10

interface ParsedArgs {
  slug: string
  sampleIds: string[] | null
  topics: string[] | null
  categories: string[] | null
  modes: string[] | null
  limit: number | null
  concurrency: number
  maxCostUsd: number | null
  ownerReview: boolean
}

function parseArgs(argv: string[]): ParsedArgs | null {
  const args = argv.slice(2)
  let slug: string | null = null
  let sampleIds: string[] | null = null
  let topics: string[] | null = null
  let categories: string[] | null = null
  let modes: string[] | null = null
  let limit: number | null = null
  let concurrency = DEFAULT_CONCURRENCY
  let maxCostUsd: number | null = null
  let ownerReview = false

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--owner-review') {
      ownerReview = true
    } else if (a === '--sample-ids') {
      sampleIds = (args[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    } else if (a === '--topic') {
      topics = (args[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    } else if (a === '--category') {
      categories = (args[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    } else if (a === '--mode') {
      modes = (args[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    } else if (a === '--limit') {
      limit = Number(args[++i])
      if (!Number.isFinite(limit) || limit <= 0) {
        console.error('[run-test-scenarios] --limit must be a positive number')
        return null
      }
    } else if (a === '--concurrency') {
      concurrency = Number(args[++i])
      if (!Number.isFinite(concurrency) || concurrency <= 0) {
        console.error('[run-test-scenarios] --concurrency must be a positive number')
        return null
      }
    } else if (a === '--max-cost') {
      maxCostUsd = Number(args[++i])
      if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
        console.error('[run-test-scenarios] --max-cost must be a positive number (USD)')
        return null
      }
    } else if (a.startsWith('--')) {
      console.error(`[run-test-scenarios] unknown flag: ${a}`)
      return null
    } else if (!slug) {
      slug = a
    } else {
      console.error(`[run-test-scenarios] unexpected positional arg: ${a}`)
      return null
    }
  }
  if (!slug) return null
  if (ownerReview && (sampleIds || topics || categories || modes || limit !== null)) {
    console.error(
      '[run-test-scenarios] --owner-review cannot be combined with --sample-ids/--topic/--category/--mode/--limit — it selects scenarios itself',
    )
    return null
  }
  return { slug, sampleIds, topics, categories, modes, limit, concurrency, maxCostUsd, ownerReview }
}

function applyFilters(rows: ScenarioSheetRow[], parsed: ParsedArgs): ScenarioSheetRow[] {
  if (parsed.sampleIds) {
    const wanted = new Set(parsed.sampleIds)
    const found = rows.filter((r) => wanted.has(r.sample_id))
    const foundIds = new Set(found.map((r) => r.sample_id))
    for (const id of parsed.sampleIds) {
      if (!foundIds.has(id)) console.warn(`[run-test-scenarios] --sample-ids: "${id}" not found in sheet (skipped)`)
    }
    return found
  }
  let filtered = rows
  if (parsed.topics) {
    const set = new Set(parsed.topics)
    filtered = filtered.filter((r) => set.has(r.topic))
  }
  if (parsed.categories) {
    const set = new Set(parsed.categories)
    filtered = filtered.filter((r) => set.has(r.category))
  }
  if (parsed.modes) {
    const set = new Set(parsed.modes)
    filtered = filtered.filter((r) => set.has(r.mode))
  }
  if (parsed.limit !== null) {
    filtered = filtered.slice(0, parsed.limit)
  }
  return filtered
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv)
  if (!parsed) {
    console.error(
      'Usage: npm run run-test-scenarios -- <slug> [--sample-ids id1,id2,...] [--topic t1,t2] [--category c1,c2] [--mode graded|exploratory] [--limit N] [--concurrency N] [--max-cost USD] [--owner-review]',
    )
    process.exit(1)
  }
  const { slug } = parsed

  const parentFolderId = process.env.GOOGLE_DRIVE_VENUES_FOLDER_ID
  if (!parentFolderId) {
    console.error('Missing env var: GOOGLE_DRIVE_VENUES_FOLDER_ID')
    process.exit(1)
  }

  // ---- Guardrail 1: credential clearing, before anything else touches the pipeline ----
  clearMessagingCredentials()
  console.log('[run-test-scenarios] cleared Sendblue/APNs credentials from process.env')

  // ---- Venue guard ----
  const venueCtx = await loadVenueContext(slug)
  assertVenueGuard(venueCtx)
  console.log(
    `[run-test-scenarios] venue ${venueCtx.slug} (id=${venueCtx.venueId}, is_test=${venueCtx.isTest}, status=${venueCtx.status}) — guard passed`,
  )
  const persona = await loadBrandPersona(venueCtx.venueId)
  const knownContact = extractKnownContactData(venueCtx.venueInfo)

  // ---- Load scenarios from the 07-sheet (Scenarios tab) ----
  const drive = getDrive()
  const sheets = getSheets()
  const folder = await findVenueFolder(drive, parentFolderId, slug)
  const files = await listVenueFiles(drive, folder.id)
  const sheetFile = findByPrefix(files.filter((f) => f.mimeType === GSHEET_MIME), SHEET_NAME_PREFIX)
  if (!sheetFile) {
    throw new Error(
      `[run-test-scenarios] no 07-${slug}-test-scenarios sheet found in folder ${folder.name}. Run npm run extract-test-scenarios -- ${slug} first.`,
    )
  }
  const existing = await loadExistingSheet(sheets, sheetFile.id)
  console.log(`[run-test-scenarios] sheet: ${sheetFile.name} — ${existing.currentRows.length} rows`)

  const runnable = filterRunnableScenarios(existing.currentRows)
  const selected = parsed.ownerReview ? selectOwnerReviewCandidates(runnable) : applyFilters(runnable, parsed)
  if (selected.length === 0) {
    throw new Error('[run-test-scenarios] filters matched zero scenarios — nothing to run')
  }
  console.log(
    `[run-test-scenarios] selected ${selected.length} scenario(s) to run${parsed.ownerReview ? ' (owner-review candidate pool)' : ''}`,
  )

  // ---- Seed synthetic guests (sequential state settling happens inside) ----
  const venueId = venueCtx.venueId
  console.log(`[run-test-scenarios] seeding synthetic guests at venue ${venueId}...`)
  const { guestIdsByState, outcomes } = await seedSyntheticGuests(venueId)
  for (const o of outcomes) {
    const mark = o.matched ? 'OK' : 'MISMATCH'
    console.log(
      `[run-test-scenarios] synthetic guest: ${o.state.padEnd(11)} ${o.phone}  guestId=${o.guestId}  score=${o.computedScore}  state=${o.computedState}  ${mark}`,
    )
  }
  const mismatches = outcomes.filter((o) => !o.matched)
  const usableStates = new Set(outcomes.filter((o) => o.matched).map((o) => o.state))
  if (mismatches.length > 0) {
    console.warn(
      `[run-test-scenarios] synthetic guest tuning mismatch (TAC-344): ${mismatches
        .map((m) => `${m.state} (got ${m.computedState}, score ${m.computedScore})`)
        .join('; ')}. Per TAC-347's build authorization, proceeding with the ${usableStates.size} matched state(s) — scenarios targeting a mismatched state are skipped below, not silently run against the wrong band.`,
    )
  }

  const runnableSelected = selected.filter((s) => {
    if (usableStates.has(s.guest_state)) return true
    console.warn(`[run-test-scenarios] skipping ${s.sample_id}: guest_state=${s.guest_state} not tuned correctly`)
    return false
  })

  // ---- Guardrail 2: clean-state preflight ----
  const hits = await checkCleanState(venueId, guestIdsByState, SYNTHETIC_PHONES)
  if (hits.length > 0) {
    const listing = hits
      .map((h) => `  - ${h.state} (${h.phone}, guest=${h.guestId}): ${h.kind} — ${h.detail}`)
      .join('\n')
    throw new Error(
      `[run-test-scenarios] clean-state preflight FAILED — synthetic guest(s) already have a pending draft or active commitment. Never auto-deleted. Resolve by hand in Supabase Studio, then rerun:\n${listing}`,
    )
  }
  console.log('[run-test-scenarios] clean-state preflight: no pending drafts or active commitments')

  // ---- Guardrail 3: before counts ----
  const before = await countGuardrailState(venueId)
  console.log(
    `[run-test-scenarios] before counts: messages=${before.messages} guest_commitments=${before.guestCommitments} guest_states=${before.guestStates} engagement_events=${before.engagementEvents}`,
  )

  // ---- Run scenarios (decision-only, bounded concurrency) ----
  let cost = newCostTracker()
  const runStart = Date.now()
  const results = await mapWithConcurrency(runnableSelected, parsed.concurrency, async (scenario) => {
    const guestId = guestIdsByState[scenario.guest_state]
    const result = await runScenario({ scenario, venueId, guestId })
    console.log(
      `[run-test-scenarios] ${result.sampleId} (${result.category}, ${result.guestState}): ${result.outcome}${
        result.route ? ` -> ${result.route}` : ''
      }${result.primaryTrigger ? ` [${result.primaryTrigger}]` : ''} in ${result.elapsedMs}ms`,
    )
    return result
  })
  for (let i = 0; i < results.length; i++) cost = addScenarioRun(cost)
  const totalElapsedMs = Date.now() - runStart

  // ---- Guardrail 3b: after counts, fail loudly on any delta ----
  const after = await countGuardrailState(venueId)
  const deltas = diffGuardrailState(before, after)
  if (deltas.length > 0) {
    throw new Error(
      `[run-test-scenarios] GUARDRAIL VIOLATION — row counts changed during a decision-only run:\n${deltas
        .map((d) => `  - ${d}`)
        .join('\n')}\nThis harness must never write to these tables. Investigate before trusting any result above.`,
    )
  }
  console.log('[run-test-scenarios] after counts: unchanged (guardrail passed — zero delta on all four tables)')

  // ---- Grading (Stage 3): deterministic voice + LLM grade + routing, per scenario ----
  console.log(`[run-test-scenarios] grading ${results.length} result(s)...`)
  const graded: GradedScenario[] = []
  let ungraded = 0
  for (const result of results) {
    const scenario = runnableSelected.find((s) => s.sample_id === result.sampleId)!
    if (wouldExceedCap(cost, parsed.maxCostUsd)) {
      console.warn(
        `[run-test-scenarios] --max-cost ${parsed.maxCostUsd} would be exceeded — stopping grading at ${graded.length}/${results.length} (remaining scenarios are reported ungraded)`,
      )
      ungraded = results.length - graded.length
      break
    }
    const deterministicVoice =
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
    const llmGrade = await gradeScenario({
      scenario,
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
    const routing = gradeRouting({
      expectedRoute: scenario.expected_route,
      actualRoute: result.route,
    })
    graded.push({ scenario, result, deterministicVoice, llmGrade, routing })
    console.log(
      `[run-test-scenarios]   graded ${result.sampleId}: knowledge=${llmGrade.knowledgeVerdict} voice=${
        deterministicVoice.pass && llmGrade.voiceVerdict === 'pass' ? 'pass' : 'fail'
      } routing=${routing.verdict} expected_behavior=${llmGrade.expectedBehaviorVerdict}`,
    )
  }

  // ---- Scorecard + report ----
  const topicPassRates = computeTopicPassRates(graded)
  const reviewList = buildReviewList(graded)
  const voiceReadSample = sampleForVoiceRead(graded)
  const graderSpotCheckSample = sampleForGraderSpotCheck(graded)

  const runDateIso = new Date().toISOString()
  const reportRows = buildReportRows({
    runDateIso,
    scenarioCount: results.length,
    runTimeSeconds: totalElapsedMs / 1000,
    estimatedCostUsd: cost.estimatedUsd,
    measuredCostUsd: cost.measuredUsd,
    gradedCount: graded.length,
    ungraded,
    topicPassRates,
    reviewList,
    voiceReadSample,
    graderSpotCheckSample,
  })

  const reportTabName = buildTimestampedTabName(REPORT_TAB_PREFIX, runDateIso)
  await ensureTabExists(sheets, sheetFile.id, reportTabName)
  await writeTabValues(sheets, sheetFile.id, reportTabName, reportRows)
  console.log(`[run-test-scenarios] wrote ${reportTabName} tab (${reportRows.length} rows) to sheet ${sheetFile.id}`)
  const reportPrune = await pruneTabsByPrefix(sheets, sheetFile.id, REPORT_TAB_PREFIX, TAB_RETENTION_COUNT)
  if (reportPrune.deletedTitles.length > 0) {
    console.log(`[run-test-scenarios] pruned old Report tabs (kept ${TAB_RETENTION_COUNT}): ${reportPrune.deletedTitles.join(', ')}`)
  }

  // ---- Run tab: one row per scenario, the full detail Report's samples/
  // caps leave out. Each run gets its own timestamped tab (tab-retention.ts)
  // rather than overwriting a single reused tab — a reused tab meant every
  // run silently destroyed the previous run's result set. The most recent
  // TAB_RETENTION_COUNT are kept; older ones are pruned below.
  const runRows: RunRow[] = graded.map((g): RunRow => {
    const voicePass = g.deterministicVoice.pass && g.llmGrade.voiceVerdict === 'pass'
    const voiceReasonParts = [...g.deterministicVoice.findings.map((f) => `${f.check}: ${f.detail}`), g.llmGrade.voiceReason].filter(
      (s): s is string => Boolean(s),
    )
    return {
      sampleId: g.result.sampleId,
      topic: g.result.topic,
      category: g.result.category,
      scenarioSource: g.result.scenarioSource,
      mode: g.result.mode,
      guestState: g.result.guestState,
      inboundMessage: g.result.inboundMessage,
      outcome: g.result.outcome,
      route: g.result.route ?? '',
      primaryTrigger: g.result.primaryTrigger ?? '',
      allTriggers: (g.result.triggers ?? []).join(', '),
      voiceFidelity: g.result.voiceFidelity !== null ? g.result.voiceFidelity.toFixed(2) : '',
      replyBody: g.result.replyBody ?? '',
      knowledgeVerdict: g.llmGrade.knowledgeVerdict,
      knowledgeReason: g.llmGrade.knowledgeReason,
      voiceVerdict: voicePass ? 'pass' : 'fail',
      voiceReason: voiceReasonParts.join(' | '),
      routingVerdict: g.routing.verdict,
      expectedRoute: g.routing.expectedRoute,
      actualRoute: g.routing.actualRoute ?? '',
      expectedBehaviorVerdict: g.llmGrade.expectedBehaviorVerdict,
      expectedBehaviorReason: g.llmGrade.expectedBehaviorReason,
    }
  })
  const runTabName = buildTimestampedTabName(RUN_TAB_PREFIX, runDateIso)
  await ensureTabExists(sheets, sheetFile.id, runTabName)
  await writeTabValues(sheets, sheetFile.id, runTabName, buildRunRows(runRows))
  console.log(`[run-test-scenarios] wrote ${runTabName} tab (${runRows.length} rows) to sheet ${sheetFile.id}`)
  const runPrune = await pruneTabsByPrefix(sheets, sheetFile.id, RUN_TAB_PREFIX, TAB_RETENTION_COUNT)
  if (runPrune.deletedTitles.length > 0) {
    console.log(`[run-test-scenarios] pruned old Run tabs (kept ${TAB_RETENTION_COUNT}): ${runPrune.deletedTitles.join(', ')}`)
  }

  // ---- Owner-review export (TAC-347 Stage 4): a separate 08-{slug}-response-
  // review gsheet, in the exact shape ingest-response-review's parseReviewSheet
  // expects, blank verdict/edited_message/comment for the owner to fill in.
  if (parsed.ownerReview) {
    const finalSelection = selectOwnerReviewFinal(graded)
    if (finalSelection.length === 0) {
      console.warn('[run-test-scenarios] owner-review: zero scenarios passed knowledge+routing grading — writing an empty sheet')
    } else if (finalSelection.length < 30) {
      console.warn(
        `[run-test-scenarios] owner-review: only ${finalSelection.length} scenario(s) passed grading + eligibility (target ~30)`,
      )
    }
    const csv = rowsToCsv(buildOwnerReviewRows(finalSelection, runDateIso))
    const ownerReviewFileName = `08-${slug}-response-review`
    const { id: ownerReviewFileId } = await writeSheetFile(drive, folder.id, ownerReviewFileName, csv)
    const ownerReviewLink = `https://docs.google.com/spreadsheets/d/${ownerReviewFileId}/edit`
    console.log(
      `[run-test-scenarios] wrote owner-review sheet "${ownerReviewFileName}" (${finalSelection.length} rows): ${ownerReviewLink}`,
    )
  }

  printReport({
    slug,
    results,
    graded,
    topicPassRates,
    reviewList,
    totalElapsedMs,
    cost,
    before,
    after,
  })
}

function printReport(input: {
  slug: string
  results: ScenarioResult[]
  graded: GradedScenario[]
  topicPassRates: ReturnType<typeof computeTopicPassRates>
  reviewList: ReturnType<typeof buildReviewList>
  totalElapsedMs: number
  cost: CostTrackerState
  before: { messages: number; guestCommitments: number; guestStates: number; engagementEvents: number }
  after: { messages: number; guestCommitments: number; guestStates: number; engagementEvents: number }
}): void {
  const { slug, results, graded, topicPassRates, reviewList, totalElapsedMs, cost, before, after } = input
  const byOutcome: Record<string, number> = {}
  for (const r of results) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1

  console.log(`\n[run-test-scenarios] === ${slug} run ===`)
  console.log(`  ran: ${results.length}, graded: ${graded.length}`)
  for (const [outcome, count] of Object.entries(byOutcome)) {
    console.log(`    ${outcome}: ${count}`)
  }
  console.log(`  total run time: ${(totalElapsedMs / 1000).toFixed(1)}s`)
  console.log(
    `  cost: estimated (classify+generate) $${cost.estimatedUsd.toFixed(4)} + measured (grading) $${cost.measuredUsd.toFixed(4)} = $${totalCostUsd(cost).toFixed(4)}`,
  )
  console.log(
    `  row counts before -> after: messages ${before.messages}->${after.messages}, guest_commitments ${before.guestCommitments}->${after.guestCommitments}, guest_states ${before.guestStates}->${after.guestStates}, engagement_events ${before.engagementEvents}->${after.engagementEvents}`,
  )

  console.log(`\n  --- per-topic pass rates ---`)
  for (const t of topicPassRates) {
    const fmt = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(0)}%`)
    console.log(`    ${t.topic}: n=${t.total} knowledge=${fmt(t.knowledgePassRate)} voice=${fmt(t.voicePassRate)} routing=${fmt(t.routingPassRate)}`)
  }

  console.log(`\n  --- review list (${reviewList.length}) ---`)
  for (const item of reviewList) {
    console.log(`    [${item.severity}] ${item.sampleId}: ${item.reason}`)
  }

  console.log('')
  for (const g of graded) {
    const r = g.result
    console.log(`--- ${r.sampleId} (${r.category}, ${r.guestState}) ---`)
    console.log(`  inbound: ${r.inboundMessage}`)
    console.log(
      `  outcome: ${r.outcome}${r.route ? ` (route=${r.route})` : ''}${r.primaryTrigger ? ` trigger=${r.primaryTrigger}` : ''}${r.triggers && r.triggers.length > 1 ? ` all_triggers=[${r.triggers.join(', ')}]` : ''}`,
    )
    if (r.wouldBlankBody) console.log('  (production would BLANK this body before persisting — TAC-309 knowledge_gap)')
    if (r.voiceFidelity !== null) console.log(`  voice_fidelity: ${r.voiceFidelity.toFixed(2)}`)
    if (r.replyBody !== null) console.log(`  reply: ${r.replyBody}`)
    if (r.errorMessage !== null) console.log(`  error: ${r.errorMessage}`)
    if (r.expectedRoute !== 'unknown') console.log(`  expected_route: ${r.expectedRoute}`)
    if (g.scenario.expected_behavior) console.log(`  expected_behavior: ${g.scenario.expected_behavior}`)
    console.log(
      `  grade: knowledge=${g.llmGrade.knowledgeVerdict} (${g.llmGrade.knowledgeReason}) voice=${
        g.deterministicVoice.pass && g.llmGrade.voiceVerdict === 'pass' ? 'pass' : 'fail'
      } routing=${g.routing.verdict} expected_behavior=${g.llmGrade.expectedBehaviorVerdict}${
        g.llmGrade.expectedBehaviorVerdict === 'fail' ? ` (${g.llmGrade.expectedBehaviorReason})` : ''
      }`,
    )
    console.log('')
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e))
  process.exit(1)
})
