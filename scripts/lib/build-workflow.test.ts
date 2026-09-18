import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENDING } from './run-report.mjs'

// Nothing runs a workflow under test, so these read the files as text, like
// linear-prompts.test.ts does. What they guard (TAC-447): one ticket per
// run, one turn limit read in one place, the turn-limit notices wired to
// the script that writes them, and the new markers agreeing with every list
// that routes on markers.

const ROOT = resolve(__dirname, '..', '..')
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8')

const WORKFLOW = read('.github/workflows/build-ready.yml')

// The text between two markers that must each appear exactly once.
function between(text: string, start: string, end: string) {
  const from = text.indexOf(start)
  const to = text.indexOf(end, from + start.length)
  if (from < 0 || to < 0 || text.indexOf(start, from + 1) >= 0) {
    throw new Error(`"${start}" … "${end}" moved`)
  }
  return text.slice(from, to)
}

// A step's `run: |` block, as the runner sees it: the common indent removed.
function runBlock(stepName: string) {
  const step = WORKFLOW.slice(WORKFLOW.indexOf(`- name: ${stepName}`))
  const lines = step.slice(step.indexOf('run: |\n') + 'run: |\n'.length).split('\n')
  const indent = lines[0].match(/^ */)![0]
  const body: string[] = []
  for (const line of lines) {
    if (line.trim() !== '' && !line.startsWith(indent)) break
    body.push(line.slice(indent.length))
  }
  return body.join('\n')
}

const INPUTS = between(WORKFLOW, '  workflow_dispatch:', 'concurrency:')
const PROMPT = between(WORKFLOW, 'prompt: |', '- name: Check the session posted')
const QUEUE = runBlock('Find tickets to work')
const CHECK = runBlock('Check the session posted on every ticket it worked')

// Bookkeeping: posted by a workflow, never the newest comment on a ticket.
const BOOKKEEPING = ['DENIALS', 'OVER-LIMIT', 'RESUME-CLAIM', 'SLACK']
// Posted by the workflow after a session, so never the session's own comment.
const WORKFLOW_NOTICES = [...BOOKKEEPING, 'SILENT-RUN', 'TURN-LIMIT'].sort()

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort()
// Every [MARKER] named in a stretch of prose.
const markersIn = (text: string) => sorted([...text.matchAll(/\[([A-Z][A-Z-]*)\]/g)].map((m) => m[1]))
// The alternation inside marker_is("...") or \[(?:...)\].
const alternation = (text: string, pattern: RegExp) => {
  const m = text.match(pattern)
  if (!m) throw new Error(`no match for ${pattern}`)
  return sorted(m[1].split('|'))
}

describe('build-ready.yml selects one ticket per run', () => {
  it('limits the queue to one ticket', () => {
    expect(WORKFLOW).toContain('          LIMIT: "1"\n')
    expect(WORKFLOW).not.toMatch(/LIMIT: "[02-9]/)
  })

  it('tells the session it has one ticket', () => {
    expect(PROMPT).toContain('Ticket: ${{ steps.queue.outputs.tickets }}')
    expect(PROMPT).not.toMatch(/Tickets, in order/)
    expect(PROMPT).not.toMatch(/next ticket/)
  })
})

describe('build-ready.yml sets its turn limit in one place', () => {
  it('defaults to 120 when a run has no inputs', () => {
    expect(WORKFLOW).toContain('    env:\n      MAX_TURNS: ${{ inputs.max_turns || 120 }}\n')
  })

  it('passes that limit to the session', () => {
    expect(WORKFLOW).toContain('--max-turns ${{ env.MAX_TURNS }}\n')
    expect(WORKFLOW).not.toMatch(/--max-turns \d/)
  })

  it('lets only a manual dispatch lower it', () => {
    expect(INPUTS).toContain('      max_turns:\n')
    expect(between(INPUTS, '      max_turns:', 'type: number')).toContain('default: 120')
    expect(between(WORKFLOW, '  repository_dispatch:', '  workflow_dispatch:')).not.toContain('inputs')
  })

  it('tells the session its limit and to push as it goes', () => {
    expect(PROMPT).toContain('YOU HAVE ${{ env.MAX_TURNS }} TURNS.')
    expect(PROMPT).toContain('Never save pushes for the end.')
  })
})

describe('the check after the session reports the turn limit', () => {
  const run = CHECK

  it('is valid bash', () => {
    const r = spawnSync('bash', ['-n'], { input: run, encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  it('asks the report script how the session ended, against the same limit', () => {
    expect(run).toContain('node scripts/run-report.mjs ending "$EXECUTION_FILE" "$MAX_TURNS"')
    expect(run).toContain('node scripts/run-report.mjs notice "$1" "$EXECUTION_FILE" "$MAX_TURNS"')
  })

  it('branches on the endings the script prints', () => {
    const compared = sorted([...run.matchAll(/"\$ENDING" = "([a-z-]+)"/g)].map((m) => m[1]))
    expect(compared).toEqual(sorted([ENDING.STOPPED_AT_LIMIT, ENDING.FINISHED_OVER_LIMIT]))
  })

  it('falls back to the old behaviour when the script fails', () => {
    expect(run).toContain('|| ENDING="unknown"')
    expect(run.match(/BODY=\$\(notice "\$TICKET"\) \|\| BODY=""/g)).toHaveLength(2)
  })

  it('never counts its own notices as the session\'s comment', () => {
    expect(alternation(run, /\\\\\[\(\?:([A-Z|-]+)\)\\\\\]"\) \| not\)\]/)).toEqual(WORKFLOW_NOTICES)
  })

  it('blocks the ticket and fails the run when the session was stopped', () => {
    const branch = run.slice(run.indexOf('if [ "$ENDING" = "stopped-at-limit" ]'), run.indexOf('if [ "$POSTED" -gt 0 ]'))
    expect(branch).toContain('LIMITED="$LIMITED $TICKET"')
    expect(branch).toContain('block "$ID" "$ISSUE"')
    expect(run).toContain('if [ -n "$SILENT" ] || [ -n "$LIMITED" ]; then\n  exit 1')
  })

  it('posts [OVER-LIMIT] only on a ticket the session did post on', () => {
    const posted = run.slice(run.indexOf('if [ "$POSTED" -gt 0 ]'))
    expect(posted.indexOf('"$ENDING" = "finished-over-limit"')).toBeGreaterThan(-1)
    expect(posted.indexOf('"$ENDING" = "finished-over-limit"')).toBeLessThan(posted.indexOf('continue'))
  })
})

describe('bookkeeping markers agree across the workflow', () => {
  it('the queue skips exactly the bookkeeping markers when finding the newest comment', () => {
    expect(alternation(QUEUE, /marker_is\("([A-Z|-]+)"\) \| not/)).toEqual(BOOKKEEPING)
  })

  it('the header says the same', () => {
    const line = WORKFLOW.slice(WORKFLOW.indexOf('# "Newest comment" skips'), WORKFLOW.indexOf('buries a ruling.'))
    expect(markersIn(line)).toEqual(BOOKKEEPING)
  })

  it('the resume instructions say the same', () => {
    const para = between(PROMPT, 'RESUMING.', 'bookkeeping, is human')
    expect(markersIn(para)).toEqual(BOOKKEEPING)
  })
})

describe('the Slack sync', () => {
  const slack = read('scripts/slack-rulings.mjs')
  const set = slack.match(/const BLOCKING_MARKERS = new Set\(\[([\s\S]*?)\]\)/)
  if (!set) throw new Error('BLOCKING_MARKERS moved')
  const blocking = [...set[1].matchAll(/'([A-Z-]+)'/g)].map((m) => m[1])

  it('forwards [TURN-LIMIT], which needs Jaipal, and not [OVER-LIMIT], which is bookkeeping', () => {
    expect(blocking).toContain('TURN-LIMIT')
    expect(blocking).not.toContain('OVER-LIMIT')
  })

  it('tells him what a reply to [TURN-LIMIT] does', () => {
    expect(slack).toContain("if (marker === 'TURN-LIMIT') {")
  })

  it('lists the same bookkeeping markers in its header', () => {
    const line = slack.slice(slack.indexOf('build-ready.yml and work-ticket.md both skip'), slack.indexOf('when deciding who spoke last'))
    expect(markersIn(line)).toEqual(BOOKKEEPING)
  })
})
