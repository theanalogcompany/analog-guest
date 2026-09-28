import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * Generates `docs/testing/`: an index of what the suite tests, one line per
 * test file, split per area so reading about `lib/pos` does not load
 * `lib/agent`'s 42 entries.
 *
 * WHY A GENERATED INDEX RATHER THAN PROSE. A hand-written map of 304 files is a
 * claim nothing enforces, and this repo's expensive defects are all of that
 * shape (see `.claude/rules/testing-discipline.md`). test-map.test.ts asserts
 * the committed output equals what this produces, so adding a test file without
 * regenerating fails CI. That is the only reason to trust the index at all.
 *
 * WHY NOT A CLAUDE.md. `scripts/lib/claude-md-budget.test.ts` caps every
 * instruction file combined at 140,000 bytes and they sit at ~121,000. A nested
 * CLAUDE.md also loads in full whenever anyone reads anything in its directory,
 * so a test index there would be paid by every task in `lib/agent`, most of
 * which are not about tests. `docs/testing/` is outside that tree and is read
 * on demand: the pointer in `.claude/rules/testing-discipline.md` loads when a
 * test file is opened, which is when the index is wanted.
 *
 * WHAT THIS CANNOT DO. A summary derived from `describe`/`it` names inherits
 * every lie those names tell, and this repo has a specimen whose title encoded
 * the OPPOSITE of its assertion and passed for two months. So each row records
 * where its summary came from: `header` when the file opens with a comment
 * block (written by a human who read the assertions), `names` when it was
 * derived mechanically. Use the index to choose what to read. Do not use it to
 * conclude a behaviour is covered - that needs the assertion.
 */

const ROOT = resolve(__dirname, '..', '..')

/** Longest a generated summary may be before it stops being scannable. */
const SUMMARY_MAX_CHARS = 200

export interface ParsedTestFile {
  /** First paragraph of the file's leading comment block, or null if bare. */
  headerSummary: string | null
  /** Top-level `describe` names, in source order. Nested ones are ignored. */
  describes: string[]
  /** `it(`/`test(` declaration sites. NOT the runtime test count - see eachSites. */
  cases: number
  /** `.each` tables, each of which expands to several tests at runtime. */
  eachSites: number
}

export interface MapEntry extends ParsedTestFile {
  path: string
  summary: string
  source: 'header' | 'names' | 'none'
}

/**
 * The leading comment block, as a single collapsed paragraph.
 *
 * Stops at the first blank comment line (`//` alone), because these headers put
 * the subject in the first paragraph and the detail below it - taking the whole
 * block would put 20 lines in a table cell. Handles both `//` runs and a single
 * leading block comment.
 */
export function parseHeader(text: string): string | null {
  const lines = text.split('\n')
  if (lines[0]?.startsWith('/*')) {
    const collected: string[] = []
    for (const line of lines) {
      const stripped = line.replace(/^\s*\/\*+/, '').replace(/\*+\/\s*$/, '').replace(/^\s*\*\s?/, '')
      if (collected.length > 0 && stripped.trim() === '') break
      if (stripped.trim() !== '') collected.push(stripped.trim())
      if (line.includes('*/')) break
    }
    return collapse(collected.join(' '))
  }
  if (!lines[0]?.startsWith('//')) return null
  const collected: string[] = []
  for (const line of lines) {
    if (!line.startsWith('//')) break
    const stripped = line.replace(/^\/\/\s?/, '').trim()
    if (stripped === '') break
    collected.push(stripped)
  }
  return collapse(collected.join(' '))
}

function collapse(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  if (flat.length <= SUMMARY_MAX_CHARS) return flat
  return `${flat.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`
}

/**
 * Top-level `describe` names only, anchored at column 0.
 *
 * A nested describe is a subdivision of its parent and adds noise at this
 * altitude. `describe.each` is included: the name is a template, which is still
 * informative about the subject.
 */
export function parseDescribes(text: string): string[] {
  const names: string[] = []
  for (const line of text.split('\n')) {
    // `describe.each(table)('name')` takes the name in a SECOND call, so the
    // plain pattern finds a `(` where it wants a quote and drops the block. One
    // file uses this form today (scripts/lib/repo-line-owner.test.ts), and
    // without the second pattern it reads as having no top-level describe at
    // all - indistinguishable from a file that genuinely has none.
    const m =
      /^describe(?:\.\w+)?\(\s*(['"`])(.*?)\1/.exec(line) ??
      /^describe\.each[\s\S]*?\)\s*\(\s*(['"`])(.*?)\1/.exec(line)
    if (m) names.push(m[2])
  }
  return names
}

/** `it(`/`test(` declaration sites, at any indentation. */
export function countCases(text: string): number {
  return text.split('\n').filter((l) => /^\s*(?:it|test)(?:\.\w+)?\(/.test(l)).length
}

/** `.each` tables. One site is several runtime tests, so the two never match. */
export function countEachSites(text: string): number {
  return text.split('\n').filter((l) => /\.each[([`]/.test(l)).length
}

export function parseTestFile(text: string): ParsedTestFile {
  return {
    headerSummary: parseHeader(text),
    describes: parseDescribes(text),
    cases: countCases(text),
    eachSites: countEachSites(text),
  }
}

/**
 * Which area a test file belongs to: its first two path segments, or the first
 * alone for a file sitting directly in a root directory.
 *
 * `lib/ai/prompts/serializers.test.ts` lands in `lib/ai` deliberately - a third
 * level would split `lib/ai` across four files of four rows each, which is the
 * fragmentation the split was meant to avoid.
 */
export function areaOf(path: string): string {
  const parts = path.split('/')
  if (parts.length === 1) return '<root>'
  return `${parts[0]}/${parts[1]}`.replace(/\/[^/]*\.test\.tsx?$/, '')
}

/** `lib/agent` to `lib-agent`, `<root>` to `root`. */
export function areaSlug(area: string): string {
  if (area === '<root>') return 'root'
  return area.replace(/\//g, '-')
}

/** A table cell cannot contain a bare pipe without splitting the column. */
export function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|')
}

export function toEntry(path: string, text: string): MapEntry {
  const parsed = parseTestFile(text)
  if (parsed.headerSummary) {
    return { ...parsed, path, summary: parsed.headerSummary, source: 'header' }
  }
  if (parsed.describes.length > 0) {
    return { ...parsed, path, summary: collapse(parsed.describes.join('; ')), source: 'names' }
  }
  return { ...parsed, path, summary: '(no header, no top-level describe)', source: 'none' }
}

const GENERATED_NOTICE = [
  '<!-- GENERATED FILE - do not edit by hand. Run `npm run test-map` to regenerate. -->',
  '<!-- Source: scripts/lib/test-map.ts. Enforced by scripts/lib/test-map.test.ts. -->',
].join('\n')

export function renderAreaDoc(area: string, entries: readonly MapEntry[]): string {
  const cases = entries.reduce((sum, e) => sum + e.cases, 0)
  const each = entries.reduce((sum, e) => sum + e.eachSites, 0)
  const rows = entries.map((e) => {
    const count = e.eachSites > 0 ? `${e.cases} +${e.eachSites}e` : `${e.cases}`
    return `| \`${e.path}\` | ${count} | ${e.source} | ${escapeCell(e.summary)} |`
  })
  return [
    GENERATED_NOTICE,
    '',
    `# Tests in \`${area}\``,
    '',
    `${entries.length} test files, ${cases} \`it\`/\`test\` declaration sites` +
      (each > 0 ? `, ${each} \`.each\` tables (each expands to several tests at runtime).` : '.'),
    '',
    'The `source` column says where the summary came from. `header` is the file\'s own leading',
    'comment, written by someone who read the assertions. `names` is derived from `describe`',
    'names and inherits whatever those names get wrong. Neither is evidence that a behaviour is',
    'covered: use this to pick a file to read, then read the assertion.',
    '',
    '| file | cases | source | what it covers |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
}

export function renderIndex(areas: ReadonlyMap<string, readonly MapEntry[]>): string {
  const sorted = [...areas.keys()].sort()
  const rows = sorted.map((area) => {
    const entries = areas.get(area) ?? []
    const cases = entries.reduce((sum, e) => sum + e.cases, 0)
    const headers = entries.filter((e) => e.source === 'header').length
    return (
      `| \`${area}\` | ${entries.length} | ${cases} | ${headers}/${entries.length} | ` +
      `[${areaSlug(area)}.md](${areaSlug(area)}.md) |`
    )
  })
  const files = [...areas.values()].reduce((sum, e) => sum + e.length, 0)
  const cases = [...areas.values()].reduce((sum, e) => sum + e.reduce((s, x) => s + x.cases, 0), 0)
  return [
    GENERATED_NOTICE,
    '',
    '# What the test suite covers',
    '',
    `${files} test files, ${cases} \`it\`/\`test\` declaration sites, across ${sorted.length} areas.`,
    '',
    '**Declaration sites are not the test count.** `.each` tables expand at runtime, so the',
    'figure `vitest` reports is higher. Quote the run, never this number - the root `CLAUDE.md`',
    'records the measured baseline and how to re-measure it.',
    '',
    'The `headers` column is how many of an area\'s test files open with a comment block',
    'describing what they pin. A low ratio means that area\'s summaries below are mostly derived',
    'from `describe` names, which are less reliable.',
    '',
    '| area | files | cases | headers | detail |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## What is not here',
    '',
    '- **No rendered-component tests.** There is no `.test.tsx` in the repo, so the Command',
    '  Center UI is verified by eye and by its loaders, never by rendering.',
    '- **No end-to-end tier in `vitest`.** `scripts/measurement/*` make real model calls, cost',
    '  money, and are run by hand. `npm run run-test-scenarios` must run during a venue\'s open',
    '  hours. CI runs none of them.',
    '- **DB-touching code is generally not unit-tested**, by the convention in the root',
    '  `CLAUDE.md`, and neither is the non-`-pure.ts` half of a module split. A source file with',
    '  no sibling test is often deliberate; it is not a gap by itself.',
    '',
  ].join('\n')
}

/**
 * Test files, discovered through `git ls-files`.
 *
 * Not a directory walk: an untracked scratch copy or a worktree under
 * `.claude/worktrees/` would otherwise be collected, which is the doubling
 * `vitest.config.ts` already excludes for. Same technique as
 * claude-md-budget.test.ts, for the same reason.
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
  const areas = buildMap(root)
  const files = new Map<string, string>()
  files.set('docs/testing/README.md', renderIndex(areas))
  for (const [area, entries] of areas) {
    files.set(`docs/testing/${areaSlug(area)}.md`, renderAreaDoc(area, entries))
  }
  return files
}

/** Generated files currently on disk, so a stale area file is detected. */
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
  process.stdout.write(`wrote ${files.size} files to docs/testing/\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) main()
