import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The instruction files restate live numbers - the fidelity floors, PROMPT_VERSION,
// how many approval triggers there are. Every one of those is a claim nothing
// enforced: the doc and the constant agreed only for as long as whoever moved the
// constant remembered the doc. CLAUDE.md's own "A number quoted anywhere else may
// be stale" is an admission, not a guard.
//
// It has already happened one tier down. lib/operator/queue.ts said "Five of the
// thirteen approval triggers have never fired in production" while
// APPROVAL_TRIGGERS held 23. Nothing failed, because nothing compared them.
//
// So: read both sides and compare. This lands green - all four claims were correct
// on 2026-09-28 - which is the point. It exists to fail on the next bump that
// updates one side only.
//
// Sibling of claude-md-budget.test.ts, deliberately separate: that file budgets how
// much the instruction files cost, this one checks whether they are true.
//
// Parse the source, never import it. lib/agent/stages.ts pulls in Supabase and
// Voyage clients transitively, and module-load SDK init in a test process is the
// failure mode scripts/CLAUDE.md's "Module split for testability" exists for.

const ROOT = resolve(__dirname, '..', '..')
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8')

const STAGES = 'lib/agent/stages.ts'
const SYSTEM_TEMPLATE = 'lib/ai/prompts/system-template.ts'

function tracked(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  return out.split('\0').filter(Boolean)
}

const allTracked = tracked()

/**
 * Instruction files are the ones an agent loads without choosing to: root
 * CLAUDE.md every session, a nested CLAUDE.md on reading that directory, a
 * .claude/rules/ file on reading a path its frontmatter matches.
 */
const instructionFiles = allTracked.filter(
  (p) => p === 'CLAUDE.md' || p.endsWith('/CLAUDE.md') || /^\.claude\/rules\/.+\.md$/.test(p),
)

/**
 * Every document a reader is entitled to believe, which is wider than the set an
 * agent auto-loads: README.md is the human entry point and the decision records
 * are cited from it and from root CLAUDE.md. A number restated in one of those
 * rots exactly like a number in CLAUDE.md, and the human reading it has no
 * constant in view to check it against.
 *
 * Fixtures stay OUT. scripts/onboarding/fixtures/test-scenarios-example.md says
 * "PROMPT_VERSION v1.2.0+", a true statement about when a rule set was introduced
 * that would read as drift to the version check below.
 */
const claimFiles = [
  ...instructionFiles,
  ...allTracked.filter((p) => p === 'README.md' || /^docs\/decisions\/.+\.md$/.test(p)),
]

/**
 * Files a citation may point AT, which is wider still: `.claude/process.md` and
 * the command and agent files are cited by section name from the workflow even
 * though no path glob auto-loads them.
 *
 * Scanning the commands and agents is what surfaced the worst instance. Both
 * told a session to apply the old keep-this-file-current rule that
 * docs/decisions/0001 had replaced with the routing table - so the reviewer was
 * still flagging MAJOR for not appending to root, the behaviour that grew root
 * to 1.34 MB.
 *
 * (Written without quoting that rule's name next to a filename on purpose. This
 * file is tracked, so the check below reads it too, and a quoted example here
 * is indistinguishable from a real citation. That is the correct behaviour:
 * self-exclusion would be a hole big enough to hide a live pointer in.)
 */
const citableFiles = [
  ...claimFiles,
  ...allTracked.filter((p) => /^\.claude\/(process\.md|commands\/.+\.md|agents\/.+\.md)$/.test(p)),
]

const sourceFiles = allTracked.filter((p) => /^(lib|app|scripts)\/.+\.tsx?$/.test(p))

interface Line {
  path: string
  line: number
  text: string
}

function linesOf(paths: string[]): Line[] {
  return paths.flatMap((path) =>
    read(path)
      .split('\n')
      .map((text, i) => ({ path, line: i + 1, text })),
  )
}

const claimLines = linesOf(claimFiles)

/** Every number written on a line, as numbers, so 0.40 and 0.4 compare equal. */
function numbersOn(text: string): number[] {
  return (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number)
}

/**
 * A mention of `name` that is not the tail of a longer SCREAMING_SNAKE
 * identifier. Without the boundary, `SEND_FIDELITY_FLOOR` also matches every
 * `AUTO_SEND_FIDELITY_FLOOR` line and the two floors check each other's rows.
 */
function mentions(text: string, name: string): boolean {
  return new RegExp(`(^|[^A-Z0-9_])${name}(?![A-Z0-9_])`).test(text)
}

// --- the live side -----------------------------------------------------------

const stagesSrc = read(STAGES)

function liveNumber(name: string): number {
  const m = new RegExp(`^export const ${name} = (-?\\d+(?:\\.\\d+)?)\\s*(?://.*)?$`, 'm').exec(stagesSrc)
  if (!m) throw new Error(`${STAGES} no longer declares ${name} as a plain numeric literal`)
  return Number(m[1])
}

const FLOORS = [
  'SEND_FIDELITY_FLOOR',
  'AUTO_SEND_FIDELITY_FLOOR',
  'STRONG_MATCH_SIMILARITY',
  'MIN_STRONG_MATCHES',
  'KNOWLEDGE_RELEVANCE_FLOOR',
] as const

const liveFloors = new Map<string, number>(FLOORS.map((name) => [name, liveNumber(name)]))

function livePromptVersion(): string {
  const m = /^export const PROMPT_VERSION = '(v\d+\.\d+\.\d+)'$/m.exec(read(SYSTEM_TEMPLATE))
  if (!m) throw new Error(`${SYSTEM_TEMPLATE} no longer declares PROMPT_VERSION as a version literal`)
  return m[1]
}

function liveTriggerCount(): number {
  const open = stagesSrc.indexOf('export const APPROVAL_TRIGGERS = {')
  if (open < 0) throw new Error(`${STAGES} no longer declares APPROVAL_TRIGGERS`)
  const close = stagesSrc.indexOf('\n} as const', open)
  if (close < 0) throw new Error(`APPROVAL_TRIGGERS in ${STAGES} is no longer closed by "} as const"`)
  const body = stagesSrc.slice(open, close)
  return (body.match(/^ {2}[A-Z][A-Z0-9_]*: '/gm) ?? []).length
}

// --- guard the guard --------------------------------------------------------

describe('live values are readable at all', () => {
  // Every check below iterates a discovered list or a parsed value. An empty list
  // or a silently-zero count passes all of them while comparing nothing.
  it('finds the documents that state claims', () => {
    expect(instructionFiles).toContain('CLAUDE.md')
    expect(instructionFiles.length).toBeGreaterThanOrEqual(12)
    // README.md is the human entry point and states some of the same facts.
    expect(claimFiles).toContain('README.md')
    expect(claimFiles.length).toBeGreaterThan(instructionFiles.length)
    expect(sourceFiles.length).toBeGreaterThanOrEqual(100)
  })

  it('parses every floor as a number', () => {
    for (const name of FLOORS) {
      expect(liveFloors.get(name), name).toEqual(expect.any(Number))
      expect(Number.isNaN(liveFloors.get(name)), name).toBe(false)
    }
  })

  it('parses PROMPT_VERSION and the trigger count', () => {
    expect(livePromptVersion()).toMatch(/^v\d+\.\d+\.\d+$/)
    // A brace-counting bug or a changed closing token would read as a plausible
    // small number, so require a count in the range this constant has lived in.
    expect(liveTriggerCount()).toBeGreaterThanOrEqual(10)
  })
})

// --- the claims -------------------------------------------------------------

describe('documents quote the live floors', () => {
  // The rule: if a line names a floor AND quotes a number, one of the numbers on
  // that line must be the live value. A line naming a floor with no number at all
  // is prose and is exempt.
  const checked = FLOORS.flatMap((name) =>
    claimLines
      .filter((l) => mentions(l.text, name) && numbersOn(l.text).length > 0)
      .map((l) => ({ name, ...l })),
  )

  it('finds floor rows to check', () => {
    // Both tables are currently found: root CLAUDE.md's and lib/agent/CLAUDE.md's.
    expect(checked.length).toBeGreaterThanOrEqual(8)
    expect(new Set(checked.map((c) => c.path)).size).toBeGreaterThanOrEqual(2)
    for (const name of FLOORS) {
      expect(
        checked.filter((c) => c.name === name).length,
        `no document quotes a number for ${name}`,
      ).toBeGreaterThan(0)
    }
  })

  it('quotes the value in lib/agent/stages.ts', () => {
    const stale = checked
      .filter((c) => !numbersOn(c.text).includes(liveFloors.get(c.name) as number))
      .map((c) => `${c.path}:${c.line} quotes ${c.name} but not ${liveFloors.get(c.name)}`)
    expect(
      stale,
      `${STAGES} owns these values. Update the instruction files, or the floor, but not one alone.`,
    ).toEqual([])
  })
})

describe('documents quote the live PROMPT_VERSION', () => {
  const live = livePromptVersion()
  // Only PROMPT_VERSION itself. The verifiers and extractors carry their own
  // sibling versions and are deliberately independent - see
  // .claude/rules/prompt-versioning.md, "Sibling versions are independent".
  const checked = claimLines.filter(
    (l) => mentions(l.text, 'PROMPT_VERSION') && /v\d+\.\d+\.\d+/.test(l.text),
  )

  it('finds version mentions to check', () => {
    expect(checked.length).toBeGreaterThanOrEqual(2)
  })

  it('names the version in lib/ai/prompts/system-template.ts', () => {
    const versionsOn = (text: string): string[] => text.match(/v\d+\.\d+\.\d+/g) ?? []
    const stale = checked
      .filter((l) => !versionsOn(l.text).includes(live))
      .map((l) => `${l.path}:${l.line} quotes a version other than ${live}`)
    expect(
      stale,
      `A bump is a repo-wide sweep and these are two of its sites - .claude/rules/prompt-versioning.md.`,
    ).toEqual([])
  })
})

describe('cited section names exist', () => {
  // Documents and source comments point at each other by section name, and the
  // restructure that split CLAUDE.md renamed sections without updating the
  // pointers. "Common gotchas" was cited from 13 places; the heading had become
  // "Gotchas worth carrying everywhere". Four more names - "Operator API",
  // "Adding a tunable", "Module-load vs first-call", "File path conventions" -
  // existed in no file at all.
  //
  // Agents never noticed: they hold the whole file in context and pattern-match
  // past a wrong heading. A human types the name into find-in-file, gets
  // nothing, and concludes the docs are stale.
  //
  // A citation must sit on ONE line to be seen here. That is a real limit, and
  // the reason to keep the filename and the quoted section name together when
  // wrapping a comment rather than breaking the line between them.
  //
  // The forms are described rather than shown, because this file is tracked and
  // the check reads it too: a literal example is indistinguishable from a live
  // citation. Filename first, then the section in double quotes, optionally
  // separated by a comma, arrow or section sign.
  const CITATION = /([A-Za-z0-9_./-]+\.md)(?:'s)?\s*(?:[,→§]\s*)?"([^"]{3,80})"/g
  // The workflow files invert it: quoted section name, the word `in`, filename.
  const REVERSED = /"([^"]{3,80})" in `?([A-Za-z0-9_./-]+\.md)/g

  const scanned = [...linesOf(citableFiles), ...linesOf(sourceFiles)]
  const cited = scanned.flatMap((l) => [
    ...[...l.text.matchAll(CITATION)].map((m) => ({ ...l, file: m[1], section: m[2] })),
    ...[...l.text.matchAll(REVERSED)].map((m) => ({ ...l, file: m[2], section: m[1] })),
  ])

  it('finds citations to check', () => {
    expect(cited.length).toBeGreaterThanOrEqual(10)
  })

  it('names a section that exists in the file it names', () => {
    const dangling = cited
      .filter((c) => {
        // A path-qualified citation is checked against that exact file. A bare
        // `CLAUDE.md` is checked against every instruction file, because which
        // one it means depends on where the reader is standing - which is an
        // argument for path-qualifying a new one.
        const targets =
          c.file === 'CLAUDE.md' ? instructionFiles : citableFiles.filter((p) => p === c.file)
        if (targets.length === 0) return true
        return !targets.some((p) => read(p).includes(c.section))
      })
      .map((c) => `${c.path}:${c.line} cites ${c.file} "${c.section}", which is not in it`)
    expect(
      dangling,
      'a renamed heading leaves every pointer at the old name silently wrong',
    ).toEqual([])
  })
})

describe('the documentation-routing note has one spelling', () => {
  // work-ticket writes this line into the PR body; code-reviewer flags its
  // absence and audit-codebase greps merged PRs for it. Three files, one
  // literal, and nothing held them together - renaming it in the producer left
  // the auditor searching for a string no session would ever write again, which
  // reads as "every PR skipped the note" rather than as a broken check.
  const NOTE = 'Documentation routing considered:'
  const PARTIES = [
    '.claude/commands/work-ticket.md',
    '.claude/commands/audit-codebase.md',
    '.claude/agents/code-reviewer.md',
  ]

  it('is spelled identically by the producer and both readers', () => {
    const disagreeing = PARTIES.filter((p) => !read(p).includes(NOTE))
    expect(disagreeing, `these no longer agree on the PR-body note "${NOTE}"`).toEqual([])
  })
})

describe('written approval-trigger counts match APPROVAL_TRIGGERS', () => {
  const live = liveTriggerCount()
  // Digit form only. A word-form count ("thirteen approval triggers", which is
  // what queue.ts carried) is not caught here, and a guard that matched the
  // spellings it was written against would read as covering more than it does.
  // Write the count in digits.
  const pattern = /(\d+) approval trigger/g
  const checked = [...claimLines, ...linesOf(sourceFiles)].flatMap((l) =>
    [...l.text.matchAll(pattern)].map((m) => ({ ...l, written: Number(m[1]) })),
  )

  it('finds counts to check', () => {
    expect(checked.length).toBeGreaterThanOrEqual(2)
  })

  it('matches the number of keys', () => {
    const stale = checked
      .filter((c) => c.written !== live)
      .map((c) => `${c.path}:${c.line} says ${c.written} approval triggers, APPROVAL_TRIGGERS has ${live}`)
    expect(stale, 'adding a trigger is a sweep: the count is written in prose in more than one place').toEqual([])
  })
})
