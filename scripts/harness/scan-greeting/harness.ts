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
import {
  isScanGreetingDue,
  msUntilScanGreetingDue,
  SCAN_CARRY_FORWARD_MS,
  SCAN_FAST_PATH_WAKE_MARGIN_MS,
  SCAN_GREETING_CARRY_FORWARD_MS,
  SCAN_GREETING_DELAY_MS,
  SCAN_GREETING_MAX_AGE_MS,
  scanCarryForwardAt,
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
    const builder = {
      eq(column: string, value: Value) {
        filters.push([column, value])
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
      async select() {
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

  function messagesSelect() {
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
        case 'venues':
          return { select: () => single(() => ({ ...venue })) }
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
}

/** A clock that advances by exactly what was slept. */
function fakeClock(start: Date) {
  let now = start.getTime()
  const slept: number[] = []
  return {
    slept,
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
    assert.equal(isScanGreetingDue(SCAN, at(19 * SECOND)), false)
    assert.equal(isScanGreetingDue(SCAN, at(20 * SECOND)), true)
  })

  await check(
    'msUntilScanGreetingDue: fresh, half elapsed, already due, capped, invalid',
    () => {
      assert.equal(msUntilScanGreetingDue(SCAN, SCAN), 20 * SECOND)
      assert.equal(msUntilScanGreetingDue(SCAN, at(10 * SECOND)), 10 * SECOND)
      assert.equal(msUntilScanGreetingDue(SCAN, at(25 * SECOND)), 0)
      assert.equal(msUntilScanGreetingDue(at(10 * MINUTE), SCAN), 40 * SECOND)
      assert.equal(msUntilScanGreetingDue(new Date(NaN), SCAN), 0)
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
      await runScanGreetingFastPath(
        db.client,
        { id: 'a1', scannedAt: SCAN },
        clock.deps,
      )
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
        { id: 'a1', scannedAt: SCAN },
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
        { id: 'a1', scannedAt: SCAN },
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
      const scheduled = { id: 'a1', scannedAt: scan }

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
            { id: 'a1', scannedAt: SCAN },
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
              { id, scannedAt: SCAN },
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
        { id: 'a1', scannedAt: SCAN },
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
    await runScanGreetingFastPath(
      db.client,
      { id: 'a1', scannedAt: SCAN },
      fakeClock(SCAN).deps,
    )
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
        { id: 'a1', scannedAt: SCAN },
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
        { id: 'a1', scannedAt: ahead },
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
        { id: 'a1', scannedAt: SCAN },
        fakeClock(SCAN).deps,
      )
      assert.equal(db.stats.updates, 0)
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
