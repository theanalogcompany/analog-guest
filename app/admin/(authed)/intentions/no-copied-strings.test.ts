import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INTENTION_DEFINITIONS } from '@/lib/agent/intentions/definitions'

// TAC-379 §7: "Render definitions from INTENTION_DEFINITIONS directly. Do not
// copy the strings into the view; a drifted copy of promptLine would misreport
// what the model actually sees."
//
// That instruction is about a property no behavioural test can observe — a
// copied literal renders identically to a read one, right up until the
// constant changes and the page starts lying. So it is checked at the source
// level, the same way lib/ui/token-bridge.test.ts and TAC-366's
// filterByRelevance import assertion are.
//
// A raw `toContain` is NOT enough, and the repo's own tooling is why:
// `react/no-unescaped-entities` (via eslint-config-next) makes a bare
// apostrophe in JSX text an ERROR and suggests `&apos;` / `&rsquo;` instead.
// Both current promptLine values contain apostrophes, so the lint rule
// converts the copy this guard catches into a copy it would miss. page.tsx
// already writes `&rsquo;` that way, so it is the house style a paster would
// follow. Both sides are therefore normalized first: quote entities decoded,
// typographic quotes folded to ASCII, whitespace runs collapsed (prettier
// wraps long JSX text, which would otherwise hide a copy behind a newline).
//
// What this still does NOT catch: a paraphrase. Prose that describes a prompt
// line without quoting it passes here and can go stale. Saying so plainly
// rather than letting the green tick imply more than it proves.

const SURFACE_DIR = resolve(__dirname)

function surfaceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...surfaceFiles(full))
      continue
    }
    if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full)
  }
  return out
}

const FILES = surfaceFiles(SURFACE_DIR)

/** Quote entities only. `&amp;` is deliberately absent — decoding it would
 *  create an ordering trap (`&amp;rsquo;` -> `&rsquo;` -> `'`) for no gain,
 *  since these strings differ only by quote characters. */
const QUOTE_ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ['&apos;', "'"],
  ['&#39;', "'"],
  ['&#x27;', "'"],
  ['&quot;', '"'],
  ['&rsquo;', '\u2019'],
  ['&lsquo;', '\u2018'],
  ['&ldquo;', '\u201C'],
  ['&rdquo;', '\u201D'],
]

/**
 * Fold the ways the same literal text can be spelled in JSX into one form, so
 * the comparison sees a copy as a copy. Applied to BOTH the source and the
 * definition string.
 */
function normalizeForCopyCheck(text: string): string {
  let out = text
  for (const [entity, char] of QUOTE_ENTITIES) out = out.split(entity).join(char)
  return out
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('intentions surface renders definitions from the constant', () => {
  it('finds the surface files it means to check', () => {
    // Guards the guard: an empty or mis-rooted file list would make every
    // assertion below vacuously true.
    const names = FILES.map((f) => f.slice(SURFACE_DIR.length + 1))
    expect(names).toContain('page.tsx')
    expect(names).toContain(join('_components', 'definitions-list.tsx'))
    expect(FILES.length).toBeGreaterThanOrEqual(4)
  })

  it('the definitions list imports INTENTION_DEFINITIONS', () => {
    const src = readFileSync(join(SURFACE_DIR, '_components', 'definitions-list.tsx'), 'utf-8')
    expect(src).toContain("from '@/lib/agent/intentions/definitions'")
    expect(src).toContain('INTENTION_DEFINITIONS')
  })

  it('no definition string is pasted as a literal anywhere in the surface', () => {
    for (const file of FILES) {
      const src = normalizeForCopyCheck(readFileSync(file, 'utf-8'))
      const where = file.slice(SURFACE_DIR.length + 1)
      for (const def of INTENTION_DEFINITIONS) {
        expect(src, `${where} copies ${def.key}.promptLine`).not.toContain(
          normalizeForCopyCheck(def.promptLine),
        )
        expect(src, `${where} copies ${def.key}.classifierDescription`).not.toContain(
          normalizeForCopyCheck(def.classifierDescription),
        )
        expect(src, `${where} copies ${def.key}.satisfactionLabel`).not.toContain(
          normalizeForCopyCheck(def.satisfactionLabel),
        )
      }
    }
  })

  // The keys themselves are a different case: derive.ts's suppression rule is
  // specific to learn_first_order, so the gating copy names it deliberately.
  // Pinned so that reference is a decision rather than an accident.
  it('names learn_first_order in the gating copy, since the rule is key-specific', () => {
    const src = readFileSync(join(SURFACE_DIR, '_components', 'gating-conditions.tsx'), 'utf-8')
    expect(src).toContain('learn_first_order')
  })
})
