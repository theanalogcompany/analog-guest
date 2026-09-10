import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getAirtableRecord } from './onboarding/airtable'
import {
  findByPrefix,
  findVenueFolder,
  getDrive,
  listVenueFiles,
  readDriveFileAsText,
  writeMarkdownFile,
} from './onboarding/drive'
import { extractVenueSpec } from './onboarding/extract'

interface ParsedArgs {
  slug: string
  dryRun: boolean
}

function parseArgs(argv: string[]): ParsedArgs | null {
  const args = argv.slice(2)
  let slug: string | null = null
  let dryRun = false
  for (const a of args) {
    if (a === '--dry-run') {
      dryRun = true
    } else if (a.startsWith('--')) {
      console.error(`[extract] unknown flag: ${a}`)
      return null
    } else if (!slug) {
      slug = a
    } else {
      console.error(`[extract] unexpected positional arg: ${a}`)
      return null
    }
  }
  if (!slug) return null
  return { slug, dryRun }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv)
  if (!parsed) {
    console.error('Usage: npm run extract-venue-spec -- <slug> [--dry-run]')
    process.exit(1)
  }
  const { slug, dryRun } = parsed

  const parentFolderId = process.env.GOOGLE_DRIVE_VENUES_FOLDER_ID
  if (!parentFolderId) {
    console.error('Missing env var: GOOGLE_DRIVE_VENUES_FOLDER_ID')
    process.exit(1)
  }

  const drive = getDrive()
  console.log(`[extract] looking up venue folder for "${slug}"...`)
  const folder = await findVenueFolder(drive, parentFolderId, slug)
  console.log(`[extract] folder: ${folder.name} (${folder.id})`)

  const files = await listVenueFiles(drive, folder.id)
  console.log(`[extract] folder has ${files.length} files`)

  // 05- = transcript (md)
  const transcriptFile = findByPrefix(files, '05-')
  if (!transcriptFile) {
    console.error(`[extract] no file with prefix "05-" found in folder; need a transcript`)
    process.exit(1)
  }
  console.log(`[extract] reading transcript: ${transcriptFile.name}`)
  const transcript = await readDriveFileAsText(drive, transcriptFile)

  // 04- = menu (gsheet, exported as CSV)
  const menuFile = findByPrefix(files, '04-')
  let menuCsv: string | null = null
  if (menuFile) {
    console.log(`[extract] reading menu: ${menuFile.name}`)
    menuCsv = await readDriveFileAsText(drive, menuFile)
  } else {
    console.warn(`[extract] no file with prefix "04-" found; menu will be omitted`)
  }

  console.log(`[extract] fetching Airtable record for "${slug}"...`)
  const airtableRecord = await getAirtableRecord(slug)
  console.log(`[extract] airtable record id: ${airtableRecord.id}`)

  const fixturePath = resolve(__dirname, 'onboarding/fixtures/venue-spec-example.md')
  const fixtureMarkdown = await readFile(fixturePath, 'utf-8')

  console.log(`[extract] calling Claude (model: claude-sonnet-4-6)...`)
  const draftMarkdown = await extractVenueSpec({
    slug,
    transcript,
    menuCsv,
    airtableFields: airtableRecord.fields,
    fixtureMarkdown,
  })
  console.log(`[extract] received ${draftMarkdown.length} chars`)

  const outName = `06-${slug}-venue-spec-draft.md`

  if (dryRun) {
    const outPath = join(tmpdir(), `${outName}.dry-run.md`)
    await writeFile(outPath, draftMarkdown, 'utf-8')
    console.log(`[extract] --dry-run: skipped Drive write`)
    console.log(`[extract] draft saved to ${outPath}`)
    return
  }

  console.log(`[extract] writing ${outName} to Drive (overwrite if exists)...`)
  const writeResult = await writeMarkdownFile(drive, folder.id, outName, draftMarkdown)
  console.log(`[extract] ✓ ${writeResult.created ? 'created' : 'updated'} ${outName} (id=${writeResult.id})`)
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e))
  process.exit(1)
})