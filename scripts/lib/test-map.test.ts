import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  areaOf,
  areaSlug,
  buildMap,
  countCases,
  countEachSites,
  discoverTestFiles,
  escapeCell,
  parseDescribes,
  parseHeader,
  readCommitted,
  renderAll,
  toEntry,
} from './test-map'

// Two jobs here, and the second is the one that matters.
//
// The pure parsers get ordinary unit tests. But the reason `docs/testing/` is
// worth trusting at all is the staleness check below: it regenerates the index
// and asserts the committed files equal it, so adding a test file without
// running `npm run test-map` fails CI. Without that, the index is a claim
// nothing enforces, which is the defect class `.claude/rules/testing-discipline.md`
// exists for - and an index is exactly the artifact people stop questioning.
//
// The integrity checks mirror the two that claude-md-budget.test.ts already runs
// over the instruction files (every pointer resolves, nothing is orphaned),
// because `docs/testing/` is outside the tree those cover.

const ROOT = resolve(__dirname, '..', '..')

describe('parseHeader', () => {
  it('collapses a leading // block up to its first blank comment line', () => {
    const text = [
      '// verifyProsePromise, one of the five post-generation verifiers.',
      '// The real NoObjectGeneratedError is passed through.',
      '//',
      '// Three concerns, in order:',
      '',
      "import { describe } from 'vitest'",
    ].join('\n')
    expect(parseHeader(text)).toBe(
      'verifyProsePromise, one of the five post-generation verifiers. The real NoObjectGeneratedError is passed through.',
    )
  })

  it('returns null for a file that opens on an import', () => {
    expect(parseHeader("import { describe } from 'vitest'\n")).toBeNull()
  })

  it('returns null for a comment that starts on the second line', () => {
    // A header has to be the first thing in the file to be the file's summary.
    expect(parseHeader("import x from 'y'\n// not a header\n")).toBeNull()
  })

  it('reads a leading block comment and strips its asterisks', () => {
    const text = ['/**', ' * What this file pins.', ' * And the second line.', ' *', ' * Detail.', ' */'].join('\n')
    expect(parseHeader(text)).toBe('What this file pins. And the second line.')
  })

  it('truncates a very long first paragraph with an ellipsis', () => {
    const long = `// ${'word '.repeat(80)}`
    const summary = parseHeader(long)
    expect(summary).not.toBeNull()
    expect(summary!.length).toBeLessThanOrEqual(200)
    expect(summary!.endsWith('…')).toBe(true)
  })
})

describe('parseDescribes', () => {
  it('takes top-level describes and ignores nested ones', () => {
    const text = [
      "describe('verifyProsePromise', () => {",
      "  describe('the approved rule (TAC-527)', () => {",
      '  })',
      '})',
      "describe('a second top-level block', () => {})",
    ].join('\n')
    expect(parseDescribes(text)).toEqual(['verifyProsePromise', 'a second top-level block'])
  })

  it('reads a describe.each template', () => {
    expect(parseDescribes("describe.each(['a'])('channel %s', () => {})")).toEqual(['channel %s'])
  })

  it('handles all three quote styles', () => {
    const text = ["describe('single', () => {})", 'describe("double", () => {})', 'describe(`tick`, () => {})'].join('\n')
    expect(parseDescribes(text)).toEqual(['single', 'double', 'tick'])
  })
})

describe('countCases', () => {
  it('counts it and test at any indentation, including modifiers', () => {
    const text = [
      "  it('a', () => {})",
      "    it.each([1])('b %i', () => {})",
      "test('c', () => {})",
      "  it.skip('d', () => {})",
      '  // it(\'commented out\', () => {})',
      "  const described = it('not this one either')",
    ].join('\n')
    // The commented line and the assignment both fail the column-anchored
    // pattern, which is what keeps the number from drifting upward.
    expect(countCases(text)).toBe(4)
  })

  it('returns zero for a file with no cases', () => {
    expect(countCases("import { it } from 'vitest'\n")).toBe(0)
  })
})

describe('countEachSites', () => {
  it('counts each tables in both call and template form', () => {
    expect(countEachSites("it.each([1, 2])('x %i')\ndescribe.each`a`\nit('plain')")).toBe(2)
  })
})

describe('areaOf', () => {
  it('uses the first two segments for a nested file', () => {
    expect(areaOf('lib/agent/stages.test.ts')).toBe('lib/agent')
  })

  it('folds a deeper path into its two-segment area', () => {
    expect(areaOf('lib/ai/prompts/serializers.test.ts')).toBe('lib/ai')
    expect(areaOf('lib/ai/prompts/categories/index.test.ts')).toBe('lib/ai')
  })

  it('uses the single segment for a file sitting directly in a root directory', () => {
    expect(areaOf('scripts/load-venue-knowledge-pure.test.ts')).toBe('scripts')
  })

  it('puts a repo-root file in its own area', () => {
    expect(areaOf('vitest.node-version.test.ts')).toBe('<root>')
  })
})

describe('areaSlug', () => {
  it('flattens a path into a filename', () => {
    expect(areaSlug('lib/agent')).toBe('lib-agent')
    expect(areaSlug('scripts/onboarding')).toBe('scripts-onboarding')
  })

  it('names the root area something that is a legal filename', () => {
    expect(areaSlug('<root>')).toBe('root')
  })
})

describe('escapeCell', () => {
  it('escapes a pipe so it cannot split the column', () => {
    // A describe name containing a pipe is not hypothetical: `a | b` reads as
    // an alternation in plenty of these names.
    expect(escapeCell('returns a | b')).toBe('returns a \\| b')
  })
})

describe('toEntry', () => {
  it('prefers the header and records that it did', () => {
    const entry = toEntry('lib/x/y.test.ts', "// What this pins.\n\ndescribe('y', () => {})")
    expect(entry.summary).toBe('What this pins.')
    expect(entry.source).toBe('header')
  })

  it('falls back to describe names and marks them as derived', () => {
    const entry = toEntry('lib/x/y.test.ts', "describe('first', () => {})\ndescribe('second', () => {})")
    expect(entry.summary).toBe('first; second')
    expect(entry.source).toBe('names')
  })

  it('says so when a file offers neither', () => {
    const entry = toEntry('lib/x/y.test.ts', "it('a bare case', () => {})")
    expect(entry.source).toBe('none')
    expect(entry.summary).toBe('(no header, no top-level describe)')
  })
})

describe('discovery', () => {
  const files = discoverTestFiles(ROOT)

  it('finds the test files at all', () => {
    // Guard the guard: every check below iterates this list, so an empty one
    // passes them vacuously - and a discovery that silently stops matching is
    // the failure this file exists to catch.
    expect(files.length).toBeGreaterThanOrEqual(300)
  })

  it('finds no file outside the tracked tree', () => {
    // A worktree under .claude/worktrees/ holds a full second copy of every
    // test file. git ls-files cannot see it; a directory walk would, and the
    // per-area counts would come back doubled.
    expect(files.filter((p) => p.startsWith('.claude/') || p.startsWith('.worktrees/'))).toEqual([])
  })

  it('assigns every discovered file to a non-empty area', () => {
    // Per area, not a combined total: a single count stays green when one area
    // resolves to nothing.
    const areas = buildMap(ROOT)
    expect(areas.size).toBeGreaterThanOrEqual(20)
    for (const [area, entries] of areas) {
      expect(entries.length, `${area} has no entries`).toBeGreaterThan(0)
    }
    const assigned = [...areas.values()].reduce((sum, e) => sum + e.length, 0)
    expect(assigned).toBe(files.length)
  })
})

describe('docs/testing is current', () => {
  const generated = renderAll(ROOT)
  const committed = readCommitted(ROOT)

  it('has the same set of files on disk as the generator produces', () => {
    expect([...committed.keys()].sort(), 'run `npm run test-map`').toEqual([...generated.keys()].sort())
  })

  it.each([...renderAll(ROOT).keys()].sort())('%s matches the generator byte for byte', (path) => {
    expect(
      committed.get(path),
      `${path} is stale or hand-edited. Run \`npm run test-map\` and commit the result.`,
    ).toBe(generated.get(path))
  })
})

describe('docs/testing integrity', () => {
  const committed = readCommitted(ROOT)
  const index = committed.get('docs/testing/README.md') ?? ''

  /**
   * Backticked repo paths, as the area docs write them.
   *
   * Anything but a backtick or whitespace: an App Router path carries `(authed)`
   * and `[messageId]`, and a `[\w./-]` class silently dropped 61 of 305 rows -
   * caught only by the floor in the next test.
   */
  function pathsIn(text: string): string[] {
    return [...new Set(text.match(/`([^`\s]+\.test\.tsx?)`/g) ?? [])].map((m) => m.slice(1, -1))
  }

  it('extracts a path from every row of every area doc', () => {
    // Guard the guard: with no paths extracted, the existence check below
    // passes against an index whose every link is broken. Reconciled against
    // the row count rather than a round number, so an extractor that silently
    // stops matching one path SHAPE fails here instead of passing on 80%.
    const areaDocs = [...committed.entries()].filter(([p]) => !p.endsWith('README.md'))
    const extracted = areaDocs.flatMap(([, t]) => pathsIn(t)).length
    const rows = areaDocs.flatMap(([, t]) => t.split('\n').filter((l) => /^\| `/.test(l))).length
    expect(rows).toBeGreaterThanOrEqual(300)
    expect(extracted, 'an area-doc row whose path the extractor cannot read').toBe(rows)
  })

  it('names only test files that exist', () => {
    const dangling: string[] = []
    for (const [doc, text] of committed) {
      for (const path of pathsIn(text)) {
        try {
          readFileSync(resolve(ROOT, path))
        } catch {
          dangling.push(`${doc} -> ${path}`)
        }
      }
    }
    expect(dangling, 'docs/testing names files that do not exist').toEqual([])
  })

  it('links every area doc from the index, so none is orphaned', () => {
    const areaDocs = [...committed.keys()].filter((p) => !p.endsWith('README.md'))
    const orphans = areaDocs.filter((p) => !index.includes(p.replace('docs/testing/', '')))
    expect(orphans, 'not linked from docs/testing/README.md').toEqual([])
  })

  it('links nothing the index cannot resolve', () => {
    const linked = [...new Set(index.match(/\]\(([\w.-]+\.md)\)/g) ?? [])].map((m) => m.slice(2, -1))
    expect(linked.length).toBeGreaterThanOrEqual(20)
    const missing = linked.filter((name) => !committed.has(`docs/testing/${name}`))
    expect(missing, 'docs/testing/README.md links a file that is not there').toEqual([])
  })

  it('warns on every generated file that it is generated', () => {
    // Without this line the first person to fix a typo by hand loses the edit
    // on the next regeneration, and the global rule against editing generated
    // files has nothing to key on.
    const unmarked = [...committed.entries()]
      .filter(([, text]) => !text.includes('GENERATED FILE - do not edit by hand'))
      .map(([path]) => path)
    expect(unmarked).toEqual([])
  })
})

describe('the pointers into docs/testing', () => {
  const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8')

  it('is reachable from the rule that loads when a test file is opened', () => {
    // This is the layer that does the work: testing-discipline.md has
    // `paths: **/*.test.ts` in its frontmatter, so it enters context exactly
    // when the index becomes relevant. An index nobody is pointed at is an
    // index nobody reads.
    expect(read('.claude/rules/testing-discipline.md')).toContain('docs/testing/README.md')
  })

  it('is reachable from the root CLAUDE.md', () => {
    expect(read('CLAUDE.md')).toContain('docs/testing/README.md')
  })
})
