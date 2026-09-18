import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { commentMarker } from './comment-provenance.mjs'
import { checkCommentBody } from './linear-cli.mjs'
import {
  ENDING,
  EXIT,
  classifyEnding,
  lastResult,
  readGitState,
  renderGitReport,
  renderOverLimit,
  renderTurnLimit,
  run,
} from './run-report.mjs'

// Result messages shaped like the ones the action wrote on real runs.
const FINISHED_OVER = { type: 'result', subtype: 'success', is_error: false, num_turns: 128 } // 35288433905, limit 120
const STOPPED = { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 61 } // 34949521131, limit 60
const FINISHED = { type: 'result', subtype: 'success', is_error: false, num_turns: 52 } // 35284910437, limit 120

const KEY = 'lin_api_SECRETKEY123'

type GitOut = Record<string, string | null>

// A fake git that answers only the exact argument lists it was given. Any
// other call fails, like a real git asked about a ref that isn't there.
function fakeGit(answers: GitOut) {
  return (args: string[]) => answers[args.join(' ')] ?? null
}

const REFS = 'for-each-ref --format=%(refname) refs/heads/ refs/remotes/origin/'

function captured() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    stdout: (t: string) => out.push(t),
    stderr: (t: string) => err.push(t),
  }
}

describe('lastResult', () => {
  it('takes the last result record from the execution file', () => {
    const text = JSON.stringify([{ type: 'system', subtype: 'init' }, FINISHED, { type: 'assistant' }, STOPPED])
    expect(lastResult(text)).toEqual(STOPPED)
  })

  it.each([['not json'], ['{"type":"result"}'], ['[]'], [JSON.stringify([{ type: 'system' }])]])(
    'returns null for %s',
    (text) => {
      expect(lastResult(text)).toBeNull()
    },
  )
})

describe('classifyEnding', () => {
  it('reads the CLI stopping the session as stopped at the limit', () => {
    expect(classifyEnding(STOPPED, 60)).toBe(ENDING.STOPPED_AT_LIMIT)
  })

  it('reads a finished session over the limit the way the action does', () => {
    expect(classifyEnding(FINISHED_OVER, 120)).toBe(ENDING.FINISHED_OVER_LIMIT)
    expect(classifyEnding({ ...FINISHED, num_turns: 121 }, 120)).toBe(ENDING.FINISHED_OVER_LIMIT)
  })

  it('counts exactly the limit as within it, as the action does', () => {
    expect(classifyEnding({ ...FINISHED, num_turns: 120 }, 120)).toBe(ENDING.FINISHED)
  })

  it('reads a finished session under the limit as finished', () => {
    expect(classifyEnding(FINISHED, 120)).toBe(ENDING.FINISHED)
  })

  it('reads any other failure as errored, not as a limit', () => {
    expect(classifyEnding({ ...FINISHED, is_error: true, num_turns: 500 }, 120)).toBe(ENDING.ERRORED)
    expect(classifyEnding({ type: 'result', subtype: 'error_during_execution', num_turns: 3 }, 120)).toBe(ENDING.ERRORED)
  })

  it('reads a missing record as no record', () => {
    expect(classifyEnding(null, 120)).toBe(ENDING.NO_RECORD)
  })
})

describe('readGitState', () => {
  const answers: GitOut = {
    [REFS]: [
      'refs/heads/main',
      'refs/heads/jaipal/tac-447-one-ticket-per-run',
      'refs/remotes/origin/main',
      'refs/remotes/origin/jaipal/tac-447-one-ticket-per-run',
      'refs/remotes/origin/jaipal/tac-4470-other-ticket',
      'refs/remotes/origin/jaipal/tac-325-order-capture',
    ].join('\n'),
    'log --format=%h %s refs/remotes/origin/main..refs/remotes/origin/jaipal/tac-447-one-ticket-per-run':
      'bbb2222 TAC-447: second\naaa1111 TAC-447: first\n',
    'log --format=%h %s refs/remotes/origin/jaipal/tac-447-one-ticket-per-run..refs/heads/jaipal/tac-447-one-ticket-per-run':
      'ccc3333 TAC-447: third, never pushed\n',
    'log --format=%h %s refs/remotes/origin/main..refs/heads/main': '',
    'rev-parse --abbrev-ref HEAD': 'jaipal/tac-447-one-ticket-per-run\n',
    'status --porcelain': ' M lib/a.ts\n?? lib/b.ts\n',
  }

  it('sorts what is on GitHub from what died with the runner', () => {
    const state = readGitState(fakeGit(answers), 'TAC-447')
    expect(state).toEqual({
      readable: true,
      head: 'jaipal/tac-447-one-ticket-per-run',
      branches: [
        {
          name: 'jaipal/tac-447-one-ticket-per-run',
          local: true,
          remote: true,
          onGitHub: ['bbb2222 TAC-447: second', 'aaa1111 TAC-447: first'],
          notPushed: ['ccc3333 TAC-447: third, never pushed'],
        },
      ],
      uncommitted: [' M lib/a.ts', '?? lib/b.ts'],
      onLocalMain: [],
    })
  })

  it('matches the ticket id whole and without regard to case', () => {
    const names = (readGitState(fakeGit(answers), 'TAC-447').branches ?? []).map((b: { name: string }) => b.name)
    expect(names).toEqual(['jaipal/tac-447-one-ticket-per-run'])
  })

  it('lists a branch only an earlier run pushed', () => {
    const state = readGitState(
      fakeGit({
        [REFS]: 'refs/remotes/origin/main\nrefs/remotes/origin/jaipal/tac-325-order-capture',
        'log --format=%h %s refs/remotes/origin/main..refs/remotes/origin/jaipal/tac-325-order-capture': 'ddd4444 TAC-325: x\n',
        'status --porcelain': '',
      }),
      'TAC-325',
    )
    expect(state.branches).toEqual([
      { name: 'jaipal/tac-325-order-capture', local: false, remote: true, onGitHub: ['ddd4444 TAC-325: x'], notPushed: [] },
    ])
  })

  it('counts every commit of a branch that was never pushed as not pushed', () => {
    const state = readGitState(
      fakeGit({
        [REFS]: 'refs/remotes/origin/main\nrefs/heads/jaipal/tac-9-local-only',
        'log --format=%h %s refs/remotes/origin/main..refs/heads/jaipal/tac-9-local-only': 'eee5555 TAC-9: y\n',
      }),
      'TAC-9',
    )
    expect(state.branches).toEqual([
      { name: 'jaipal/tac-9-local-only', local: true, remote: false, onGitHub: [], notPushed: ['eee5555 TAC-9: y'] },
    ])
  })

  it('reports commits on local main', () => {
    const state = readGitState(
      fakeGit({ [REFS]: 'refs/heads/main', 'log --format=%h %s refs/remotes/origin/main..refs/heads/main': 'fff6666 oops\n' }),
      'TAC-1',
    )
    expect(state.onLocalMain).toEqual(['fff6666 oops'])
  })

  it('says so when git cannot be read at all', () => {
    expect(readGitState(fakeGit({}), 'TAC-447')).toEqual({ readable: false })
  })
})

describe('readGitState against a real repository', () => {
  // The fake above answers only the argument lists this module sends, so it
  // cannot tell a wrong range from a right one. This runs the same calls
  // against real git.
  let dir: string
  let work: string
  const git = (cwd: string) => (args: string[]) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return null
    }
  }
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      stdio: 'ignore',
    })

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-report-'))
    const origin = join(dir, 'origin.git')
    work = join(dir, 'work')
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' })
    execFileSync('git', ['clone', origin, work], { stdio: 'ignore' })
    sh(work, 'checkout', '-b', 'main')
    writeFileSync(join(work, 'a.txt'), 'a')
    sh(work, 'add', '.')
    sh(work, 'commit', '-m', 'base')
    sh(work, 'push', 'origin', 'main')
    sh(work, 'checkout', '-b', 'jaipal/tac-447-real')
    writeFileSync(join(work, 'b.txt'), 'b')
    sh(work, 'add', '.')
    sh(work, 'commit', '-m', 'TAC-447: pushed')
    sh(work, 'push', '-u', 'origin', 'jaipal/tac-447-real')
    writeFileSync(join(work, 'c.txt'), 'c')
    sh(work, 'add', '.')
    sh(work, 'commit', '-m', 'TAC-447: not pushed')
    writeFileSync(join(work, 'd.txt'), 'd')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('sorts pushed, not pushed and not committed', () => {
    const state = readGitState(git(work), 'TAC-447')
    expect(state.readable).toBe(true)
    expect(state.head).toBe('jaipal/tac-447-real')
    expect(state.branches).toHaveLength(1)
    const [b] = state.branches ?? []
    expect(b.name).toBe('jaipal/tac-447-real')
    expect(b.onGitHub.map((c: string) => c.slice(8))).toEqual(['TAC-447: pushed'])
    expect(b.notPushed.map((c: string) => c.slice(8))).toEqual(['TAC-447: not pushed'])
    expect(state.uncommitted).toEqual(['?? d.txt'])
    expect(state.onLocalMain).toEqual([])
  })
})

describe('renderGitReport', () => {
  const state = {
    readable: true,
    head: 'jaipal/tac-447-x',
    branches: [
      { name: 'jaipal/tac-447-x', local: true, remote: true, onGitHub: ['aaa1111 TAC-447: first'], notPushed: ['ccc3333 TAC-447: `third`'] },
    ],
    uncommitted: [' M lib/a.ts'],
    onLocalMain: [],
  }

  it('names each bucket and what is in it', () => {
    const report = renderGitReport(state)
    expect(report).toContain('On GitHub, and kept:\n\n```text\njaipal/tac-447-x (1 commit ahead of main)\n  aaa1111 TAC-447: first\n```')
    expect(report).toContain('Committed on the runner but never pushed, and lost:\n\n```text\njaipal/tac-447-x\n  ccc3333')
    expect(report).toContain('Changed on the runner but never committed, and lost (on jaipal/tac-447-x):\n\n```text\n M lib/a.ts\n```')
    expect(report).not.toContain('Committed to main')
  })

  it('keeps a backtick in a commit subject from closing the fence', () => {
    const report = renderGitReport(state)
    expect(report).toContain('ˋthirdˋ')
    expect(report).not.toContain('`third`')
  })

  it('says nothing reached GitHub when there is no branch', () => {
    const report = renderGitReport({ ...state, branches: [], uncommitted: [] })
    expect(report).toContain('On GitHub, and kept: no branch for this ticket, so nothing.')
    expect(report).toContain('never pushed, and lost:\n\n```text\n(none)\n```')
  })

  it('flags commits made on main', () => {
    expect(renderGitReport({ ...state, onLocalMain: ['fff6666 oops'] })).toContain(
      'Committed to main on the runner, which a session must never do. Never pushed, and lost:',
    )
  })

  it('says the state is unknown when git could not be read', () => {
    expect(renderGitReport({ readable: false })).toContain('what was pushed is unknown')
  })
})

describe('the two notices', () => {
  const common = { ticket: 'TAC-447', turns: 61, maxTurns: 60, gitReport: 'REPORT', runUrl: 'https://run' }

  it('[TURN-LIMIT] is a comment the Linear helper accepts, with its own marker', () => {
    const body = renderTurnLimit({ ...common, denials: '2', denied: ['Bash: npx eslint x', 'Edit: /a/b'] })
    expect(checkCommentBody(body)).toMatchObject({ ok: true })
    expect(commentMarker(body)).toBe('TURN-LIMIT')
    expect(body).toContain('stopped at its turn limit (61 turns against a limit of 60)')
    expect(body).toContain('```text\nBash: npx eslint x\nEdit: /a/b\n```')
    expect(body).toContain('Reply here to continue.')
  })

  it('[OVER-LIMIT] is bookkeeping the helper accepts, with the run, turns and limit on its marker line', () => {
    const body = renderOverLimit({ ...common, turns: 128, maxTurns: 120, runId: '35288433905' })
    expect(checkCommentBody(body)).toMatchObject({ ok: true })
    expect(commentMarker(body)).toBe('OVER-LIMIT')
    expect(body).toContain('[OVER-LIMIT] TAC-447 run=35288433905 turns=128 limit=120')
    expect(body).toContain('The session was not cut short.')
    expect(body).toContain('Bookkeeping: the automation ignores this comment.')
  })
})

describe('run', () => {
  const files: Record<string, string> = {
    '/stopped.json': JSON.stringify([{ type: 'system' }, STOPPED]),
    '/over.json': JSON.stringify([FINISHED_OVER]),
    '/finished.json': JSON.stringify([FINISHED]),
  }
  const readFile = (p: string) => {
    if (!(p in files)) throw new Error('ENOENT')
    return files[p]
  }
  const git = fakeGit({
    [REFS]: 'refs/remotes/origin/jaipal/tac-447-x',
    'log --format=%h %s refs/remotes/origin/main..refs/remotes/origin/jaipal/tac-447-x': `aaa1111 TAC-447: mentions ${KEY}\n`,
  })
  const env = {
    LINEAR_API_KEY: KEY,
    RUN_URL: 'https://github.com/x/actions/runs/1',
    GITHUB_RUN_ID: '1',
    DENIALS: '2',
    DENIED: `- Bash: curl -H "Authorization: ${KEY}"\n- Edit: /a/b`,
  }
  const call = (argv: string[]) => {
    const io = captured()
    const code = run({ argv, env, readFile, git, stdout: io.stdout, stderr: io.stderr })
    return { code, out: io.out.join(''), err: io.err.join('') }
  }

  it.each([
    ['/stopped.json', '60', 'stopped-at-limit'],
    ['/over.json', '120', 'finished-over-limit'],
    ['/finished.json', '120', 'finished'],
    ['/missing.json', '120', 'no-record'],
  ])('ending %s against %s prints %s', (file, limit, expected) => {
    expect(call(['ending', file, limit])).toEqual({ code: EXIT.OK, out: `${expected}\n`, err: '' })
  })

  it('notice prints [TURN-LIMIT] for a stopped session, with the denied list', () => {
    const { code, out } = call(['notice', 'TAC-447', '/stopped.json', '60'])
    expect(code).toBe(EXIT.OK)
    expect(commentMarker(out)).toBe('TURN-LIMIT')
    expect(out).toContain('- Permission denials: 2')
    expect(out).toContain('Edit: /a/b')
    expect(out).toContain('aaa1111 TAC-447: mentions')
  })

  it('notice prints [OVER-LIMIT] for a session that finished over the limit', () => {
    const { code, out } = call(['notice', 'TAC-447', '/over.json', '120'])
    expect(code).toBe(EXIT.OK)
    expect(out).toContain('[OVER-LIMIT] TAC-447 run=1 turns=128 limit=120')
  })

  it.each([['/finished.json'], ['/missing.json']])('notice prints nothing for %s', (file) => {
    expect(call(['notice', 'TAC-447', file, '120'])).toEqual({ code: EXIT.OK, out: '', err: '' })
  })

  it('never prints the key, from the denied list or from git', () => {
    for (const [file, limit] of [['/stopped.json', '60'], ['/over.json', '120']]) {
      const { out } = call(['notice', 'TAC-447', file, limit])
      expect(out.length).toBeGreaterThan(0)
      expect(out).not.toContain(KEY)
    }
  })

  it.each([
    [[]],
    [['nonsense']],
    [['ending', '/stopped.json']],
    [['ending', '/stopped.json', 'lots']],
    [['ending', '/stopped.json', '0']],
    [['notice', 'tac-447', '/stopped.json', '60']],
    [['notice', 'TAC-447', '/stopped.json']],
  ])('refuses %j with usage', (argv) => {
    const { code, out, err } = call(argv as string[])
    expect(code).toBe(EXIT.USAGE)
    expect(out).toBe('')
    expect(err).toContain('usage:')
  })
})
