import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseArgs } from './linear-cli.mjs'

// The two CI sessions (build and audit) are taught to reach Linear by the
// same block of their workflow prompts, and .claude/commands/work-ticket.md
// restates it. These tests read those files as text: nothing runs a workflow
// under test, so a source-level check is the only one that can see a prompt
// drift from the helper or from its twin (TAC-444).

const ROOT = resolve(__dirname, '..', '..')
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8')

const WORKFLOWS = ['.github/workflows/build-ready.yml', '.github/workflows/audit-new-todo.yml']
const START = 'LINEAR, FROM CI.'
const END = 'cat, grep, cut, wc and env are not\n            available.'

function linearBlock(path: string) {
  const text = read(path)
  const start = text.indexOf(START)
  const end = text.indexOf(END, start)
  if (start < 0 || end < 0) throw new Error(`${path}: the Linear block's start or end line moved`)
  return text.slice(start, end + END.length)
}

// Every `node scripts/linear.mjs ...` line the block teaches, as the argv the
// helper would receive. ${{ runner.temp }} is expanded by GitHub before the
// session sees it; a stand-in path keeps its spaces from splitting the token.
function taughtHelperCalls(block: string) {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('node scripts/linear.mjs '))
    .map((line) => {
      const args = line.slice('node scripts/linear.mjs '.length).replaceAll('${{ runner.temp }}', '/runner/temp')
      return [...args.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2])
    })
}

describe('the Linear block of the workflow prompts', () => {
  const blocks = WORKFLOWS.map(linearBlock)

  it('is identical in the build and audit workflows', () => {
    expect(blocks[1]).toBe(blocks[0])
  })

  it.each(WORKFLOWS)('%s no longer teaches the hand-escaped JSON write form', (path) => {
    // Case-insensitive: a reintroduced sentence that starts with one of
    // these would otherwise pass.
    const block = linearBlock(path).toLowerCase()
    for (const gone of ['linear-request.json', 'escape newlines', 'commentcreate', 'issueaddlabel', 'issueupdate', ' -d @']) {
      expect(block).not.toContain(gone)
    }
  })

  it.each(WORKFLOWS)('%s no longer gives the stale reason for past refusals', (path) => {
    expect(linearBlock(path)).not.toMatch(/denied pipeline on record/i)
  })

  it.each(WORKFLOWS)('%s states the outside-the-checkout rule', (path) => {
    const block = linearBlock(path)
    expect(block).toContain('refuses any path outside this checkout, whatever the\n            allowlist says')
    expect(block).toContain('${{ runner.temp }} is outside it')
    expect(block).toContain('Open those files with\n            the Read tool')
    // Without it, a session tried mkdir on the temp folder, which is refused (run 35293187884).
    expect(block).toContain('The temp folder already exists, do not create it.')
  })

  it.each(WORKFLOWS)('%s keeps the inline curl read, which passes the key without expanding it', (path) => {
    const block = linearBlock(path)
    expect(block).toContain('curl -sS https://api.linear.app/graphql --variable %LINEAR_API_KEY --expand-header "Authorization: {{LINEAR_API_KEY}}"')
    // The only mention of the expanded forms is the sentence saying they are denied.
    expect(block.split('$LINEAR_API_KEY').length - 1).toBe(1)
  })

  it('teaches only helper calls the helper accepts, and all five of them', () => {
    const calls = taughtHelperCalls(blocks[0])
    const kinds = calls.map((argv) => {
      const parsed = parseArgs(argv)
      expect(parsed, argv.join(' ')).toMatchObject({ ok: true })
      // The helper is plain JS, so `ok` infers as boolean and can't narrow.
      if (!('command' in parsed)) return ''
      const { kind, op } = parsed.command as { kind: string; op?: string }
      return op ? `${kind} ${op}` : kind
    })
    expect(kinds.sort()).toEqual(['comment', 'describe', 'label add', 'label remove', 'state'])
  })

  it('tells the audit session its Write tool is for the helper\'s files', () => {
    const audit = read('.github/workflows/audit-new-todo.yml')
    expect(audit).toContain("The Write tool is for the helper's markdown files only.")
    expect(audit).not.toContain('request file')
  })
})

describe('work-ticket.md step 1', () => {
  const step = read('.claude/commands/work-ticket.md')
    .split('\n')
    .find((line) => line.startsWith('1. **Re-read ticket state.**'))

  it('exists', () => {
    expect(step).toBeDefined()
  })

  it('names the same two forms as the prompts', () => {
    expect(step).toContain('read with curl and write with `node scripts/linear.mjs`')
    expect(step).not.toContain('use the GraphQL API with curl and `$LINEAR_API_KEY`')
  })

  it('states the outside-the-checkout rule', () => {
    expect(step).toContain('on any file outside the checkout, which includes the runner temp folder')
  })
})
