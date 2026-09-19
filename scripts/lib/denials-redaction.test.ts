import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

// TAC-442, mirroring analog-operator's TAC-441 (PR #60, merged 2026-09-18).
// [DENIALS] used to redact LINEAR_API_KEY alone. It now redacts every secret
// the capture step holds, by value, with the names read from the workflow
// file instead of a list someone has to remember to extend. Nothing runs a
// workflow under test, so this reads both files as text, extracts the real
// embedded jq, and shells out to the real `jq` binary — the same technique
// `repo-line-owner.test.ts` and `build-workflow.test.ts` already use, and
// `jq` as a direct CLI arg with the input on stdin, this repo's convention
// (not operator's temp-file one). Every value below is fake.

const ROOT = resolve(__dirname, '..', '..')
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8')

const FILES: Record<string, string> = {
  'build-ready.yml': read('.github/workflows/build-ready.yml'),
  'audit-new-todo.yml': read('.github/workflows/audit-new-todo.yml'),
}

/** The whole capture block, from its comment to the `fi` after the fallback. */
function extractCaptureBlock(source: string): string {
  const m = /( *# What the session did[\s\S]*?\n *SESSION='\{"ended"[^\n]*\n *fi\n)/.exec(source)
  if (!m) throw new Error('no capture block found')
  return m[1]
}

function extractSecretNames(source: string): string {
  const m = /SECRET_NAMES=\$\(git show [^\n]*\| jq -Rnc '\n([\s\S]*?)'\) \|\| SECRET_NAMES='\[\]'/.exec(source)
  if (!m) throw new Error('no SECRET_NAMES program found')
  return m[1]
}

function extractSession(source: string): string {
  const m = /SESSION=\$\(jq -c --argjson names "\$SECRET_NAMES" '\n([\s\S]*?)' "\$EXECUTION_FILE"\)/.exec(source)
  if (!m) throw new Error('no SESSION program found')
  return m[1]
}

/** Runs `program` as a jq CLI arg, `input` on stdin, under an explicit env. */
function jq(program: string, args: string[], input: string, env: Record<string, string> = {}): string {
  const r = spawnSync('jq', [...args, program], {
    input,
    encoding: 'utf8',
    // Not process.env: a real LINEAR_API_KEY in the shell running the tests
    // must not reach a case that expects it unset.
    env: { NODE_ENV: 'test' as const, PATH: process.env.PATH ?? '', ...env },
  })
  if (r.status !== 0) throw new Error(`jq failed: ${r.stderr}`)
  return r.stdout
}

describe('the [DENIALS] capture block redacts every secret it holds (TAC-442)', () => {
  it('is byte-identical in both workflows', () => {
    expect(extractCaptureBlock(FILES['audit-new-todo.yml'])).toBe(extractCaptureBlock(FILES['build-ready.yml']))
  })

  it('is valid bash in both workflows', () => {
    for (const [name, source] of Object.entries(FILES)) {
      const r = spawnSync('bash', ['-n'], { input: extractCaptureBlock(source), encoding: 'utf8' })
      expect(r.stderr, name).toBe('')
      expect(r.status, name).toBe(0)
    }
  })

  it('no "Denied, first 20, ..." line still says "key redacted"', () => {
    for (const [name, source] of Object.entries(FILES)) {
      expect(source, name).not.toContain('key redacted')
      expect((source.match(/Denied, first 20, secrets redacted:/g) ?? []).length, name).toBeGreaterThan(0)
    }
  })

  type Denial = { tool_name: string; tool_input: Record<string, string> }
  type Session = { ended: string; turns: number; denials: number; redacting: string[]; denied: string[] }

  const record = (denials: Denial[]) =>
    JSON.stringify([
      { type: 'system', subtype: 'init' },
      { type: 'result', subtype: 'success', num_turns: 7, permission_denials: denials },
    ])
  const bash = (command: string): Denial => ({ tool_name: 'Bash', tool_input: { command } })

  const LINEAR = 'fake-linear-key-0001'
  const SERVICE = 'fake-service-key-0002'
  const WITHHELD = ['(withheld: this step found no secret to redact against)']

  describe.each(Object.keys(FILES))('%s', (name) => {
    const session = extractSession(FILES[name])
    const capture = (names: string[], env: Record<string, string>, denials: Denial[]): Session =>
      JSON.parse(jq(session, ['-c', '--argjson', 'names', JSON.stringify(names)], record(denials), env))

    it('replaces each secret and leaves the rest of the command as it was', () => {
      const out = capture(['LINEAR_API_KEY', 'SERVICE_ROLE_KEY'], { LINEAR_API_KEY: LINEAR, SERVICE_ROLE_KEY: SERVICE }, [
        bash(`curl -H 'Authorization: ${LINEAR}' 'https://example.test/rest/v1/guests?apikey=${SERVICE}' | jq .`),
        { tool_name: 'Read', tool_input: { file_path: `/home/runner/work/_temp/${SERVICE}.md` } },
      ])
      expect(out.denied).toEqual([
        "Bash: curl -H 'Authorization: ***' 'https://example.test/rest/v1/guests?apikey=***' | jq .",
        'Read: /home/runner/work/_temp/***.md',
      ])
      expect(out.redacting).toEqual(['LINEAR_API_KEY', 'SERVICE_ROLE_KEY'])
      expect({ ended: out.ended, turns: out.turns, denials: out.denials }).toEqual({ ended: 'success', turns: 7, denials: 2 })
    })

    // An empty value would reach split(""), which breaks the text apart
    // between every character.
    it('skips a secret that is empty, blank or unset', () => {
      const out = capture(
        ['BLANK_KEY', 'EMPTY_KEY', 'LINEAR_API_KEY', 'UNSET_KEY'],
        { BLANK_KEY: ' \n\t', EMPTY_KEY: '', LINEAR_API_KEY: LINEAR },
        [bash('git -C /home/runner/work/analog-guest/analog-guest branch --show-current')],
      )
      expect(out.denied).toEqual(['Bash: git -C /home/runner/work/analog-guest/analog-guest branch --show-current'])
      expect(out.redacting).toEqual(['LINEAR_API_KEY'])
    })

    it('matches a secret saved with a trailing newline as it was typed', () => {
      const out = capture(['SERVICE_ROLE_KEY'], { SERVICE_ROLE_KEY: `${SERVICE}\n` }, [bash(`curl -d token=${SERVICE} https://example.test`)])
      expect(out.denied).toEqual(['Bash: curl -d token=*** https://example.test'])
    })

    it('redacts a multi-line secret before whitespace is collapsed', () => {
      const pem = '-----BEGIN FAKE KEY-----\nAAAAfake\nBBBBfake\n-----END FAKE KEY-----'
      const out = capture(['SIGNING_KEY'], { SIGNING_KEY: pem }, [bash(`printf '%s' '${pem}'\n| wc -c`)])
      expect(out.denied).toEqual(["Bash: printf '%s' '***' | wc -c"])
    })

    // A tool call with no command and no file path, an MCP call say, is
    // printed as JSON, where a newline in the secret is the two characters
    // \n and the raw value no longer matches.
    it('redacts a secret inside a tool input printed as JSON', () => {
      const pem = '-----BEGIN FAKE KEY-----\nAAAAfake\n-----END FAKE KEY-----'
      const out = capture(['SIGNING_KEY'], { SIGNING_KEY: pem }, [
        { tool_name: 'mcp__fake__post', tool_input: { body: `sign ${pem} "quoted"` } },
      ])
      expect(out.denied).toEqual(['mcp__fake__post: {"body":"sign *** \\"quoted\\""}'])
    })

    // Named so that name order would take the inner one first, cut it out
    // of the outer one, and leave the rest of the outer one showing.
    it('redacts a secret that contains another as a whole', () => {
      const inner = 'fake-inner-0004'
      const outer = `fake-outer-${inner}-end`
      const out = capture(['INNER_KEY', 'OUTER_KEY'], { INNER_KEY: inner, OUTER_KEY: outer }, [bash(`a ${outer} b ${inner} c`)])
      expect(out.denied).toEqual(['Bash: a *** b *** c'])
    })

    // "Bash: " is 6 characters, so the key starts at 1991 and runs across
    // the cut. Cut first and only its first 9 characters would survive.
    it('redacts before the 2000-character cut', () => {
      const pad = 'x'.repeat(1985)
      const out = capture(['LINEAR_API_KEY'], { LINEAR_API_KEY: LINEAR }, [bash(`${pad}${LINEAR} tail`)])
      expect(out.denied).toEqual([`Bash: ${pad}*** tail`])
    })

    it('withholds the commands when it holds no secret to redact against, and still counts them', () => {
      const denials = [bash(`curl -H 'Authorization: ${LINEAR}' https://api.linear.app/graphql`)]
      // No names: the workflow file could not be read.
      const unread = capture([], { LINEAR_API_KEY: LINEAR }, denials)
      expect({ denied: unread.denied, denials: unread.denials }).toEqual({ denied: WITHHELD, denials: 1 })
      // Names, but none of them set in this step.
      expect(capture(['LINEAR_API_KEY'], {}, denials).denied).toEqual(WITHHELD)
      // Nothing denied, nothing to withhold.
      expect(capture([], {}, []).denied).toEqual([])
    })
  })

  describe('the names come from the workflow file', () => {
    type Env = Record<string, unknown> | undefined
    type Doc = { env?: Env; jobs: Record<string, { env?: Env; steps: Array<{ env?: Env; run?: string }> }> }

    // Deliberately broader than the workflow's pattern, so a form it misses,
    // such as secrets['X'], fails here instead of going unredacted.
    const SECRET_EXPR = /\bsecrets\b|\bgithub\.token\b/
    const derive = (source: string, text: string): string[] => JSON.parse(jq(extractSecretNames(source), ['-Rnc'], text))

    /** The secret-bearing env the capture step holds: workflow, job and its own. */
    const heldSecrets = (source: string): Array<[string, string]> => {
      const doc = yaml.load(source) as Doc
      const [job] = Object.values(doc.jobs)
      const step = job.steps.find((s) => s.run?.includes('SESSION=$(jq'))
      if (!step) throw new Error('no capture step')
      return [doc.env, job.env, step.env]
        .flatMap((env) => Object.entries(env ?? {}))
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && SECRET_EXPR.test(entry[1]))
    }

    it.each(Object.keys(FILES))('%s: every secret its capture step holds is found, each as a whole value', (name) => {
      const source = FILES[name]
      const held = heldSecrets(source)
      expect(held.map(([n]) => n)).toContain('LINEAR_API_KEY')
      const derived = derive(source, source)
      for (const [n, value] of held) {
        expect({ name: n, derived: derived.includes(n) }).toEqual({ name: n, derived: true })
        // "Bearer ${{ secrets.X }}" can't be redacted on its own: the
        // variable's value is not the secret's.
        expect({ name: n, value, whole: /^\$\{\{[^}]*\}\}$/.test(value) }).toEqual({ name: n, value, whole: true })
      }
    })

    it('picks up a secret added later, at any level and in either quoting', () => {
      const workflow = [
        'env:',
        '  WORKFLOW_KEY: ${{ secrets.WORKFLOW_KEY }}',
        'jobs:',
        '  report:',
        '    env:',
        '      JOB_KEY: "${{ secrets.JOB_KEY }}"',
        '    steps:',
        '      - name: Report',
        '        env:',
        '          ADDED_LATER: ${{ secrets.SOME_NEW_SECRET }}',
        "          SINGLE_QUOTED: '${{ secrets.QUOTED }}'",
        '          GH_TOKEN: ${{ github.token }}',
        '          RUN_URL: ${{ github.server_url }}/${{ github.repository }}',
        '          TICKETS: ${{ steps.queue.outputs.tickets }}',
        '          LIMIT: "2"',
        '        run: echo',
        '',
      ].join('\n')
      expect(derive(FILES['build-ready.yml'], workflow)).toEqual(['ADDED_LATER', 'GH_TOKEN', 'JOB_KEY', 'SINGLE_QUOTED', 'WORKFLOW_KEY'])
    })
  })
})
