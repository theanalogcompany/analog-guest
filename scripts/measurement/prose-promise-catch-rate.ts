// TAC-401: what does the prose-promise check actually catch?
//
// A REPLAY against fixed bodies, not a new generation run. Ruling 3
// (2026-09-15) was "decide on current evidence", and the evidence already
// exists: the 220 synthetic replies from the 2026-09-15 measurement, every one
// of them hand-read against the frozen definition and its extensions. Replaying
// is cheap, re-runnable whenever this check's prompt changes, and it isolates
// the check as the only variable — the bodies cannot drift underneath it the
// way a fresh generation's would.
//
// WHAT IT REPORTS, and the shape is the ruling (2026-09-21, ruling 4):
//
//   - FOUR CASES, NOT A RATE. Each of the four genuine uncarried promises on
//     its own line with its arm. At n=4 an aggregate would read as a precision
//     the measurement does not have, and three of the four were caught in
//     production only by checks that are not commitment controls.
//   - FALSE POSITIVES PER CATEGORY, never as one number. An apology idiom
//     ("that one was on us to get right") and a reply that offers nothing
//     ("we'll do better") fail for different reasons and have different fixes.
//   - N REPEATS PER BODY. The check runs at temperature 0.2, so one verdict is
//     a draw from a distribution, not a property of the body (the TAC-409
//     lesson). Every body is replayed N times and reported as a hold rate.
//   - THE OUTPUT-TOKEN DISTRIBUTION is not observable here — generateObject
//     does not surface usage through this path — so the cap is checked instead
//     by the truncation count, which is reported and should be zero.
//
// BOTH FAIL-OPEN PATHS THE RULING NAMED ARE COVERED BY THE POSITIVES
// THEMSELVES, not by a separate arm: three of the four are on the
// eligible-perks path (A2, where the explicit no-comps line does not render)
// and one is on a followup (A4, an engine day_3). Each is reported with its
// arm, so neither path can be read as covered when it is not.
//
// NOT COVERED HERE, deliberately: the fail-closed branch. A replay against a
// live model produces `check_failed` only by accident, and a count of zero
// would say nothing about it. It is exercised by injected faults in
// lib/agent/stages.test.ts instead.
//
// PRODUCTION BODIES ARE NOT IN THE FIXTURE AND MUST NEVER BE ADDED — this
// repo is public. The R pass of the original measurement read production
// locally and reported counts only; anything of that kind stays local.
//
// TELEMETRY: this calls lib/ai/verify-prose-promise.ts directly, not the
// stage, so it fires no PostHog event and no Slack relay. It also means the
// stage's skip conditions and its retry are NOT exercised here; what is under
// test is the check's judgement, which is the thing a prompt change moves.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { verifyProsePromise, VERIFY_PROSE_PROMISE_PROMPT_VERSION } from '@/lib/ai/verify-prose-promise'
import { createRunLog } from './run-log'

/** Repeats per body. One verdict at temperature 0.2 is a draw, not a property. */
const REPEATS = Number(process.env.REPEATS ?? '5')
/** Bodies judged concurrently. Keeps the run to a few minutes without 429s. */
const CONCURRENCY = Number(process.env.CONCURRENCY ?? '6')

type Label =
  | 'genuine_promise'
  | 'apology_idiom'
  | 'offers_nothing'
  | 'do_better_borderline'
  | 'clean'

interface FixtureRow {
  arm: string
  run: number
  label: Label
  body: string
  priorSignals: {
    carrier: boolean
    grounding: string
    mechanicOffer: string
    compRegex: boolean
    selfFlag: boolean
    forwardCommitmentGrammar: boolean
    liveAction: string
    fleetAction: string
  }
}

interface Fixture {
  source: string
  note: string
  armDescriptions: Record<string, string>
  labels: Record<string, string>
  rows: FixtureRow[]
}

interface Verdict {
  flagged: boolean
  namedCarrier: boolean
  commitmentType: string | null
  commitmentDescription: string | null
  failed: boolean
  truncated: boolean
}

async function judgeOnce(body: string): Promise<Verdict> {
  // TAC-527: body-only, deliberately. These 220 fixtures carry no inbound, so
  // passing null keeps this run byte-comparable with TAC-401's baseline. The
  // cost is stated rather than buried: on the inbound path they no longer
  // describe the shipped configuration. The inbound-bearing cases live in the
  // sibling scripts/measurement/prose-promise-elliptical.ts, not below.
  const r = await verifyProsePromise({ replyBody: body, guestInboundBody: null })
  if (!r.ok) {
    return {
      flagged: false,
      namedCarrier: false,
      commitmentType: null,
      commitmentDescription: null,
      failed: true,
      truncated: r.errorCode === 'ai_verify_prose_promise_truncated',
    }
  }
  return {
    flagged: r.data.promisesSomething,
    namedCarrier: r.data.commitmentType !== null,
    commitmentType: r.data.commitmentType,
    commitmentDescription: r.data.commitmentDescription,
    failed: false,
    truncated: false,
  }
}

interface RowResult {
  row: FixtureRow
  verdicts: Verdict[]
  flaggedCount: number
  failedCount: number
}

async function judgeRow(row: FixtureRow): Promise<RowResult> {
  const verdicts: Verdict[] = []
  for (let i = 0; i < REPEATS; i++) {
    verdicts.push(await judgeOnce(row.body))
  }
  return {
    row,
    verdicts,
    flaggedCount: verdicts.filter((v) => v.flagged).length,
    failedCount: verdicts.filter((v) => v.failed).length,
  }
}

/** Run `work` over `items` with a fixed number of workers. */
async function pooled<T, R>(items: T[], size: number, work: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await work(items[i]!)
      }
    }),
  )
  return out
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(0)}%`
}

async function main(): Promise<void> {
  const fixturePath = join(
    process.cwd(),
    'scripts/measurement/fixtures/prose-promise-replies.json',
  )
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture

  const log = createRunLog({
    name: 'prose-promise-catch-rate',
    outputPath: process.env.OUTPUT_PATH,
    meta: {
      arm: 'replay',
      promptVersion: VERIFY_PROSE_PROMISE_PROMPT_VERSION,
      repeats: REPEATS,
      concurrency: CONCURRENCY,
      fixture: 'scripts/measurement/fixtures/prose-promise-replies.json',
      fixtureSource: fixture.source,
      rowCount: fixture.rows.length,
    },
  })

  console.log(
    `[replay] ${fixture.rows.length} bodies x ${REPEATS} repeats = ${fixture.rows.length * REPEATS} calls`,
  )
  console.log(`[replay] prompt ${VERIFY_PROSE_PROMISE_PROMPT_VERSION}`)
  console.log(`[replay] writing ${log.path}`)

  let done = 0
  const results = await pooled(fixture.rows, CONCURRENCY, async (row) => {
    const result = await judgeRow(row)
    // Checkpoint per body, not per run — the expensive half is the model
    // calls, and a late throw in the cheap half must not lose them.
    log.appendUnit({
      arm: row.arm,
      run: row.run,
      label: row.label,
      body: row.body,
      priorSignals: row.priorSignals,
      flaggedCount: result.flaggedCount,
      failedCount: result.failedCount,
      repeats: REPEATS,
      verdicts: result.verdicts,
    })
    done += 1
    if (done % 20 === 0) console.log(`[replay] ${done}/${fixture.rows.length}`)
    return result
  })

  const byLabel = (l: Label) => results.filter((r) => r.row.label === l)

  console.log('\n=== The four cases (ruling 4: four cases, not a rate) ===')
  for (const r of byLabel('genuine_promise')) {
    const types = [...new Set(r.verdicts.filter((v) => v.flagged).map((v) => v.commitmentType))]
    const named = r.verdicts.filter((v) => v.flagged && v.namedCarrier).length
    console.log(
      `\n  ${r.row.arm} #${r.row.run}  held ${r.flaggedCount}/${REPEATS}, named a carrier ${named}/${REPEATS}  types: ${types.join(', ') || 'none'}`,
    )
    console.log(`     body: ${r.row.body}`)
    console.log(
      `     before this check: grounding=${r.row.priorSignals.grounding} mechanic=${r.row.priorSignals.mechanicOffer} regex=${r.row.priorSignals.compRegex} selfFlag=${r.row.priorSignals.selfFlag} -> live ${r.row.priorSignals.liveAction}, fleet ${r.row.priorSignals.fleetAction}`,
    )
    const example = r.verdicts.find((v) => v.flagged && v.namedCarrier)
    if (example !== undefined) {
      console.log(
        `     names: ${example.commitmentType} / "${example.commitmentDescription}"`,
      )
    }
  }

  console.log('\n=== False positives, per category (never one number) ===')
  for (const label of ['apology_idiom', 'offers_nothing', 'do_better_borderline'] as Label[]) {
    const rows = byLabel(label)
    const totalCalls = rows.length * REPEATS
    const flagged = rows.reduce((a, r) => a + r.flaggedCount, 0)
    console.log(`\n  ${label}: ${flagged}/${totalCalls} calls flagged (${pct(flagged, totalCalls)})`)
    for (const r of rows.filter((r) => r.flaggedCount > 0)) {
      console.log(`     ${r.row.arm} #${r.row.run}  ${r.flaggedCount}/${REPEATS}  ${r.row.body}`)
    }
  }

  const clean = byLabel('clean')
  const cleanCalls = clean.length * REPEATS
  const cleanFlagged = clean.reduce((a, r) => a + r.flaggedCount, 0)
  console.log(
    `\n  clean (${clean.length} bodies): ${cleanFlagged}/${cleanCalls} calls flagged (${pct(cleanFlagged, cleanCalls)})`,
  )
  for (const r of clean.filter((r) => r.flaggedCount > 0)) {
    console.log(`     ${r.row.arm} #${r.row.run}  ${r.flaggedCount}/${REPEATS}  ${r.row.body}`)
  }

  console.log('\n=== By arm: both fail-open paths ===')
  for (const arm of Object.keys(fixture.armDescriptions)) {
    const rows = results.filter((r) => r.row.arm === arm)
    const genuine = rows.filter((r) => r.row.label === 'genuine_promise')
    const flaggedBodies = rows.filter((r) => r.flaggedCount > 0).length
    console.log(
      `  ${arm.padEnd(4)} ${rows.length} bodies, ${genuine.length} genuine, ${flaggedBodies} flagged at least once  (${fixture.armDescriptions[arm]})`,
    )
  }

  const failed = results.reduce((a, r) => a + r.failedCount, 0)
  const truncated = results.reduce(
    (a, r) => a + r.verdicts.filter((v) => v.truncated).length,
    0,
  )
  console.log(
    `\n=== Check health ===\n  failed calls: ${failed}/${results.length * REPEATS}  (truncated: ${truncated})`,
  )
  console.log(`\n[replay] wrote ${log.path}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
