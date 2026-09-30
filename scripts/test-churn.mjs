#!/usr/bin/env node
// Report-only: which test files cost the most to maintain.
//
// WHY THIS EXISTS. Measured 2026-09: 69% of commits touched at least one test
// file (1,273 test-file touches across 232 commits in 90 days). Every touch is
// a session reading and editing that file, so high-churn test files are the
// recurring cost of the suite - the same shape as the CLAUDE.md mass problem,
// which got a budget rather than deletion. This script is the measurement half
// of "a test pays rent or leaves" (.claude/rules/testing-discipline.md): it
// names the files whose rent is highest, so a consolidation conversation has a
// number instead of a feeling.
//
// IT GATES NOTHING. A busy test file is not a defect - a file guarding the
// approval gate is SUPPOSED to move with every behaviour change. High churn
// means "read this file before adding the next overlapping test here", not
// "delete tests". No PASS/FAIL, no exit code semantics: a report that printed a
// verdict would be a ceiling nobody pre-registered.
//
// Usage: npm run test-churn [-- --days 90] [-- --top 15]

import { execFileSync } from 'node:child_process'

function parseArgs(argv) {
  const args = { days: 90, top: 15 }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--days') args.days = Number(argv[++i])
    else if (argv[i] === '--top') args.top = Number(argv[++i])
    else throw new Error(`unknown flag: ${argv[i]}`)
  }
  if (!Number.isFinite(args.days) || args.days <= 0)
    throw new Error('--days must be positive')
  if (!Number.isFinite(args.top) || args.top <= 0)
    throw new Error('--top must be positive')
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const since = new Date(
    Date.now() - args.days * 24 * 60 * 60 * 1000,
  ).toISOString()

  // One porcelain-free git call: commit hash lines delimit each commit's file
  // list, so counts are per-commit touches, not per-line mentions.
  const log = execFileSync(
    'git',
    ['log', `--since=${since}`, '--name-only', '--pretty=format:%H'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )

  const touches = new Map()
  let commits = 0
  let commitsWithTests = 0
  let sawTestInCommit = false
  for (const line of log.split('\n')) {
    if (line === '') continue
    if (/^[0-9a-f]{40}$/.test(line)) {
      commits += 1
      if (sawTestInCommit) commitsWithTests += 1
      sawTestInCommit = false
      continue
    }
    if (line.endsWith('.test.ts')) {
      touches.set(line, (touches.get(line) ?? 0) + 1)
      sawTestInCommit = true
    }
  }
  if (sawTestInCommit) commitsWithTests += 1

  const ranked = [...touches.entries()].sort((a, b) => b[1] - a[1])
  const totalTouches = ranked.reduce((sum, [, n]) => sum + n, 0)

  console.log(`test-file churn, last ${args.days} days`)
  console.log(
    `commits: ${commits}   touching >=1 test file: ${commitsWithTests}` +
      ` (${commits > 0 ? Math.round((commitsWithTests / commits) * 100) : 0}%)` +
      `   total test-file touches: ${totalTouches}`,
  )
  console.log('')
  console.log(
    'report-only. high churn reads as "read before adding the next test here",',
  )
  console.log(
    'never as "delete" (.claude/rules/testing-discipline.md, "pays rent").',
  )
  console.log('')
  if (ranked.length === 0) {
    console.log('no test files touched in the window.')
    return
  }
  const pad = Math.max(
    ...ranked.slice(0, args.top).map(([path]) => path.length),
  )
  for (const [path, n] of ranked.slice(0, args.top)) {
    console.log(
      `${String(n).padStart(4)}  ${path.padEnd(pad)}  ${'█'.repeat(Math.min(n, 40))}`,
    )
  }
}

main()
