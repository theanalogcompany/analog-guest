// Behavioural checks for the scan greeting's two runners: the webhook's fast
// path and the cron behind it. See README.md in this directory.
//
// NOT A TEST SUITE AND NOT IN CI. It is run by hand, with no credentials in
// the environment, against an in-memory store that models migration 064's
// partial unique index. `handleFollowup` is NOT stubbed: with no credentials
// it fails at context build and sends nothing, so a greeting is observed
// through the CLAIM that precedes it, never through a send.
//
// The store's key is written out longhand rather than imported from the code
// under check: a fake that reuses the code it is checking agrees with it by
// construction.
//
//   unique (venue_id, guest_id, venue_local_date) where claimed_at is not null

import assert from 'node:assert/strict'

import {
  processDueScanGreetings,
  processScanArrival,
  runScanGreetingFastPath,
} from '@/lib/agent/instagram-scan-greeting'
import { settleScanPassport } from '@/lib/agent/scan-arrival-store'
import { processDueScanItemQuestions } from '@/lib/agent/scan-item-question'
import { resolveSameVisitOrderAt } from '@/lib/agent/visit-checkin'
import { scanItemQuestionInstructions } from '@/lib/ai/prompts/categories/scan-item-question'
import { resolveScanItemQuestionDisposition } from '@/lib/schemas/approval-policy'
import {
  isDrink,
  loadScanOrder,
  pickComplimentItem,
} from '@/lib/agent/scan-order'
import {
  GUEST_ARRIVED_HELLO_ONLY_INSTRUCTIONS_AFTER_COMPLAINT,
  GUEST_ARRIVED_HELLO_ONLY_INSTRUCTIONS_NEW,
  GUEST_ARRIVED_HELLO_ONLY_INSTRUCTIONS_RETURNING,
  GUEST_ARRIVED_INSTRUCTIONS_AFTER_COMPLAINT,
  GUEST_ARRIVED_INSTRUCTIONS_NEW,
  GUEST_ARRIVED_INSTRUCTIONS_RETURNING,
  GUEST_ARRIVED_ORDER_INSTRUCTIONS_AFTER_COMPLAINT,
  GUEST_ARRIVED_ORDER_INSTRUCTIONS_NEW,
  GUEST_ARRIVED_ORDER_INSTRUCTIONS_RETURNING,
  guestArrivedInstructionsFor,
} from '@/lib/ai/prompts/categories/guest-arrived'
import type { MenuItem } from '@/lib/schemas'
import {
  HELLO_AFTER_PASSPORT_MS,
  isScanGreetingDue,
  msUntilScanGreetingDue,
  PASSPORT_WAIT_CAP_MS,
  SCAN_CARRY_FORWARD_MS,
  SCAN_FAST_PATH_WAKE_MARGIN_MS,
  SCAN_GREETING_CARRY_FORWARD_MS,
  SCAN_GREETING_DELAY_MS,
  SCAN_GREETING_MAX_AGE_MS,
  isScanItemQuestionTooLate,
  lastProactiveWasThisScan,
  resolveScanOrderVisit,
  scanCarryForwardAt,
  scanGreetingDueAt,
  scanItemQuestionDueAt,
  withoutQuestions,
} from '@/lib/agent/scan-arrival'

// With real credentials `handleFollowup` would talk to the real database and
// the real model. Refuse outright rather than trust the caller's shell.
const LIVE_KEYS = [
  'SUPABASE_SECRET_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
  'ANTHROPIC_API_KEY',
  'INSTAGRAM_ACCESS_TOKEN',
].filter((key) => process.env[key])
if (LIVE_KEYS.length > 0) {
  console.error(
    `scan-greeting harness: refusing to run with ${LIVE_KEYS.join(', ')} set. ` +
      'Run it with an empty environment; see README.md.',
  )
  process.exit(2)
}

type Value = string | boolean | null
type Row = Record<string, Value>
type Filter = [column: string, value: Value]

interface Seed {
  arrivals: Row[]
  messages?: Row[]
  venue?: Row
  guest?: Row
  hours?: Record<string, string>
  /** A table whose every access THROWS, as supabase-js does on a dead host. */
  throwOn?: string
  /** Runs inside the claim UPDATE's round trip, before it is applied. */
  beforeClaim?: (arrivals: Row[]) => void
  /**
   * TAC-588: what a receipt scan's code resolves to. The scan message's
   * `referral_ref`, its `pos_tap_events` row, the transaction and the stamp,
   * each written out longhand rather than built by the code under check.
   */
  order?: {
    referralRef: string | null
    tap?: Row | null
    transaction?: Record<string, unknown> | null
    stamp?: Row | null
  }
}

const DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]
const everyDay = (hours: string) =>
  Object.fromEntries(DAYS.map((day) => [day, hours]))
const OPEN = everyDay('7:00 AM - 3:00 PM')

/** A short random pause, so concurrent runners genuinely interleave. */
const pause = () =>
  new Promise<void>((resolve) =>
    setTimeout(resolve, Math.floor(Math.random() * 3)),
  )

const matches = (row: Row, filters: Filter[]) =>
  filters.every(([column, value]) => row[column] === value)

function makeDb(seed: Seed) {
  const arrivals: Row[] = seed.arrivals.map((row) => ({
    venue_id: 'v1',
    guest_id: 'g1',
    scan_message_id: `m-${String(row.id)}`,
    had_prior_conversation: true,
    claimed_at: null,
    venue_local_date: null,
    outcome: null,
    resolved_at: null,
    awaits_passport: false,
    passport_settled_at: null,
    passport_sent_at: null,
    item_question_due_at: null,
    item_question_claimed_at: null,
    item_question_sent_at: null,
    ...row,
  }))
  const messages = seed.messages ?? []
  const venue: Row = {
    id: 'v1',
    timezone: 'America/Los_Angeles',
    status: 'active',
    ...seed.venue,
  }
  const guest: Row = {
    id: 'g1',
    opted_out_at: null,
    last_proactive_send_at: null,
    instagram_scoped_id: 'igsid-1',
    ...seed.guest,
  }
  const stats = { claimWins: 0, resolveWins: 0, updates: 0 }

  function violatesOneGreetingPerDay(row: Row, date: Value) {
    if (date === null) return false
    return arrivals.some(
      (other) =>
        other.id !== row.id &&
        other.claimed_at !== null &&
        other.venue_id === row.venue_id &&
        other.guest_id === row.guest_id &&
        other.venue_local_date === date,
    )
  }

  function arrivalsSelect() {
    const filters: Filter[] = []
    const atMost: Filter[] = []
    const builder = {
      eq(column: string, value: Value) {
        filters.push([column, value])
        return builder
      },
      // TAC-588: the item question's due read.
      lte(column: string, value: Value) {
        atMost.push([column, value])
        return builder
      },
      is(column: string, value: Value) {
        filters.push([column, value])
        return builder
      },
      order: () => builder,
      async limit(n: number) {
        await pause()
        const data = arrivals
          .filter((row) => matches(row, filters))
          .filter((row) =>
            atMost.every(
              ([column, value]) =>
                row[column] !== null && String(row[column]) <= String(value),
            ),
          )
          .sort((a, b) =>
            String(a.scanned_at).localeCompare(String(b.scanned_at)),
          )
          .slice(0, n)
          .map((row) => ({ ...row }))
        return { data, error: null }
      },
      async maybeSingle() {
        await pause()
        const row = arrivals.find((candidate) => matches(candidate, filters))
        return { data: row ? { ...row } : null, error: null }
      },
    }
    return builder
  }

  type UpdateResult =
    | { data: null; error: { code: string; message: string } }
    | { data: { id: Value }[]; error: null }

  function arrivalsUpdate(patch: Row) {
    const filters: Filter[] = []
    const builder = {
      eq(column: string, value: Value) {
        filters.push([column, value])
        return builder
      },
      is(column: string, value: Value) {
        filters.push([column, value])
        return builder
      },
      // Awaited directly (no `.select()`), as settleScanPassport does.
      then<T>(
        resolve: (value: UpdateResult) => T,
        reject?: (reason: unknown) => T,
      ): Promise<T> {
        return builder.select().then(resolve, reject)
      },
      async select(): Promise<UpdateResult> {
        await pause()
        if ('claimed_at' in patch) seed.beforeClaim?.(arrivals)
        // From here to the return is one atomic statement, as in Postgres.
        stats.updates += 1
        const hit = arrivals.filter((row) => matches(row, filters))
        for (const row of hit) {
          const date =
            'venue_local_date' in patch
              ? patch.venue_local_date
              : row.venue_local_date
          const claimed =
            'claimed_at' in patch
              ? patch.claimed_at !== null
              : row.claimed_at !== null
          if (claimed && violatesOneGreetingPerDay(row, date)) {
            return {
              data: null,
              error: { code: '23505', message: 'duplicate key value' },
            }
          }
          Object.assign(row, patch)
          if ('claimed_at' in patch) stats.claimWins += 1
          if ('resolved_at' in patch) stats.resolveWins += 1
        }
        return { data: hit.map((row) => ({ id: row.id })), error: null }
      },
    }
    return builder
  }

  function messagesSelect(columns?: string) {
    // TAC-588: the scan-order loader reads the scan's own row by id.
    if (columns === 'referral_ref') {
      return {
        eq: () => ({
          async maybeSingle() {
            await pause()
            return {
              data:
                seed.order === undefined
                  ? null
                  : { referral_ref: seed.order.referralRef },
              error: null,
            }
          },
        }),
      }
    }
    const filters: Filter[] = []
    let since: string | null = null
    const builder = {
      eq(column: string, value: Value) {
        filters.push([column, value])
        return builder
      },
      // Only `.not('provider_message_id', 'is', null)` is ever sent.
      not: () => builder,
      gte(_column: string, value: string) {
        since = value
        return builder
      },
      limit: () => builder,
      async maybeSingle() {
        await pause()
        const found = messages.find(
          (row) =>
            matches(row, filters) &&
            row.provider_message_id !== null &&
            (since === null || String(row.created_at) >= since),
        )
        return { data: found ? { id: found.id } : null, error: null }
      },
    }
    return builder
  }

  /** Any number of `.eq()`s, then `.maybeSingle()`: one row or none. */
  const chain = (data: () => Record<string, unknown> | null) => {
    const builder = {
      eq: () => builder,
      async maybeSingle() {
        await pause()
        const row = data()
        return { data: row ? { ...row } : null, error: null }
      },
    }
    return builder
  }

  const single = (data: () => Record<string, unknown>) => ({
    eq: () => ({
      async maybeSingle() {
        await pause()
        return { data: data(), error: null }
      },
    }),
  })

  const client = {
    from(table: string) {
      if (seed.throwOn === table) throw new Error('fake: unreachable host')
      switch (table) {
        case 'instagram_scan_arrivals':
          return { select: arrivalsSelect, update: arrivalsUpdate }
        case 'messages':
          return { select: messagesSelect }
        case 'pos_tap_events':
          return { select: () => chain(() => seed.order?.tap ?? null) }
        case 'transactions':
          return {
            select: () => chain(() => seed.order?.transaction ?? null),
          }
        case 'passport_stamps':
          return { select: () => chain(() => seed.order?.stamp ?? null) }
        case 'venues':
          return {
            // TAC-588: the item question reads every venue at once, with its
            // config embedded (loadWarmCloseVenues), and awaits the select.
            select: (columns?: string) =>
              columns?.includes('venue_configs')
                ? Promise.resolve({
                    data: [
                      {
                        ...venue,
                        instagram_account_id: 'ig-1',
                        venue_configs: {
                          followup_rules: null,
                          venue_info: { menu: { highlights: [], items: [] } },
                        },
                      },
                    ],
                    error: null,
                  })
                : single(() => ({ ...venue })),
          }
        case 'venue_configs':
          return {
            select: () =>
              single(() => ({ venue_info: { hours: seed.hours ?? OPEN } })),
          }
        case 'guests':
          return {
            select: () => single(() => ({ ...guest })),
            update: (patch: Row) => ({
              async eq() {
                Object.assign(guest, patch)
                return { error: null }
              },
            }),
          }
        default:
          throw new Error(`fake: unexpected table ${table}`)
      }
    },
  }

  // The cast every fake in this repo's history took: it answers the shapes
  // the code under check sends, not the whole SupabaseClient surface.
  return { client: client as never, arrivals, messages, stats }
}

const SECOND = 1000
const MINUTE = 60 * SECOND
/** 13:18 in Los Angeles, mid-service. */
const SCAN = new Date('2026-09-20T20:18:08.000Z')
const at = (ms: number) => new Date(SCAN.getTime() + ms)
const scanRow = (over: Row = {}): Row => ({
  id: 'a1',
  scanned_at: SCAN.toISOString(),
  ...over,
})
const inbound = (ms: number): Row => ({
  id: 'in1',
  venue_id: 'v1',
  guest_id: 'g1',
  direction: 'inbound',
  provider_message_id: 'mid.1',
  created_at: at(ms).toISOString(),
})
const PENDING = {
  id: 'a1',
  venueId: 'v1',
  guestId: 'g1',
  scanMessageId: 'm-a1',
  scannedAt: SCAN,
  hadPriorConversation: true,
  awaitsPassport: false,
  passportSettledAt: null,
  passportSentAt: null,
}
/** A scan with no receipt code: the timing every check before TAC-588 used. */
const plain = (scannedAt: Date) => ({
  scannedAt,
  awaitsPassport: false,
  passportSettledAt: null,
  passportSentAt: null,
})

/** A clock that advances by exactly what was slept, or by `advance`. */
function fakeClock(start: Date) {
  let now = start.getTime()
  const slept: number[] = []
  return {
    slept,
    advance(ms: number) {
      now += ms
    },
    deps: {
      now: () => new Date(now),
      async sleep(ms: number) {
        slept.push(ms)
        now += ms
      },
    },
  }
}

const lines: string[] = []
let failed = 0
async function check(name: string, run: () => Promise<void> | void) {
  try {
    await run()
    lines.push(`ok   ${name}`)
  } catch (e) {
    failed += 1
    const reason = e instanceof Error ? e.message.split('\n')[0] : String(e)
    lines.push(`FAIL ${name}\n       ${reason}`)
  }
}

async function main() {
  await check(
    'constants: 20s delay, 5min carry-forward of its own, 15min stale, 30min greeting anchor',
    () => {
      assert.equal(SCAN_GREETING_DELAY_MS, 20 * SECOND)
      assert.equal(SCAN_CARRY_FORWARD_MS, 5 * MINUTE)
      assert.equal(SCAN_GREETING_MAX_AGE_MS, 15 * MINUTE)
      assert.equal(SCAN_GREETING_CARRY_FORWARD_MS, 30 * MINUTE)
    },
  )

  await check('isScanGreetingDue: false at 19s, true at 20s', () => {
    assert.equal(isScanGreetingDue(plain(SCAN), at(19 * SECOND)), false)
    assert.equal(isScanGreetingDue(plain(SCAN), at(20 * SECOND)), true)
  })

  await check(
    'msUntilScanGreetingDue: fresh, half elapsed, already due, capped, invalid',
    () => {
      assert.equal(msUntilScanGreetingDue(plain(SCAN), SCAN), 20 * SECOND)
      assert.equal(
        msUntilScanGreetingDue(plain(SCAN), at(10 * SECOND)),
        10 * SECOND,
      )
      assert.equal(msUntilScanGreetingDue(plain(SCAN), at(25 * SECOND)), 0)
      assert.equal(
        msUntilScanGreetingDue(plain(at(10 * MINUTE)), SCAN),
        40 * SECOND,
      )
      assert.equal(msUntilScanGreetingDue(plain(new Date(NaN)), SCAN), 0)
    },
  )

  await check(
    'carry-forward: 60s and exactly 5min are at-counter, 5min + 1s is not',
    () => {
      const carried = (ms: number) =>
        scanCarryForwardAt({
          lastScanAt: SCAN,
          lastGreetingAt: null,
          inboundAt: at(ms),
        })
      assert.deepEqual(carried(60 * SECOND), SCAN)
      assert.deepEqual(carried(5 * MINUTE), SCAN)
      assert.equal(carried(5 * MINUTE + SECOND), null)
    },
  )

  await check('cron alone: waits at 19s, claims at 20s', async () => {
    const db = makeDb({ arrivals: [scanRow()] })
    const early = await processDueScanGreetings(at(19 * SECOND), db.client)
    assert.equal(early.notYet, 1)
    assert.equal(db.stats.updates, 0)
    await processDueScanGreetings(at(20 * SECOND), db.client)
    assert.equal(db.stats.claimWins, 1)
  })

  await check(
    'fast path: sleeps the remainder plus the margin, then claims once at the post-sleep instant',
    async () => {
      const db = makeDb({ arrivals: [scanRow()] })
      const clock = fakeClock(at(2 * SECOND))
      await runScanGreetingFastPath(db.client, { id: 'a1' }, clock.deps)
      const woke = 20 * SECOND + SCAN_FAST_PATH_WAKE_MARGIN_MS
      assert.deepEqual(clock.slept, [woke - 2 * SECOND])
      assert.equal(db.stats.claimWins, 1)
      assert.equal(db.arrivals[0]?.claimed_at, at(woke).toISOString())
    },
  )

  await check(
    'timer fires 1ms early: the fast path still finds the row due and claims it',
    async () => {
      const db = makeDb({ arrivals: [scanRow()] })
      let now = SCAN.getTime()
      await runScanGreetingFastPath(
        db.client,
        { id: 'a1' },
        {
          now: () => new Date(now),
          async sleep(ms) {
            now += ms - 1
          },
        },
      )
      assert.equal(db.stats.claimWins, 1)
    },
  )

  await check(
    'guest writes inside the 20s: inbound_during_window, never claimed',
    async () => {
      const db = makeDb({ arrivals: [scanRow()] })
      const clock = fakeClock(at(SECOND))
      await runScanGreetingFastPath(
        db.client,
        { id: 'a1' },
        {
          now: clock.deps.now,
          async sleep(ms) {
            await clock.deps.sleep(ms)
            db.messages.push(inbound(12 * SECOND))
          },
        },
      )
      assert.equal(db.arrivals[0]?.outcome, 'inbound_during_window')
      assert.equal(db.stats.claimWins, 0)
    },
  )

  await check(
    'venue closes in the gap: scan 14:59:50, wake after 15:00 -> venue_closed (control with later hours claims)',
    async () => {
      const scan = new Date('2026-09-20T21:59:50.000Z')
      const arrivals = [scanRow({ scanned_at: scan.toISOString() })]
      const scheduled = { id: 'a1' }

      const db = makeDb({ arrivals })
      await runScanGreetingFastPath(db.client, scheduled, fakeClock(scan).deps)
      assert.equal(db.arrivals[0]?.outcome, 'venue_closed')
      assert.equal(db.stats.claimWins, 0)

      const control = makeDb({ arrivals, hours: everyDay('7:00 AM - 4:00 PM') })
      await runScanGreetingFastPath(
        control.client,
        scheduled,
        fakeClock(scan).deps,
      )
      assert.equal(control.stats.claimWins, 1)
    },
  )

  await check(
    'claim race: fast path and a cron tick on one row, 200 rounds -> exactly one claim every round',
    async () => {
      let overlapped = 0
      for (let round = 0; round < 200; round++) {
        const db = makeDb({ arrivals: [scanRow()] })
        const [, cron] = await Promise.all([
          runScanGreetingFastPath(
            db.client,
            { id: 'a1' },
            fakeClock(at(20 * SECOND)).deps,
          ),
          processDueScanGreetings(at(21 * SECOND), db.client),
        ])
        assert.equal(db.stats.claimWins, 1, `round ${round}`)
        if (cron.scanned === 1) overlapped += 1
      }
      // Guard the guard: a run where the cron never saw the row raced nothing.
      assert.ok(overlapped > 20, `cron reached the row in ${overlapped} rounds`)
    },
  )

  await check(
    'claim race, direct: two per-row calls on one row -> one claim and one cas_lost, 200 rounds',
    async () => {
      for (let round = 0; round < 200; round++) {
        const db = makeDb({ arrivals: [scanRow()] })
        const results = await Promise.all([
          processScanArrival(db.client, PENDING, at(20 * SECOND)),
          processScanArrival(db.client, PENDING, at(20 * SECOND)),
        ])
        assert.equal(db.stats.claimWins, 1, `round ${round}`)
        assert.ok(results.some((result) => result.kind === 'cas_lost'))
      }
    },
  )

  await check(
    'a row suppressed just before the claim lands is lost, not claimed and greeted',
    async () => {
      const db = makeDb({
        arrivals: [scanRow()],
        // The other runner's suppression, landing between this runner's own
        // checks and its claim.
        beforeClaim(arrivals) {
          Object.assign(arrivals[0] ?? {}, {
            outcome: 'inbound_during_window',
            resolved_at: at(20 * SECOND).toISOString(),
          })
        },
      })
      const result = await processScanArrival(
        db.client,
        PENDING,
        at(20 * SECOND),
      )
      assert.equal(result.kind, 'cas_lost')
      assert.equal(db.stats.claimWins, 0)
      assert.equal(db.arrivals[0]?.claimed_at, null)
      assert.equal(db.arrivals[0]?.outcome, 'inbound_during_window')
    },
  )

  await check(
    'duplicate delivery: two rows for one guest, two fast paths -> one claim, one already_greeted_today',
    async () => {
      for (let round = 0; round < 100; round++) {
        const db = makeDb({ arrivals: [scanRow(), scanRow({ id: 'a2' })] })
        await Promise.all(
          ['a1', 'a2'].map((id) =>
            runScanGreetingFastPath(
              db.client,
              { id },
              fakeClock(at(20 * SECOND)).deps,
            ),
          ),
        )
        assert.equal(db.stats.claimWins, 1, `round ${round}`)
        const repeats = db.arrivals.filter(
          (row) => row.outcome === 'already_greeted_today',
        )
        assert.equal(repeats.length, 1, `round ${round}`)
      }
    },
  )

  await check(
    'two runners suppress one scan -> exactly one resolve wins',
    async () => {
      for (let round = 0; round < 100; round++) {
        const db = makeDb({
          arrivals: [scanRow()],
          messages: [inbound(5 * SECOND)],
        })
        await Promise.all([
          processScanArrival(db.client, PENDING, at(20 * SECOND)),
          processScanArrival(db.client, PENDING, at(21 * SECOND)),
        ])
        assert.equal(db.stats.resolveWins, 1, `round ${round}`)
      }
    },
  )

  await check(
    'a runner that did not claim cannot resolve a row the other runner claimed and is greeting',
    async () => {
      const db = makeDb({
        arrivals: [
          scanRow({
            claimed_at: at(20 * SECOND).toISOString(),
            venue_local_date: '2026-09-20',
          }),
        ],
        messages: [inbound(22 * SECOND)],
      })
      await processScanArrival(db.client, PENDING, at(23 * SECOND))
      assert.equal(db.stats.resolveWins, 0)
      assert.equal(db.arrivals[0]?.outcome, null)
    },
  )

  await check(
    'fast path dies in the sleep: nothing escapes, the row stays pending, a tick at 60s claims it',
    async () => {
      const db = makeDb({ arrivals: [scanRow()] })
      await runScanGreetingFastPath(
        db.client,
        { id: 'a1' },
        {
          now: () => SCAN,
          async sleep() {
            throw new Error('instance recycled')
          },
        },
      )
      assert.equal(db.stats.updates, 0)
      assert.equal(db.arrivals[0]?.claimed_at, null)
      assert.equal(db.arrivals[0]?.resolved_at, null)
      await processDueScanGreetings(at(60 * SECOND), db.client)
      assert.equal(db.stats.claimWins, 1)
    },
  )

  await check('a THROWING read does not escape the fast path', async () => {
    const db = makeDb({
      arrivals: [scanRow()],
      throwOn: 'instagram_scan_arrivals',
    })
    await runScanGreetingFastPath(db.client, { id: 'a1' }, fakeClock(SCAN).deps)
  })

  await check(
    'row already resolved before waking: the fast path writes nothing',
    async () => {
      const db = makeDb({
        arrivals: [
          scanRow({
            outcome: 'venue_paused',
            resolved_at: at(20 * SECOND).toISOString(),
          }),
        ],
      })
      await runScanGreetingFastPath(
        db.client,
        { id: 'a1' },
        fakeClock(SCAN).deps,
      )
      assert.equal(db.stats.updates, 0)
    },
  )

  await check(
    "Meta's clock ahead of ours: not due on waking, left pending for the cron",
    async () => {
      const ahead = at(10 * MINUTE)
      const db = makeDb({
        arrivals: [scanRow({ scanned_at: ahead.toISOString() })],
      })
      await runScanGreetingFastPath(
        db.client,
        { id: 'a1' },
        fakeClock(SCAN).deps,
      )
      assert.equal(db.stats.updates, 0)
    },
  )

  await check(
    'spacing hold: held and nothing written, by the fast path too',
    async () => {
      const db = makeDb({
        arrivals: [scanRow()],
        guest: { last_proactive_send_at: at(-10 * MINUTE).toISOString() },
      })
      await runScanGreetingFastPath(
        db.client,
        { id: 'a1' },
        fakeClock(SCAN).deps,
      )
      assert.equal(db.stats.updates, 0)
    },
  )

  // ---------------------------------------------------------------------------
  // TAC-588: a scan of a receipt code waits for its passport images
  // ---------------------------------------------------------------------------

  const passport = (over: {
    settled?: number | null
    sent?: number | null
  }) => ({
    scannedAt: SCAN,
    awaitsPassport: true,
    passportSettledAt:
      over.settled === undefined || over.settled === null
        ? null
        : at(over.settled),
    passportSentAt:
      over.sent === undefined || over.sent === null ? null : at(over.sent),
  })

  await check(
    'TAC-588 constants: hello 4s after the images, 60s passport cap',
    () => {
      assert.equal(HELLO_AFTER_PASSPORT_MS, 4 * SECOND)
      assert.equal(PASSPORT_WAIT_CAP_MS, 60 * SECOND)
    },
  )

  await check(
    'scanGreetingDueAt: no code 20s; sent at 5s -> 9s; ended unsent -> 20s; still running -> 60s',
    () => {
      assert.deepEqual(scanGreetingDueAt(plain(SCAN)), at(20 * SECOND))
      assert.deepEqual(
        scanGreetingDueAt(passport({ settled: 5 * SECOND, sent: 5 * SECOND })),
        at(9 * SECOND),
      )
      assert.deepEqual(
        scanGreetingDueAt(
          passport({ settled: 30 * SECOND, sent: 28 * SECOND }),
        ),
        at(32 * SECOND),
      )
      assert.deepEqual(
        scanGreetingDueAt(passport({ settled: 6 * SECOND })),
        at(20 * SECOND),
      )
      // An unsent run that ended after the fallback is already due.
      assert.equal(
        isScanGreetingDue(passport({ settled: 45 * SECOND }), at(45 * SECOND)),
        true,
      )
      assert.deepEqual(scanGreetingDueAt(passport({})), at(60 * SECOND))
    },
  )

  await check(
    'msUntilScanGreetingDue: a running stamp waits to the 60s cap, never the old 40s one',
    () => {
      assert.equal(
        msUntilScanGreetingDue(passport({}), at(2 * SECOND)),
        58 * SECOND,
      )
      assert.equal(
        msUntilScanGreetingDue(passport({}), at(-10 * MINUTE)),
        PASSPORT_WAIT_CAP_MS + 20 * SECOND,
      )
    },
  )

  await check(
    'fast path waits for the stamp run, then greets 4s after the images (not at 20s, not at 60s)',
    async () => {
      const db = makeDb({ arrivals: [scanRow({ awaits_passport: true })] })
      const clock = fakeClock(at(SECOND))
      const passportSettled = (async () => {
        await pause()
        await pause()
        clock.advance(4 * SECOND)
        Object.assign(db.arrivals[0] ?? {}, {
          passport_settled_at: at(5 * SECOND).toISOString(),
          passport_sent_at: at(5 * SECOND).toISOString(),
        })
      })()
      await runScanGreetingFastPath(
        db.client,
        { id: 'a1', passportSettled },
        clock.deps,
      )
      const woke = 9 * SECOND + SCAN_FAST_PATH_WAKE_MARGIN_MS
      assert.equal(db.stats.claimWins, 1)
      assert.equal(db.arrivals[0]?.claimed_at, at(woke).toISOString())
    },
  )

  await check('stamp run ended without sending: the 20s fallback', async () => {
    const db = makeDb({
      arrivals: [
        scanRow({
          awaits_passport: true,
          passport_settled_at: at(6 * SECOND).toISOString(),
        }),
      ],
    })
    const clock = fakeClock(at(6 * SECOND))
    await runScanGreetingFastPath(
      db.client,
      { id: 'a1', passportSettled: Promise.resolve() },
      clock.deps,
    )
    const woke = 20 * SECOND + SCAN_FAST_PATH_WAKE_MARGIN_MS
    assert.equal(db.arrivals[0]?.claimed_at, at(woke).toISOString())
  })

  await check(
    'stamp run never recorded an outcome: the hello goes at the 60s cap',
    async () => {
      const db = makeDb({ arrivals: [scanRow({ awaits_passport: true })] })
      const clock = fakeClock(at(2 * SECOND))
      await runScanGreetingFastPath(
        db.client,
        { id: 'a1', passportSettled: Promise.resolve() },
        clock.deps,
      )
      const woke = 60 * SECOND + SCAN_FAST_PATH_WAKE_MARGIN_MS
      assert.equal(db.arrivals[0]?.claimed_at, at(woke).toISOString())
    },
  )

  await check(
    'a rejected stamp promise does not escape the fast path, and the cap still greets',
    async () => {
      const db = makeDb({ arrivals: [scanRow({ awaits_passport: true })] })
      await runScanGreetingFastPath(
        db.client,
        { id: 'a1', passportSettled: Promise.reject(new Error('boom')) },
        fakeClock(at(2 * SECOND)).deps,
      )
      assert.equal(db.stats.claimWins, 1)
    },
  )

  await check(
    'cron behind a receipt scan: not at 20s or 59s while the run is open, claims at 60s',
    async () => {
      const db = makeDb({ arrivals: [scanRow({ awaits_passport: true })] })
      await processDueScanGreetings(at(20 * SECOND), db.client)
      await processDueScanGreetings(at(59 * SECOND), db.client)
      assert.equal(db.stats.updates, 0)
      await processDueScanGreetings(at(60 * SECOND), db.client)
      assert.equal(db.stats.claimWins, 1)
    },
  )

  await check(
    'cron behind a receipt scan whose images went at 5s: not at 8.9s, claims at 9s',
    async () => {
      const db = makeDb({
        arrivals: [
          scanRow({
            awaits_passport: true,
            passport_settled_at: at(5 * SECOND).toISOString(),
            passport_sent_at: at(5 * SECOND).toISOString(),
          }),
        ],
      })
      await processDueScanGreetings(at(8900), db.client)
      assert.equal(db.stats.updates, 0)
      await processDueScanGreetings(at(9 * SECOND), db.client)
      assert.equal(db.stats.claimWins, 1)
    },
  )

  await check(
    'settleScanPassport writes once: a second outcome cannot move a timed hello',
    async () => {
      const db = makeDb({ arrivals: [scanRow({ awaits_passport: true })] })
      await settleScanPassport(db.client, 'a1', {
        settledAt: at(5 * SECOND),
        sentAt: at(5 * SECOND),
      })
      await settleScanPassport(db.client, 'a1', {
        settledAt: at(30 * SECOND),
        sentAt: null,
      })
      assert.equal(
        db.arrivals[0]?.passport_sent_at,
        at(5 * SECOND).toISOString(),
      )
      assert.equal(
        db.arrivals[0]?.passport_settled_at,
        at(5 * SECOND).toISOString(),
      )
    },
  )

  // ---------------------------------------------------------------------------
  // TAC-588: the order, the item, and a hello that asks nothing
  // ---------------------------------------------------------------------------

  const menu = (name: string, category: string, description?: string) =>
    ({
      name,
      category,
      price: 5,
      modifiers: [],
      dietary: [],
      isOffMenu: false,
      ...(description === undefined ? {} : { description }),
    }) satisfies MenuItem
  const MENU: MenuItem[] = [
    menu('Oat Cortado', 'Espresso Drinks', 'Smooth and nutty, with oat milk.'),
    menu('Pink Panther', 'Signature Drinks', '   '),
    menu('Matcha Latte', 'Matcha'),
    menu('Croissant', 'Pastries', 'Laminated in-house, best warm.'),
    menu('Sourdough Toast', 'Food'),
    menu('Iced Sofi', 'Coffee'),
  ]
  const pickOf = (names: string[], discovered: string | null = null) =>
    pickComplimentItem({
      lineItemNames: names,
      discoveredLabel: discovered,
      menuItems: MENU,
    })

  await check(
    'item pick: the DISCOVERED item beats a drink, and is marked first time',
    () => {
      const pick = pickOf(
        ['Croissant', 'Oat Cortado', 'Pink Panther'],
        'Pink Panther',
      )
      assert.equal(pick?.item, 'Pink Panther')
      assert.equal(pick?.firstTime, true)
      // A blank menu description is no description.
      assert.equal(pick?.menuDescription, null)
      // The stamp's label matches by its own key: case and spacing fold.
      assert.equal(
        pickOf(['Croissant', 'Pink Panther'], 'pink  PANTHER')?.item,
        'Pink Panther',
      )
    },
  )

  await check(
    'item pick: a drink beats food, the first drink in Square order, with its menu description',
    () => {
      const pick = pickOf(['Croissant', 'Oat Cortado', 'Matcha Latte'])
      assert.equal(pick?.item, 'Oat Cortado')
      assert.equal(pick?.firstTime, false)
      assert.equal(pick?.menuDescription, 'Smooth and nutty, with oat milk.')
      // A DISCOVERED label naming nothing on this order falls back to drinks.
      assert.equal(
        pickOf(['Croissant', 'Matcha Latte'], 'Chai')?.item,
        'Matcha Latte',
      )
    },
  )

  await check(
    'item pick: food only takes the first item; nothing named is null',
    () => {
      assert.equal(pickOf(['Croissant', 'Sourdough Toast'])?.item, 'Croissant')
      assert.equal(pickOf([]), null)
      assert.equal(pickOf(['  ']), null)
    },
  )

  await check(
    'drink test: the menu category decides when the item is on the menu, the name when it is not',
    () => {
      const row = (name: string) =>
        MENU.find((item) => item.name === name) ?? null
      // On the menu: the category, not the name. "Iced Sofi" names no drink.
      assert.equal(isDrink('Iced Sofi', row('Iced Sofi')), true)
      assert.equal(isDrink('Pink Panther', row('Pink Panther')), true)
      assert.equal(isDrink('Croissant', row('Croissant')), false)
      // Off the menu: the name.
      assert.equal(isDrink('Iced Oat Cortado', null), true)
      assert.equal(isDrink('Flat White', null), true)
      assert.equal(isDrink('Almond Croissant', null), false)
      // Whole words only: "teacake" is not tea.
      assert.equal(isDrink('Teacake', null), false)
    },
  )

  await check(
    'withoutQuestions: drops the asking sentence, keeps the rest and the line breaks',
    () => {
      assert.deepEqual(
        withoutQuestions(
          "hey jaipal, good to see you\nthe oat cortado's a great one. what did you get?",
        ),
        {
          body: "hey jaipal, good to see you\nthe oat cortado's a great one.",
          dropped: 1,
        },
      )
      assert.deepEqual(withoutQuestions('really?! that one is lovely.'), {
        body: 'that one is lovely.',
        dropped: 1,
      })
      assert.deepEqual(withoutQuestions('hey! the croissant is best warm'), {
        body: 'hey! the croissant is best warm',
        dropped: 0,
      })
      assert.deepEqual(withoutQuestions('what did you get?'), {
        body: '',
        dropped: 1,
      })
    },
  )

  await check(
    'greeting wording: an order compliments, an expired code says hello only, neither asks as before',
    () => {
      const order = {
        item: 'Oat Cortado',
        firstTime: false,
        menuDescription: null,
      }
      const pickFor = (over: {
        prior?: boolean
        complaint?: boolean
        order?: typeof order | null
        expired?: boolean
      }) =>
        guestArrivedInstructionsFor({
          hadPriorConversation: over.prior ?? false,
          afterComplaint: over.complaint ?? false,
          order: over.order ?? null,
          expiredCode: over.expired ?? false,
        })
      assert.equal(pickFor({ order }), GUEST_ARRIVED_ORDER_INSTRUCTIONS_NEW)
      assert.equal(
        pickFor({ order, prior: true }),
        GUEST_ARRIVED_ORDER_INSTRUCTIONS_RETURNING,
      )
      assert.equal(
        pickFor({ order, prior: true, complaint: true }),
        GUEST_ARRIVED_ORDER_INSTRUCTIONS_AFTER_COMPLAINT,
      )
      assert.equal(
        pickFor({ expired: true }),
        GUEST_ARRIVED_HELLO_ONLY_INSTRUCTIONS_NEW,
      )
      assert.equal(
        pickFor({ expired: true, prior: true }),
        GUEST_ARRIVED_HELLO_ONLY_INSTRUCTIONS_RETURNING,
      )
      assert.equal(
        pickFor({ expired: true, complaint: true }),
        GUEST_ARRIVED_HELLO_ONLY_INSTRUCTIONS_AFTER_COMPLAINT,
      )
      // No order and no expired code: today's counter wording, unchanged.
      assert.equal(pickFor({}), GUEST_ARRIVED_INSTRUCTIONS_NEW)
      assert.equal(
        pickFor({ prior: true }),
        GUEST_ARRIVED_INSTRUCTIONS_RETURNING,
      )
      assert.equal(
        pickFor({ complaint: true }),
        GUEST_ARRIVED_INSTRUCTIONS_AFTER_COMPLAINT,
      )
      assert.equal(
        guestArrivedInstructionsFor(null),
        GUEST_ARRIVED_INSTRUCTIONS_NEW,
      )
    },
  )

  await check(
    'greeting wording: every receipt variant asks nothing and never says they are in the shop; hello-only never compliments',
    () => {
      const receipt = [
        GUEST_ARRIVED_ORDER_INSTRUCTIONS_NEW,
        GUEST_ARRIVED_ORDER_INSTRUCTIONS_RETURNING,
        GUEST_ARRIVED_ORDER_INSTRUCTIONS_AFTER_COMPLAINT,
        GUEST_ARRIVED_HELLO_ONLY_INSTRUCTIONS_NEW,
        GUEST_ARRIVED_HELLO_ONLY_INSTRUCTIONS_RETURNING,
        GUEST_ARRIVED_HELLO_ONLY_INSTRUCTIONS_AFTER_COMPLAINT,
      ]
      for (const text of receipt) {
        assert.match(text, /ask nothing at all/i)
        assert.match(text, /may already have left/)
        assert.doesNotMatch(text, /in the shop right now/)
        assert.match(text, /Don't mention a passport or a stamp/)
      }
      for (const text of receipt.slice(3)) {
        assert.doesNotMatch(text, /compliment/i)
      }
    },
  )

  const ORDER_SCAN = {
    venueId: 'v1',
    guestId: 'g1',
    scanMessageId: 'm-a1',
    scannedAt: SCAN,
  }
  const tap = (over: Row = {}): Row => ({
    status: 'matched',
    received_at: at(-5 * MINUTE).toISOString(),
    reconciled_transaction_id: 't1',
    ...over,
  })
  const txn = (over: Row = {}) => ({
    id: 't1',
    guest_id: 'g1',
    occurred_at: at(-5 * MINUTE).toISOString(),
    retracted_at: null,
    raw_data: {
      line_items: [
        { name: 'Croissant', quantity: 1 },
        { name: 'Pink Panther', quantity: 1 },
      ],
    },
    ...over,
  })

  await check(
    'scan order: a bound code reads the order, its line items and its DISCOVERED label',
    async () => {
      const db = makeDb({
        arrivals: [],
        order: {
          referralRef: 'sc_abc',
          tap: tap(),
          transaction: txn(),
          stamp: { kind: 'discovered', label: 'Pink Panther' },
        },
      })
      const order = await loadScanOrder(db.client, ORDER_SCAN)
      assert.equal(order.kind, 'bound')
      if (order.kind !== 'bound') return
      assert.deepEqual(order.lineItemNames, ['Croissant', 'Pink Panther'])
      assert.equal(order.discoveredLabel, 'Pink Panther')
      assert.deepEqual(order.orderedAt, at(-5 * MINUTE))
    },
  )

  await check(
    "scan order: none for the counter sign, another guest's order, a retracted one, and a payment not yet ingested",
    async () => {
      const kindOf = async (order: Seed['order']) =>
        (
          await loadScanOrder(
            makeDb({ arrivals: [], order }).client,
            ORDER_SCAN,
          )
        ).kind
      assert.equal(await kindOf({ referralRef: 'LEMILS-COUNTER' }), 'none')
      assert.equal(await kindOf({ referralRef: null }), 'none')
      assert.equal(
        await kindOf({
          referralRef: 'sc_abc',
          tap: tap(),
          transaction: txn({ guest_id: 'g2' }),
        }),
        'none',
      )
      assert.equal(
        await kindOf({
          referralRef: 'sc_abc',
          tap: tap(),
          transaction: txn({ retracted_at: at(0).toISOString() }),
        }),
        'none',
      )
      assert.equal(
        await kindOf({
          referralRef: 'sc_abc',
          tap: tap({ status: 'pending', reconciled_transaction_id: null }),
        }),
        'none',
      )
    },
  )

  await check(
    'scan order: an unbound code past 24h at the scan is expired (pending or already flipped); 23h59m is not',
    async () => {
      const kindAt = async (status: string, ageMs: number) =>
        (
          await loadScanOrder(
            makeDb({
              arrivals: [],
              order: {
                referralRef: 'sc_abc',
                tap: tap({
                  status,
                  reconciled_transaction_id: null,
                  received_at: at(-ageMs).toISOString(),
                }),
              },
            }).client,
            ORDER_SCAN,
          )
        ).kind
      assert.equal(
        await kindAt('pending', 24 * 60 * MINUTE + SECOND),
        'expired',
      )
      assert.equal(await kindAt('expired', 25 * 60 * MINUTE), 'expired')
      assert.equal(await kindAt('pending', 24 * 60 * MINUTE - MINUTE), 'none')
    },
  )

  await check(
    'ruling Q2: a receipt scan with a bound order is greeted after hours; one without an order is not',
    async () => {
      // 16:30 in Los Angeles, after the 3 PM close.
      const late = new Date('2026-09-20T23:30:00.000Z')
      const row = scanRow({
        scanned_at: late.toISOString(),
        awaits_passport: true,
        passport_settled_at: late.toISOString(),
      })
      const pending = {
        ...PENDING,
        scannedAt: late,
        awaitsPassport: true,
        passportSettledAt: late,
      }
      const bound = makeDb({
        arrivals: [row],
        order: {
          referralRef: 'sc_abc',
          tap: tap(),
          transaction: txn(),
          stamp: null,
        },
      })
      await processScanArrival(
        bound.client,
        pending,
        new Date(late.getTime() + 20 * SECOND),
      )
      assert.equal(bound.stats.claimWins, 1)

      const expired = makeDb({
        arrivals: [row],
        order: {
          referralRef: 'sc_abc',
          tap: tap({
            status: 'expired',
            reconciled_transaction_id: null,
            received_at: new Date(
              late.getTime() - 25 * 60 * MINUTE,
            ).toISOString(),
          }),
        },
      })
      await processScanArrival(
        expired.client,
        pending,
        new Date(late.getTime() + 20 * SECOND),
      )
      assert.equal(expired.arrivals[0]?.outcome, 'venue_closed')
      assert.equal(expired.stats.claimWins, 0)
    },
  )

  // ---------------------------------------------------------------------------
  // TAC-588: the item question
  // ---------------------------------------------------------------------------

  await check(
    'item question timing: scans at order +2, +15, +28 min, +3 h and +20 h (hello 10 s after each scan)',
    () => {
      const order = SCAN
      const dueFor = (scanAfterOrderMs: number) =>
        scanItemQuestionDueAt({
          orderedAt: order,
          helloAt: at(scanAfterOrderMs + 10 * SECOND),
        })
      // +2: the order + 20 wins.
      assert.deepEqual(dueFor(2 * MINUTE), at(20 * MINUTE))
      // +15: hello at 15:10, so hello + 5 = 20:10 wins.
      assert.deepEqual(dueFor(15 * MINUTE), at(20 * MINUTE + 10 * SECOND))
      // +28: hello + 5 = 33:10.
      assert.deepEqual(dueFor(28 * MINUTE), at(33 * MINUTE + 10 * SECOND))
      // Late scans: always hello + 5.
      assert.deepEqual(
        dueFor(3 * 60 * MINUTE),
        at(3 * 60 * MINUTE + 5 * MINUTE + 10 * SECOND),
      )
      assert.deepEqual(
        dueFor(20 * 60 * MINUTE),
        at(20 * 60 * MINUTE + 5 * MINUTE + 10 * SECOND),
      )
    },
  )

  await check('item question gives up 2 h after it was due, not at 2 h', () => {
    const due = at(20 * MINUTE)
    assert.equal(
      isScanItemQuestionTooLate(due, at(20 * MINUTE + 2 * 60 * MINUTE)),
      false,
    )
    assert.equal(
      isScanItemQuestionTooLate(
        due,
        at(20 * MINUTE + 2 * 60 * MINUTE + SECOND),
      ),
      true,
    )
  })

  await check(
    "spacing: only this scan's own hello is exempt, not a message from before the scan",
    () => {
      const late = at(20 * 60 * MINUTE)
      assert.equal(
        lastProactiveWasThisScan(at(20 * 60 * MINUTE + 10 * SECOND), late),
        true,
      )
      assert.equal(lastProactiveWasThisScan(late, late), true)
      // A warm close from the night before is not this visit, even though it
      // is after the order: the order-anchored rule would have excused it.
      assert.equal(lastProactiveWasThisScan(at(10 * 60 * MINUTE), late), false)
      assert.equal(lastProactiveWasThisScan(null, late), false)
    },
  )

  await check(
    'reply turns: a receipt-scan visit lasts 2 h from its hello; the reply path closes once the timer has sent',
    () => {
      const hello = at(20 * SECOND)
      const at1h = resolveScanOrderVisit({
        helloAt: hello,
        itemQuestionSentAt: null,
        inboundAt: at(60 * MINUTE),
      })
      assert.deepEqual(at1h, { known: true, likedAt: hello })
      const afterTimer = resolveScanOrderVisit({
        helloAt: hello,
        itemQuestionSentAt: at(20 * MINUTE),
        inboundAt: at(30 * MINUTE),
      })
      assert.deepEqual(afterTimer, { known: true, likedAt: null })
      const tooLate = resolveScanOrderVisit({
        helloAt: hello,
        itemQuestionSentAt: null,
        inboundAt: at(20 * SECOND + 2 * 60 * MINUTE + SECOND),
      })
      assert.deepEqual(tooLate, { known: false, likedAt: null })
    },
  )

  await check(
    "counter flow's 'they named it' arming is off on a receipt-scan visit, and unchanged without one",
    () => {
      const base = {
        scanAt: SCAN,
        guestCreatedVia: 'instagram',
        guestCreatedAt: at(-60 * MINUTE),
        inboundAt: at(MINUTE),
        mentionsMenuItem: true,
        answeringOurQuestion: true,
        alreadyAskedThisVisit: false,
      }
      assert.deepEqual(resolveSameVisitOrderAt(base), at(MINUTE))
      assert.equal(
        resolveSameVisitOrderAt({ ...base, scanOrderKnown: true }),
        null,
      )
    },
  )

  await check(
    'approval: nothing set auto-sends; only an explicit hold holds; visitCheckback is not read',
    () => {
      assert.equal(resolveScanItemQuestionDisposition(null), 'auto_send')
      assert.equal(
        resolveScanItemQuestionDisposition({
          default: 'auto_send',
          perCategory: {},
          visitCheckback: 'operator_approval',
        }),
        'auto_send',
      )
      assert.equal(
        resolveScanItemQuestionDisposition({
          default: 'auto_send',
          perCategory: {},
          scanItemQuestion: 'operator_approval',
        }),
        'operator_approval',
      )
    },
  )

  await check(
    'item question wording: names the item, bans the two tenses',
    () => {
      const text = scanItemQuestionInstructions('Oat\n  Cortado')
      assert.match(text, /how they liked the Oat Cortado,/)
      assert.match(text, /Don't say "how is it" or "how was it"/)
      assert.match(text, /still finishing it or have already left/)
    },
  )

  const greeted = (over: Row = {}): Row =>
    scanRow({
      claimed_at: at(20 * SECOND).toISOString(),
      venue_local_date: '2026-09-20',
      outcome: 'greeted',
      resolved_at: at(20 * SECOND).toISOString(),
      item_question_due_at: at(20 * MINUTE).toISOString(),
      ...over,
    })

  await check('item question timer: not read before it is due', async () => {
    const db = makeDb({ arrivals: [greeted()] })
    const tick = await processDueScanItemQuestions(at(19 * MINUTE), db.client)
    assert.equal(tick.scanned, 0)
    assert.equal(db.arrivals[0]?.item_question_claimed_at, null)
  })

  await check(
    'a guest reply after the hello cancels the timer for good: claimed, never sent',
    async () => {
      const db = makeDb({
        arrivals: [greeted()],
        messages: [inbound(5 * MINUTE)],
      })
      const tick = await processDueScanItemQuestions(at(21 * MINUTE), db.client)
      assert.equal(tick.skipped.guest_replied, 1)
      assert.equal(
        db.arrivals[0]?.item_question_claimed_at,
        at(21 * MINUTE).toISOString(),
      )
      assert.equal(db.arrivals[0]?.item_question_sent_at, null)
      const again = await processDueScanItemQuestions(
        at(22 * MINUTE),
        db.client,
      )
      assert.equal(again.scanned, 0)
    },
  )

  await check(
    'a reply BEFORE the hello (the scan delay) does not cancel it; held past 2 h it is given up',
    async () => {
      const before = makeDb({
        arrivals: [greeted()],
        messages: [inbound(5 * SECOND)],
      })
      const tick = await processDueScanItemQuestions(
        at(21 * MINUTE),
        before.client,
      )
      assert.equal(tick.skipped.guest_replied, undefined)

      const late = makeDb({ arrivals: [greeted()] })
      const lateTick = await processDueScanItemQuestions(
        at(20 * MINUTE + 2 * 60 * MINUTE + SECOND),
        late.client,
      )
      assert.equal(lateTick.skipped.too_late, 1)
      assert.equal(late.arrivals[0]?.item_question_sent_at, null)
    },
  )

  console.log(lines.join('\n'))
  const total = lines.length
  console.log(
    failed > 0
      ? `HARNESS FAILED: ${failed} of ${total} checks`
      : `HARNESS PASSED: ${total} checks`,
  )
  process.exitCode = failed > 0 ? 1 : 0
}

void main()
