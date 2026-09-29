import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * Generates `docs/testing/README.md`: the shape of the suite per area, and what
 * it deliberately does not cover.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. An earlier version also wrote 26 per-area
 * files listing every test file with a one-line summary. Two controlled
 * experiments killed them. Six subagents, three questions each, control arm on
 * a worktree without the index: it was opened in 3 of 6 runs, never first,
 * never produced a better answer, and on the one question it was written for -
 * "where is coverage weakest" - neither arm read it. Both agents on a fourth
 * question independently ran `grep -rn "^describe(" lib/agent --include=*.test.ts`,
 * which IS a per-file index, generated live and scoped to one directory. The
 * area files were a cached copy of a grep.
 *
 * So what survives here is only what a grep cannot produce: counts per area,
 * how many of each area's files carry a written header, and absence - the
 * things that are not tested anywhere, which nothing can be grepped for.
 *
 * WHY GENERATED AT ALL. test-map.test.ts asserts the committed file equals what
 * this produces, so it fails CI when it drifts. The root CLAUDE.md's
 * hand-stamped baseline went stale within one commit of being written; that is
 * what an unenforced number does here.
 *
 * WHY NOT A CLAUDE.md. `scripts/lib/claude-md-budget.test.ts` caps every
 * instruction file combined at 140,000 bytes and they sit at ~121,000. A nested
 * CLAUDE.md also loads in full whenever anyone reads anything in its directory.
 * This is outside that tree and read on demand.
 */

const ROOT = resolve(__dirname, '..', '..')

export interface MapEntry {
  path: string
  /** `it(`/`test(` declaration sites. NOT the runtime test count - see eachSites. */
  cases: number
  /** `.each` tables, each of which expands to several tests at runtime. */
  eachSites: number
  /** Whether the file opens with a comment block saying what it pins. */
  hasHeader: boolean
}

/**
 * Does the file open with a comment block?
 *
 * Only presence matters. The text used to be extracted into a per-file summary;
 * that output is gone, and a header is now read where it lives, at the top of
 * the file you are already opening. What remains useful is the RATIO per area:
 * a low one means that area's tests explain themselves poorly, so budget more
 * reading.
 */
export function hasHeader(text: string): boolean {
  const first = text.split('\n')[0] ?? ''
  return first.startsWith('//') || first.startsWith('/*')
}

/** `it(`/`test(` declaration sites, at any indentation. */
export function countCases(text: string): number {
  return text.split('\n').filter((l) => /^\s*(?:it|test)(?:\.\w+)?\(/.test(l)).length
}

/** `.each` tables. One site is several runtime tests, so the two never match. */
export function countEachSites(text: string): number {
  return text.split('\n').filter((l) => /\.each[([`]/.test(l)).length
}

/**
 * Which area a test file belongs to: its first two path segments, or the first
 * alone for a file sitting directly in a root directory.
 */
export function areaOf(path: string): string {
  const parts = path.split('/')
  if (parts.length === 1) return '<root>'
  return `${parts[0]}/${parts[1]}`.replace(/\/[^/]*\.test\.tsx?$/, '')
}

export function toEntry(path: string, text: string): MapEntry {
  return {
    path,
    cases: countCases(text),
    eachSites: countEachSites(text),
    hasHeader: hasHeader(text),
  }
}

const GENERATED_NOTICE = [
  '<!-- GENERATED FILE - do not edit by hand. Run `npm run test-map` to regenerate. -->',
  '<!-- Source: scripts/lib/test-map.ts. Enforced by scripts/lib/test-map.test.ts. -->',
].join('\n')

export function renderIndex(areas: ReadonlyMap<string, readonly MapEntry[]>): string {
  const sorted = [...areas.keys()].sort()
  const rows = sorted.map((area) => {
    const entries = areas.get(area) ?? []
    const cases = entries.reduce((sum, e) => sum + e.cases, 0)
    const headers = entries.filter((e) => e.hasHeader).length
    return `| \`${area}\` | ${entries.length} | ${cases} | ${headers}/${entries.length} |`
  })
  const files = [...areas.values()].reduce((sum, e) => sum + e.length, 0)
  const cases = [...areas.values()].reduce((sum, e) => sum + e.reduce((s, x) => s + x.cases, 0), 0)
  const each = [...areas.values()].reduce((sum, e) => sum + e.reduce((s, x) => s + x.eachSites, 0), 0)
  return [
    GENERATED_NOTICE,
    '',
    '# The shape of the test suite',
    '',
    `${files} test files, ${cases} \`it\`/\`test\` declaration sites across ${sorted.length} areas.`,
    '',
    `**Declaration sites are not the test count.** ${each} \`.each\` tables expand at runtime, so`,
    'the figure `vitest` reports is higher. Quote the run, never this number.',
    '',
    '## To find which test covers something, do not read this file',
    '',
    '`grep -rn "^describe(" <area> --include="*.test.ts"` lists every test file in a directory',
    'with what it covers, generated live and scoped to the directory you care about. For a',
    'behaviour with an obvious literal, `grep -rn "<literal>" --include="*.test.ts"` is',
    'exhaustive by construction. Measured against a control arm, neither is beaten by an index.',
    '',
    'This file is for the question grep cannot answer: **what is not tested anywhere.**',
    '',
    '## Per area',
    '',
    'The `headers` column counts files that open with a comment block saying what they pin. A',
    'low ratio means that area explains itself poorly - budget more reading, and write a header',
    'when you leave.',
    '',
    '| area | files | cases | headers |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    '## What is not covered, anywhere',
    '',
    '- **No rendered-component tests.** There is no `.test.tsx` in the repo. The Command Center',
    '  UI is verified through its loaders and by eye, never by rendering.',
    '- **No end-to-end tier in `vitest`.** `scripts/measurement/*` make real model calls, cost',
    '  money, and are run by hand. `npm run run-test-scenarios` must run during a venue\'s open',
    '  hours. CI runs none of them.',
    '- **DB-touching code is generally not unit-tested**, by the convention in the root',
    '  `CLAUDE.md`, and neither is the non-`-pure.ts` half of a module split. A source file with',
    '  no sibling test is often deliberate; it is not a gap by itself.',
    '',
    'Known gaps that are NOT deliberate, each confirmed by mutating the source and watching the',
    'full suite stay green:',
    '',
    '- `app/api/webhooks/square/route.ts` has no test. Its own header flags it high-stakes and',
    '  payment-adjacent; the sibling `sendblue` and `instagram` routes both have large ones.',
    '- `lib/recognition/evaluate-state.ts` and `normalize-signals.ts` have none. Changing',
    '  `MONEY_MAX_DOLLARS` from 300 to 37, and inverting `normalizeRecency`, both pass the whole',
    '  suite. These feed the relationship score that gates auto-send.',
    '- `lib/auth/require-admin.ts` has none. Deleting the cross-venue span check in',
    '  `requireKnowledgeEntriesAdmin` passes the whole suite, on a hard-stop surface.',
    '',
  ].join('\n')
}

/**
 * Test files, discovered through `git ls-files`.
 *
 * Not a directory walk: an untracked scratch copy or a worktree under
 * `.claude/worktrees/` would otherwise be collected, which is the doubling
 * `vitest.config.ts` already excludes for.
 */
export function discoverTestFiles(root: string = ROOT): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  return out
    .split('\0')
    .filter((p) => /\.test\.tsx?$/.test(p))
    .sort()
}

export function buildMap(root: string = ROOT): Map<string, MapEntry[]> {
  const areas = new Map<string, MapEntry[]>()
  for (const path of discoverTestFiles(root)) {
    const text = readFileSync(resolve(root, path), 'utf8')
    const area = areaOf(path)
    const entries = areas.get(area) ?? []
    entries.push(toEntry(path, text))
    areas.set(area, entries)
  }
  return areas
}

/** Every file this generator owns, as path to content. */
export function renderAll(root: string = ROOT): Map<string, string> {
  return new Map([['docs/testing/README.md', renderIndex(buildMap(root))]])
}

/** Generated files currently on disk, so a leftover area file is detected. */
export function readCommitted(root: string = ROOT): Map<string, string> {
  const dir = resolve(root, 'docs/testing')
  const files = new Map<string, string>()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return files
  }
  for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
    files.set(`docs/testing/${name}`, readFileSync(resolve(dir, name), 'utf8'))
  }
  return files
}

function main(): void {
  const files = renderAll()
  const dir = resolve(ROOT, 'docs/testing')
  rmSync(dir, { recursive: true, force: true })
  for (const [path, content] of files) {
    mkdirSync(dirname(resolve(ROOT, path)), { recursive: true })
    writeFileSync(resolve(ROOT, path), content, 'utf8')
  }
  process.stdout.write(`wrote ${files.size} file to docs/testing/\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) main()
