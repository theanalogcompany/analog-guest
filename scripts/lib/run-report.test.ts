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
  MAX_LIST,
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
    'worktree list --porcelain': [
      'worktree /runner/checkout',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /runner/checkout/.worktrees/resume',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/jaipal/tac-447-one-ticket-per-run',
      '',
    ].join('\n'),
    '-C /runner/checkout/.worktrees/resume status --porcelain': ' M lib/c.ts\n',
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
      sideFolders: [
        { path: '/runner/checkout/.worktrees/resume', branch: 'jaipal/tac-447-one-ticket-per-run', uncommitted: [' M lib/c.ts'] },
      ],
      onLocalMain: [],
    })
  })

  // TAC-471: a resume edits its branch in a side folder, which the
  // checkout's own status cannot see, so each one is read with git -C.
  it('reads a side folder git could not read as unknown, not as none', () => {
    const rest = Object.fromEntries(Object.entries(answers).filter(([args]) => !args.startsWith('-C ')))
    expect(readGitState(fakeGit(rest), 'TAC-447').sideFolders).toEqual([
      { path: '/runner/checkout/.worktrees/resume', branch: 'jaipal/tac-447-one-ticket-per-run', uncommitted: null },
    ])
  })

  it('names no branch for a side folder on a detached head', () => {
    const state = readGitState(
      fakeGit({
        ...answers,
        'worktree list --porcelain': 'worktree /runner/checkout\nbranch refs/heads/main\n\nworktree /runner/checkout/.worktrees/baseline\ndetached\n',
        '-C /runner/checkout/.worktrees/baseline status --porcelain': '',
      }),
      'TAC-447',
    )
    expect(state.sideFolders).toEqual([{ path: '/runner/checkout/.worktrees/baseline', branch: null, uncommitted: [] }])
  })

  it('lists no side folder when the checkout is the only worktree', () => {
    const state = readGitState(
      fakeGit({ ...answers, 'worktree list --porcelain': 'worktree /runner/checkout\nbranch refs/heads/main\n' }),
      'TAC-447',
    )
    expect(state.sideFolders).toEqual([])
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

  it('reads a git call that failed as unknown, not as none', () => {
    const state = readGitState(fakeGit({ [REFS]: 'refs/heads/jaipal/tac-447-x\nrefs/remotes/origin/jaipal/tac-447-x' }), 'TAC-447')
    expect(state.branches).toEqual([
      { name: 'jaipal/tac-447-x', local: true, remote: true, onGitHub: null, notPushed: null },
    ])
    expect(state.uncommitted).toBeNull()
    expect(state.sideFolders).toBeNull()
  })

  it('says so when git cannot be read at all', () => {
    expect(readGitState(fakeGit({}), 'TAC-447')).toEqual({ readable: false })
  })
})

// 20s, not the 5000ms default (2026-09-25). Every test in this block shells
// out to real git, and the beforeAll below builds an entire repository —
// init bare, clone, branch, commits, a worktree. Unloaded that is ~500ms for
// the whole file, but vitest runs on the forks pool at CPU count and under a
// full-suite run these spawns compete with every other fork; this block
// failed intermittently in the full suite while passing every time alone.
//
// The budget is raised rather than the work reduced because the real git IS
// the test: the fake above answers only the argument lists this module sends,
// so it cannot tell a wrong revision range from a right one. Same reasoning
// and same number as scripts/lib/linear-cli.test.ts and the claim-check test
// in build-workflow.test.ts.
describe('readGitState against a real repository', { timeout: 20_000 }, () => {
  // The fake above answers only the argument lists this module sends, so it
  // cannot tell a wrong range from a right one. This runs the same calls
  // against real git.
  let dir: string
  let work: string
  // A git hook (this test runs in the pre-commit hook) exports GIT_DIR and
  // GIT_INDEX_FILE, which would point every call here at the outer repo, and
  // `git -c` or a global config can change hash length or run hooks. None of
  // it may reach the temporary repository, so every GIT_ variable goes.
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'
  const git = (cwd: string) => (args: string[]) => {
    try {
      return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return null
    }
  }
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      env,
      stdio: 'ignore',
    })
  const subject = (line: string) => line.split(' ').slice(1).join(' ')

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-report-'))
    const origin = join(dir, 'origin.git')
    work = join(dir, 'work')
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { env, stdio: 'ignore' })
    execFileSync('git', ['clone', origin, work], { env, stdio: 'ignore' })
    sh(work, 'checkout', '-b', 'main')
    writeFileSync(join(work, 'a.txt'), 'a')
    // As in this repo, so the checkout's own status cannot see a side folder.
    writeFileSync(join(work, '.gitignore'), '.worktrees/\n')
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
    sh(work, 'worktree', 'add', '--detach', '.worktrees/resume')
    writeFileSync(join(work, '.worktrees', 'resume', 'e.txt'), 'e')
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
    expect(b.onGitHub.map(subject)).toEqual(['TAC-447: pushed'])
    expect(b.notPushed.map(subject)).toEqual(['TAC-447: not pushed'])
    expect(state.uncommitted).toEqual(['?? d.txt'])
    expect(state.onLocalMain).toEqual([])
  })

  it('reads uncommitted work in a side folder, which the checkout\'s own status cannot see', () => {
    const state = readGitState(git(work), 'TAC-447')
    expect(state.uncommitted).not.toContain('?? e.txt')
    expect(state.sideFolders).toHaveLength(1)
    const [folder] = state.sideFolders ?? []
    expect(folder.path.endsWith('/work/.worktrees/resume')).toBe(true)
    expect(folder.branch).toBeNull()
    expect(folder.uncommitted).toEqual(['?? e.txt'])
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
    expect(report).toContain('\u02cbthird\u02cb')
    expect(report).not.toContain('`third`')
  })

  it('lists each side folder\'s uncommitted work, with its branch', () => {
    const report = renderGitReport({
      ...state,
      sideFolders: [{ path: '/runner/checkout/.worktrees/resume', branch: 'jaipal/tac-447-x', uncommitted: ['?? lib/e.ts'] }],
    })
    expect(report).toContain('Changed in the side folder /runner/checkout/.worktrees/resume but never committed, and lost (on jaipal/tac-447-x):\n\n```text\n?? lib/e.ts\n```')
  })

  it('says side folders are unknown when git could not list them', () => {
    expect(renderGitReport({ ...state, sideFolders: null })).toContain(
      'Changed in a side folder but never committed, and lost:\n\n```text\n(unknown: git could not read it)\n```',
    )
  })

  it('adds nothing when there is no side folder', () => {
    expect(renderGitReport({ ...state, sideFolders: [] })).not.toContain('side folder')
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

  it('says a list is unknown when git could not read it, rather than empty', () => {
    const report = renderGitReport({
      ...state,
      branches: [{ name: 'jaipal/tac-447-x', local: true, remote: true, onGitHub: null, notPushed: null }],
      uncommitted: null,
    })
    expect(report).toContain('jaipal/tac-447-x (unknown: git could not read it)')
    expect(report).not.toContain('(none)')
    expect(report).not.toContain('commits ahead of main')
  })

  it('cuts a long list so the comment stays postable', () => {
    const many = Array.from({ length: MAX_LIST + 7 }, (_, i) => `?? file-${i}.ts`)
    const report = renderGitReport({ ...state, uncommitted: many })
    expect(report).toContain(`?? file-${MAX_LIST - 1}.ts\n...and 7 more`)
    expect(report).not.toContain(`?? file-${MAX_LIST}.ts`)
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

  it('accepts a ticket id typed in lowercase on a manual dispatch', () => {
    const { code, out } = call(['notice', 'tac-447', '/stopped.json', '60'])
    expect(code).toBe(EXIT.OK)
    expect(out).toContain('[TURN-LIMIT] TAC-447')
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
    [['notice', 'not-a-ticket', '/stopped.json', '60']],
    [['notice', 'TAC-447', '/stopped.json']],
  ])('refuses %j with usage', (argv) => {
    const { code, out, err } = call(argv as string[])
    expect(code).toBe(EXIT.USAGE)
    expect(out).toBe('')
    expect(err).toContain('usage:')
  })
})
