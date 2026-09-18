import { describe, expect, it } from 'vitest'
import { REF_FORMAT } from './claims.mjs'
import { EXIT, PIPELINE, USAGE, deriveTargetStatus, reconcile, run } from './reconcile-status.mjs'

const ref = (name: string, at = 0, email = 'jaipal@foncii.com') => ({ name, at, email })

describe('deriveTargetStatus', () => {
  it('moves a Ready ticket with a branch to In Progress', () => {
    expect(deriveTargetStatus({ currentState: 'Ready', hasBranch: true, hasMergedPr: false })).toBe('In Progress')
  })

  it('moves a Ready ticket whose PR already merged straight to Ready For QA', () => {
    // A ticket can reach Ready For QA without ever being observed In
    // Progress — the branch may have been deleted by the merge by the time
    // this runs. A merged PR still implies a branch existed.
    expect(deriveTargetStatus({ currentState: 'Ready', hasBranch: false, hasMergedPr: true })).toBe('Ready For QA')
  })

  it('moves an In Progress ticket to Ready For QA once its PR merges', () => {
    expect(deriveTargetStatus({ currentState: 'In Progress', hasBranch: true, hasMergedPr: true })).toBe('Ready For QA')
  })

  it('does nothing for a Ready ticket with neither a branch nor a merged PR', () => {
    expect(deriveTargetStatus({ currentState: 'Ready', hasBranch: false, hasMergedPr: false })).toBeNull()
  })

  it('never moves a ticket backward: In Progress with only a branch stays In Progress', () => {
    // hasBranch alone derives 'In Progress', which is not strictly ahead of
    // a ticket already there.
    expect(deriveTargetStatus({ currentState: 'In Progress', hasBranch: true, hasMergedPr: false })).toBeNull()
  })

  it('never invents a status: an unrecognised currentState never moves, even with a merged PR', () => {
    expect(deriveTargetStatus({ currentState: 'Todo', hasBranch: true, hasMergedPr: true })).toBeNull()
    expect(deriveTargetStatus({ currentState: 'Done', hasBranch: true, hasMergedPr: true })).toBeNull()
  })

  it('never moves a ticket already at the end of the pipeline', () => {
    expect(deriveTargetStatus({ currentState: 'Ready For QA', hasBranch: true, hasMergedPr: true })).toBeNull()
  })

  it('the pipeline is forward-only and Ready is never a write target', () => {
    expect(PIPELINE).toEqual(['Ready', 'In Progress', 'Ready For QA'])
  })
})

describe('reconcile', () => {
  const candidates = [
    { id: 'uuid-1', identifier: 'TAC-1', state: 'Ready' },
    { id: 'uuid-2', identifier: 'TAC-2', state: 'In Progress' },
    { id: 'uuid-3', identifier: 'TAC-3', state: 'Ready' },
  ]

  it('writes only the candidates whose derived target is ahead of their current state, in order', () => {
    const ctx = {
      refs: [ref('jaipal/tac-1-x'), ref('jaipal/tac-3-y')],
      mergedPrBranches: ['jaipal/tac-2-z'],
    }
    expect(reconcile(candidates, ctx)).toEqual([
      { id: 'uuid-1', identifier: 'TAC-1', from: 'Ready', to: 'In Progress' },
      { id: 'uuid-2', identifier: 'TAC-2', from: 'In Progress', to: 'Ready For QA' },
      { id: 'uuid-3', identifier: 'TAC-3', from: 'Ready', to: 'In Progress' },
    ])
  })

  it('writes nothing when nothing on GitHub matches any candidate', () => {
    expect(reconcile(candidates, { refs: [], mergedPrBranches: [] })).toEqual([])
  })

  it('matches branch and PR names case-insensitively, like the claim check', () => {
    const ctx = { refs: [], mergedPrBranches: ['jaipal/TAC-1-uppercase-branch'] }
    expect(reconcile([candidates[0]], ctx)).toEqual([{ id: 'uuid-1', identifier: 'TAC-1', from: 'Ready', to: 'Ready For QA' }])
  })

  it("a branch for a different ticket never moves this one", () => {
    const ctx = { refs: [ref('jaipal/tac-10-other')], mergedPrBranches: [] }
    expect(reconcile([candidates[0]], ctx)).toEqual([])
  })
})

describe('run', () => {
  const REFS_ARGS = ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/remotes/origin/']
  const REFS_OUT = `jaipal/tac-1-x\t0\t<jaipal@foncii.com>\n`

  function invoke({
    candidates = [{ id: 'uuid-1', identifier: 'TAC-1', state: 'Ready' }] as unknown,
    env = {} as Record<string, string>,
    git = (args: string[]) => (args.join(' ') === REFS_ARGS.join(' ') ? REFS_OUT : null),
    gh = ((): string | null => '[]') as (args: string[]) => string | null,
  } = {}) {
    const out: string[] = []
    const err: string[] = []
    const ghCalls: string[][] = []
    const code = run({
      env,
      stdin: typeof candidates === 'string' ? candidates : JSON.stringify(candidates),
      git,
      gh: (args: string[]) => {
        ghCalls.push(args)
        return gh(args)
      },
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
    })
    return { code, out: out.join(''), err: err.join(''), ghCalls }
  }

  it('prints the writes to make, in the shape the workflow reads', () => {
    const r = invoke()
    expect(r.code).toBe(EXIT.OK)
    expect(JSON.parse(r.out)).toEqual([{ id: 'uuid-1', identifier: 'TAC-1', from: 'Ready', to: 'In Progress' }])
    expect(r.err).toBe('')
  })

  it('prints an empty array, not nothing, when there is nothing to write', () => {
    const r = invoke({ git: () => null })
    expect(JSON.parse(r.out)).toEqual([])
  })

  it('asks for merged PRs of the repository it runs for', () => {
    const r = invoke({ env: { GITHUB_REPOSITORY: 'theanalogcompany/analog-guest' } })
    expect(r.ghCalls).toEqual([['pr', 'list', '--state', 'merged', '--limit', '200', '--json', 'headRefName', '--repo', 'theanalogcompany/analog-guest']])
  })

  it('degrades to reconciling nothing, with a warning, when the branches cannot be read — never fails the run', () => {
    const r = invoke({ git: () => null })
    expect(r.code).toBe(EXIT.OK)
    expect(JSON.parse(r.out)).toEqual([])
    expect(r.err).toContain('::warning title=Status reconcile::Could not read the branches')
  })

  it('degrades to reconciling nothing from PRs, with a warning, when the merged PRs cannot be read', () => {
    const r = invoke({ gh: () => null })
    expect(r.code).toBe(EXIT.OK)
    // The branch read still worked, so TAC-1 still moves to In Progress.
    expect(JSON.parse(r.out)).toEqual([{ id: 'uuid-1', identifier: 'TAC-1', from: 'Ready', to: 'In Progress' }])
    expect(r.err).toContain('::warning title=Status reconcile::Could not list merged PRs')
  })

  it('treats a non-array gh response the same as an unreadable one', () => {
    const r = invoke({ gh: () => '{}' })
    expect(r.code).toBe(EXIT.OK)
    expect(r.err).toContain('::warning title=Status reconcile::Could not list merged PRs')
  })

  it('never fails on a candidate read failure — it is a usage error, distinct from claims.mjs which fails the run closed', () => {
    const r = invoke({ candidates: 'not json' })
    expect(r.code).toBe(EXIT.USAGE)
    expect(r.out).toBe('')
    expect(r.err).toContain(USAGE)
  })

  it('refuses a non-array payload', () => {
    const r = invoke({ candidates: '{}' })
    expect(r.code).toBe(EXIT.USAGE)
  })
})
