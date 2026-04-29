import { createAdminClient } from '@/lib/db/admin'
import {
  findByPrefix,
  findVenueFolder,
  getDrive,
  listVenueFiles,
  readDriveFileAsText,
  writeMarkdownFile,
} from './onboarding/drive'
import {
  appendPhase5Section,
  buildPhase5Subsection,
  classifyRow,
  type CorpusEntrySummary,
  dedupeAndAppendAntiPatterns,
  parseReviewSheet,
  rulePayloadFromComment,
  upsertCorpusEdit,
} from './onboarding/ingest-response-review'

interface ParsedArgs {
  slug: string
}

function parseArgs(argv: string[]): ParsedArgs | null {
  const args = argv.slice(2)
  let slug: string | null = null
  for (const a of args) {
    if (a.startsWith('--')) {
      console.error(`[ingest-response-review] unknown flag: ${a}`)
      return null
    }
    if (!slug) {
      slug = a
    } else {
      console.error(`[ingest-response-review] unexpected positional arg: ${a}`)
      return null
    }
  }
  if (!slug) return null
  return { slug }
}

async function resolveVenueId(slug: string): Promise<string> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('venues')
    .select('id')
    .eq('slug', slug)
    .maybeSingle()
  if (error) {
    throw new Error(`[ingest-response-review] venue lookup failed for "${slug}": ${error.message}`)
  }
  if (!data) {
    throw new Error(
      `[ingest-response-review] venue not found for slug "${slug}". Run npm run seed-venue -- ${slug} first.`,
    )
  }
  return data.id
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv)
  if (!parsed) {
    console.error('Usage: npm run ingest-response-review -- <slug>')
    process.exit(1)
  }
  const { slug } = parsed

  const parentFolderId = process.env.GOOGLE_DRIVE_VENUES_FOLDER_ID
  if (!parentFolderId) {
    console.error('Missing env var: GOOGLE_DRIVE_VENUES_FOLDER_ID')
    process.exit(1)
  }

  const drive = getDrive()
  console.log(`[ingest-response-review] looking up venue folder for "${slug}"...`)
  const folder = await findVenueFolder(drive, parentFolderId, slug)
  console.log(`[ingest-response-review] folder: ${folder.name} (${folder.id})`)

  const files = await listVenueFiles(drive, folder.id)

  // Read 08-response-review (gsheet → CSV via Drive export).
  const sheetFile = findByPrefix(files, '08-')
  if (!sheetFile) {
    throw new Error(
      `[ingest-response-review] no 08-${slug}-response-review found in folder ${folder.name}. Run npm run run-test-scenarios -- ${slug} first.`,
    )
  }
  console.log(`[ingest-response-review] reading review sheet: ${sheetFile.name}`)
  const sheetCsv = await readDriveFileAsText(drive, sheetFile)
  const rows = parseReviewSheet(sheetCsv)
  console.log(`[ingest-response-review] parsed ${rows.length} data rows`)

  // Read 06-venue-spec-draft.md ahead of any DB writes — if it's missing,
  // bail before changing state, so DB and markdown don't split.
  const specFile = findByPrefix(files, '06-')
  if (!specFile) {
    throw new Error(
      `[ingest-response-review] no 06-${slug}-venue-spec-draft.md in folder ${folder.name}. Cannot append phase-5 review additions without the spec draft.`,
    )
  }
  console.log(`[ingest-response-review] reading spec draft: ${specFile.name}`)
  const existingSpec = await readDriveFileAsText(drive, specFile)

  const venueId = await resolveVenueId(slug)
  console.log(`[ingest-response-review] venue id: ${venueId}`)

  // Per-row processing.
  const newCorpusEntries: CorpusEntrySummary[] = []
  const candidateRules: string[] = []
  const embedFailures: Array<{ corpusId: string; sample_id: string; category: string }> = []
  let approveCount = 0
  let expectedFailureCount = 0
  let corpusInsertedCount = 0
  let corpusExistingCount = 0

  for (const row of rows) {
    const kind = classifyRow(row)
    if (kind === 'approve') {
      approveCount++
      console.log(`[ingest-response-review] ${row.sample_id}: skipped (approve)`)
      continue
    }
    if (kind === 'expected_failure') {
      expectedFailureCount++
      console.log(
        `[ingest-response-review] ${row.sample_id}: skipped (${row.comment.trim()})`,
      )
      continue
    }

    if (kind === 'edit' || kind === 'edit_and_rule') {
      if (row.edited_message.trim().length === 0) {
        throw new Error(
          `[ingest-response-review] ${row.sample_id}: verdict=edit but edited_message is empty. Operator must fill the edited_message cell or change verdict to approve.`,
        )
      }
      const result = await upsertCorpusEdit(venueId, row)
      if (result.inserted) {
        corpusInsertedCount++
        if (result.embedFailed) {
          embedFailures.push({
            corpusId: result.corpusId,
            sample_id: row.sample_id,
            category: row.category,
          })
        }
        newCorpusEntries.push({
          sample_id: row.sample_id,
          category: row.category,
          inbound_message: row.inbound_message,
          generated_message: row.generated_message,
          edited_message: row.edited_message,
        })
      } else {
        corpusExistingCount++
      }
    }

    if (kind === 'rule' || kind === 'edit_and_rule') {
      candidateRules.push(rulePayloadFromComment(row.comment))
    }

    const tag =
      kind === 'edit_and_rule'
        ? 'ingested edit + added rule'
        : kind === 'edit'
          ? 'ingested edit'
          : 'added rule'
    console.log(`[ingest-response-review] ${row.sample_id}: ${tag}`)
  }

  // One read-modify-write for anti-patterns.
  const apResult = await dedupeAndAppendAntiPatterns(venueId, candidateRules)

  // Markdown append: skip entirely if zero net new ingestions.
  const netNewCorpus = newCorpusEntries.length
  const netNewAntiPatterns = apResult.added.length
  let markdownStatus: string
  if (netNewCorpus === 0 && netNewAntiPatterns === 0) {
    markdownStatus = 'no — skipped because no new ingestions'
  } else {
    const subsection = buildPhase5Subsection({
      timestampIso: new Date().toISOString(),
      newAntiPatterns: apResult.added,
      newCorpusEntries,
      sourceFileName: sheetFile.name,
    })
    const { newMarkdown, alreadyHadSection } = appendPhase5Section(existingSpec, subsection)
    try {
      await writeMarkdownFile(drive, folder.id, specFile.name, newMarkdown)
      markdownStatus = alreadyHadSection ? 'yes (appended subsection)' : 'yes (new section)'
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.error(
        `[ingest-response-review] DRIVE WRITE FAILED for ${specFile.name}: ${errMsg}`,
      )
      console.error(
        `[ingest-response-review] DB state is updated. Markdown is OUT OF SYNC. Manually paste the following into ${specFile.name}, OR re-run after fixing the Drive issue (re-run is safe — DB upserts are no-ops, but a fresh subsection will be appended).`,
      )
      console.error('--- BEGIN UNAPPENDED MARKDOWN SUBSECTION ---')
      console.error(subsection)
      console.error('--- END UNAPPENDED MARKDOWN SUBSECTION ---')
      throw e
    }
  }

  // Final summary log.
  console.log(`[ingest-response-review] ${slug}`)
  console.log(`  gsheet rows: ${rows.length}`)
  console.log(`  skipped (approve): ${approveCount}`)
  console.log(`  skipped (expected_failure): ${expectedFailureCount}`)
  console.log(
    `  corpus rows added: ${corpusInsertedCount + corpusExistingCount}  (existing: ${corpusExistingCount}, new: ${corpusInsertedCount})`,
  )
  console.log(
    `  anti-patterns added: ${apResult.existing.length + apResult.added.length}  (existing in voiceAntiPatterns: ${apResult.existing.length}, new: ${apResult.added.length})`,
  )
  console.log(`  markdown updated: ${markdownStatus}`)
  if (embedFailures.length > 0) {
    console.warn(
      `[ingest-response-review] WARNING: ${embedFailures.length} corpus rows inserted but embedding failed:`,
    )
    for (const f of embedFailures) {
      console.warn(`  - voice_corpus.id = ${f.corpusId} (sample_id ${f.sample_id}, category ${f.category})`)
    }
    console.warn(
      `These rows have no embeddings and won't be retrieved by RAG. To recover: delete these rows in Supabase Studio and re-run.`,
    )
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e))
  process.exit(1)
})