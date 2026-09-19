// TAC-469: the three things about Instagram outbound that only a real send can
// settle. Run by hand, against a test account, by a person who means it.
//
//   A. IDENTITY. The Send API answers with `message_id`; the echo webhook
//      carries a `mid`. Everything about the echo race assumes they are the
//      same string: the agent arm reconciles on a duplicate-key collision on
//      provider_message_id, and the operator arm folds the echo into the card.
//      If they are different identifiers, the collision never fires, every
//      send leaves two rows, and that half of TAC-469 needs rethinking. This
//      sends one message and waits for its echo to be saved under that exact
//      value.
//   B. THE CAP. Meta documents 1000 bytes; whether 1000 itself is accepted is
//      not something the docs settle. This sends exactly 1000 bytes through
//      the real transport, then posts 1001 bytes straight at the Graph API,
//      bypassing our own guard, to see which side of the line Meta draws.
//   C. ONE ROW EITHER WAY. The echo and our own write race, and the outcome
//      must be one row whichever lands first. This exercises both orders
//      against the real database and the real webhook.
//
// It sends up to three real messages from the venue's Instagram account, so it
// refuses to do anything without --confirm.
//
// EVERY CHECK NEEDS THE 24-HOUR REPLY WINDOW OPEN, so the run refuses to start
// with it shut. Meta refuses every send outside it with code 10, and that one
// refusal looks identical whatever a check was asking, which is how the first
// real run (2026-09-19, 25 minutes past the close) reported a cap PASS and a
// cap FAIL that were both really the window. A PASSING RUN THEREFORE HAS A
// SHELF LIFE OF ABOUT 24 HOURS from the guest's last inbound message: after
// that it has to be re-run against a fresh one, not cited.
//
// The token is NOT read from a committed file: pass it for the one run, e.g.
//   INSTAGRAM_ACCESS_TOKEN=... npm run instagram-smoke -- --venue le-mils-coffee --guest <uuid> --confirm
// An environment variable set on the command line wins over .env.local, so the
// token can stay commented out there.
//
// What it prints: PASS / FAIL / INCONCLUSIVE per check, and the row IDs it
// touched. It does NOT print the guest's Instagram-scoped ID, the token, or a
// mid (TAC-458); a mid is compared internally and reported as a match or not.
// --show-ids prints mids, for diagnosing a mismatch, and is the one flag that
// puts one on your screen.

import { createAdminClient } from '@/lib/db/admin'
import { insertOrReconcileEcho } from '@/lib/agent/dispatch-instagram-reply'
import { graphRequest, type GraphFailure } from '@/lib/messaging/instagram/graph'
import { INSTAGRAM_MAX_TEXT_BYTES, classifySendFailure, sendInstagramText } from '@/lib/messaging/instagram/send'
import { loadInstagramSendTarget, type InstagramSendTarget } from '@/lib/messaging/instagram/send-target'
import { instagramWindowState, loadLastGuestActionAt } from '@/lib/messaging/instagram/window'
import { capVerdictBlocker, idForLog as idForLogPure, parseSmokeArgs, textOfBytes } from './lib/instagram-smoke'

type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'NOTE'

const results: Array<{ check: string; verdict: Verdict; detail: string }> = []
const touchedRows: string[] = []
let showIds = false

function record(check: string, verdict: Verdict, detail: string): void {
  results.push({ check, verdict, detail })
  const mark = verdict === 'PASS' ? '✓' : verdict === 'FAIL' ? '✗' : '·'
  console.log(`${mark} ${check}: ${verdict} — ${detail}`)
}

const idForLog = (value: string): string => idForLogPure(value, showIds)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Under this much window left, the run could start open and finish closed. */
const TIGHT_WINDOW_MS = 10 * 60 * 1000

/** " 3.2h ago", or nothing when the close time is unknown. */
function closedAgo(closesAt: Date | null): string {
  if (closesAt === null) return ''
  return ` (${((Date.now() - closesAt.getTime()) / 3_600_000).toFixed(1)}h ago)`
}

type Supabase = ReturnType<typeof createAdminClient>

/** Outbound rows saved for this mid, newest first. The echo arrives by webhook. */
async function rowsForMid(supabase: Supabase, mid: string): Promise<Array<{ id: string; generated_by: string | null }>> {
  const { data, error } = await supabase
    .from('messages')
    .select('id, generated_by')
    .eq('provider_message_id', mid)
    .eq('direction', 'outbound')
  if (error) throw new Error(`row lookup failed: ${error.message}`)
  return data ?? []
}

/** Wait for the webhook to save the echo of `mid`. */
async function waitForEcho(supabase: Supabase, mid: string, seconds: number): Promise<Array<{ id: string }>> {
  for (let i = 0; i < seconds; i += 2) {
    const rows = await rowsForMid(supabase, mid)
    if (rows.length > 0) return rows
    await sleep(2000)
  }
  return []
}

async function newestOutboundRow(
  supabase: Supabase,
  venueId: string,
  guestId: string,
  since: Date,
): Promise<{ id: string; provider_message_id: string | null } | null> {
  const { data } = await supabase
    .from('messages')
    .select('id, provider_message_id, created_at')
    .eq('venue_id', venueId)
    .eq('guest_id', guestId)
    .eq('direction', 'outbound')
    .eq('channel', 'instagram')
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ?? null
}

/** The row our own send would write, with no agent metadata: this is a test, not a reply. */
function smokeRow(venueId: string, guestId: string, body: string, mid: string) {
  return {
    venue_id: venueId,
    guest_id: guestId,
    channel: 'instagram',
    direction: 'outbound',
    status: 'sent',
    body,
    provider_message_id: mid,
    sent_at: new Date().toISOString(),
    generated_by: null,
    review_state: null,
  }
}

// --- A. message_id and the echo's mid -------------------------------------

async function checkIdentity(
  supabase: Supabase,
  target: InstagramSendTarget,
  venueId: string,
  guestId: string,
): Promise<string | null> {
  const startedAt = new Date(Date.now() - 5000)
  const sent = await sendInstagramText({ ...target, fetchImpl: fetch, text: 'analog smoke test 1 of 3, please ignore' })
  if (!sent.ok) {
    // Not a FAIL: a send that never left says nothing about whether the
    // Send API's message_id and the echo's mid are the same string, and the
    // summary reads a check-A FAIL as "the design has to change".
    record('A identity', 'INCONCLUSIVE', `the send itself failed (${sent.kind}), so nothing was asked of the identity question`)
    return null
  }
  console.log(`  sent, waiting up to 60s for the echo | message_id=${idForLog(sent.mid)}`)

  const rows = await waitForEcho(supabase, sent.mid, 60)
  if (rows.length > 0) {
    touchedRows.push(...rows.map((r) => r.id))
    record(
      'A identity',
      'PASS',
      `the echo was saved under the same value the Send API returned, so the collision fires as designed (row ${rows[0]!.id})`,
    )
    return sent.mid
  }

  const other = await newestOutboundRow(supabase, venueId, guestId, startedAt)
  if (other?.provider_message_id) {
    record(
      'A identity',
      'FAIL',
      `an echo arrived under a DIFFERENT value: sent ${idForLog(sent.mid)}, echo ${idForLog(other.provider_message_id)}. ` +
        'The duplicate-key reconciliation on both arms cannot fire; re-run with --show-ids and put both values on the ticket.',
    )
    return null
  }
  record(
    'A identity',
    'INCONCLUSIVE',
    'no echo arrived within 60s. That is the webhook, not the identity question: check the Vercel logs for instagram_event_persisted and re-run.',
  )
  return null
}

// --- B. the 1000-byte boundary --------------------------------------------

/** Meta's own words for a refusal, for a person deciding what it meant. */
function graphFailureDetail(failure: GraphFailure): string {
  if (failure.reason !== 'graph_error') return failure.reason
  return `code ${failure.code ?? '?'}, subcode ${failure.subcode ?? '?'}, HTTP ${failure.httpStatus}`
}

async function checkCap(target: InstagramSendTarget): Promise<void> {
  // BOTH verdicts below read a refusal as evidence about the message's SIZE,
  // so both must first establish that size is what Meta was judging. A refusal
  // for any other reason refuses 1000 and 1001 bytes identically.
  const atCap = await sendInstagramText({ ...target, fetchImpl: fetch, text: textOfBytes(INSTAGRAM_MAX_TEXT_BYTES, 'analog smoke test 2 of 3') })
  if (atCap.ok) {
    record('B cap', 'PASS', `Meta accepted exactly ${INSTAGRAM_MAX_TEXT_BYTES} bytes, so the cap is right where it is`)
  } else {
    const blocker = capVerdictBlocker(atCap.kind)
    if (blocker !== null) {
      record(
        'B cap',
        'INCONCLUSIVE',
        `the ${INSTAGRAM_MAX_TEXT_BYTES}-byte send never reached a judgement about its size: ${blocker} (${atCap.kind}). The cap is neither confirmed nor disproved; fix that and re-run.`,
      )
    } else {
      record(
        'B cap',
        'FAIL',
        `Meta refused exactly ${INSTAGRAM_MAX_TEXT_BYTES} bytes with an unrecognised error (${atCap.failure ? graphFailureDetail(atCap.failure) : atCap.kind}). ` +
          'Read that code before changing anything: if it means the message was too long, INSTAGRAM_MAX_TEXT_BYTES has to be lower, and if it means something else this check is inconclusive and the code belongs on the ticket.',
      )
    }
  }

  // One byte over, posted straight at Graph: our own transport would refuse
  // this before the network, which is the behaviour under test everywhere
  // else, so the probe has to go around it.
  const over = textOfBytes(INSTAGRAM_MAX_TEXT_BYTES + 1, 'analog smoke test 2b of 3')
  const probe = await graphRequest('POST', `/${encodeURIComponent(target.accountId)}/messages`, target.token, fetch, {
    body: { recipient: { id: target.recipientId }, message: { text: over } },
    timeoutMs: 10_000,
  })
  if (probe.ok) {
    record(
      'B cap',
      'NOTE',
      `Meta ACCEPTED ${INSTAGRAM_MAX_TEXT_BYTES + 1} bytes, so its real limit is higher than the documented one. Ours stays where it is; nothing is broken.`,
    )
    return
  }
  // Classified through the transport's own classifier so this script's reading
  // of Meta's codes cannot drift from the one production sends through.
  const blocker = capVerdictBlocker(classifySendFailure(probe.failure))
  if (blocker !== null) {
    record(
      'B cap',
      'INCONCLUSIVE',
      `the ${INSTAGRAM_MAX_TEXT_BYTES + 1}-byte probe was refused for a reason that is not about size: ${blocker} (${graphFailureDetail(probe.failure)}). It does not show where Meta draws the line.`,
    )
    return
  }
  record(
    'B cap',
    'PASS',
    `Meta refused ${INSTAGRAM_MAX_TEXT_BYTES + 1} bytes (${graphFailureDetail(probe.failure)}), which is the line we enforce`,
  )
}

// --- C. one row, whichever write lands first ------------------------------

async function checkOneRowEitherWay(
  supabase: Supabase,
  target: InstagramSendTarget,
  venueId: string,
  guestId: string,
  echoedMid: string | null,
): Promise<void> {
  // C1, echo first: reuse the message from check A, whose echo is already
  // saved. Our write must fill that row in rather than make a second one.
  if (echoedMid === null) {
    record('C1 echo first', 'INCONCLUSIVE', 'check A did not produce an echoed message to reuse')
  } else {
    const reconciled = await insertOrReconcileEcho(
      supabase,
      smokeRow(venueId, guestId, 'analog smoke test 1 of 3, please ignore', echoedMid),
    )
    const after = await rowsForMid(supabase, echoedMid)
    if (reconciled.ok && reconciled.reconciled && after.length === 1) {
      record('C1 echo first', 'PASS', `our write filled in the echo's row, still one row (${after[0]!.id})`)
    } else {
      record(
        'C1 echo first',
        'FAIL',
        reconciled.ok
          ? `expected a reconcile onto one row, got reconciled=${reconciled.reconciled} and ${after.length} rows`
          : `the write failed: ${reconciled.error}`,
      )
    }
  }

  // C2, our write first: send, then write the row immediately, before the
  // echo can arrive. The webhook must then skip its own insert as a duplicate.
  const sent = await sendInstagramText({ ...target, fetchImpl: fetch, text: 'analog smoke test 3 of 3, please ignore' })
  if (!sent.ok) {
    record('C2 our write first', 'INCONCLUSIVE', `the send failed: ${sent.kind}`)
    return
  }
  const inserted = await insertOrReconcileEcho(
    supabase,
    smokeRow(venueId, guestId, 'analog smoke test 3 of 3, please ignore', sent.mid),
  )
  if (!inserted.ok) {
    record('C2 our write first', 'FAIL', `our own write failed: ${inserted.error}`)
    return
  }
  touchedRows.push(inserted.id)
  if (inserted.reconciled) {
    record(
      'C2 our write first',
      'NOTE',
      'the echo beat our write even here, so this run exercised the echo-first path twice rather than both orders',
    )
  }
  console.log('  waiting 45s to see whether the webhook adds a second row')
  await sleep(45_000)
  const after = await rowsForMid(supabase, sent.mid)
  if (after.length === 1 && after[0]!.id === inserted.id) {
    record('C2 our write first', 'PASS', `the webhook skipped its insert as a duplicate, still one row (${inserted.id})`)
  } else {
    record('C2 our write first', 'FAIL', `expected one row (${inserted.id}), found ${after.length}`)
  }
}

// --- the run ---------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseSmokeArgs(process.argv.slice(2))
  showIds = args.showIds
  if (!args.venue || !args.guest) {
    console.error('✗ usage: npm run instagram-smoke -- --venue <slug> --guest <guest-uuid> --confirm [--show-ids]')
    process.exit(2)
  }
  if (!args.confirm) {
    console.error('✗ this sends up to three real Instagram messages from the venue account. Re-run with --confirm.')
    process.exit(2)
  }

  const supabase = createAdminClient()
  const { data: venue, error: venueError } = await supabase
    .from('venues')
    .select('id, slug')
    .eq('slug', args.venue)
    .maybeSingle()
  if (venueError || !venue) {
    console.error(`✗ venue ${args.venue} not found${venueError ? `: ${venueError.message}` : ''}`)
    process.exit(1)
  }

  const target = await loadInstagramSendTarget(supabase, { venueId: venue.id, guestId: args.guest })
  if (!target.ok) {
    console.error(
      `✗ cannot send: ${target.problem}. ` +
        (target.problem === 'token_missing'
          ? 'Pass the token for this run: INSTAGRAM_ACCESS_TOKEN=... npm run instagram-smoke -- ...'
          : 'Check the venue and guest.'),
    )
    process.exit(1)
  }

  // PRE-FLIGHT: the 24-hour reply window. Every check sends, Meta refuses
  // every send outside the window, and one refusal looks the same whatever the
  // check was asking — so a run with the window shut produces verdicts about
  // the window wearing the labels of identity, the cap and the race. Bail here
  // rather than leave a person reading error codes to notice.
  const lastAction = await loadLastGuestActionAt(supabase, venue.id, args.guest)
  if (!lastAction.ok) {
    console.error(
      `✗ cannot read the reply window: ${lastAction.error}. Not running: with the window shut every check is meaningless, and this is the check for that.`,
    )
    process.exit(3)
  }
  const windowState = instagramWindowState(lastAction.value, new Date())
  if (!windowState.open) {
    console.error(
      windowState.reason === 'no_guest_action'
        ? '✗ the 24-hour reply window has never opened: this guest has no saved Instagram message or icebreaker postback. Send a DM to the venue from that Instagram account and re-run.'
        : `✗ the 24-hour reply window is closed${closedAgo(windowState.closesAt)}. Every send would be refused with code 10, which is not an answer to anything this script asks. Send a DM to the venue from that Instagram account and re-run.`,
    )
    process.exit(3)
  }

  console.log(`Instagram outbound smoke test | venue=${venue.slug} | guest=${args.guest}`)
  console.log(`Reply window open, ${(windowState.remainingMs / 3_600_000).toFixed(1)}h left.`)
  if (windowState.remainingMs < TIGHT_WINDOW_MS) {
    console.log('  That is tight: this run takes about two minutes and could straddle the close.')
  }
  console.log('Sending up to three real messages. Each check prints its own verdict.\n')

  const echoedMid = await checkIdentity(supabase, target.target, venue.id, args.guest)
  await checkCap(target.target)
  await checkOneRowEitherWay(supabase, target.target, venue.id, args.guest, echoedMid)

  console.log('\n--- summary ---')
  for (const r of results) console.log(`${r.verdict.padEnd(12)} ${r.check}: ${r.detail}`)
  if (touchedRows.length > 0) {
    console.log(`\nrows written or filled in: ${[...new Set(touchedRows)].join(', ')}`)
    console.log('They are ordinary outbound rows for messages that really were sent; delete them if you want the thread clean.')
  }

  const failed = results.filter((r) => r.verdict === 'FAIL')
  const inconclusive = results.filter((r) => r.verdict === 'INCONCLUSIVE')
  if (failed.length > 0) {
    console.log(`\n✗ ${failed.length} check(s) FAILED. Check A failing is the one that changes the design.`)
    process.exit(1)
  }
  if (inconclusive.length > 0) {
    console.log(`\n· ${inconclusive.length} check(s) inconclusive. Nothing is disproved; re-run.`)
    process.exit(3)
  }
  console.log('\n✓ every check passed. The echo handling on both arms rests on check A, and it holds.')
}

main().catch((e: unknown) => {
  console.error(`✗ unexpected error: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
