// TAC-423: re-score a first-touch run log with the CURRENT detector.
//
// The run log stores every body verbatim, which is what makes this possible:
// the detector's contraction gap was found mid-run, and the fix is applied to
// data already generated rather than paid for again in model calls. The
// `isOrderQuestion` written into the log is whatever the detector believed at
// generation time; this is the authority.

import { readFileSync } from 'node:fs'
import { classifyFirstTouchReply } from './first-touch-question-detector'

const path = process.argv[2]
if (!path) {
  console.error('usage: tsx scripts/measurement/first-touch-question-score.ts <run-log.jsonl>')
  process.exit(2)
}

interface Row {
  __meta__?: boolean
  scenarioId?: string
  arm?: string
  body?: string | null
  invalid?: string
}

const rows: Row[] = readFileSync(path, 'utf8')
  .split('\n')
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as Row)

const meta = rows.find((r) => r.__meta__)
const units = rows.filter((r) => !r.__meta__)

const tally = new Map<string, { n: number; q: number; o: number; implied: number; invalid: number; noBody: number }>()
const key = (r: Row) => `${r.scenarioId}|${r.arm}`
for (const r of units) {
  const t = tally.get(key(r)) ?? { n: 0, q: 0, o: 0, implied: 0, invalid: 0, noBody: 0 }
  if (r.invalid) t.invalid += 1
  else if (!r.body) t.noBody += 1
  else {
    const v = classifyFirstTouchReply(r.body)
    t.n += 1
    if (v.hasQuestion) t.q += 1
    if (v.isOrderQuestion) t.o += 1
    if (!v.hasQuestion && v.impliedAsk) t.implied += 1
  }
  tally.set(key(r), t)
}

console.log(`run: ${path}`)
console.log(`prompt version at generation: ${String(meta?.['promptVersion' as keyof Row] ?? '?')}`)
console.log(`units: ${units.length}\n`)
const pct = (x: number, n: number) => (n ? `${x}/${n} (${Math.round((100 * x) / n)}%)` : '0/0')
for (const [k, t] of [...tally.entries()].sort()) {
  const [scenario, arm] = k.split('|')
  console.log(
    `${(scenario ?? '').padEnd(22)} ${(arm ?? '').padEnd(7)} asks anything ${pct(t.q, t.n).padEnd(15)} asks the order ${pct(t.o, t.n).padEnd(15)}` +
      `${t.implied ? ` implied-only ${t.implied}` : ''}${t.invalid ? ` INVALID ${t.invalid}` : ''}${t.noBody ? ` no-body ${t.noBody}` : ''}`,
  )
}
