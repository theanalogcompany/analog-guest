// Issue a scan code for a Square payment and print its ig.me link.
//
//   npm run pos-scan-code -- --venue <venueId> --payment <squarePaymentId>
//   npm run pos-scan-code -- --venue <venueId> --latest
//
// Without `--printer` THIS STANDS IN FOR THE PRINTER: it prints the URL to a
// terminal and you point a phone's camera at a QR you generate from it (or
// just open the link on the phone). With `--printer <host[:port]>` it sends
// the QR to a LAN ESC/POS receipt printer (raw TCP, port 9100 by default), so
// run it from a machine on the printer's network. Everything after the scan is
// the production path.
//
//   npm run pos-scan-code -- --venue <venueId> --latest --printer 192.168.1.50
//
// `--latest` reads the venue's most recent `transactions` row with
// `source = 'square'`, which is the honest shortcut while codes are issued by
// hand: the device feed that will do this automatically is deferred until
// there is hardware to feed.
//
// Thin orchestrator per scripts/CLAUDE.md: args in, lib calls, log out. The
// issuing and link rules live in lib/pos/scan-code.ts and lib/pos/scan-link.ts
// so this file cannot drift from what the server does.

import { Socket } from 'node:net'

import { createAdminClient } from '@/lib/db/admin'
import { buildQrSlip } from '@/lib/pos/escpos-qr'
import { issueScanCode } from '@/lib/pos/scan-code'
import { buildScanLink } from '@/lib/pos/scan-link'

type Args = {
  venueId: string
  paymentId: string | null
  latest: boolean
  printer: { host: string; port: number } | null
}

function parseArgs(argv: readonly string[]): Args | string {
  let venueId: string | null = null
  let paymentId: string | null = null
  let latest = false
  let printer: Args['printer'] = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--venue') venueId = argv[++i] ?? null
    else if (arg === '--payment') paymentId = argv[++i] ?? null
    else if (arg === '--latest') latest = true
    else if (arg === '--printer') {
      const [host, port] = (argv[++i] ?? '').split(':')
      if (!host) return '--printer needs <host[:port]>'
      printer = { host, port: port ? Number(port) : 9100 }
      if (!Number.isInteger(printer.port)) return `bad printer port: ${port}`
    } else return `unknown argument: ${arg}`
  }
  if (!venueId) return 'missing --venue <venueId>'
  if (!paymentId && !latest) return 'need either --payment <id> or --latest'
  if (paymentId && latest)
    return '--payment and --latest are mutually exclusive'
  return { venueId, paymentId, latest, printer }
}

/** Send bytes to the printer and resolve once they are flushed and the socket closed. */
function sendToPrinter(
  printer: { host: string; port: number },
  payload: Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket()
    socket.setTimeout(8000, () => {
      socket.destroy(new Error('printer timed out'))
    })
    socket.once('error', reject)
    socket.connect(printer.port, printer.host, () => {
      socket.end(payload, () => setTimeout(resolve, 300))
    })
  })
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (typeof args === 'string') {
    console.error(`error: ${args}`)
    console.error(
      '\nusage:\n' +
        '  npm run pos-scan-code -- --venue <venueId> --payment <squarePaymentId>\n' +
        '  npm run pos-scan-code -- --venue <venueId> --latest\n' +
        '  add --printer <host[:port]> to print the QR on a LAN receipt printer',
    )
    process.exit(1)
  }

  const db = createAdminClient()

  const { data: venue, error: venueError } = await db
    .from('venues')
    .select('slug, instagram_username')
    .eq('id', args.venueId)
    .maybeSingle()
  if (venueError) {
    console.error(`error: venue lookup failed: ${venueError.message}`)
    process.exit(1)
  }
  if (!venue) {
    console.error(`error: no venue ${args.venueId}`)
    process.exit(1)
  }

  // Resolve the payment and its location. The location rides onto the code row
  // so the deferred time-window reconciler has it without a second lookup.
  let paymentId = args.paymentId
  let locationExternalId: string | null = null

  if (args.latest) {
    const { data: txn, error } = await db
      .from('transactions')
      .select('external_id, occurred_at')
      .eq('venue_id', args.venueId)
      .eq('source', 'square')
      .is('retracted_at', null)
      .order('occurred_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) {
      console.error(`error: transaction lookup failed: ${error.message}`)
      process.exit(1)
    }
    if (!txn?.external_id) {
      console.error(
        `error: no square transactions for venue ${args.venueId}. ` +
          'Ingest one first (npm run square-e2e creates sandbox payments).',
      )
      process.exit(1)
    }
    paymentId = txn.external_id
    console.log(`latest square payment: ${paymentId} (${txn.occurred_at})`)
  }

  const { data: cred } = await db
    .from('pos_credentials')
    .select('location_external_id')
    .eq('venue_id', args.venueId)
    .eq('provider', 'square')
    .maybeSingle()
  locationExternalId = cred?.location_external_id ?? null

  const issued = await issueScanCode({
    venueId: args.venueId,
    providerPaymentId: paymentId!,
    locationExternalId,
    supabase: db,
  })
  if (!issued.ok) {
    console.error(
      `error: ${issued.errorCode ?? 'issue_failed'}: ${issued.error}`,
    )
    process.exit(1)
  }

  const link = buildScanLink({
    instagramUsername: venue.instagram_username,
    code: issued.data.code,
  })
  if (!link.ok) {
    console.error(
      `error: ${link.error}\n` +
        `  venue ${venue.slug} needs venues.instagram_username set to its handle ` +
        `(e.g. theanalog.company) before a scan link can be built.`,
    )
    process.exit(1)
  }

  console.log('')
  console.log(`venue    ${venue.slug}`)
  console.log(`payment  ${paymentId}`)
  console.log(
    `code     ${issued.data.code}${issued.data.created ? '' : '  (already issued)'}`,
  )
  console.log(`link     ${link.url}`)
  if (args.printer) {
    try {
      await sendToPrinter(args.printer, buildQrSlip(link.url))
    } catch (e) {
      console.error(
        `error: printer ${args.printer.host}:${args.printer.port}: ${e instanceof Error ? e.message : e}\n` +
          '  (the code is issued; re-run the same command to print it again)',
      )
      process.exit(1)
    }
    console.log(`printed  sent to ${args.printer.host}:${args.printer.port}`)
  }

  console.log('')
  console.log(
    'Open that link on a phone signed into Instagram, or render it as a QR and\n' +
      'scan it. Watch for pos_scan_code_bound, then check the transaction:\n' +
      `  select guest_id, match_method from transactions where external_id = '${paymentId}';`,
  )
}

main().catch((e) => {
  console.error('error:', e instanceof Error ? e.message : e)
  process.exit(1)
})
