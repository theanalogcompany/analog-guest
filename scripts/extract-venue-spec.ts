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
import { parseArgs, shouldRefuseOverwrite } from './onboarding/extract-venue-spec-args'
import { countVoiceCorpusEntries, formatNeedsConfirmationSection, runVerification } from './onboarding/verify'

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv)
  if (!parsed) {
    console.error('Usage: npm run extract-venue-spec -- <slug> [--dry-run] [--force] [--interview-date YYYY-MM-DD]')
    process.exit(1)
  }
  const { slug, dryRun, force, interviewDate } = parsed

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

  // TAC-346 overwrite guard, mirroring seed-venue's hard-refuse-on-existing
  // pattern. Skipped for --dry-run: that flag's whole point (documented in
  // CLAUDE.md) is testing an extraction against a venue that already has a
  // live 06-file without touching it, so it never writes to the real
  // location this guard protects.
  const existing06 = findByPrefix(files, '06-')
  if (existing06 !== null && shouldRefuseOverwrite(true, dryRun, force)) {
    console.error(
      `[extract] ${existing06.name} already exists in the venue folder — refusing to overwrite an operator's reviewed spec.`,
    )
    console.error('[extract] pass --force to overwrite anyway, or back up/resolve the existing file first.')
    process.exit(1)
  }

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
    ...(interviewDate ? { interviewDate } : {}),
  })
  console.log(`[extract] received ${draftMarkdown.length} chars`)

  console.log(`[extract] running verification pass...`)
  let verifyResult
  try {
    verifyResult = await runVerification({
      slug,
      transcript,
      menuCsv,
      airtableFields: airtableRecord.fields,
      draftMarkdown,
      ...(interviewDate ? { interviewDate } : {}),
    })
  } catch (e: unknown) {
    // TAC-346 change #3: verify failure aborts cleanly. Write nothing
    // anywhere (Drive or the --dry-run tmp file) and leave an existing 06
    // untouched — every 06 that lands in Drive must have passed
    // verification, with no partially-verified draft ever written.
    console.error(
      `[extract] verification pass FAILED after retry: ${e instanceof Error ? e.message : String(e)}`,
    )
    console.error('[extract] refusing to write — nothing was written to Drive or disk.')
    process.exit(1)
  }
  console.log(
    `[extract] verify: ${verifyResult.unsupportedClaims.length} unsupported claims, ` +
      `${verifyResult.uncoveredAnswers.length} uncovered answers, ${verifyResult.missingInformation.length} missing info, ` +
      `${verifyResult.resolvedDates.length} dates, ${verifyResult.mechanicApprovalReview.length} mechanics reviewed`,
  )

  const voiceCorpusCount = countVoiceCorpusEntries(draftMarkdown)
  const needsConfirmationSection = formatNeedsConfirmationSection(verifyResult, voiceCorpusCount)
  const finalMarkdown = `${draftMarkdown}\n\n---\n\n${needsConfirmationSection}\n`

  const outName = `06-${slug}-venue-spec-draft.md`

  if (dryRun) {
    const outPath = join(tmpdir(), `${outName}.dry-run.md`)
    await writeFile(outPath, finalMarkdown, 'utf-8')
    console.log(`[extract] --dry-run: skipped Drive write`)
    console.log(`[extract] draft saved to ${outPath}`)
    return
  }

  console.log(`[extract] writing ${outName} to Drive...`)
  const writeResult = await writeMarkdownFile(drive, folder.id, outName, finalMarkdown)
  console.log(`[extract] ✓ ${writeResult.created ? 'created' : 'updated'} ${outName} (id=${writeResult.id})`)
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e))
  process.exit(1)
})
