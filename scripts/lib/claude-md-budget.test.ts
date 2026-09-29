import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The instruction files have a size budget, enforced here because nothing else
// enforces it. Claude Code shows a startup warning over its recommended length
// and `/doctor prompt-audit` proposes trims, but neither fails CI - so the file
// grew to 1,336,095 bytes / 376,170 tokens, which exceeded a subagent's entire
// 200k context window and left every .claude/agents/* and every subagent
// handoff non-functional. See docs/decisions/0001-claude-md-is-an-index.md.
//
// Budget on BYTES, not only lines. The pre-split file was 1,798 lines and would
// have passed any plausible line check, because one line was 362 KB. Both
// limits are here, plus a max line length so the byte count cannot be gamed by
// unwrapping.
//
// EVERY CLAUDE.md is budgeted, not just the root one. Budgeting root alone lets
// the mass migrate into lib/agent/CLAUDE.md, which then loads in full whenever
// anyone touches the agent - the same problem with a narrower blast radius and
// harder to notice, because root still looks healthy.

const ROOT = resolve(__dirname, '..', '..')
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8')

/** Root is tighter than the rest: it loads on every session, they do not. */
const ROOT_MAX_BYTES = 24_000
const ROOT_MAX_LINES = 400

/** A nested file loads only when Claude reads a file in its directory. */
const NESTED_MAX_BYTES = 24_000
const NESTED_MAX_LINES = 400

/** A path-scoped rule loads when Claude reads a matching file. */
const RULE_MAX_BYTES = 24_000
const RULE_MAX_LINES = 400

/**
 * Splitting must not become a way to hide growth: a hundred small nested files
 * is the same total cost for anyone whose task spans them.
 *
 * Landed at 120,903 bytes across 15 files on 2026-09-28, against 1,205,827 in
 * a single eagerly-loaded file before. The cap is set with room for roughly one
 * more subsystem file, so the next substantial addition is a conversation
 * rather than a reflex. Raising it is fine; raising it without saying what grew
 * is how the old file got to 1.34 MB.
 */
const COMBINED_MAX_BYTES = 140_000

/** One 362 KB line is how 135 KB of duplicated text stayed invisible. */
const MAX_LINE_CHARS = 2_000

/**
 * Discover tracked instruction files through git, so an untracked scratch copy
 * or a worktree under .worktrees/ cannot affect the result.
 */
function tracked(pattern?: string): string[] {
  const args = pattern ? ['ls-files', '-z', pattern] : ['ls-files', '-z']
  const out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  return out.split('\0').filter(Boolean)
}

const rootFile = 'CLAUDE.md'

// Filter every tracked path by BASENAME rather than trusting a git pathspec.
//
// The obvious star-slash-doublestar-slash-CLAUDE.md pathspec silently missed
// both `scripts/CLAUDE.md` and `.github/CLAUDE.md`: one path segment is not
// enough for that pattern, and a leading dot is not matched either. Two files
// escaped the budget entirely and the orphan check below could not see them,
// while every assertion in this file still passed. A basename filter has no
// pathspec subtleties to get wrong.
//
// (Spelled out in words above because the pattern itself contains the
// characters that end a block comment.)
const allClaudeMd = tracked().filter(
  (p) => p === 'CLAUDE.md' || p.endsWith('/CLAUDE.md'),
)
const nestedFiles = allClaudeMd.filter((p) => p !== rootFile)
const ruleFiles = tracked().filter((p) => /^\.claude\/rules\/.+\.md$/.test(p))
const decisionFiles = tracked().filter((p) =>
  /^docs\/decisions\/.+\.md$/.test(p),
)

interface Sized {
  path: string
  bytes: number
  lines: number
  longestLine: number
}

function measure(path: string): Sized {
  const text = read(path)
  const lines = text.split('\n')
  return {
    path,
    bytes: Buffer.byteLength(text, 'utf8'),
    lines: lines.length,
    longestLine: lines.reduce((max, l) => Math.max(max, l.length), 0),
  }
}

describe('instruction file budget', () => {
  it('finds the instruction files at all', () => {
    // Guard the guard. Every check below iterates a discovered list, so an
    // empty list passes all of them vacuously - and a glob that silently stops
    // matching is exactly the failure this file exists to prevent.
    expect(nestedFiles.length).toBeGreaterThanOrEqual(8)
    expect(ruleFiles.length).toBeGreaterThanOrEqual(3)
    expect(decisionFiles.length).toBeGreaterThanOrEqual(2)
    expect(nestedFiles).not.toContain(rootFile)
  })

  it(`keeps the root CLAUDE.md under ${ROOT_MAX_BYTES} bytes and ${ROOT_MAX_LINES} lines`, () => {
    const m = measure(rootFile)
    expect(
      m.bytes,
      `${rootFile} is ${m.bytes} bytes. It loads at every session start. Move subsystem ` +
        `detail into that directory's CLAUDE.md, a .claude/rules/ file, or the source ` +
        `header - see docs/decisions/0001-claude-md-is-an-index.md.`,
    ).toBeLessThanOrEqual(ROOT_MAX_BYTES)
    expect(m.lines).toBeLessThanOrEqual(ROOT_MAX_LINES)
  })

  it.each(nestedFiles)('keeps %s within the nested budget', (path) => {
    const m = measure(path)
    expect(
      m.bytes,
      `${path} is ${m.bytes} bytes. A nested file loads in full whenever Claude reads ` +
        `anything in its directory, so this is not free - split it or cut history out.`,
    ).toBeLessThanOrEqual(NESTED_MAX_BYTES)
    expect(m.lines).toBeLessThanOrEqual(NESTED_MAX_LINES)
  })

  it.each(ruleFiles)('keeps %s within the rule budget', (path) => {
    const m = measure(path)
    expect(m.bytes).toBeLessThanOrEqual(RULE_MAX_BYTES)
    expect(m.lines).toBeLessThanOrEqual(RULE_MAX_LINES)
  })

  it('keeps every instruction file free of an unreadable mega-line', () => {
    const offenders = [rootFile, ...nestedFiles, ...ruleFiles]
      .map(measure)
      .filter((m) => m.longestLine > MAX_LINE_CHARS)
      .map((m) => `${m.path}: ${m.longestLine} chars`)
    expect(
      offenders,
      'A very long line hides its own content from review. One 362 KB line is how 135 KB ' +
        'of duplicated text survived a merge unnoticed.',
    ).toEqual([])
  })

  it(`keeps every instruction file combined under ${COMBINED_MAX_BYTES} bytes`, () => {
    const all = [rootFile, ...nestedFiles, ...ruleFiles].map(measure)
    const total = all.reduce((sum, m) => sum + m.bytes, 0)
    const breakdown = all
      .sort((a, b) => b.bytes - a.bytes)
      .map((m) => `${m.path} ${m.bytes}`)
      .join(', ')
    expect(total, `total ${total} bytes: ${breakdown}`).toBeLessThanOrEqual(
      COMBINED_MAX_BYTES,
    )
  })
})

describe('instruction file pointers', () => {
  const rootText = read(rootFile)

  // Paths the root file names, as written. Matches inside backticks or bare.
  const POINTER =
    /(?:docs\/decisions\/[\w.-]+\.md|\.claude\/rules\/[\w.-]+\.md|(?:[\w./-]+\/)?CLAUDE\.md)/g

  function pointersIn(text: string): string[] {
    return [...new Set(text.match(POINTER) ?? [])]
  }

  it('extracts pointers from the root file at all', () => {
    // Guard the guard again: with no pointers found, the dead-link check below
    // passes against any file at all, including one whose links are all broken.
    expect(pointersIn(rootText).length).toBeGreaterThanOrEqual(5)
  })

  it('points only at files that exist', () => {
    const dangling = pointersIn(rootText).filter((p) => {
      if (p === rootFile) return false
      try {
        readFileSync(resolve(ROOT, p))
        return false
      } catch {
        return true
      }
    })
    expect(dangling, `${rootFile} points at files that do not exist`).toEqual(
      [],
    )
  })

  it('names every nested CLAUDE.md, so none is orphaned', () => {
    // A nested file nobody is pointed at is a file nobody discovers: it loads
    // only once Claude is already in that directory, which is too late to tell
    // it the directory has rules.
    const named = pointersIn(rootText)
    const orphans = nestedFiles.filter(
      (p) => !named.includes(p) && !named.includes(`${relative('.', p)}`),
    )
    expect(orphans, `not referenced from ${rootFile}`).toEqual([])
  })

  // A nested file is where a human lands from a code search, and five of them used
  // to name nothing at all - no index, no decisions, no way out except the back
  // button. Agents never felt it because the loader hands them the next hop; a
  // human has only what the page links to.
  it('gives every nested CLAUDE.md a way back to the index', () => {
    const deadEnds = nestedFiles.filter(
      (p) => !pointersIn(read(p)).includes(rootFile),
    )
    expect(
      deadEnds,
      `these name no path back to ${rootFile}. A reader who arrives here from a code search ` +
        `has no route to the index or the decision records.`,
    ).toEqual([])
  })

  // README.md is the only document that links rather than quoting paths in
  // backticks, because it is the one a human opens first and GitHub renders a
  // backticked path as unclickable code. Links rot silently, so resolve them.
  it('resolves every relative link in README.md', () => {
    const readme = read('README.md')
    const targets = [...readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
      .map((m) => m[1])
      .filter((t) => !/^(https?:|mailto:|#)/.test(t))
      .map((t) => t.split('#')[0])

    // Guard the guard: with no targets found this passes against a README whose
    // every link is broken, which is the state it is meant to prevent.
    expect(
      targets.length,
      'README.md has no relative links to check',
    ).toBeGreaterThanOrEqual(15)

    const dangling = [...new Set(targets)].filter((t) => {
      try {
        readFileSync(resolve(ROOT, t))
        return false
      } catch {
        return true
      }
    })
    expect(dangling, 'README.md links at files that do not exist').toEqual([])
  })

  it('names every decision record from the decisions index', () => {
    const indexText = read('docs/decisions/README.md')
    const orphans = decisionFiles
      .filter((p) => !p.endsWith('README.md'))
      .filter((p) => !indexText.includes(p.split('/').pop() as string))
    expect(orphans, 'not listed in docs/decisions/README.md').toEqual([])
  })
})
