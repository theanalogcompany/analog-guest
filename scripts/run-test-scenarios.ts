import { createAdminClient } from '@/lib/db/admin'
import {
  findByPrefix,
  findVenueFolder,
  getDrive,
  listVenueFiles,
  readDriveFileAsText,
  writeSheetFile,
} from './onboarding/drive'
import {
  buildCsv,
  type RowOutput,
  runScenario,
  seedSyntheticGuests,
  TestScenariosFileSchema,
} from './onboarding/run-test-scenarios'

interface ParsedArgs {
  slug: string
  force: boolean
}

function parseArgs(argv: string[]): ParsedArgs | null {
  const args = argv.slice(2)
  let slug: string | null = null
  let force = false
  for (const a of args) {
    if (a === '--force') {
      force = true
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
  return { slug, force }
}

async function resolveVenueId(slug: string): Promise<string> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('venues')
    .select('id')
    .eq('slug', slug)
    .maybeSingle()
  if (error) {
    throw new Error(`[run-test-scenarios] venue lookup failed for slug "${slug}": ${error.message}`)
  }
  if (!data) {
    throw new Error(
      `[run-test-scenarios] venue not found for slug "${slug}". Run npm run seed-venue -- ${slug} first.`,
    )
  }
  return data.id
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv)
  if (!parsed) {
    console.error('Usage: npm run run-test-scenarios -- <slug> [--force]')
    process.exit(1)
  }
  const { slug, force } = parsed

  const parentFolderId = process.env.GOOGLE_DRIVE_VENUES_FOLDER_ID
  if (!parentFolderId) {
    console.error('Missing env var: GOOGLE_DRIVE_VENUES_FOLDER_ID')
    process.exit(1)
  }

  const drive = getDrive()
  console.log(`[run-test-scenarios] looking up venue folder for "${slug}"...`)
  const folder = await findVenueFolder(drive, parentFolderId, slug)
  console.log(`[run-test-scenarios] folder: ${folder.name} (${folder.id})`)

  const files = await listVenueFiles(drive, folder.id)
  console.log(`[run-test-scenarios] folder has ${files.length} files`)

  // Existence guard before any expensive work.
  const existing = findByPrefix(files, '08-')
  const outName = `08-${slug}-response-review`
  if (existing) {
    if (!force) {
      console.error(
        `[run-test-scenarios] ${existing.name} already exists in folder. Pass --force to overwrite.`,
      )
      process.exit(1)
    }
    console.log(`[run-test-scenarios] overwriting existing ${existing.name}`)
  }

  // Read 07-file.
  const scenarioFile = findByPrefix(files, '07-')
  if (!scenarioFile) {
    throw new Error(
      `[run-test-scenarios] no 07-${slug}-test-scenarios.json found in folder ${folder.name}. Run npm run extract-test-scenarios -- ${slug} first.`,
    )
  }
  console.log(`[run-test-scenarios] reading scenarios: ${scenarioFile.name}`)
  const scenarioRaw = await readDriveFileAsText(drive, scenarioFile)
  let parsedScenarios
  try {
    parsedScenarios = TestScenariosFileSchema.parse(JSON.parse(scenarioRaw))
  } catch (e) {
    throw new Error(
      `[run-test-scenarios] 07-file failed schema validation: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  const scenarios = parsedScenarios.scenarios
  console.log(`[run-test-scenarios] read scenarios: ${scenarios.length}`)

  // Resolve venue + seed synthetic guests.
  const venueId = await resolveVenueId(slug)
  console.log(`[run-test-scenarios] seeding synthetic guests at venue ${venueId}...`)
  const { guestIdsByState, outcomes } = await seedSyntheticGuests(venueId)
  for (const o of outcomes) {
    const mark = o.matched ? '✓' : '✗ MISMATCH'
    console.log(
      `[run-test-scenarios] seeded synthetic guest: ${o.state.padEnd(11)} ${o.phone}  guestId=${o.guestId}  score=${o.computedScore}  state=${o.computedState}  ${mark}`,
    )
  }
  const mismatches = outcomes.filter((o) => !o.matched)
  if (mismatches.length > 0) {
    throw new Error(
      `[run-test-scenarios] synthetic guest tuning failed for: ${mismatches.map((m) => `${m.state} (got ${m.computedState}, score ${m.computedScore})`).join('; ')}. Adjust seed values in seedSignalsForState and rerun.`,
    )
  }

  // Run scenarios sequentially.
  const rows: RowOutput[] = []
  let errorCount = 0
  for (const scenario of scenarios) {
    const guestId = guestIdsByState[scenario.guest_state]
    const start = Date.now()
    const row = await runScenario({ scenario, venueId, guestId })
    const elapsedMs = Date.now() - start
    rows.push(row)
    if (row.generated_message === '<ERROR>') errorCount++
    const fidelityStr = row.voice_fidelity === null ? 'null' : row.voice_fidelity.toFixed(2)
    console.log(
      `[run-test-scenarios] ${scenario.sample_id} (${scenario.category}, ${scenario.guest_state}): generated in ${elapsedMs}ms, fidelity ${fidelityStr}`,
    )
  }

  // Assemble CSV + upload as native gsheet.
  const csv = buildCsv(rows)
  console.log(`[run-test-scenarios] writing ${outName} to Drive...`)
  const writeResult = await writeSheetFile(drive, folder.id, outName, csv)
  console.log(
    `[run-test-scenarios] ${writeResult.created ? 'created' : 'updated'} ${outName} (id=${writeResult.id})`,
  )
  console.log(`[run-test-scenarios] ${slug}`)
  console.log(`  read scenarios: ${scenarios.length}`)
  console.log(`  ran: ${rows.length}`)
  console.log(`  errors: ${errorCount}`)
  console.log(`  wrote: ${outName}`)
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e))
  process.exit(1)
})