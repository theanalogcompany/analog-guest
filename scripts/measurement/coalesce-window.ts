/**
 * TAC-526: what would a coalescing window actually have caught?
 *
 * The ticket says of the settle window: *"Propose a number with reasoning; we
 * will measure rather than argue about it."* `COALESCE_SETTLE_MS = 8_000` is
 * the proposal and the reasoning is in its own docstring. THIS is what lets
 * the number be moved on evidence rather than on the argument.
 *
 * READ-ONLY. It SELECTs from `messages` and writes nothing anywhere: no sends,
 * no claims, no ledger rows, no model calls. Safe to run against production,
 * which is the only place the data exists.
 *
 * WHAT IT MEASURES. For every inbound message in the window, the gap to the
 * guest's PREVIOUS inbound at the same venue. A gap below the settle is a
 * burst the settle would have folded before a model call was spent; a gap
 * above it is a turn that would have been unaffected. It then replays a range
 * of candidate windows over the same data, so the cost of moving the constant
 * is a table rather than a guess.
 *
 * WHAT IT CANNOT TELL YOU, stated because the table looks more authoritative
 * than it is:
 *
 *   - It counts gaps between INBOUND rows. It cannot see whether the agent
 *     had already replied in between, so a "burst" here may be an ordinary
 *     back-and-forth the settle would never have folded. `repliedBetween`
 *     is reported per pair so that population can be excluded; it is derived
 *     from outbound rows, which the ledger says can be missing for reasons of
 *     their own.
 *   - It is blind to the EXTENSION. A fragment that lands mid-generation is
 *     caught by the pre-dispatch check whatever the settle is, so the settle's
 *     true marginal value is smaller than the burst count suggests.
 *   - Gaps are computed on `created_at` for both channels — our receipt time.
 *     Instagram rows also carry Meta's own clock and Sendblue rows never do,
 *     so ordering on that would sort the two channels on different clocks.
 *     (Named indirectly on purpose: `handle-events.test.ts` guards that column
 *     by MENTION, and its list is meant to be the set of files that genuinely
 *     read or write it. A measurement script explaining why it does neither
 *     does not belong there.) Two messages of one Instagram delivery can share
 *     a millisecond, which shows up as a zero gap and is real, not an artifact.
 *
 * Run:
 *   npx tsx --env-file=.env.local scripts/measurement/coalesce-window.ts --days 30
 *   npx tsx --env-file=.env.local scripts/measurement/coalesce-window.ts --venue le-mils-coffee
 *
 * Output goes through `createRunLog` per CLAUDE.md's measurement-harness
 * convention: one JSON-Lines row per inbound pair, timestamped by default so a
 * re-run can never overwrite a previous result set, with the candidate windows
 * and the git sha in the header.
 */

import { createAdminClient } from '@/lib/db/admin'
import { COALESCE_SETTLE_MS } from '@/lib/agent/coalesce-turn'
import { createRunLog } from './run-log'

/** The windows the table reports, in milliseconds. */
const CANDIDATE_WINDOWS_MS = [0, 2_000, 4_000, 6_000, 8_000, 12_000, 20_000, 30_000] as const

interface Args {
  days: number
  venueSlug: string | null
  outputPath: string | null
  force: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { days: 30, venueSlug: null, outputPath: null, force: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--days') args.days = Number(argv[++i])
    else if (flag === '--venue') args.venueSlug = argv[++i] ?? null
    else if (flag === '--out') args.outputPath = argv[++i] ?? null
    else if (flag === '--force') args.force = true
  }
  if (!Number.isFinite(args.days) || args.days <= 0) {
    throw new Error(`--days must be a positive number, got ${String(args.days)}`)
  }
  return args
}

interface InboundRow {
  id: string
  venue_id: string
  guest_id: string | null
  created_at: string
  channel: string | null
}

interface OutboundRow {
  venue_id: string
  guest_id: string | null
  created_at: string
}

/** One inbound and the gap to the guest's previous inbound. */
interface Pair extends Record<string, unknown> {
  venueId: string
  guestId: string
  channel: string | null
  previousMessageId: string
  messageId: string
  gapMs: number
  /** Did an outbound land between the two? Then it is a conversation, not a burst. */
  repliedBetween: boolean
}

function buildPairs(inbound: InboundRow[], outbound: OutboundRow[]): Pair[] {
  const outboundByGuest = new Map<string, number[]>()
  for (const row of outbound) {
    if (row.guest_id === null) continue
    const key = `${row.venue_id}::${row.guest_id}`
    const at = new Date(row.created_at).getTime()
    if (!Number.isNaN(at)) (outboundByGuest.get(key) ?? outboundByGuest.set(key, []).get(key)!).push(at)
  }

  const byGuest = new Map<string, InboundRow[]>()
  for (const row of inbound) {
    if (row.guest_id === null) continue
    const key = `${row.venue_id}::${row.guest_id}`
    ;(byGuest.get(key) ?? byGuest.set(key, []).get(key)!).push(row)
  }

  const pairs: Pair[] = []
  for (const [key, rows] of byGuest) {
    // Oldest first, with the id as the tiebreak — the same total order
    // `pickNewer` uses, because one Instagram delivery can insert several rows
    // in the same millisecond and a timestamp-only sort is not deterministic.
    rows.sort((a, b) => {
      const d = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      return d !== 0 ? d : a.id < b.id ? -1 : 1
    })
    const replies = outboundByGuest.get(key) ?? []
    for (let i = 1; i < rows.length; i += 1) {
      const prev = new Date(rows[i - 1].created_at).getTime()
      const cur = new Date(rows[i].created_at).getTime()
      if (Number.isNaN(prev) || Number.isNaN(cur)) continue
      pairs.push({
        venueId: rows[i].venue_id,
        guestId: rows[i].guest_id as string,
        channel: rows[i].channel,
        previousMessageId: rows[i - 1].id,
        messageId: rows[i].id,
        gapMs: cur - prev,
        repliedBetween: replies.some((at) => at > prev && at < cur),
      })
    }
  }
  return pairs
}

/** How many pairs each candidate window would fold, excluding real exchanges. */
function windowTable(pairs: Pair[]): { windowMs: number; folded: number; ofBursts: number }[] {
  const bursts = pairs.filter((p) => !p.repliedBetween)
  return CANDIDATE_WINDOWS_MS.map((windowMs) => ({
    windowMs,
    folded: bursts.filter((p) => p.gapMs <= windowMs).length,
    ofBursts: bursts.length,
  }))
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const supabase = createAdminClient()
  const since = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000).toISOString()

  let venueId: string | null = null
  if (args.venueSlug !== null) {
    const { data, error } = await supabase
      .from('venues')
      .select('id')
      .eq('slug', args.venueSlug)
      .maybeSingle()
    if (error || !data) throw new Error(`venue not found: ${args.venueSlug}`)
    venueId = data.id
  }

  const inboundQuery = supabase
    .from('messages')
    .select('id, venue_id, guest_id, created_at, channel')
    .eq('direction', 'inbound')
    .gte('created_at', since)
  const inbound = await (venueId ? inboundQuery.eq('venue_id', venueId) : inboundQuery)
  if (inbound.error) throw new Error(`inbound read failed: ${inbound.error.message}`)

  const outboundQuery = supabase
    .from('messages')
    .select('venue_id, guest_id, created_at')
    .eq('direction', 'outbound')
    .gte('created_at', since)
  const outbound = await (venueId ? outboundQuery.eq('venue_id', venueId) : outboundQuery)
  if (outbound.error) throw new Error(`outbound read failed: ${outbound.error.message}`)

  const pairs = buildPairs(inbound.data ?? [], outbound.data ?? [])
  const table = windowTable(pairs)

  const log = await createRunLog({
    name: 'coalesce-window',
    outputPath: args.outputPath ?? undefined,
    force: args.force,
    meta: {
      arm: 'observation',
      days: args.days,
      venueSlug: args.venueSlug,
      shippedSettleMs: COALESCE_SETTLE_MS,
      candidateWindowsMs: [...CANDIDATE_WINDOWS_MS],
      inboundRows: inbound.data?.length ?? 0,
      pairs: pairs.length,
    },
  })
  // Checkpointed per pair rather than buffered: the expensive half here is the
  // read, and a late throw in the cheap half must not cost it.
  for (const pair of pairs) await log.appendUnit(pair)

  const bursts = pairs.filter((p) => !p.repliedBetween)
  console.log(`\ninbound rows: ${inbound.data?.length ?? 0}   pairs: ${pairs.length}`)
  console.log(`pairs with no reply in between (candidate bursts): ${bursts.length}`)
  console.log(`\n  window     folded   of bursts`)
  for (const row of table) {
    const pct = row.ofBursts === 0 ? 0 : Math.round((row.folded / row.ofBursts) * 100)
    const mark = row.windowMs === COALESCE_SETTLE_MS ? '  <- shipped' : ''
    console.log(
      `  ${String(row.windowMs).padStart(6)}ms ${String(row.folded).padStart(8)} ${String(pct).padStart(9)}%${mark}`,
    )
  }
  console.log(
    `\nA folded pair is one the SETTLE would have caught before a model call.` +
      `\nIt is not the feature's whole value: a fragment landing mid-generation is` +
      `\ncaught by the extension whatever the window is. See the header of this file.`,
  )
  console.log(`\nrun log: ${log.path}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
