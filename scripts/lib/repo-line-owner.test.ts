import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// TAC-443: `repo_line_names` (and the `owner` that consumes it) live as
// identical jq text embedded in two workflow files' RULES strings
// (`.claude/process.md`'s "The repo rule", kept in sync by hand — see the
// comment above each RULES=' block). Nothing runs a workflow under test, so
// this reads both files as text, extracts the actual patched jq, and shells
// out to the real `jq` binary against fixtures, mirroring the technique
// `scripts/lib/build-workflow.test.ts` already uses for the selection's own
// jq. A jq program nobody runs is not tested by reading it.

const ROOT = resolve(__dirname, '..', '..')
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8')

const FILES = {
  'build-ready.yml': read('.github/workflows/build-ready.yml'),
  'audit-new-todo.yml': read('.github/workflows/audit-new-todo.yml'),
}

// `repo_labels`, `repo_line_names` and `owner`, from the first def through
// the `end;` that closes `owner`'s if/elif/else — the whole repo-assignment
// rule, nothing else. Two `end;`s appear in between (one closes
// `repo_line_names`'s own if, one closes `owner`'s), so the SECOND one is
// the anchor.
function extractRepoRule(text: string): string {
  const start = text.indexOf('def repo_labels:')
  if (start < 0) throw new Error('def repo_labels: not found')
  const firstEnd = text.indexOf('end;', start)
  const secondEnd = text.indexOf('end;', firstEnd + 1)
  if (firstEnd < 0 || secondEnd < 0) throw new Error('end; anchors not found')
  if (!text.slice(start, secondEnd).includes('def owner:')) {
    throw new Error('def owner: not between the two end; anchors — extraction moved')
  }
  return text.slice(start, secondEnd + 'end;'.length)
}

const RULES = Object.fromEntries(Object.entries(FILES).map(([name, text]) => [name, extractRepoRule(text)]))

// The assignment: everything before the first sentence-ending period. A
// fixture's `labels` is set to whatever the real ticket carries, so `owner`
// resolves to the repo name itself, not just "not a defect".
function owner(rules: string, description: string, labelNames: string[]) {
  const program = `${rules}\nrepo_labels as $labels | owner`
  const input = { description, labels: { nodes: labelNames.map((name) => ({ name })) } }
  const r = spawnSync('jq', ['-r', program], { input: JSON.stringify(input), encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`jq failed: ${r.stderr}`)
  return r.stdout.trim()
}

// audit-new-todo.yml carries one extra comment line ahead of
// `def repo_line_names:` that build-ready.yml doesn't (pre-existing, not
// this ticket's concern) — so the drift guard below compares from
// `def repo_line_names:` on, which is the part TAC-443 touches and the part
// that must not silently diverge again.
const fromLineNames = (rules: string) => rules.slice(rules.indexOf('def repo_line_names:'))

describe('both workflows extract the identical repo-assignment rule', () => {
  it('is byte-identical in build-ready.yml and audit-new-todo.yml, from repo_line_names on', () => {
    expect(fromLineNames(RULES['audit-new-todo.yml'])).toBe(fromLineNames(RULES['build-ready.yml']))
  })

  it('actually contains the TAC-443 fix, not a stale extraction', () => {
    for (const rules of Object.values(RULES)) {
      expect(rules).toContain('capture("^(?<head>[^.]*)").head')
    }
  })
})

// TAC-443's own fixtures, verbatim from the ticket body. The two prose
// "accept" cases quoting TAC-389 and TAC-386 are their ORIGINAL lines
// (before both tickets were hand-edited on 2026-09-17 to route around the
// bug) — not re-fetched from Linear, since the live descriptions no longer
// carry the wording this ticket exists to fix.
const ACCEPT: Array<{ label: string; description: string; labels: string[]; expectOwner: string }> = [
  {
    label: 'bare single-repo assignment',
    description: '**Repo:** analog-guest',
    labels: ['analog-guest'],
    expectOwner: 'analog-guest',
  },
  {
    label: 'assignment followed by ordinary prose',
    description: '**Repo:** analog-guest. Agent runtime.',
    labels: ['analog-guest'],
    expectOwner: 'analog-guest',
  },
  {
    label: "TAC-389's original line — parenthetical then an explanatory clause naming the other repo",
    description: '**Repo:** analog-guest (the endpoint). Reached from analog-operator, but the defect is server-side.',
    labels: ['analog-guest'],
    expectOwner: 'analog-guest',
  },
  {
    label: "TAC-386's original line — a clause stating the other repo is NOT touched",
    description: '**Repo:** analog-guest. No analog-operator changes, so no ## Contract section.',
    labels: ['analog-guest'],
    expectOwner: 'analog-guest',
  },
  {
    label: "TAC-412's exact line — a second repo named conditionally, pending an open question",
    description: '**Repo:** analog-operator. Possibly analog-guest too, depending on Open question 1.',
    labels: ['analog-operator'],
    expectOwner: 'analog-operator',
  },
]

const REFUSE: Array<{ label: string; description: string }> = [
  { label: '"and"-joined two-repo assignment', description: '**Repo:** analog-guest and analog-operator' },
  { label: 'comma-joined two-repo assignment', description: '**Repo:** analog-guest, analog-operator' },
  { label: '"+"-joined two-repo assignment', description: '**Repo:** analog-guest + analog-operator' },
]

describe.each(Object.keys(RULES))('%s', (file) => {
  const rules = RULES[file]

  describe.each(ACCEPT)('accepts: $label', ({ description, labels, expectOwner }) => {
    it(`resolves to ${expectOwner}, not defect:multi-repo-line`, () => {
      expect(owner(rules, description, labels)).toBe(expectOwner)
    })
  })

  describe.each(REFUSE)('refuses: $label', ({ description }) => {
    it('resolves to defect:multi-repo-line', () => {
      expect(owner(rules, description, ['analog-guest'])).toBe('defect:multi-repo-line')
    })
  })
})
