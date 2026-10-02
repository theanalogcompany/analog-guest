/**
 * generation-latency-score.ts — the pure half of the generation-latency
 * probe (generation-latency.ts). No `@/*` imports, per the scripts
 * module-split convention, so the aggregation and the arm-integrity rules
 * need no SDK init.
 *
 * WHY THIS EXISTS. Production `generate` latency (p50 ~6s) decomposes as
 * TTFT + decode, but `generateObject` is non-streaming so no trace records
 * TTFT — a regression over Langfuse observations could only estimate the
 * split (2026-09-30: ~2.8s fixed + ~19ms/output-token, n=55). The probe
 * measures it directly by streaming the same composed prompt per arm.
 *
 * Arm integrity (harness convention points 5 and 9):
 * - a failed call DISQUALIFIES its cell — an errored unit produces no
 *   verdict, and a cell averaging only its survivors flatters the arm that
 *   crashed;
 * - a warm cell must prove it actually read cache, and a cold cell must
 *   prove it did not. A "warm" arm with zero cache reads is measuring the
 *   same thing as its control, and the delta between them is then noise
 *   read as signal.
 */

export type SchemaArm = 'full' | 'slim'
export type CacheArm = 'cold' | 'warm'

export interface ProbeUnit {
  model: string
  schemaArm: SchemaArm
  cacheArm: CacheArm
  ok: boolean
  error: string | null
  ttftMs: number | null
  totalMs: number | null
  outputTokens: number | null
  cacheReadTokens: number
  cacheWriteTokens: number
  uncachedInputTokens: number
}

export interface CellSummary {
  /** `${model} ${schemaArm} ${cacheArm}` — the reporting key. */
  cell: string
  n: number
  failures: number
  valid: boolean
  invalidReason: string | null
  medianTtftMs: number | null
  medianTotalMs: number | null
  medianOutputTokens: number | null
  /** Median of per-unit decode rates, not a rate of medians. */
  medianDecodeTokPerSec: number | null
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * Per-unit decode rate: output tokens over the time spent after the first
 * token arrived. Null when the unit lacks a usable split — a TTFT at or
 * past the total (a one-chunk response) has no decode window to rate.
 */
export function decodeTokPerSec(unit: ProbeUnit): number | null {
  if (
    unit.ttftMs === null ||
    unit.totalMs === null ||
    unit.outputTokens === null
  )
    return null
  const decodeMs = unit.totalMs - unit.ttftMs
  if (decodeMs <= 0) return null
  return unit.outputTokens / (decodeMs / 1000)
}

function cellKey(u: ProbeUnit): string {
  return `${u.model} ${u.schemaArm} ${u.cacheArm}`
}

export function summarizeCells(units: readonly ProbeUnit[]): CellSummary[] {
  const byCell = new Map<string, ProbeUnit[]>()
  for (const u of units) {
    const key = cellKey(u)
    const existing = byCell.get(key)
    if (existing) existing.push(u)
    else byCell.set(key, [u])
  }

  return Array.from(byCell.entries()).map(([cell, cellUnits]) => {
    const okUnits = cellUnits.filter((u) => u.ok)
    const failures = cellUnits.length - okUnits.length

    let invalidReason: string | null = null
    if (failures > 0) {
      invalidReason = `${failures} failed call(s) disqualify the cell`
    } else if (okUnits.length === 0) {
      invalidReason = 'no calls recorded'
    } else {
      const cacheArm = cellUnits[0]!.cacheArm
      if (cacheArm === 'warm' && okUnits.some((u) => u.cacheReadTokens <= 0)) {
        invalidReason =
          'a warm call read no cache; arm does not differ from cold'
      } else if (
        cacheArm === 'cold' &&
        okUnits.some((u) => u.cacheReadTokens > 0)
      ) {
        invalidReason = 'a cold call read cache; arm does not differ from warm'
      }
    }

    const nums = (f: (u: ProbeUnit) => number | null): number[] =>
      okUnits.map(f).filter((v): v is number => v !== null)

    return {
      cell,
      n: cellUnits.length,
      failures,
      valid: invalidReason === null,
      invalidReason,
      medianTtftMs: median(nums((u) => u.ttftMs)),
      medianTotalMs: median(nums((u) => u.totalMs)),
      medianOutputTokens: median(nums((u) => u.outputTokens)),
      medianDecodeTokPerSec: median(nums((u) => decodeTokPerSec(u))),
    }
  })
}

export function formatReport(cells: readonly CellSummary[]): string {
  const lines = [
    'cell                                               n  ttft(ms)  total(ms)  out(tok)  decode(tok/s)',
  ]
  for (const c of cells) {
    const fmt = (v: number | null): string =>
      v === null ? '—' : String(Math.round(v))
    const row = `${c.cell.padEnd(49)} ${String(c.n).padStart(2)}  ${fmt(c.medianTtftMs).padStart(8)}  ${fmt(c.medianTotalMs).padStart(9)}  ${fmt(c.medianOutputTokens).padStart(8)}  ${fmt(c.medianDecodeTokPerSec).padStart(13)}`
    lines.push(c.valid ? row : `${row}  INVALID: ${c.invalidReason}`)
  }
  return lines.join('\n')
}
