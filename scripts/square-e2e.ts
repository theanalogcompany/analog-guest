// Live end-to-end test for the Square integration. Exercises the real code path
// (parse webhook -> map -> ingest -> reconcile) against the Square SANDBOX and
// the live database, then cleans up after itself so it's safely re-runnable.
//
//   npm run square-e2e
//
// Requires .env.local with SQUARE_ENV=sandbox + SQUARE_SANDBOX_ACCESS_TOKEN +
// Supabase keys. Creates real sandbox orders/payments (free, sandbox) against
// the Mock Sextant venue + a dedicated test guest, asserts the outcomes, then
// deletes the rows it created.
//
// ============================================================================
// WHAT TESTS 4-6 ADD, AND WHY THEY DRIVE THE REAL ENTRY POINTS
// ============================================================================
//
// Tests 1-3 cover ingest, fingerprint auto-match and idempotency. Test 2 sets
// up its mapping by calling `linkFingerprintToGuest` directly, which is fine
// for what it asserts but means the test SUPPLIES the thing production is
// supposed to produce.
//
// The scan-code tests must not work that way. Extended naively — issue a code,
// write the mapping by hand, assert the mapping worked — the harness would be
// self-consistent and pass cleanly with the entire scan-to-bind path broken.
// So tests 4-6 hand a REAL META DELIVERY ENVELOPE to
// `processInstagramDelivery`, which runs the actual parser, the actual guest
// creation and the actual `referral_ref` write, then call the same selector and
// reconciler the webhook route calls, in the same order. The harness supplies
// only what Meta would supply.
//
// WHAT THIS STILL DOES NOT COVER, stated so a green run is not over-read:
//   - HMAC signature verification and the route's 200-on-everything posture.
//     `processInstagramDelivery` is called directly, so nothing here proves the
//     route accepts or refuses a delivery correctly.
//   - `waitUntil` wiring. The route fires the bind without awaiting it; here it
//     is awaited, so this cannot catch a bind that never gets scheduled.
//   - Meta actually delivering `ref`. Verified by hand once against a real
//     ig.me link; production prod data already shows SHORTLINK referrals
//     arriving with hand-set refs.
//   - Latency. Sandbox payments are created by our own API call, so there is no
//     terminal, no card and no cloud propagation to measure. A number from here
//     would be unrelated to the real one, not a cautious estimate of it.

import { createHash, randomUUID } from 'node:crypto'

import { GET as getPrintJobs } from '@/app/api/devices/[deviceId]/print-jobs/route'
import { loadScanOrder, pickComplimentItem } from '@/lib/agent/scan-order'
import { guestArrivedInstructionsFor } from '@/lib/ai/prompts/categories/guest-arrived'
import { formatScanArrival } from '@/lib/ai/prompts/serializers'
import { createAdminClient } from '@/lib/db/admin'
import {
  processInstagramDelivery,
  scanCodeBindTargetFor,
} from '@/lib/messaging/instagram/handle-events'
import { linkFingerprintToGuest } from '@/lib/pos/reconcile'
import { reconcileScanCodeFromReferral } from '@/lib/pos/reconcile-tap'
import { issueScanCode, looksLikeScanCode } from '@/lib/pos/scan-code'
import { buildScanLink } from '@/lib/pos/scan-link'
import {
  createSandboxPayment,
  ingestViaWebhook,
  type SnakePayment,
} from './lib/square-sandbox'

const VENUE = '5cd8231f-6c54-4ac2-9c60-b75d2801f579' // Mock Sextant Coffee Roasters
const LOCATION = 'LAVV773570DWH' // sandbox default location
const TEST_PHONE = '+15550009999'

// Instagram fixtures for tests 4-6. The account id is 17 digits like a real
// one and deliberately not any live account's — `venues.instagram_account_id`
// is UNIQUE, and the live pilot holds 17841479626987104 (theanalog.company).
// Both venue columns are set up and torn down by this script.
const IG_ACCOUNT_ID = '99999999999999999'
const IG_GUEST_IGSID = '9999000099990000'
const IG_HANDLE = 'e2e.testvenue'
// Meta's own constant for a thread opened from an ig.me link. Must match
// SCAN_REFERRAL_SOURCE or the guest is not created as a scan.
const SHORTLINK = 'SHORTLINK'

const db = createAdminClient()

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail?: string): void {
  console.log(
    `   ${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ` (${detail})` : ''}`,
  )
  if (ok) passed++
  else failed++
}

async function createOrderAndPayment(itemName: string): Promise<SnakePayment> {
  return createSandboxPayment(itemName, LOCATION)
}

/**
 * The raw delivery Meta sends for a BARE SCAN: an ig.me link followed into a
 * thread that already exists, so no icebreaker and no message — just a
 * referral. Only `id`, `time` and `messaging` on the entry, because
 * parse-events.ts reports any other entry key as `unrecognized_entry_field`.
 */
function referralDelivery(code: string): unknown {
  const nowMs = Date.now()
  return {
    object: 'instagram',
    entry: [
      {
        id: IG_ACCOUNT_ID,
        time: nowMs,
        messaging: [
          {
            sender: { id: IG_GUEST_IGSID },
            recipient: { id: IG_ACCOUNT_ID },
            timestamp: nowMs,
            referral: { ref: code, source: SHORTLINK, type: 'OPEN_THREAD' },
          },
        ],
      },
    ],
  }
}

/**
 * Run the delivery through the real handler, then do exactly what the webhook
 * route does with each outcome: ask the selector whether this is a scan code,
 * and if so reconcile it. Returns the bind outcome, or a reason it never got
 * one — which is itself an assertable result.
 */
async function deliverScanAndBind(
  code: string,
): Promise<
  | { kind: 'no_target'; outcomes: number }
  | { kind: 'bind'; status: string; fingerprint?: string; guestId: string }
  | { kind: 'error'; error: string }
> {
  const outcomes = await processInstagramDelivery(referralDelivery(code), db)
  for (const outcome of outcomes) {
    const target = scanCodeBindTargetFor(outcome, looksLikeScanCode)
    if (target === null) continue
    const result = await reconcileScanCodeFromReferral({
      venueId: target.venueId,
      guestId: target.guestId,
      code: target.code,
      supabase: db,
    })
    if (!result.ok) return { kind: 'error', error: result.error }
    return {
      kind: 'bind',
      status: result.data.status,
      fingerprint:
        result.data.status === 'bound' ? result.data.fingerprint : undefined,
      guestId: target.guestId,
    }
  }
  return { kind: 'no_target', outcomes: outcomes.length }
}

/** The leftover Instagram test guest from a run that died before cleanup. */
async function findIgTestGuest(): Promise<string | null> {
  const { data } = await db
    .from('guests')
    .select('id')
    .eq('venue_id', VENUE)
    .eq('instagram_scoped_id', IG_GUEST_IGSID)
    .maybeSingle()
  return data?.id ?? null
}

/**
 * Drop fingerprint mappings owned by this script's two test guests, and only
 * those. Never a venue-wide delete: the deterministic sandbox fingerprint is
 * the thing that needs clearing, and a real mapping on the same venue is not
 * this script's to remove.
 */
async function clearTestFingerprints(phoneGuestId: string): Promise<void> {
  const ids = [phoneGuestId]
  const igGuestId = await findIgTestGuest()
  if (igGuestId) ids.push(igGuestId)
  await db
    .from('guest_card_fingerprints')
    .delete()
    .eq('venue_id', VENUE)
    .in('guest_id', ids)
}

/**
 * Migration 076 must be applied first. Checked up front with a clear message,
 * because without it every scan-code assertion fails on a missing column and
 * the output reads like a logic bug.
 */
async function preflight(): Promise<boolean> {
  const { error } = await db
    .from('pos_tap_events')
    .select('provider_payment_id, channel')
    .limit(1)
  if (error) {
    console.error(
      '\nPREFLIGHT FAILED — migration 076_pos_scan_codes.sql is not applied.\n' +
        'Apply it in Supabase Studio, run `npm run db:types`, then re-run.\n' +
        `  (${error.message})`,
    )
    return false
  }
  const { error: venueError } = await db
    .from('venues')
    .select('instagram_username')
    .limit(1)
  if (venueError) {
    console.error(
      '\nPREFLIGHT FAILED — venues.instagram_username is missing (migration 076).\n' +
        `  (${venueError.message})`,
    )
    return false
  }
  return true
}

async function main(): Promise<void> {
  if (!(await preflight())) process.exit(1)

  const createdExternalIds: string[] = []
  const runStart = new Date(Date.now() - 60_000).toISOString()

  // Setup: ensure the venue's Square connection + a test guest exist.
  await db.from('pos_credentials').upsert(
    {
      venue_id: VENUE,
      provider: 'square',
      location_external_id: LOCATION,
      is_active: true,
    },
    { onConflict: 'venue_id,provider' },
  )
  const { data: guest } = await db
    .from('guests')
    .upsert(
      { venue_id: VENUE, phone_number: TEST_PHONE, created_via: 'manual' },
      { onConflict: 'venue_id,phone_number' },
    )
    .select('id')
    .single()
  const guestId = guest!.id

  // The sandbox test card yields a DETERMINISTIC fingerprint, so a mapping left
  // by a prior run would auto-match TEST 1's payment. Clear it up front so the
  // "unmatched until mapped" assertion is meaningful.
  //
  // Covers BOTH test guests, because a run that died before its cleanup can
  // leave that deterministic fingerprint mapped to the Instagram guest instead
  // and a phone-guest-only delete would miss it — making TEST 1 fail for a
  // reason unrelated to the code. Still scoped to rows this script owns rather
  // than to the whole venue: a venue-wide delete would take a real mapping
  // with it the day this venue has one.
  await clearTestFingerprints(guestId)

  // Instagram fixtures for tests 4-6, so the delivery resolves to this venue.
  // The previous values are captured and restored in `finally` rather than
  // assumed to be null — this venue has no Instagram account today, and
  // hardcoding that assumption would silently wipe one the day it gets set.
  const { data: venueBefore } = await db
    .from('venues')
    .select('instagram_account_id, instagram_username')
    .eq('id', VENUE)
    .single()
  if (venueBefore?.instagram_account_id) {
    console.error(
      `\nABORTED — venue ${VENUE} already has instagram_account_id ` +
        `${venueBefore.instagram_account_id}. This script would have to ` +
        `overwrite it to route its test delivery, and that is a live routing ` +
        `column. Point the script at a venue with none, or clear it first.`,
    )
    process.exit(1)
  }
  await db
    .from('venues')
    .update({
      instagram_account_id: IG_ACCOUNT_ID,
      instagram_username: IG_HANDLE,
    })
    .eq('id', VENUE)

  try {
    console.log('TEST 1 — ingest a sandbox payment (line items + fingerprint)')
    const pay1 = await createOrderAndPayment('Matcha Latte')
    createdExternalIds.push(pay1.id)
    await ingestViaWebhook(pay1)
    const { data: t1 } = await db
      .from('transactions')
      .select('amount_cents, card_fingerprint, guest_id, raw_data')
      .eq('external_id', pay1.id)
      .maybeSingle()
    const items1 =
      (t1?.raw_data as { line_items?: { name: string }[] } | null)
        ?.line_items ?? []
    check('transaction landed', !!t1)
    check('amount correct', t1?.amount_cents === 650)
    check(
      'card fingerprint captured',
      !!t1?.card_fingerprint,
      t1?.card_fingerprint ?? 'none',
    )
    check(
      'line items present',
      items1[0]?.name?.toLowerCase() === 'matcha latte',
      items1.map((i) => i.name).join(', '),
    )
    check('unmatched before fingerprint is mapped', t1?.guest_id === null)

    console.log(
      '\nTEST 2 — returning guest auto-matches by fingerprint (no tap)',
    )
    const fp = pay1.card_details.card.fingerprint!
    await linkFingerprintToGuest({
      venueId: VENUE,
      guestId,
      cardFingerprint: fp,
    })
    const pay2 = await createOrderAndPayment('Almond Croissant')
    createdExternalIds.push(pay2.id)
    await ingestViaWebhook(pay2)
    const { data: t2 } = await db
      .from('transactions')
      .select('guest_id, match_method')
      .eq('external_id', pay2.id)
      .maybeSingle()
    check('2nd payment auto-attributed to the guest', t2?.guest_id === guestId)
    check(
      "match_method is 'card_fingerprint'",
      t2?.match_method === 'card_fingerprint',
    )

    console.log('\nTEST 3 — idempotency (re-deliver the same payment)')
    await ingestViaWebhook(pay1)
    const { count } = await db
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('external_id', pay1.id)
    check('no duplicate transaction row', count === 1, `rows=${count}`)

    // ------------------------------------------------------------------------
    // The scan-code half. Fingerprint mappings are cleared first so TEST 5's
    // auto-match can only be the work of TEST 4's bind.
    // ------------------------------------------------------------------------
    await clearTestFingerprints(guestId)

    console.log('\nTEST 4 — a scan code binds its payment to the guest')
    const pay3 = await createOrderAndPayment('Iced SoFi')
    createdExternalIds.push(pay3.id)
    await ingestViaWebhook(pay3)

    const issued = await issueScanCode({
      venueId: VENUE,
      providerPaymentId: pay3.id,
      locationExternalId: LOCATION,
      supabase: db,
    })
    check('code issued for the payment', issued.ok)
    if (!issued.ok) throw new Error('issueScanCode failed: ' + issued.error)
    check('code is newly created', issued.data.created)

    const link = buildScanLink({
      instagramUsername: IG_HANDLE,
      code: issued.data.code,
    })
    check(
      'ig.me link built',
      link.ok &&
        link.url === `https://ig.me/m/${IG_HANDLE}?ref=${issued.data.code}`,
      link.ok ? link.url : link.error,
    )

    const bound = await deliverScanAndBind(issued.data.code)
    check(
      'the delivery produced a bind target',
      bound.kind === 'bind',
      bound.kind === 'no_target'
        ? `no target from ${bound.outcomes} outcome(s)`
        : bound.kind === 'error'
          ? bound.error
          : bound.status,
    )
    check(
      'bind succeeded',
      bound.kind === 'bind' && bound.status === 'bound',
      bound.kind === 'bind' ? bound.status : bound.kind,
    )
    check(
      'the card was mapped for future visits',
      bound.kind === 'bind' && bound.fingerprint === 'linked',
      bound.kind === 'bind' ? (bound.fingerprint ?? 'none') : bound.kind,
    )

    const igGuestId = bound.kind === 'bind' ? bound.guestId : null
    const { data: t3 } = await db
      .from('transactions')
      .select('guest_id, match_method')
      .eq('external_id', pay3.id)
      .maybeSingle()
    check(
      'payment attributed to the scanning guest',
      igGuestId !== null && t3?.guest_id === igGuestId,
      `guest_id=${t3?.guest_id ?? 'null'}`,
    )
    check(
      "match_method is 'scan_code'",
      t3?.match_method === 'scan_code',
      t3?.match_method ?? 'null',
    )

    // The code made the whole round trip through Meta's field, not our own
    // call: if referral_ref were dropped anywhere in persistence, the bind
    // above could still pass while production could not see the code at all.
    const { data: refRow } = await db
      .from('messages')
      .select('referral_ref, referral_source')
      .eq('venue_id', VENUE)
      .eq('referral_ref', issued.data.code)
      .maybeSingle()
    check(
      'the code was persisted to messages.referral_ref',
      refRow?.referral_ref === issued.data.code,
    )
    check(
      'the scan was recorded as a SHORTLINK referral',
      refRow?.referral_source === SHORTLINK,
      refRow?.referral_source ?? 'null',
    )

    const { data: igGuest } = await db
      .from('guests')
      .select('created_via')
      .eq('venue_id', VENUE)
      .eq('instagram_scoped_id', IG_GUEST_IGSID)
      .maybeSingle()
    check(
      "the scan created the guest as 'qr_scan'",
      igGuest?.created_via === 'qr_scan',
      igGuest?.created_via ?? 'no guest',
    )

    console.log(
      '\nTEST 5 — THE PAYOFF: their next visit auto-matches with no scan',
    )
    // Same sandbox test card, so the same deterministic fingerprint. Nothing
    // here supplies the mapping: it exists only because TEST 4's bind wrote it
    // through the production path.
    const pay4 = await createOrderAndPayment('Oat Cortado')
    createdExternalIds.push(pay4.id)
    await ingestViaWebhook(pay4)
    const { data: t4 } = await db
      .from('transactions')
      .select('guest_id, match_method')
      .eq('external_id', pay4.id)
      .maybeSingle()
    check(
      'next payment auto-attributed with no scan',
      igGuestId !== null && t4?.guest_id === igGuestId,
      `guest_id=${t4?.guest_id ?? 'null'}`,
    )
    check(
      "match_method is 'card_fingerprint'",
      t4?.match_method === 'card_fingerprint',
      t4?.match_method ?? 'null',
    )

    console.log('\nTEST 6 — one code per payment, and a code binds only once')
    const reissued = await issueScanCode({
      venueId: VENUE,
      providerPaymentId: pay3.id,
      locationExternalId: LOCATION,
      supabase: db,
    })
    check(
      're-issuing returns the same code',
      reissued.ok && reissued.data.code === issued.data.code,
      reissued.ok ? `created=${reissued.data.created}` : reissued.error,
    )
    check(
      're-issuing does not create a second code',
      reissued.ok && !reissued.data.created,
    )

    const replay = await deliverScanAndBind(issued.data.code)
    check(
      'a replayed scan does not re-bind',
      replay.kind === 'bind' && replay.status === 'code_not_found',
      replay.kind === 'bind' ? replay.status : replay.kind,
    )

    // ------------------------------------------------------------------------
    // The printer half and the two customer flows (receipt printer).
    // ------------------------------------------------------------------------
    console.log(
      '\nTEST 7 — the printer feed serves the same link the QR carries',
    )
    const printerId = 'e2e-printer'
    const printerToken = 'e2e-' + randomUUID()
    await db.from('pos_devices').delete().eq('device_id', printerId)
    await db.from('pos_devices').insert({
      device_id: printerId,
      venue_id: VENUE,
      location_external_id: LOCATION,
      device_token_hash: createHash('sha256')
        .update(printerToken)
        .digest('hex'),
    })
    const feed = (token: string | null, since: string) =>
      getPrintJobs(
        new Request(
          `https://x.test/api/devices/${printerId}/print-jobs?since=${encodeURIComponent(since)}`,
          { headers: token ? { authorization: `Bearer ${token}` } : {} },
        ),
        { params: Promise.resolve({ deviceId: printerId }) },
      )
    check(
      'no token is refused with 401',
      (await feed(null, runStart)).status === 401,
    )
    check(
      'a wrong token is refused with 401',
      (await feed('nope', runStart)).status === 401,
    )
    const feedRes = await feed(printerToken, runStart)
    check(
      'a valid token gets 200',
      feedRes.status === 200,
      String(feedRes.status),
    )
    const feedBody = (await feedRes.json()) as {
      cursor: string | null
      jobs: { id: string; at: string; url: string }[]
    }
    const job3 = feedBody.jobs.find((j) => j.url.endsWith(issued.data.code))
    check(
      "the job for payment 3 carries TEST 4's exact link",
      job3?.url === (link.ok ? link.url : null),
      job3?.url ?? `jobs=${feedBody.jobs.length}`,
    )
    check(
      'the job url is the ig.me form the QR must encode',
      /^https:\/\/ig\.me\/m\/[A-Za-z0-9._]+\?ref=sc_[A-Za-z0-9_-]{32}$/.test(
        job3?.url ?? '',
      ),
    )
    const feedAgain = (await (await feed(printerToken, runStart)).json()) as {
      jobs: { url: string }[]
    }
    check(
      're-polling serves the same links (no new codes minted)',
      JSON.stringify(feedAgain.jobs.map((j) => j.url)) ===
        JSON.stringify(feedBody.jobs.map((j) => j.url)),
    )

    console.log('\nTEST 8 — FLOW 1, new customer: scan states their order')
    const { data: scan3 } = await db
      .from('messages')
      .select('id, guest_id, created_at')
      .eq('venue_id', VENUE)
      .eq('referral_ref', issued.data.code)
      // TEST 6's replay wrote a second row with the same ref; the first is the scan.
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    const order3 = await loadScanOrder(db, {
      venueId: VENUE,
      guestId: igGuestId ?? '',
      scanMessageId: scan3?.id ?? null,
      scannedAt: new Date(scan3?.created_at ?? Date.now()),
    })
    check(
      'the scan reads back as a bound order',
      order3.kind === 'bound',
      order3.kind,
    )
    if (order3.kind === 'bound') {
      check(
        'it names what they ordered',
        order3.lineItemNames.join(',') === 'Iced SoFi',
        order3.lineItemNames.join(','),
      )
      check(
        'no earlier order on file for a new customer',
        (order3.previousLineItemNames ?? null) === null,
      )
      const pick3 = pickComplimentItem({
        lineItemNames: order3.lineItemNames,
        discoveredLabel: order3.discoveredLabel,
        menuItems: [],
      })
      const arrival3 = {
        hadPriorConversation: false,
        hasRecordedVisit: false,
        afterComplaint: false,
        priorGreetings: [],
        order: pick3,
        previousOrder: order3.previousLineItemNames ?? null,
        helloOnly: false,
      }
      const facts3 = formatScanArrival(arrival3)
      check(
        "the facts state today's order",
        facts3.includes('What they ordered: Iced SoFi'),
      )
      check('the facts state no past order', !facts3.includes('last time'))
      check(
        'new-customer wording is picked',
        guestArrivedInstructionsFor(arrival3).includes(
          'Always open with a short hello,',
        ),
      )
    }
    const { data: tx3 } = await db
      .from('transactions')
      .select('guest_id')
      .eq('external_id', pay3.id)
      .maybeSingle()
    check(
      'the customer ID is stored against the transaction',
      !!tx3?.guest_id && tx3.guest_id === igGuestId,
    )

    console.log(
      '\nTEST 9 — FLOW 2, returning customer: second receipt states new and past order',
    )
    // pay4 (Oat Cortado) was auto-attributed to this guest by fingerprint in
    // TEST 5, with no scan: the realistic returning-customer case. Its receipt
    // prints a code, and that code is scanned now.
    const issued4 = await issueScanCode({
      venueId: VENUE,
      providerPaymentId: pay4.id,
      locationExternalId: LOCATION,
      supabase: db,
    })
    check('a code is issued for the second receipt', issued4.ok)
    if (!issued4.ok) throw new Error('issueScanCode failed: ' + issued4.error)
    const bound4 = await deliverScanAndBind(issued4.data.code)
    check(
      'the second scan bound or recognised its order',
      bound4.kind === 'bind',
      bound4.kind === 'bind' ? bound4.status : bound4.kind,
    )
    const { data: scan4 } = await db
      .from('messages')
      .select('id, created_at')
      .eq('venue_id', VENUE)
      .eq('referral_ref', issued4.data.code)
      .maybeSingle()
    const order4 = await loadScanOrder(db, {
      venueId: VENUE,
      guestId: igGuestId ?? '',
      scanMessageId: scan4?.id ?? null,
      scannedAt: new Date(scan4?.created_at ?? Date.now()),
    })
    check(
      'the second scan reads back as a bound order',
      order4.kind === 'bound',
      order4.kind,
    )
    if (order4.kind === 'bound') {
      check(
        "it names today's order",
        order4.lineItemNames.join(',') === 'Oat Cortado',
        order4.lineItemNames.join(','),
      )
      check(
        'it names the past order',
        (order4.previousLineItemNames ?? []).join(',') === 'Iced SoFi',
        (order4.previousLineItemNames ?? []).join(',') || 'none',
      )
      const arrival4 = {
        hadPriorConversation: true,
        hasRecordedVisit: true,
        afterComplaint: false,
        priorGreetings: [],
        order: pickComplimentItem({
          lineItemNames: order4.lineItemNames,
          discoveredLabel: order4.discoveredLabel,
          menuItems: [],
        }),
        previousOrder: order4.previousLineItemNames ?? null,
        helloOnly: false,
      }
      const facts4 = formatScanArrival(arrival4)
      check(
        'the facts state both orders',
        facts4.includes('What they ordered: Oat Cortado') &&
          facts4.includes('What they ordered last time: Iced SoFi'),
      )
      check(
        'the returning wording is picked',
        guestArrivedInstructionsFor(arrival4).includes('welcome back'),
      )
    }
  } finally {
    // Cleanup so the test is re-runnable and leaves no residue. Children
    // before parents: messages and scan arrivals reference the guest, and
    // pos_tap_events references the transactions.
    await db.from('pos_devices').delete().eq('device_id', 'e2e-printer')
    const igGuestId = await findIgTestGuest()
    if (igGuestId) {
      await db.from('messages').delete().eq('guest_id', igGuestId)
      await db
        .from('instagram_scan_arrivals')
        .delete()
        .eq('guest_id', igGuestId)
    }
    // Only the codes this run issued. A venue-wide delete would take the
    // pre-existing NFC tap_events on this venue with it.
    if (createdExternalIds.length > 0) {
      await db
        .from('pos_tap_events')
        .delete()
        .eq('venue_id', VENUE)
        .in('provider_payment_id', createdExternalIds)
    }
    await clearTestFingerprints(guestId)
    if (createdExternalIds.length > 0) {
      await db
        .from('transactions')
        .delete()
        .in('external_id', createdExternalIds)
    }
    if (igGuestId) await db.from('guests').delete().eq('id', igGuestId)
    // Put the venue's Instagram columns back exactly as they were, rather than
    // assuming they were null.
    await db
      .from('venues')
      .update({
        instagram_account_id: venueBefore?.instagram_account_id ?? null,
        instagram_username: venueBefore?.instagram_username ?? null,
      })
      .eq('id', VENUE)
  }

  console.log(
    `\n${failed === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${passed} passed, ${failed} failed`,
  )
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error('FAIL:', e instanceof Error ? e.message : e)
  process.exit(1)
})
