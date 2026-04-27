import {
  findByPrefix,
  findVenueFolder,
  getDrive,
  listVenueFiles,
  readDriveFileAsText,
} from './onboarding/drive'
import { parseVenueSpec } from './onboarding/parse-venue-spec'
import { seedVenue } from './onboarding/seed-supabase'

async function main(): Promise<void> {
  const slug = process.argv[2]
  if (!slug) {
    console.error('Usage: npm run seed-venue -- <slug> [--messaging-phone <e164>]')
    process.exit(1)
  }

  // Optional --messaging-phone <number> flag.
  let messagingPhoneNumber: string | null = null
  const phoneFlagIdx = process.argv.indexOf('--messaging-phone')
  if (phoneFlagIdx !== -1 && process.argv[phoneFlagIdx + 1]) {
    messagingPhoneNumber = process.argv[phoneFlagIdx + 1]
  }

  const parentFolderId = process.env.GOOGLE_DRIVE_VENUES_FOLDER_ID
  if (!parentFolderId) {
    console.error('Missing env var: GOOGLE_DRIVE_VENUES_FOLDER_ID')
    process.exit(1)
  }

  const drive = getDrive()
  console.log(`[seed] looking up venue folder for "${slug}"...`)
  const folder = await findVenueFolder(drive, parentFolderId, slug)
  console.log(`[seed] folder: ${folder.name} (${folder.id})`)

  const files = await listVenueFiles(drive, folder.id)
  const draftFile = findByPrefix(files, '06-')
  if (!draftFile) {
    console.error(`[seed] no file with prefix "06-" found in folder; run extract-venue-spec first`)
    process.exit(1)
  }
  console.log(`[seed] reading draft: ${draftFile.name}`)
  const draftMarkdown = await readDriveFileAsText(drive, draftFile)

  console.log(`[seed] parsing draft...`)
  const parsed = parseVenueSpec(draftMarkdown)
  console.log(
    `[seed] parsed: ${parsed.mechanics.length} mechanics, ${parsed.voiceCorpus.length} corpus entries`,
  )

  console.log(`[seed] writing to Supabase...`)
  const result = await seedVenue({ parsed, messagingPhoneNumber })

  const totalEmbedded = result.embeddedChunkCounts.reduce((a, b) => a + b, 0)
  console.log(`[seed] ✓ venue ${result.venueId} seeded`)
  console.log(`[seed]   slug: ${parsed.slug}`)
  console.log(`[seed]   messaging_phone_number: ${messagingPhoneNumber ?? '(null)'}`)
  console.log(`[seed]   mechanics inserted: ${result.mechanicsInsertedCount}`)
  console.log(`[seed]   corpus rows inserted: ${result.insertedCorpusIds.length}`)
  console.log(`[seed]   total embedded chunks: ${totalEmbedded}`)
  console.log(`[seed] note: status='pending', is_test=true. Flip to 'active' manually after spot-check.`)
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e))
  process.exit(1)
})