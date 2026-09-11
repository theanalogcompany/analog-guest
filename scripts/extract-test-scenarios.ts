import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  createMultiTabSheet,
  findByPrefix,
  findVenueFolder,
  getDrive,
  getSheets,
  GSHEET_MIME,
  listVenueFiles,
  readDriveFileAsText,
} from './onboarding/drive'
import {
  assignSampleIds,
  extractTestScenarios,
  parseFixtureCategoryOrder,
  validateUniversalCategories,
} from './onboarding/extract-test-scenarios'
import {
  buildCoverableRows,
  buildVenueContentDigest,
  computeUncoveredRowIds,
  parseMissingInformationItems,
} from './onboarding/generate-scenarios-pure'
import {
  generateAdversarialScenarios,
  generateAllTopicScenarios,
  generateBackfillScenarios,
  generateComplaintScenarios,
  generateEdgeCaseScenarios,
  generateMechanicScenarios,
  generateOwnerTranscriptScenarios,
  generateTopicTaxonomy,
  generateUnansweredProbes,
} from './onboarding/generate-scenarios'
import { assertVenueGuard, loadVenueContext } from './onboarding/load-venue-context'
import { loadExistingSheet, runMerge, writeFullSheet } from './onboarding/merge-scenario-sheet'
import { sanitizeScenarios } from './onboarding/sanitize-scenario-text'
import type { Scenario, ScenarioSource } from './onboarding/scenario-schema'

const SHEET_NAME_PREFIX = '07-'

function parseArgs(argv: string[]): { slug: string } | null {
  const args = argv.slice(2)
  if (args.length !== 1 || args[0].startsWith('--')) return null
  return { slug: args[0] }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv)
  if (!parsed) {
    console.error('Usage: npm run extract-test-scenarios -- <slug>')
    process.exit(1)
  }
  const { slug } = parsed

  const parentFolderId = process.env.GOOGLE_DRIVE_VENUES_FOLDER_ID
  if (!parentFolderId) {
    console.error('Missing env var: GOOGLE_DRIVE_VENUES_FOLDER_ID')
    process.exit(1)
  }

  console.log(`[extract-test-scenarios] loading DB context for "${slug}"...`)
  const ctx = await loadVenueContext(slug)
  assertVenueGuard(ctx)
  console.log(
    `[extract-test-scenarios] venue ${ctx.slug} (id=${ctx.venueId}, is_test=${ctx.isTest}, status=${ctx.status}) — guard passed`,
  )
  console.log(
    `[extract-test-scenarios] DB state: ${ctx.knowledgeRows.filter((r) => r.isProcessed).length} processed knowledge rows, ${ctx.mechanics.filter((m) => m.isActive).length} active mechanics, ${ctx.venueInfo.menu.items.length} menu items`,
  )

  const drive = getDrive()
  const sheets = getSheets()
  const folder = await findVenueFolder(drive, parentFolderId, slug)
  const files = await listVenueFiles(drive, folder.id)

  const specFile = findByPrefix(files, '06-')
  if (!specFile) {
    throw new Error(`[extract-test-scenarios] no 06-${slug}-venue-spec-draft.md found in folder ${folder.name}`)
  }
  const specMarkdown = await readDriveFileAsText(drive, specFile)

  const transcriptFile = findByPrefix(files, '05-')
  const transcriptText = transcriptFile ? await readDriveFileAsText(drive, transcriptFile) : null
  console.log(
    `[extract-test-scenarios] 05 transcript: ${transcriptText ? 'found' : 'not found, skipping owner-reported questions'}`,
  )

  // --- Topic taxonomy ---
  console.log('[extract-test-scenarios] generating topic taxonomy + row mapping...')
  const taxonomy = await generateTopicTaxonomy(ctx, specMarkdown, transcriptText)
  console.log(
    `[extract-test-scenarios] ${taxonomy.topics.length} topics, ${taxonomy.unmappedRows.length} rows unmapped (will be backfilled)`,
  )

  // --- Per-topic graded generation ---
  console.log(
    `[extract-test-scenarios] generating per-topic scenarios (${taxonomy.topics.length} topics, bounded concurrency)...`,
  )
  const topicScenarios = await generateAllTopicScenarios(taxonomy.topics, taxonomy.rowsByTopic)
  console.log(`[extract-test-scenarios] ${topicScenarios.length} venue-topic scenarios`)

  // --- Owner-reported guest questions ---
  let transcriptScenarios: Scenario[] = []
  if (transcriptText) {
    transcriptScenarios = await generateOwnerTranscriptScenarios(
      transcriptText,
      taxonomy.topics.map((t) => t.topic),
    )
    console.log(`[extract-test-scenarios] ${transcriptScenarios.length} owner-transcript scenarios`)
  }

  // Condensed reference of everything the venue's own data covers —
  // grounds route/fact decisions in edge cases, complaints and unanswerable
  // probes against reality instead of a guess.
  const coverableRowsForDigest = buildCoverableRows(ctx)
  const venueDigest = buildVenueContentDigest(coverableRowsForDigest)

  // --- Realistic edge cases ---
  console.log('[extract-test-scenarios] generating realistic edge cases...')
  const edgeCaseScenarios = await generateEdgeCaseScenarios(ctx.slug, venueDigest)
  console.log(`[extract-test-scenarios] ${edgeCaseScenarios.length} edge-case scenarios`)

  // --- Stress and adversarial ---
  console.log('[extract-test-scenarios] generating stress and adversarial scenarios...')
  const adversarialScenarios = await generateAdversarialScenarios(ctx.slug)
  console.log(`[extract-test-scenarios] ${adversarialScenarios.length} adversarial scenarios`)

  // --- Complaints and refunds ---
  console.log('[extract-test-scenarios] generating complaint and refund scenarios...')
  const complaintScenarios = await generateComplaintScenarios(ctx.slug, venueDigest)
  console.log(`[extract-test-scenarios] ${complaintScenarios.length} complaint scenarios`)

  // --- Mechanics ---
  console.log('[extract-test-scenarios] generating mechanic scenarios...')
  const mechanicScenarios = await generateMechanicScenarios(ctx)
  console.log(`[extract-test-scenarios] ${mechanicScenarios.length} mechanic scenarios`)

  // --- Unanswerable probes ---
  console.log('[extract-test-scenarios] generating unanswerable probes...')
  const needsConfirmationItems = parseMissingInformationItems(specMarkdown)
  const { scenarios: unansweredScenarios, dropped: droppedUnanswered } = await generateUnansweredProbes(
    ctx,
    needsConfirmationItems,
    venueDigest,
  )
  console.log(
    `[extract-test-scenarios] ${unansweredScenarios.length} unanswerable scenarios (${droppedUnanswered.length} dropped — DB now answers them)`,
  )
  for (const d of droppedUnanswered) {
    console.log(`    dropped: "${d.message}" — answered by ${d.answeringRowId}`)
  }

  // --- Behavior categories (unchanged mechanism) ---
  console.log('[extract-test-scenarios] generating behavior-category scenarios...')
  const fixturePath = resolve(__dirname, 'onboarding/fixtures/test-scenarios-example.md')
  const fixtureMarkdown = await readFile(fixturePath, 'utf-8')
  const fixtureCategoryOrder = parseFixtureCategoryOrder(fixtureMarkdown)
  const rawBehaviorScenarios = await extractTestScenarios({ slug, fixtureMarkdown, specMarkdown })
  validateUniversalCategories({
    scenarios: rawBehaviorScenarios,
    validCategories: new Set(fixtureCategoryOrder),
  })
  const behaviorScenarios = assignSampleIds(rawBehaviorScenarios, slug, fixtureCategoryOrder)
  console.log(`[extract-test-scenarios] ${behaviorScenarios.length} behavior-category scenarios`)

  let allFresh: Scenario[] = [
    ...topicScenarios,
    ...transcriptScenarios,
    ...edgeCaseScenarios,
    ...adversarialScenarios,
    ...complaintScenarios,
    ...mechanicScenarios,
    ...unansweredScenarios,
    ...behaviorScenarios,
  ]

  // --- Coverage + backfill ---
  const coverableRows = coverableRowsForDigest
  const usedRowIds = new Set(allFresh.flatMap((s) => s.source_row_ids))
  const uncoveredIds = computeUncoveredRowIds(coverableRows, usedRowIds)
  if (uncoveredIds.length > 0) {
    console.log(
      `[extract-test-scenarios] ${uncoveredIds.length} coverable rows have zero scenarios, generating targeted backfill...`,
    )
    const rowById = new Map(coverableRows.map((r) => [r.id, r]))
    const topicForId = (id: string): string => {
      for (const [topic, rows] of taxonomy.rowsByTopic) {
        if (rows.some((r) => r.id === id)) return topic
      }
      return 'uncategorized'
    }
    const uncoveredRows = uncoveredIds.flatMap((id) => {
      const r = rowById.get(id)
      return r ? [r] : []
    })
    const backfillScenarios = await generateBackfillScenarios(uncoveredRows, topicForId)
    allFresh = [...allFresh, ...backfillScenarios]
    console.log(`[extract-test-scenarios] ${backfillScenarios.length} backfill scenarios added`)
  }

  const finalUsedRowIds = new Set(allFresh.flatMap((s) => s.source_row_ids))
  const finalUncovered = computeUncoveredRowIds(coverableRows, finalUsedRowIds)

  // --- Sanitize (em/en dash safety net) ---
  const { scenarios: sanitized, dashHitCount } = sanitizeScenarios(allFresh)
  allFresh = sanitized
  console.log(`[extract-test-scenarios] sanitizer fixed ${dashHitCount} scenario(s) that emitted a long dash`)

  // --- Sheet resolve + merge + write ---
  const sheetName = `${SHEET_NAME_PREFIX}${slug}-test-scenarios`
  // Filter to actual spreadsheets before prefix-matching: a stale non-sheet
  // file sharing the 07- prefix (e.g. a leftover 07-*.json from before this
  // redesign) must never be mistaken for the scenarios sheet — the Sheets
  // API rejects values.get/update against a non-spreadsheet fileId outright.
  const existingSheetFile = findByPrefix(
    files.filter((f) => f.mimeType === GSHEET_MIME),
    SHEET_NAME_PREFIX,
  )
  const spreadsheetId = existingSheetFile
    ? existingSheetFile.id
    : await createMultiTabSheet(drive, sheets, folder.id, sheetName, ['Topics', 'Scenarios', '_meta'])
  console.log(
    `[extract-test-scenarios] ${existingSheetFile ? 'regenerating into existing' : 'created new'} sheet ${spreadsheetId}`,
  )

  const existing = existingSheetFile ? await loadExistingSheet(sheets, spreadsheetId) : null
  if (existing) {
    console.log(
      `[extract-test-scenarios] existing sheet: ${existing.currentRows.length} rows, ${existing.metaEntries.length} meta entries`,
    )
  }

  const { finalRows, allMetaEntries, mergeStats, dedupReport } = await runMerge({
    freshScenarios: allFresh,
    existing,
  })
  console.log(
    `[extract-test-scenarios] merge: kept ${mergeStats.keptOwner} owner rows, kept ${mergeStats.keptEdited} edited rows, replaced ${mergeStats.replaced} untouched rows, inserted ${mergeStats.inserted} fresh rows`,
  )
  if (mergeStats.dedupedSampleIds.length > 0) {
    console.warn(
      `[extract-test-scenarios] resolved ${mergeStats.dedupedSampleIds.length} same-id collision(s) (the "false kept as edited" bug class, TAC-347): ${mergeStats.dedupedSampleIds.join(', ')}`,
    )
  }
  if (dedupReport.droppedCount > 0) {
    console.log(
      `[extract-test-scenarios] tombstone dedup dropped ${dedupReport.droppedCount} near-duplicate(s) of owner-deleted scenarios:`,
    )
    for (const d of dedupReport.dropped) {
      console.log(`    dropped: "${d.message}" (topic=${d.topic}) — matches deleted ${d.matchedTombstoneId}`)
    }
  }

  const topicsTabRows: string[][] = [
    ['topic', 'label', 'subtopics', 'source_row_ids'],
    ...taxonomy.topics.map((t) => [
      t.topic,
      t.label,
      t.subtopics.join('; '),
      (taxonomy.rowsByTopic.get(t.topic) ?? []).map((r) => r.id).join('; '),
    ]),
  ]

  await writeFullSheet(sheets, { spreadsheetId, finalRows, topicsTabRows, allMetaEntries })
  console.log(`[extract-test-scenarios] wrote ${finalRows.length} scenario rows, ${taxonomy.topics.length} topics`)

  // --- Report ---
  const countsBySource: Partial<Record<ScenarioSource, number>> = {}
  const countsByMode: Record<'graded' | 'exploratory', number> = { graded: 0, exploratory: 0 }
  for (const r of finalRows) {
    countsBySource[r.scenario_source] = (countsBySource[r.scenario_source] ?? 0) + 1
    countsByMode[r.mode] += 1
  }

  console.log(`\n[extract-test-scenarios] === ${slug} summary ===`)
  console.log(`  total scenarios: ${finalRows.length}`)
  console.log(`  by source:`)
  for (const [source, count] of Object.entries(countsBySource)) {
    console.log(`    ${source}: ${count}`)
  }
  console.log(`  by mode: graded=${countsByMode.graded} exploratory=${countsByMode.exploratory}`)
  console.log(`  topics: ${taxonomy.topics.length}`)
  console.log(`  coverage gaps remaining after backfill: ${finalUncovered.length}`)
  console.log(`  sheet: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`)
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e))
  process.exit(1)
})
