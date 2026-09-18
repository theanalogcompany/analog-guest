import { describe, expect, it } from 'vitest'
import { EXIT, MERGE_COMMIT_MESSAGE, REQUIRED_FILES, USAGE, findBranch, missingFiles, refreshOne, run } from './refresh-branch.mjs'

type Exec = (args: string[]) => { ok: boolean; output: string }

const ok = (output = ''): { ok: true; output: string } => ({ ok: true, output })
const fail = (output = ''): { ok: false; output: string } => ({ ok: false, output })

describe('findBranch', () => {
  const REFS = 'origin/jaipal/tac-462-x\norigin/jaipal/tac-4620-y\norigin/main\n'

  it('finds the ticket\'s branch, case-insensitively', () => {
    expect(findBranch(REFS, 'TAC-462')).toBe('jaipal/tac-462-x')
    expect(findBranch(REFS, 'tac-462')).toBe('jaipal/tac-462-x')
  })

  it('does not match a numeric-prefix collision: TAC-462 is not a prefix of TAC-4620\'s branch', () => {
    expect(findBranch('origin/jaipal/tac-4620-y\n', 'TAC-462')).toBeNull()
  })

  it('returns null when the ticket has no branch', () => {
    expect(findBranch('origin/jaipal/tac-1-x\norigin/main\n', 'TAC-462')).toBeNull()
  })

  it('returns null against empty or missing input', () => {
    expect(findBranch('', 'TAC-462')).toBeNull()
    expect(findBranch(undefined as unknown as string, 'TAC-462')).toBeNull()
  })
})

describe('missingFiles', () => {
  it('checks every required file against the branch, over the local refs', () => {
    const calls: string[][] = []
    const git: Exec = (args) => {
      calls.push(args)
      return ok()
    }
    missingFiles(git, 'jaipal/tac-462-x')
    expect(calls).toEqual(REQUIRED_FILES.map((f) => ['cat-file', '-e', `origin/jaipal/tac-462-x:${f}`]))
  })

  it('names only the files that are missing', () => {
    const git: Exec = (args) => (args[2] === `origin/b:${REQUIRED_FILES[0]}` ? fail() : ok())
    expect(missingFiles(git, 'b')).toEqual([REQUIRED_FILES[0]])
  })

  it('is empty when every file is present', () => {
    expect(missingFiles(() => ok(), 'b')).toEqual([])
  })
})

describe('refreshOne', () => {
  const refsOutput = 'origin/jaipal/tac-462-x\n'
  const allPresent: Exec = () => ok()
  const noGh: Exec = () => {
    throw new Error('gh should not be called')
  }

  it('reports no-branch when the ticket has none, and never touches git or gh beyond the ref list', () => {
    const r = refreshOne({ identifier: 'TAC-9', refsOutput, git: noGh, gh: noGh, repo: 'o/r' })
    expect(r).toEqual({ ticket: 'TAC-9', outcome: 'no-branch' })
  })

  it('reports up-to-date when every required file is already on the branch, and never calls gh', () => {
    const r = refreshOne({ identifier: 'TAC-462', refsOutput, git: allPresent, gh: noGh, repo: 'o/r' })
    expect(r).toEqual({ ticket: 'TAC-462', branch: 'jaipal/tac-462-x', outcome: 'up-to-date' })
  })

  it('merges main into the branch on GitHub when a file is missing, and reports what was missing', () => {
    const git: Exec = (args) => (args[0] === 'cat-file' ? fail() : ok())
    const ghCalls: string[][] = []
    const gh: Exec = (args) => {
      ghCalls.push(args)
      return ok()
    }
    const r = refreshOne({ identifier: 'TAC-462', refsOutput, git, gh, repo: 'theanalogcompany/analog-guest' })
    expect(r).toEqual({ ticket: 'TAC-462', branch: 'jaipal/tac-462-x', outcome: 'merged', missing: REQUIRED_FILES })
    expect(ghCalls).toEqual([
      [
        'api',
        'repos/theanalogcompany/analog-guest/merges',
        '-f',
        'base=jaipal/tac-462-x',
        '-f',
        'head=main',
        '-f',
        `commit_message=${MERGE_COMMIT_MESSAGE}`,
      ],
    ])
  })

  it('a successful merge\'s courtesy fetch failing is not reported as the merge itself failing', () => {
    // The merge already succeeded on GitHub — the local ref refresh is a
    // courtesy, not the source of truth (module header). The session's own
    // `git fetch origin` before checkout is the real backstop.
    const git: Exec = (args) => (args[0] === 'fetch' ? fail('network blip') : fail())
    const r = refreshOne({ identifier: 'TAC-462', refsOutput, git, gh: () => ok(), repo: 'o/r' })
    expect(r.outcome).toBe('merged')
  })

  it('fetches the merged branch fresh after a successful merge', () => {
    const git: Exec = (args) => (args[0] === 'cat-file' ? fail() : ok())
    const calls: string[][] = []
    const wrapped: Exec = (args) => {
      calls.push(args)
      return git(args)
    }
    refreshOne({ identifier: 'TAC-462', refsOutput, git: wrapped, gh: () => ok(), repo: 'o/r' })
    expect(calls).toContainEqual(['fetch', 'origin', '+refs/heads/jaipal/tac-462-x:refs/remotes/origin/jaipal/tac-462-x'])
  })

  it('reports failed with gh\'s own error text when the merge cannot be made, and never fetches', () => {
    const git: Exec = (args) => {
      if (args[0] === 'fetch') throw new Error('must not fetch on a failed merge')
      return args[0] === 'cat-file' ? fail() : ok()
    }
    const r = refreshOne({ identifier: 'TAC-462', refsOutput, git, gh: () => fail('409 Conflict: Merge conflict'), repo: 'o/r' })
    expect(r).toEqual({ ticket: 'TAC-462', branch: 'jaipal/tac-462-x', outcome: 'failed', missing: REQUIRED_FILES, error: '409 Conflict: Merge conflict' })
  })

  it('treats a transient gh failure the same as a real conflict: both are "failed", with the real text attached', () => {
    // A false stop on a rare transient error costs one reply; guessing which
    // kind it was and silently retrying is the failure class this exists to
    // close (the plan's own framing).
    const git: Exec = (args) => (args[0] === 'cat-file' ? fail() : ok())
    const r = refreshOne({ identifier: 'TAC-462', refsOutput, git, gh: () => fail('502 Bad Gateway'), repo: 'o/r' })
    expect(r.outcome).toBe('failed')
    expect((r as { error: string }).error).toBe('502 Bad Gateway')
  })
})

describe('run', () => {
  const refsOutput = 'origin/jaipal/tac-462-x\n'

  function invoke({
    tickets = ['TAC-462'] as unknown,
    env = { GITHUB_REPOSITORY: 'theanalogcompany/analog-guest' } as Record<string, string>,
    git = ((args: string[]) => (args[0] === 'for-each-ref' ? ok(refsOutput) : ok())) as Exec,
    gh = (() => ok()) as Exec,
  } = {}) {
    const out: string[] = []
    const err: string[] = []
    const code = run({
      env,
      stdin: typeof tickets === 'string' ? tickets : JSON.stringify(tickets),
      git,
      gh,
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
    })
    return { code, out: out.join(''), err: err.join('') }
  }

  it('prints the per-ticket results, in the shape the workflow reads', () => {
    const r = invoke()
    expect(r.code).toBe(EXIT.OK)
    expect(JSON.parse(r.out)).toEqual([{ ticket: 'TAC-462', branch: 'jaipal/tac-462-x', outcome: 'up-to-date' }])
    expect(r.err).toBe('')
  })

  it('prints an empty array, not nothing, when there are no tickets', () => {
    const r = invoke({ tickets: [] })
    expect(r.code).toBe(EXIT.OK)
    expect(JSON.parse(r.out)).toEqual([])
  })

  it('handles more than one ticket, each independently', () => {
    const refs = 'origin/jaipal/tac-462-x\norigin/jaipal/tac-9-y\n'
    const git = (args: string[]) => {
      if (args[0] === 'for-each-ref') return ok(refs)
      if (args[0] === 'cat-file') return args[2]?.includes('tac-9-y') ? fail() : ok()
      return ok()
    }
    const r = invoke({ tickets: ['TAC-462', 'TAC-9', 'TAC-1'], git })
    const results = JSON.parse(r.out)
    expect(results.map((x: { ticket: string; outcome: string }) => `${x.ticket}:${x.outcome}`)).toEqual([
      'TAC-462:up-to-date',
      'TAC-9:merged',
      'TAC-1:no-branch',
    ])
  })

  it('rejects non-JSON input', () => {
    const r = invoke({ tickets: 'not json' })
    expect(r.code).toBe(EXIT.USAGE)
    expect(r.out).toBe('')
    expect(r.err).toContain(USAGE)
  })

  it('rejects a non-array payload', () => {
    const r = invoke({ tickets: '{}' })
    expect(r.code).toBe(EXIT.USAGE)
  })

  it('rejects an array of anything other than strings', () => {
    const r = invoke({ tickets: [{ identifier: 'TAC-462' }] as unknown })
    expect(r.code).toBe(EXIT.USAGE)
  })

  it('degrades to reporting no-branch for everything, with a warning, when the branch list cannot be read', () => {
    const r = invoke({ git: (args: string[]) => (args[0] === 'for-each-ref' ? fail() : ok()) })
    expect(r.code).toBe(EXIT.OK)
    expect(JSON.parse(r.out)).toEqual([{ ticket: 'TAC-462', outcome: 'no-branch' }])
    expect(r.err).toContain('::warning title=Stale-branch check::')
  })
})
