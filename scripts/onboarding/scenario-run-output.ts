import { existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// TAC-481. Implements TAC-426's output properties (never overwrite a prior
// run by default, checkpoint per unit) FOR THIS HARNESS specifically, not as
// TAC-426's own shared helper — that ticket is still Ready, unbuilt. When it
// ships, this module is a natural first caller to migrate onto it.
//
// Output is evidence of a specific run, not source: JSON-Lines under
// scripts/onboarding/scenario-runs/ (gitignored, mirrors scripts/sandbox/'s
// existing entry), one line per header/result so a run interrupted partway
// leaves every completed scenario readable.

export interface ScenarioRunHeader {
  promptVersion: string
  gitSha: string
  model: string
  generatedAt: string
  venueSlug: string
  guestState: string
}

/**
 * Deterministic, collision-resistant default path for one run: an ISO
 * timestamp with colons/dots replaced by dashes so it's filesystem-safe on
 * every platform, plus milliseconds so two runs started in the same second
 * (e.g. a test) still get distinct files.
 */
export function defaultOutputPath(now: Date): string {
  const iso = now.toISOString().replace(/[:.]/g, '-')
  return `scripts/onboarding/scenario-runs/run-${iso}.jsonl`
}

/**
 * Mirrors seed-venue's hard-refuse-then---force shape (CLAUDE.md cites this
 * exact pattern for TAC-426): never silently overwrite a prior run's
 * evidence. `--out` with an existing path and no `--force` is a mistake, not
 * an intent to destroy.
 */
export function refuseExistingUnlessForced(path: string, force: boolean): void {
  if (existsSync(path) && !force) {
    throw new Error(
      `scenario-run-output: refusing to overwrite existing run file "${path}" — pass --force to overwrite, or omit --out to write a fresh timestamped file.`,
    )
  }
}

/** Creates the file (and parent dir) with the header as the first JSON-Lines row. */
export function writeHeader(path: string, header: ScenarioRunHeader): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ kind: 'header', ...header })}\n`)
}

/**
 * Appends one scenario result as its own JSON-Lines row — the checkpoint
 * property. A run interrupted after N scenarios leaves exactly N readable
 * result rows behind it, never a half-written file.
 */
export function appendResult(path: string, result: unknown): void {
  appendFileSync(path, `${JSON.stringify({ kind: 'result', ...toRecord(result) })}\n`)
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object') return value as Record<string, unknown>
  return { value }
}
