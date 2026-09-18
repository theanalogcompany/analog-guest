import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
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

// TAC-449, copied from analog-operator's __tests__/workflows.test.ts (TAC-451).
// Both allowlists carried Bash(node:*) until TAC-449 narrowed it to
// Bash(node scripts/linear.mjs:*), the entry operator ships. Without it every
// taught write is refused, and a refusal fails silently. `allows` models
// Claude Code's documented Bash rule, not its code, so it proves the entry is
// present, not that Claude Code admits it. Only a real run can show that:
// operator's audit run 35303513132 (TAC-451's fixture, Claude Code 2.1.276)
// admitted all four helper calls under this entry. Unlike the tests above,
// these parse the workflows as YAML, so a vitest run is also the YAML check
// a CI session used to make with `node -e`.
describe('the Linear helper each prompt teaches is on its allowlist', () => {
  type Step = { uses?: string; with?: { claude_args?: string; prompt?: string } }

  const claudeStep = (src: string) => {
    const doc = yaml.load(src) as { jobs: Record<string, { steps: Step[] }> }
    const step = Object.values(doc.jobs)
      .flatMap((job) => job.steps)
      .find((s) => s.uses?.startsWith('anthropics/claude-code-action'))
    if (!step?.with?.claude_args || !step.with.prompt) throw new Error('no claude-code-action step')
    return { args: step.with.claude_args, prompt: step.with.prompt }
  }

  const tools = (args: string, flag: string) => {
    const m = new RegExp(`${flag} "([^"]*)"`).exec(args)
    if (!m) throw new Error(`no ${flag}`)
    return m[1].split(',')
  }

  // Bash(x) allows exactly x; Bash(x:*) allows x followed by anything. Any
  // other `*` is a wildcard form this doesn't model, and treating it as an
  // exact match would let a deny rule such as Bash(node *) pass unseen.
  const allows = (rule: string, command: string) => {
    const m = /^Bash\((.*)\)$/.exec(rule)
    if (!m) return false
    if (m[1].replace(/:\*$/, '').includes('*')) throw new Error(`unmodelled wildcard rule: ${rule}`)
    if (!m[1].endsWith(':*')) return command === m[1]
    const prefix = m[1].slice(0, -2)
    return command === prefix || command.startsWith(`${prefix} `)
  }

  it.each(WORKFLOWS)('%s', (path) => {
    const { args, prompt } = claudeStep(read(path))
    const taught = prompt
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('node scripts/linear.mjs '))
    // comment, describe, label add, label remove, state. Zero would pass
    // every assertion below and prove nothing.
    expect(taught).toHaveLength(5)
    const allowed = tools(args, '--allowedTools')
    const disallowed = tools(args, '--disallowedTools')
    for (const command of taught) {
      expect({ command, allowed: allowed.some((rule) => allows(rule, command)) }).toEqual({ command, allowed: true })
      expect({ command, disallowed: disallowed.some((rule) => allows(rule, command)) }).toEqual({ command, disallowed: false })
    }
  })

  // Not in operator's test. Everything above also passes under Bash(node:*),
  // so without this nothing would notice the wildcard coming back, which is
  // the change TAC-449 made, along with removing Bash(python3:*). It lists
  // every rule naming node, nodejs or python, any version and with or without
  // a path (python3.12 is the runners' own python), because probing `node -e`
  // alone would miss Bash(node -p:*) or a second script. The list skips
  // wildcard spellings such as Bash(node*) and Bash(*), so it also probes:
  // `allows` throws on those, and a bare Bash allows every command. It does
  // not see a rule that reaches an interpreter another way, such as
  // Bash(env python3:*) or Bash(bash:*).
  it.each(WORKFLOWS)('%s carries no node or python rule but the helper\'s', (path) => {
    const allowed = tools(claudeStep(read(path)).args, '--allowedTools')
    expect(allowed.filter((rule) => /^Bash\((?:\S*\/)?(nodejs|node|python[\d.]*)(?=[\s:)])/.test(rule))).toEqual(['Bash(node scripts/linear.mjs:*)'])
    for (const command of ['node -e 1', 'python3 -c 1']) {
      expect({ command, allowed: allowed.some((rule) => allows(rule, command)) }).toEqual({ command, allowed: false })
    }
    expect(allowed).not.toContain('Bash')
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
