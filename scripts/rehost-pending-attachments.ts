// TAC-582: copy every attachment still marked `pending` into the guest-media
// bucket. Run by hand.
//
// WHY THIS EXISTS. The webhook re-hosts a guest's photo inside waitUntil, after
// it has answered. If that function dies mid-download the row stays `pending`
// and nothing retries it: there is no sweep. This is the retry. It is also how
// the rows migration 080 backfilled from `messages.media_urls` get their files,
// since those were written `pending` with a kind of `unknown` and no webhook
// will ever run for them.
//
// RUN IT SOON AFTER THE ROWS APPEAR. Instagram's links are signed and expire.
// A link that has expired settles as `failed` with `download_status`, which is
// the true answer and is not recoverable from here.
//
// SAFE TO RUN TWICE, and safe beside a live webhook: every status write is
// guarded on `status = 'pending'` (lib/messaging/attachments/rehost.ts), so a
// row another run settled first is reported as `skipped` and left alone.
//
// Usage:
//   npm run rehost-pending-attachments -- --dry-run    list them, change nothing
//   npm run rehost-pending-attachments                 re-host up to 200
//   npm run rehost-pending-attachments -- --limit=20

import { createAdminClient } from '@/lib/db/admin'
import {
  rehostAttachment,
  touchParentMessage,
} from '@/lib/messaging/attachments/rehost'
import { loadPendingAttachments } from '@/lib/messaging/attachments/store'

const DEFAULT_LIMIT = 200

function parseLimit(args: readonly string[]): number {
  const arg = args.find((a) => a.startsWith('--limit='))
  if (!arg) return DEFAULT_LIMIT
  const value = Number(arg.slice('--limit='.length))
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--limit must be a positive integer, got "${arg}"`)
  }
  return value
}

function hostOf(url: string | null): string {
  if (url === null) return '(no link)'
  try {
    return new URL(url).hostname
  } catch {
    return '(unparseable)'
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const limit = parseLimit(args)
  const supabase = createAdminClient()

  const pending = await loadPendingAttachments(supabase, limit)
  if (!pending.ok)
    throw new Error(`could not load pending rows: ${pending.error}`)

  console.log(`${pending.data.length} pending attachment(s)`)
  for (const row of pending.data) {
    console.log(
      `  ${row.id}  ${row.kind.padEnd(8)}  ${row.createdAt}  ${hostOf(row.providerUrl)}`,
    )
  }
  if (dryRun) {
    console.log('\n--dry-run: nothing changed.')
    return
  }
  if (pending.data.length === 0) return

  const touched = new Set<string>()
  const counts = { ready: 0, failed: 0, skipped: 0 }
  console.log('')
  for (const row of pending.data) {
    const outcome = await rehostAttachment(supabase, row)
    counts[outcome.status] += 1
    if (outcome.status === 'ready') {
      console.log(
        `  READY    ${row.id}  ${outcome.kind}  ${outcome.bytes} bytes`,
      )
    } else if (outcome.status === 'failed') {
      console.log(`  FAILED   ${row.id}  ${outcome.reason}`)
    } else {
      console.log(`  SKIPPED  ${row.id}  settled by another run`)
    }
    if (outcome.status !== 'skipped') touched.add(row.messageId)
  }
  for (const messageId of touched) await touchParentMessage(supabase, messageId)

  console.log(
    `\nready=${counts.ready} failed=${counts.failed} skipped=${counts.skipped}`,
  )
  // A failure is a result, not a crash: the rows say why. Exit non-zero only
  // so a caller scripting this notices that not everything was recovered.
  if (counts.failed > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
