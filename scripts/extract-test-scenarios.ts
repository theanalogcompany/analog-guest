import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  findByPrefix,
  findVenueFolder,
  getDrive,
  listVenueFiles,
  readDriveFileAsText,
  writeJsonFile,
} from './onboarding/drive'
import {
  assignSampleIds,
  extractMechanicNames,
  extractTestScenarios,
  parseFixtureCategoryOrder,
  validateMechanicsCategoriesAreReal,
  validateMechanicsCoverage,
  validateUniversalCategories,
} from './onboarding/extract-test-scenarios'

const PROMPT_VERSION = 'extract-test-scenarios-v2'

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
      console.error(`[extract-test-scenarios] unknown flag: ${a}`)
      return null
    } else if (!slug) {
      slug = a
    } else {
      console.error(`[extract-test-scenarios] unexpected positional arg: ${a}`)
      return null
    }
  }
  if (!slug) return null
  return { slug, force }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv)
  if (!parsed) {
    console.error('Usage: npm run extract-test-scenarios -- <slug> [--force]')
    process.exit(1)
  }
  const { slug, force } = parsed

  const parentFolderId = process.env.GOOGLE_DRIVE_VENUES_FOLDER_ID
  if (!parentFolderId) {
    console.error('Missing env var: GOOGLE_DRIVE_VENUES_FOLDER_ID')
    process.exit(1)
  }

  const drive = getDrive()
  console.log(`[extract-test-scenarios] looking up venue folder for "${slug}"...`)
  const folder = await findVenueFolder(drive, parentFolderId, slug)
  console.log(`[extract-test-scenarios] folder: ${folder.name} (${folder.id})`)

  const files = await listVenueFiles(drive, folder.id)
  console.log(`[extract-test-scenarios] folder has ${files.length} files`)

  // Existence guard before any expensive work (LLM call, etc.).
  const existing = findByPrefix(files, '07-')
  const outName = `07-${slug}-test-scenarios.json`
  if (existing) {
    if (!force) {
      console.error(
        `[extract-test-scenarios] ${existing.name} already exists in folder. Pass --force to overwrite.`,
      )
      process.exit(1)
    }
    console.log(`[extract-test-scenarios] overwriting existing ${existing.name}`)
  }

  const specFile = findByPrefix(files, '06-')
  if (!specFile) {
    throw new Error(
      `[extract-test-scenarios] no 06-${slug}-venue-spec-draft.md found in folder ${folder.name}`,
    )
  }
  console.log(`[extract-test-scenarios] reading spec: ${specFile.name}`)
  const specMarkdown = await readDriveFileAsText(drive, specFile)

  const fixturePath = resolve(__dirname, 'onboarding/fixtures/test-scenarios-example.md')
  const fixtureMarkdown = await readFile(fixturePath, 'utf-8')

  const expectedMechanics = extractMechanicNames(specMarkdown)
  console.log(`[extract-test-scenarios] expected mechanics: ${expectedMechanics.size}`)

  const fixtureCategoryOrder = parseFixtureCategoryOrder(fixtureMarkdown)
  const validUniversalCategories = new Set(fixtureCategoryOrder)

  console.log(`[extract-test-scenarios] calling Claude (model: claude-sonnet-4-6)...`)
  const rawScenarios = await extractTestScenarios({ slug, fixtureMarkdown, specMarkdown })
  console.log(`[extract-test-scenarios] received ${rawScenarios.length} scenarios`)

  validateUniversalCategories({
    scenarios: rawScenarios,
    validCategories: validUniversalCategories,
  })
  // Forward + reverse mechanics validation run together as a pair.
  validateMechanicsCoverage({ scenarios: rawScenarios, expectedMechanics })
  validateMechanicsCategoriesAreReal({ scenarios: rawScenarios, expectedMechanics })

  const scenarios = assignSampleIds(rawScenarios, slug, fixtureCategoryOrder)

  const universalCount = scenarios.filter((s) => !s.is_mechanic_derived).length
  const mechanicCount = scenarios.filter((s) => s.is_mechanic_derived).length
  const expectedFailureCount = scenarios.filter((s) => s.expected_failure !== null).length

  const output = {
    slug,
    generated_at: new Date().toISOString(),
    prompt_version: PROMPT_VERSION,
    scenarios,
  }

  console.log(`[extract-test-scenarios] writing ${outName} to Drive (overwrite if exists)...`)
  const writeResult = await writeJsonFile(drive, folder.id, outName, output)
  console.log(
    `[extract-test-scenarios] ${writeResult.created ? 'created' : 'updated'} ${outName} (id=${writeResult.id})`,
  )
  console.log(`[extract-test-scenarios] ${slug}`)
  console.log(`  universal scenarios: ${universalCount}`)
  console.log(`  mechanic-derived scenarios: ${mechanicCount}`)
  console.log(`  expected_failure rows: ${expectedFailureCount}`)
  console.log(`  total: ${scenarios.length}`)
  console.log(`  wrote: ${outName}`)
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e))
  process.exit(1)
})