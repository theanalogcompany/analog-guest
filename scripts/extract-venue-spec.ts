import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
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

async function main(): Promise<void> {
  const slug = process.argv[2]
  if (!slug) {
    console.error('Usage: npm run extract-venue-spec -- <slug>')
    process.exit(1)
  }
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
  console.log(`[extract] writing ${outName} to Drive (overwrite if exists)...`)
  const writeResult = await writeMarkdownFile(drive, folder.id, outName, draftMarkdown)
  console.log(`[extract] ✓ ${writeResult.created ? 'created' : 'updated'} ${outName} (id=${writeResult.id})`)
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e))
  process.exit(1)
})