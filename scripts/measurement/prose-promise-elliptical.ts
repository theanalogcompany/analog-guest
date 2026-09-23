// TAC-527: does handing the prose-promise check the guest's message let it
// catch an elliptical promise, WITHOUT making anything else flaggable?
//
// Verifier-only, like its two siblings. It calls lib/ai/verify-prose-promise.ts
// directly against hand-built, self-contained pairs: no database, no venue
// lookup, no generation, no send, and the bodies cannot drift underneath the
// thing being measured. Needs ANTHROPIC_API_KEY, so it cannot run in CI, the
// same posture as prose-promise-catch-rate.ts.
//
// TWO ARMS, ONE VARIABLE: whether the guest's message is supplied.
//
//   with_inbound  what production does now
//   body_only     guestInboundBody: null, reproducing the input a pre-TAC-527
//                 call had
//
// BE PRECISE ABOUT THE CONTROL ARM, because it is easy to overclaim. It runs
// against the v1.1.0 SYSTEM PROMPT, so it is "new prompt, no guest message",
// never a measurement of v1.0.0. That is the right control — the new rule is
// explicitly conditional on the guest's message being present, so with no
// message it has no referent — but the distinction belongs in any report of
// these numbers. Same caveat channel-self-reference-replay.ts carries.
//
// WHY THE CONTROL ARM EXISTS AT ALL: if body_only already flags the elliptical
// rows, this replay has not reproduced the defect and can say nothing about
// whether the fix addressed it. A silently broken arm produces exactly the
// "the fix works" shape.
//
// THE TWO ARMS ARE HELD TO DIFFERENT CRITERIA, deliberately:
//
//   - with_inbound is the claim under test and is STRICT. Every repeat must go
//     the expected way. A 6/10 reported as a pass hides the "no stable verdict
//     at all" case TAC-409 found.
//   - body_only on an elliptical row only has to REPRODUCE the defect: stay
//     clean on most repeats. The miss is a probabilistic verdict at
//     temperature 0.2, not a deterministic rule.
//   - body_only on a MUST-STAY-CLEAN row is strict. Those rows test rules that
//     should not depend on chance, in either arm.
//
// A FAILED CALL IS NOT A RESULT. A call that errored produces no verdict, and a
// run that counted it as "did not flag" would score a wholly broken run as a
// clean one — TAC-502's replay hit exactly that. Any row with a failed call
// fails its expectation whatever its flag count reads.
//
// PRODUCTION BODIES: none. See the fixture's own note for the one row whose
// shape comes from the operator's own device test.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  verifyProsePromise,
  VERIFY_PROSE_PROMISE_PROMPT_VERSION,
} from '@/lib/ai/verify-prose-promise'
import { createRunLog } from './run-log'

const REPEATS = Number(process.env.REPEATS ?? '10')
const CONCURRENCY = Number(process.env.CONCURRENCY ?? '4')

type Label =
  | 'elliptical_promise'
  | 'explicit_promise'
  | 'apology_no_item'
  | 'on_us_unrelated_item'
  | 'clean'
type Arm = 'with_inbound' | 'body_only'

const ARMS: readonly Arm[] = ['with_inbound', 'body_only']

interface Row {
  id: string
  label: Label
  guestInbound: string
  body: string
}

interface Fixture {
  source: string
  note: string
  labels: Record<string, string>
  rows: Row[]
}

interface Verdict {
  flagged: boolean
  commitmentType: string | null
  commitmentDescription: string | null
  failed: boolean
}

interface Cell {
  row: Row
  arm: Arm
  verdicts: Verdict[]
  flagged: number
  failed: number
}

/**
 * What each arm should do, per label. A total map, so a new label has to state
 * both arms rather than inherit one flag plus a special case.
 *
 *   flag          every repeat flags. The strict criterion.
 *   clean         every repeat stays clean. Strict, both arms: these test rules
 *                 that should not depend on chance.
 *   mostly_clean  the CONTROL criterion for a row the guest's message is
 *                 supposed to be what catches. It only has to reproduce the
 *                 defect, because the miss is a probabilistic verdict at
 *                 temperature 0.2, not a deterministic rule.
 */
type Expectation = 'flag' | 'clean' | 'mostly_clean'

const EXPECTATION = {
  elliptical_promise: { with_inbound: 'flag', body_only: 'mostly_clean' },
  explicit_promise: { with_inbound: 'flag', body_only: 'flag' },
  apology_no_item: { with_inbound: 'clean', body_only: 'clean' },
  on_us_unrelated_item: { with_inbound: 'clean', body_only: 'clean' },
  clean: { with_inbound: 'clean', body_only: 'clean' },
} satisfies Record<Label, Record<Arm, Expectation>>

/** Reproducing the defect needs most repeats clean, not all of them. */
const DEFECT_REPRODUCED_FLOOR = 0.7

async function judge(row: Row, arm: Arm): Promise<Verdict> {
  const r = await verifyProsePromise({
    replyBody: row.body,
    guestInboundBody: arm === 'with_inbound' ? row.guestInbound : null,
  })
  if (!r.ok) {
    return { flagged: false, commitmentType: null, commitmentDescription: null, failed: true }
  }
  return {
    flagged: r.data.promisesSomething,
    commitmentType: r.data.commitmentType,
    commitmentDescription: r.data.commitmentDescription,
    failed: false,
  }
}

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

/**
 * Did this cell meet its criterion? A failed call disqualifies the cell
 * whatever its flag count, per the header.
 */
function verdictOnCell(cell: Cell): { ok: boolean; why: string } {
  if (cell.failed > 0) {
    return { ok: false, why: `${cell.failed} failed call(s), no verdict` }
  }
  switch (EXPECTATION[cell.row.label][cell.arm]) {
    case 'flag':
      return { ok: cell.flagged === REPEATS, why: `expected ${REPEATS}/${REPEATS} flagged` }
    case 'clean':
      return { ok: cell.flagged === 0, why: `expected 0/${REPEATS} flagged` }
    case 'mostly_clean': {
      const floor = Math.ceil(REPEATS * DEFECT_REPRODUCED_FLOOR)
      return {
        ok: REPEATS - cell.flagged >= floor,
        why: `control: expected at least ${floor}/${REPEATS} CLEAN, reproducing the defect`,
      }
    }
  }
}

async function main(): Promise<void> {
  const fixturePath = join(
    process.cwd(),
    'scripts/measurement/fixtures/prose-promise-elliptical.json',
  )
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture

  const log = createRunLog({
    name: 'prose-promise-elliptical',
    outputPath: process.env.OUTPUT_PATH,
    meta: {
      arm: 'two-arm: with_inbound vs body_only',
      promptVersion: VERIFY_PROSE_PROMISE_PROMPT_VERSION,
      repeats: REPEATS,
      concurrency: CONCURRENCY,
      fixture: 'scripts/measurement/fixtures/prose-promise-elliptical.json',
      fixtureSource: fixture.source,
      rowCount: fixture.rows.length,
      controlArmCaveat:
        'body_only runs the v1.1.0 prompt with no guest message. It is NOT a measurement of v1.0.0.',
    },
  })

  const cellsToRun = fixture.rows.flatMap((row) => ARMS.map((arm) => ({ row, arm })))
  console.log(
    `[elliptical] ${fixture.rows.length} rows x ${ARMS.length} arms x ${REPEATS} repeats = ${cellsToRun.length * REPEATS} calls`,
  )
  console.log(`[elliptical] prompt ${VERIFY_PROSE_PROMISE_PROMPT_VERSION}`)
  console.log(`[elliptical] writing ${log.path}`)

  let done = 0
  const cells = await pooled(cellsToRun, CONCURRENCY, async ({ row, arm }) => {
    const verdicts: Verdict[] = []
    for (let i = 0; i < REPEATS; i++) verdicts.push(await judge(row, arm))
    const cell: Cell = {
      row,
      arm,
      verdicts,
      flagged: verdicts.filter((v) => v.flagged).length,
      failed: verdicts.filter((v) => v.failed).length,
    }
    // Checkpoint per cell: the model calls are the expensive half.
    log.appendUnit({
      id: row.id,
      label: row.label,
      arm,
      guestInbound: arm === 'with_inbound' ? row.guestInbound : null,
      body: row.body,
      flagged: cell.flagged,
      failed: cell.failed,
      repeats: REPEATS,
      verdicts,
    })
    done += 1
    if (done % 6 === 0) console.log(`[elliptical] ${done}/${cellsToRun.length} cells`)
    return cell
  })

  const cellFor = (id: string, arm: Arm) =>
    cells.find((c) => c.row.id === id && c.arm === arm)!

  let breaches = 0

  for (const label of Object.keys(EXPECTATION) as Label[]) {
    const rows = fixture.rows.filter((r) => r.label === label)
    if (rows.length === 0) continue
    const e = EXPECTATION[label]
    console.log(
      `\n=== ${label} (${rows.length} rows) — with_inbound: ${e.with_inbound}, body_only: ${e.body_only} ===`,
    )
    for (const row of rows) {
      const withI = cellFor(row.id, 'with_inbound')
      const bodyO = cellFor(row.id, 'body_only')
      const vw = verdictOnCell(withI)
      const vb = verdictOnCell(bodyO)
      if (!vw.ok) breaches += 1
      if (!vb.ok) breaches += 1
      console.log(
        `\n  ${row.id}  with_inbound ${withI.flagged}/${REPEATS} ${vw.ok ? 'PASS' : `FAIL (${vw.why})`}` +
          `   body_only ${bodyO.flagged}/${REPEATS} ${vb.ok ? 'PASS' : `FAIL (${vb.why})`}`,
      )
      console.log(`     guest: ${row.guestInbound}`)
      console.log(`     reply: ${row.body}`)
      const named = withI.verdicts.find((v) => v.flagged && v.commitmentType !== null)
      if (named !== undefined) {
        console.log(`     names: ${named.commitmentType} / "${named.commitmentDescription}"`)
      }
    }
  }

  const failedCalls = cells.reduce((a, c) => a + c.failed, 0)
  const totalCalls = cells.length * REPEATS
  console.log(`\n=== Check health ===`)
  console.log(`  failed calls: ${failedCalls}/${totalCalls}`)
  console.log(`  cells breaching their criterion: ${breaches}/${cells.length}`)
  console.log(
    `\n  Read the bodies, not just the table: a rate cannot tell a correct catch from` +
      `\n  one that named the wrong item. The 'names:' lines above are there for that.`,
  )
  console.log(`\n[elliptical] wrote ${log.path}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
