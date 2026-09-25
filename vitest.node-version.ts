// Fail the run when the Node major differs from .nvmrc (2026-09-25).
//
// WHY THIS EXISTS. Before it, this repo had no `.nvmrc`, no `engines` field,
// and `.github/workflows/ci.yml` hardcoded `node-version: 20` while local
// development ran v24 — a three-way skew with nothing enforcing it, on a
// runtime that reached end-of-life in April 2026. A test can pass on one major
// and fail on another, and the failure reads as a broken branch rather than a
// broken environment.
//
// The sibling repo already paid for this lesson and is where the pattern comes
// from: analog-operator/jest.node-version.js, written after TAC-427, when a
// test hung on CI's Node and passed locally — CI sat in its Test step for six
// hours a day for three days before anyone found it. A loud failure in the
// first second is worth a great deal more than a silent difference.
//
// `.nvmrc` is the single source of truth: `nvm use` reads it, CI reads it via
// `node-version-file`, and this asserts it. Changing the version is a one-line
// edit to that file.
//
// MAJOR ONLY, deliberately. Pinning a patch would fail every developer whose
// nvm is a fortnight stale, and the failures this guards against are
// major-version behaviour differences, not patch ones.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Pure so it can be tested without spawning a process on another Node.
 *
 * Returns an error string, or null when the versions agree. Returning rather
 * than throwing keeps the decision and the reporting separate — the caller
 * owns how a run dies.
 */
export function checkNodeVersion(runningVersion: string, nvmrcContents: string): string | null {
  const wanted = nvmrcContents.trim().replace(/^v/, '').split('.')[0]
  const running = runningVersion.replace(/^v/, '').split('.')[0]
  if (wanted === '' || running === '') {
    return `Could not compare Node versions: .nvmrc="${nvmrcContents.trim()}", running="${runningVersion}"`
  }
  if (wanted === running) return null
  return [
    `Node major mismatch: running v${running}, .nvmrc wants v${wanted}.`,
    '',
    `  nvm use            # reads .nvmrc`,
    `  nvm install ${wanted}     # if you do not have it yet`,
    '',
    'Tests are not run on a different major than CI: a pass here would not mean a pass there.',
  ].join('\n')
}

export default function setup(): void {
  const nvmrc = readFileSync(join(__dirname, '.nvmrc'), 'utf8')
  const problem = checkNodeVersion(process.version, nvmrc)
  if (problem !== null) throw new Error(problem)
}
