import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkCommentBody,
  checkDescriptionBody,
  EXIT,
  LINEAR_ENDPOINT,
  parseArgs,
  redact,
  run,
} from './linear-cli.mjs'

// Shaped like a real Linear personal key, and long enough that no other
// string in these tests contains it by accident.
const FAKE_KEY = 'lin_api_FAKEkey0123456789abcdefghijklmnopqrstuvwx'

const ISSUE_UUID = '8c793855-77ff-4e62-b960-199b2aa3f3e3'
const TEAM_ID = 'team-analog'
const OTHER_TEAM_ID = 'team-other'

const PLAN_BODY =
  '**[FROM CLAUDE CODE]**\n\n[PLAN] TAC-1\n\nA "quoted" word, a back\\slash, and\na second line.'

type Reply = { status?: number; body?: unknown; raw?: string; throws?: Error }
type Call = { url: string; headers: Record<string, string>; query: string; variables: Record<string, unknown>; rawBody: string }

// A stand-in for Linear. Each GraphQL operation is answered by the first
// handler whose key appears in the query text; an operation nobody answers
// fails the test loudly rather than returning something plausible.
function fakeLinear(handlers: Record<string, Reply>) {
  const calls: Call[] = []
  const fetch = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const parsed = JSON.parse(init.body)
    calls.push({ url, headers: init.headers, query: parsed.query, variables: parsed.variables, rawBody: init.body })
    const match = Object.keys(handlers).find((k) => parsed.query.includes(k))
    if (!match) throw new Error(`unexpected query: ${parsed.query}`)
    const reply = handlers[match]
    if (reply.throws) throw reply.throws
    const status = reply.status ?? 200
    const text = reply.raw ?? JSON.stringify(reply.body)
    return { ok: status < 400, status, text: async () => text }
  }
  return { fetch, calls }
}

const ISSUE_OK: Reply = { body: { data: { issue: { id: ISSUE_UUID, identifier: 'TAC-1', team: { id: TEAM_ID } } } } }

function files(map: Record<string, string>) {
  return async (path: string) => {
    if (!(path in map)) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
    return map[path]
  }
}

async function runWith(
  argv: string[],
  { handlers = {}, fileMap = {}, key = FAKE_KEY }: { handlers?: Record<string, Reply>; fileMap?: Record<string, string>; key?: string } = {},
) {
  const linear = fakeLinear(handlers)
  let stdout = ''
  let stderr = ''
  const code = await run({
    argv,
    env: key ? { LINEAR_API_KEY: key } : {},
    fetch: linear.fetch,
    readFile: files(fileMap),
    stdout: (t: string) => { stdout += t },
    stderr: (t: string) => { stderr += t },
  })
  return { code, stdout, stderr, calls: linear.calls }
}

describe('parseArgs', () => {
  it('accepts every command the prompts teach', () => {
    expect(parseArgs(['comment', 'TAC-395', '/tmp/a.md'])).toEqual({ ok: true, command: { kind: 'comment', issue: 'TAC-395', file: '/tmp/a.md' } })
    expect(parseArgs(['describe', 'TAC-395', '/tmp/d.md'])).toEqual({ ok: true, command: { kind: 'describe', issue: 'TAC-395', file: '/tmp/d.md' } })
    expect(parseArgs(['label', 'add', 'TAC-395', 'Needs Decision'])).toEqual({ ok: true, command: { kind: 'label', op: 'add', issue: 'TAC-395', name: 'Needs Decision' } })
    expect(parseArgs(['label', 'remove', 'TAC-395', 'Needs Decision'])).toEqual({ ok: true, command: { kind: 'label', op: 'remove', issue: 'TAC-395', name: 'Needs Decision' } })
    expect(parseArgs(['state', 'TAC-395', 'Ready'])).toEqual({ ok: true, command: { kind: 'state', issue: 'TAC-395', name: 'Ready' } })
  })

  it('accepts an issue uuid as well as an identifier', () => {
    expect(parseArgs(['state', ISSUE_UUID, 'Ready']).ok).toBe(true)
  })

  it.each([
    [[]],
    [['post', 'TAC-1', 'a.md']],
    [['comment', 'TAC-1']],
    [['comment', 'TAC-1', 'a.md', 'extra']],
    [['describe', 'TAC-1', '  ']],
    [['label', 'toggle', 'TAC-1', 'Needs Decision']],
    [['label', 'add', 'TAC-1']],
    // A label name with a space that arrived unquoted, as two words.
    [['label', 'add', 'TAC-1', 'Needs', 'Decision']],
    [['state', 'TAC-1']],
    [['state', 'TAC-1', ' ']],
    [['state', 'tac-1', 'Ready']],
    [['state', 'TAC', 'Ready']],
    [['state', '395', 'Ready']],
  ])('rejects %j', (argv) => {
    expect(parseArgs(argv).ok).toBe(false)
  })
})

describe('checkCommentBody', () => {
  it('accepts a prefixed comment with its marker', () => {
    expect(checkCommentBody(PLAN_BODY).ok).toBe(true)
  })

  // Only the provenance module unescapes before matching. A local regex
  // written for the plain prefix would refuse this, so this pins that the
  // check is the shared one (TAC-396), not a second copy of it.
  it('accepts a prefix that arrives with escaped brackets', () => {
    expect(checkCommentBody('**\\[FROM CLAUDE CODE\\]**\n\n\\[AUDIT\\] TAC-1\n\nBody.').ok).toBe(true)
  })

  it.each([
    ['empty', '   \n'],
    ['no prefix', '[PLAN] TAC-1\n\nA plan.'],
    ['a Claude Chat ruling', '**[FROM CLAUDE CHAT — RULING]**\n\nBuild it.'],
    ['prefix without a marker', '**[FROM CLAUDE CODE]**\n\nJust some text.'],
    ['a marker only quoted later in the body', '**[FROM CLAUDE CODE]**\n\nThis is not a [PLAN] marker.'],
  ])('refuses %s', (_label, body) => {
    expect(checkCommentBody(body).ok).toBe(false)
  })
})

describe('checkDescriptionBody', () => {
  it('refuses an empty description rather than blanking the ticket', () => {
    expect(checkDescriptionBody(' \n\t').ok).toBe(false)
  })

  it('accepts any non-empty description', () => {
    expect(checkDescriptionBody('## Open questions\n\n1. A question.').ok).toBe(true)
  })
})

describe('redact', () => {
  it('replaces every occurrence of the key', () => {
    expect(redact(`a ${FAKE_KEY} b ${FAKE_KEY}`, FAKE_KEY)).toBe('a *** b ***')
  })

  it('leaves text alone when there is no key', () => {
    expect(redact('text', '')).toBe('text')
  })
})

describe('comment', () => {
  it('posts the file as the body, flat, on the resolved issue', async () => {
    const r = await runWith(['comment', 'TAC-1', '/tmp/plan.md'], {
      fileMap: { '/tmp/plan.md': PLAN_BODY },
      handlers: {
        'issue(id:': ISSUE_OK,
        commentCreate: { body: { data: { commentCreate: { success: true, comment: { id: 'c-1' } } } } },
      },
    })
    expect(r.code).toBe(EXIT.OK)
    expect(r.stdout).toBe('ok: comment posted on TAC-1 (c-1)\n')
    expect(r.stderr).toBe('')
    expect(r.calls).toHaveLength(2)
    expect(r.calls[0].variables).toEqual({ id: 'TAC-1' })
    const post = r.calls[1]
    expect(post.url).toBe(LINEAR_ENDPOINT)
    // Byte for byte what was in the file: quotes, backslashes and newlines
    // are the helper's to encode, not the session's.
    expect(post.variables).toEqual({ id: ISSUE_UUID, body: PLAN_BODY })
    expect(post.query).not.toContain('parentId')
  })

  it('sends nothing for a comment that is not one of Claude Code\'s own', async () => {
    const r = await runWith(['comment', 'TAC-1', '/tmp/plan.md'], {
      fileMap: { '/tmp/plan.md': 'Plan approved. Build it.' },
    })
    expect(r.code).toBe(EXIT.FAILED)
    expect(r.calls).toHaveLength(0)
    expect(r.stderr).toContain('**[FROM CLAUDE CODE]**')
  })

  it('sends nothing when the file cannot be read', async () => {
    const r = await runWith(['comment', 'TAC-1', '/tmp/missing.md'])
    expect(r.code).toBe(EXIT.FAILED)
    expect(r.calls).toHaveLength(0)
    expect(r.stderr).toContain('/tmp/missing.md')
  })

  it('fails when Linear does not return success: true', async () => {
    const r = await runWith(['comment', 'TAC-1', '/tmp/plan.md'], {
      fileMap: { '/tmp/plan.md': PLAN_BODY },
      handlers: { 'issue(id:': ISSUE_OK, commentCreate: { body: { data: { commentCreate: { success: false } } } } },
    })
    expect(r.code).toBe(EXIT.FAILED)
    expect(r.stdout).toBe('')
  })

  it('fails when the issue does not exist, before posting anything', async () => {
    const r = await runWith(['comment', 'TAC-999', '/tmp/plan.md'], {
      fileMap: { '/tmp/plan.md': PLAN_BODY },
      handlers: { 'issue(id:': { body: { data: { issue: null } } } },
    })
    expect(r.code).toBe(EXIT.FAILED)
    expect(r.calls).toHaveLength(1)
  })
})

describe('describe', () => {
  it('replaces the description with the file, as written', async () => {
    const description = '**Repo:** `analog-guest`\n\n## Open questions\n\n1. "A" question?'
    const r = await runWith(['describe', 'TAC-1', '/tmp/d.md'], {
      fileMap: { '/tmp/d.md': description },
      handlers: { 'issue(id:': ISSUE_OK, issueUpdate: { body: { data: { issueUpdate: { success: true } } } } },
    })
    expect(r.code).toBe(EXIT.OK)
    expect(r.stdout).toBe('ok: description updated on TAC-1\n')
    expect(r.calls[1].query).toContain('description: $description')
    expect(r.calls[1].variables).toEqual({ id: ISSUE_UUID, description })
  })

  it('sends nothing for an empty file', async () => {
    const r = await runWith(['describe', 'TAC-1', '/tmp/d.md'], { fileMap: { '/tmp/d.md': '\n' } })
    expect(r.code).toBe(EXIT.FAILED)
    expect(r.calls).toHaveLength(0)
  })

  it('fails when Linear does not return success: true', async () => {
    const r = await runWith(['describe', 'TAC-1', '/tmp/d.md'], {
      fileMap: { '/tmp/d.md': 'text' },
      handlers: { 'issue(id:': ISSUE_OK, issueUpdate: { body: { data: { issueUpdate: { success: false } } } } },
    })
    expect(r.code).toBe(EXIT.FAILED)
  })
})

describe('label', () => {
  const labels = (nodes: unknown[]): Reply => ({ body: { data: { issueLabels: { nodes } } } })

  it('adds the label this ticket can carry, skipping another team\'s', async () => {
    const r = await runWith(['label', 'add', 'TAC-1', 'Needs Decision'], {
      handlers: {
        'issue(id:': ISSUE_OK,
        issueLabels: labels([
          { id: 'l-other', name: 'Needs Decision', team: { id: OTHER_TEAM_ID } },
          { id: 'l-workspace', name: 'Needs Decision', team: null },
        ]),
        issueAddLabel: { body: { data: { issueAddLabel: { success: true } } } },
      },
    })
    expect(r.code).toBe(EXIT.OK)
    expect(r.stdout).toBe('ok: label "Needs Decision" added to TAC-1\n')
    expect(r.calls[1].variables).toEqual({ name: 'Needs Decision' })
    expect(r.calls[2].variables).toEqual({ id: ISSUE_UUID, labelId: 'l-workspace' })
  })

  it('removes a label through issueRemoveLabel', async () => {
    const r = await runWith(['label', 'remove', 'TAC-1', 'Needs Decision'], {
      handlers: {
        'issue(id:': ISSUE_OK,
        issueLabels: labels([{ id: 'l-team', name: 'Needs Decision', team: { id: TEAM_ID } }]),
        issueRemoveLabel: { body: { data: { issueRemoveLabel: { success: true } } } },
      },
    })
    expect(r.code).toBe(EXIT.OK)
    expect(r.stdout).toBe('ok: label "Needs Decision" removed from TAC-1\n')
    expect(r.calls[2].query).toContain('issueRemoveLabel')
    expect(r.calls[2].variables).toEqual({ id: ISSUE_UUID, labelId: 'l-team' })
  })

  it('refuses to guess between two labels this ticket could carry', async () => {
    const r = await runWith(['label', 'add', 'TAC-1', 'Needs Decision'], {
      handlers: {
        'issue(id:': ISSUE_OK,
        issueLabels: labels([
          { id: 'l-team', name: 'Needs Decision', team: { id: TEAM_ID } },
          { id: 'l-workspace', name: 'Needs Decision', team: null },
        ]),
      },
    })
    expect(r.code).toBe(EXIT.FAILED)
    expect(r.calls.some((c) => c.query.includes('issueAddLabel'))).toBe(false)
  })

  it('fails when no such label exists', async () => {
    const r = await runWith(['label', 'add', 'TAC-1', 'Needs Decison'], {
      handlers: { 'issue(id:': ISSUE_OK, issueLabels: labels([]) },
    })
    expect(r.code).toBe(EXIT.FAILED)
  })

  it.each(['add', 'remove'])('fails when Linear does not return success: true on %s', async (op) => {
    const field = op === 'add' ? 'issueAddLabel' : 'issueRemoveLabel'
    const r = await runWith(['label', op, 'TAC-1', 'Needs Decision'], {
      handlers: {
        'issue(id:': ISSUE_OK,
        issueLabels: labels([{ id: 'l-team', name: 'Needs Decision', team: { id: TEAM_ID } }]),
        [field]: { body: { data: { [field]: { success: false } } } },
      },
    })
    expect(r.code).toBe(EXIT.FAILED)
  })
})

describe('state', () => {
  const states = (nodes: unknown[]): Reply => ({ body: { data: { workflowStates: { nodes } } } })

  it('moves the ticket to the named state in its own team', async () => {
    const r = await runWith(['state', 'TAC-1', 'Ready'], {
      handlers: {
        'issue(id:': ISSUE_OK,
        workflowStates: states([{ id: 's-ready', name: 'Ready' }]),
        issueUpdate: { body: { data: { issueUpdate: { success: true } } } },
      },
    })
    expect(r.code).toBe(EXIT.OK)
    expect(r.stdout).toBe('ok: TAC-1 moved to Ready\n')
    expect(r.calls[1].variables).toEqual({ name: 'Ready', team: TEAM_ID })
    expect(r.calls[2].query).toContain('stateId: $stateId')
    expect(r.calls[2].variables).toEqual({ id: ISSUE_UUID, stateId: 's-ready' })
  })

  it('fails when the team has no such state', async () => {
    const r = await runWith(['state', 'TAC-1', 'Redy'], {
      handlers: { 'issue(id:': ISSUE_OK, workflowStates: states([]) },
    })
    expect(r.code).toBe(EXIT.FAILED)
  })

  it('fails when Linear does not return success: true', async () => {
    const r = await runWith(['state', 'TAC-1', 'Ready'], {
      handlers: {
        'issue(id:': ISSUE_OK,
        workflowStates: states([{ id: 's-ready', name: 'Ready' }]),
        issueUpdate: { body: { data: { issueUpdate: { success: false } } } },
      },
    })
    expect(r.code).toBe(EXIT.FAILED)
  })
})

describe('transport failures', () => {
  const stateCall = (issueReply: Reply) =>
    runWith(['state', 'TAC-1', 'Ready'], { handlers: { 'issue(id:': issueReply } })

  it('fails on GraphQL errors, even with HTTP 200', async () => {
    const r = await stateCall({ body: { errors: [{ message: 'Entity not found' }], data: null } })
    expect(r.code).toBe(EXIT.FAILED)
    expect(r.stderr).toContain('Entity not found')
  })

  it('fails on a non-JSON response', async () => {
    const r = await stateCall({ status: 502, raw: '<html>Bad gateway</html>' })
    expect(r.code).toBe(EXIT.FAILED)
    expect(r.stderr).toContain('HTTP 502')
  })

  it('fails on an HTTP error with a JSON body', async () => {
    const r = await stateCall({ status: 500, body: { message: 'boom' } })
    expect(r.code).toBe(EXIT.FAILED)
  })

  it('fails when the request itself throws', async () => {
    const r = await stateCall({ throws: new Error('ECONNRESET') })
    expect(r.code).toBe(EXIT.FAILED)
    expect(r.stderr).toContain('ECONNRESET')
  })
})

describe('usage', () => {
  it('exits 2 and sends nothing on a bad command', async () => {
    const r = await runWith(['post', 'TAC-1'])
    expect(r.code).toBe(EXIT.USAGE)
    expect(r.calls).toHaveLength(0)
    expect(r.stderr).toContain('usage:')
  })

  it('exits 2 and sends nothing without a key', async () => {
    const r = await runWith(['state', 'TAC-1', 'Ready'], { key: '' })
    expect(r.code).toBe(EXIT.USAGE)
    expect(r.calls).toHaveLength(0)
    expect(r.stderr).toContain('LINEAR_API_KEY is not set')
  })
})

describe('the key never appears in output or errors', () => {
  it('is sent only as the Authorization header, never in a request body', async () => {
    const r = await runWith(['comment', 'TAC-1', '/tmp/plan.md'], {
      fileMap: { '/tmp/plan.md': PLAN_BODY },
      handlers: { 'issue(id:': ISSUE_OK, commentCreate: { body: { data: { commentCreate: { success: true, comment: { id: 'c-1' } } } } } },
    })
    expect(r.code).toBe(EXIT.OK)
    for (const call of r.calls) {
      expect(call.headers.Authorization).toBe(FAKE_KEY)
      expect(call.rawBody).not.toContain(FAKE_KEY)
    }
  })

  // Every place a message can come from, made to echo the key.
  it.each<[string, string[], Record<string, Reply>, Record<string, string>]>([
    ['a GraphQL error that quotes the key', ['state', 'TAC-1', 'Ready'], { 'issue(id:': { status: 401, body: { errors: [{ message: `Authentication failed for ${FAKE_KEY}` }] } } }, {}],
    ['a non-JSON body that quotes the key', ['state', 'TAC-1', 'Ready'], { 'issue(id:': { status: 400, raw: `bad header: Authorization: ${FAKE_KEY}` } }, {}],
    ['a network error that quotes the key', ['state', 'TAC-1', 'Ready'], { 'issue(id:': { throws: new Error(`socket closed sending ${FAKE_KEY}`) } }, {}],
    ['a success line that echoes the key', ['comment', 'TAC-1', '/tmp/plan.md'], { 'issue(id:': { body: { data: { issue: { id: ISSUE_UUID, identifier: FAKE_KEY, team: { id: TEAM_ID } } } } }, commentCreate: { body: { data: { commentCreate: { success: true, comment: { id: FAKE_KEY } } } } } }, { '/tmp/plan.md': PLAN_BODY }],
    ['a file error that names the key', ['comment', 'TAC-1', `/tmp/${FAKE_KEY}.md`], {}, {}],
  ])('%s', async (_label, argv, handlers, fileMap) => {
    const r = await runWith(argv, { handlers, fileMap })
    const printed = r.stdout + r.stderr
    expect(printed).not.toBe('')
    expect(printed).not.toContain(FAKE_KEY)
    expect(printed).toContain('***')
  })
})

// The real entry point, as a CI session runs it, with a fake key in its
// environment. Only paths that stop before the network, so no request leaves
// the machine.
describe('scripts/linear.mjs as a process', () => {
  const entry = resolve(__dirname, '..', 'linear.mjs')
  const node = (args: string[], env: Record<string, string>) => {
    const r = spawnSync(process.execPath, [entry, ...args], {
      env: { NODE_ENV: 'test' as const, PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
      timeout: 20_000,
    })
    return { code: r.status, printed: `${r.stdout}${r.stderr}` }
  }

  it('prints usage and exits 2 on a bad command, without the key', () => {
    const r = node([], { LINEAR_API_KEY: FAKE_KEY })
    expect(r.code).toBe(EXIT.USAGE)
    expect(r.printed).toContain('usage:')
    expect(r.printed).not.toContain(FAKE_KEY)
  })

  it('redacts the key from a file error in the real process', () => {
    const r = node(['comment', 'TAC-1', join(tmpdir(), `${FAKE_KEY}-missing.md`)], { LINEAR_API_KEY: FAKE_KEY })
    expect(r.code).toBe(EXIT.FAILED)
    expect(r.printed).toContain('***')
    expect(r.printed).not.toContain(FAKE_KEY)
  })

  it('refuses an unprefixed comment before any request', () => {
    const dir = mkdtempSync(join(tmpdir(), 'linear-cli-'))
    const file = join(dir, 'comment.md')
    writeFileSync(file, 'Approved, go ahead.')
    const r = node(['comment', 'TAC-1', file], { LINEAR_API_KEY: FAKE_KEY })
    expect(r.code).toBe(EXIT.FAILED)
    expect(r.printed).toContain('**[FROM CLAUDE CODE]**')
    expect(r.printed).not.toContain(FAKE_KEY)
  })

  it('exits 2 when LINEAR_API_KEY is not set', () => {
    const r = node(['state', 'TAC-1', 'Ready'], {})
    expect(r.code).toBe(EXIT.USAGE)
    expect(r.printed).toContain('LINEAR_API_KEY is not set')
  })
})

describe('source', () => {
  // The comment check must be the provenance module's (TAC-396), so the
  // helper cannot accept a comment that the automation will then read as
  // human input.
  it('takes its comment check from comment-provenance.mjs', () => {
    const source = readFileSync(resolve(__dirname, 'linear-cli.mjs'), 'utf8')
    expect(source).toMatch(/import\s*\{[^}]*\bcommentMarker\b[^}]*\bisBotComment\b[^}]*\}\s*from\s*'\.\/comment-provenance\.mjs'/)
    expect(source).not.toMatch(/\/[^/\n]*FROM CLAUDE CODE[^/\n]*\/[gimsuy]*/)
  })
})
