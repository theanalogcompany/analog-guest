import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  areaOf,
  buildMap,
  countCases,
  countEachSites,
  discoverTestFiles,
  hasHeader,
  readCommitted,
  renderAll,
  toEntry,
} from './test-map'

// The parsers get ordinary unit tests. The reason docs/testing/README.md is
// worth trusting at all is the staleness check: it regenerates the file and
// asserts the committed one equals it, so a PR that adds a test file without
// running `npm run test-map` fails CI. Without that it is a claim nothing
// enforces, which is the defect class .claude/rules/testing-discipline.md
// exists for - and the root CLAUDE.md's hand-stamped baseline went stale within
// one commit of being written, in this very branch.
//
// Verified by mutation, not by reading: adding a throwaway test file and
// running without regenerating fails the staleness assertion with the command
// to fix it.

const ROOT = resolve(__dirname, '..', '..')

describe('hasHeader', () => {
  it('is true for a leading line comment', () => {
    expect(hasHeader('// what this pins\n\nimport x from "y"')).toBe(true)
  })

  it('is true for a leading block comment', () => {
    expect(hasHeader('/**\n * what this pins\n */\n')).toBe(true)
  })

  it('is false for a file that opens on an import', () => {
    expect(hasHeader("import { describe } from 'vitest'\n")).toBe(false)
  })

  it('is false for a comment that starts on the second line', () => {
    // A header has to be the first thing in the file to describe the file.
    expect(hasHeader("import x from 'y'\n// not a header\n")).toBe(false)
  })
})

describe('countCases', () => {
  it('counts it and test at any indentation, including modifiers', () => {
    const text = [
      "  it('a', () => {})",
      "    it.each([1])('b %i', () => {})",
      "test('c', () => {})",
      "  it.skip('d', () => {})",
      "  // it('commented out', () => {})",
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

describe('toEntry', () => {
  it('records cases, each sites and header presence', () => {
    const entry = toEntry('lib/x/y.test.ts', "// pins y\n\nit.each([1])('a %i', () => {})")
    expect(entry).toEqual({ path: 'lib/x/y.test.ts', cases: 1, eachSites: 1, hasHeader: true })
  })
})

describe('discovery', () => {
  const files = discoverTestFiles(ROOT)

  it('finds the test files at all', () => {
    // Guard the guard: every check below iterates this list, so an empty one
    // passes them vacuously, and a discovery that silently stops matching is
    // the failure this file exists to catch.
    expect(files.length).toBeGreaterThanOrEqual(300)
  })

  it('finds no file outside the tracked tree', () => {
    // A worktree under .claude/worktrees/ holds a full second copy of every
    // test file. git ls-files cannot see it; a directory walk would, and every
    // per-area count would come back doubled.
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

  it('holds exactly the files the generator produces, and no leftovers', () => {
    // Both directions. The area files this generator used to emit were deleted;
    // a stale one left behind would otherwise sit there forever, unregenerated
    // and silently wrong.
    expect([...committed.keys()].sort(), 'run `npm run test-map`').toEqual([...generated.keys()].sort())
  })

  it('matches the generator byte for byte', () => {
    expect(
      committed.get('docs/testing/README.md'),
      'docs/testing/README.md is stale or hand-edited. Run `npm run test-map` and commit it.',
    ).toBe(generated.get('docs/testing/README.md'))
  })

  it('reconciles its per-area file counts against discovery', () => {
    // The table is the whole artifact now, so a row that disagrees with the
    // repo is the only way this file can lie. Parsed back out of the rendered
    // markdown rather than recomputed, so a rendering bug cannot hide.
    const text = generated.get('docs/testing/README.md') ?? ''
    const rows = [...text.matchAll(/^\| `([^`]+)` \| (\d+) \| (\d+) \| (\d+)\/(\d+) \|$/gm)]
    expect(rows.length).toBeGreaterThanOrEqual(20)
    const areas = buildMap(ROOT)
    expect(rows.length).toBe(areas.size)
    for (const [, area, files, , headers, headerTotal] of rows) {
      const entries = areas.get(area)
      expect(entries, `row for ${area} names an area that does not exist`).toBeDefined()
      expect(Number(files), `${area} file count`).toBe(entries!.length)
      expect(Number(headerTotal), `${area} header denominator`).toBe(entries!.length)
      expect(Number(headers), `${area} header count`).toBe(entries!.filter((e) => e.hasHeader).length)
    }
  })

  it('warns that it is generated', () => {
    // Without this line the first person to fix a typo by hand loses the edit
    // on the next regeneration, and the global rule against editing generated
    // files has nothing to key on.
    expect(committed.get('docs/testing/README.md')).toContain('GENERATED FILE - do not edit by hand')
  })

  it('still records what is not covered anywhere', () => {
    // The absence section is the ONLY reason this file survived the experiment
    // that deleted the 26 per-area files: it is the one question grep cannot
    // answer. If it is ever emptied, the file has no purpose left.
    const text = committed.get('docs/testing/README.md') ?? ''
    expect(text).toContain('What is not covered, anywhere')
    expect(text).toContain('app/api/webhooks/square/route.ts')
    expect(text).toContain('lib/auth/require-admin.ts')
  })
})

describe('the pointers into docs/testing', () => {
  const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8')

  it('is reachable from the rule that loads when a test file is opened', () => {
    // testing-discipline.md has `paths: **/*.test.ts` in its frontmatter, so it
    // enters context exactly when this becomes relevant.
    expect(read('.claude/rules/testing-discipline.md')).toContain('docs/testing/README.md')
  })

  it('is reachable from the root CLAUDE.md', () => {
    expect(read('CLAUDE.md')).toContain('docs/testing/README.md')
  })

  it('is named by the agent that is meant to consult it', () => {
    expect(read('.claude/agents/test-author.md')).toContain('docs/testing/README.md')
  })
})
