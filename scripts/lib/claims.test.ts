import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUILD_SESSION_COMMITTER,
  DEFAULT_LIVE_SESSION_HOURS,
  EXIT,
  POLL_HEARTBEAT_MINUTES,
  REF_FORMAT,
  claimOf,
  claimReleased,
  claimRun,
  isTicketBranch,
  parseRefs,
  pickUnclaimed,
  run,
  sessionComments,
} from './claims.mjs'

const t = (iso: string) => Date.parse(iso)
const MINUTE = 60_000
const HOUR = 60 * MINUTE

type Comment = { id?: string; body: string; createdAt: string; updatedAt?: string }
type Ref = { name: string; at: number; email: string }

// A comment of CC's: the prefix, a blank line, then the marker line.
const cc = (markerLine: string, at: string, updatedAt = at): Comment => ({
  body: `**[FROM CLAUDE CODE]**\n\n${markerLine}`,
  createdAt: at,
  updatedAt,
})
const LOCAL_CLAIM = (at: string, updatedAt = at) => cc('[CLAIM] TAC-396 session=local', at, updatedAt)
const RELEASED_CLAIM = (at: string, updatedAt = at) => cc('[CLAIM] TAC-396 session=local released', at, updatedAt)
const JAIPAL = 'jaipal@foncii.com'
// The committer on jaipal/tac-396-comment-provenance-module, pushed by the
// build session in run 35288433905. Written out rather than imported, so
// the fixtures check the constant against what was seen.
const CLAUDE_BOT = '41898282+claude[bot]@users.noreply.github.com'

// TAC-396's thread on 2026-09-18, from Linear, bodies cut to the prefix and
// the marker line. At 02:34:18 run 35299836324 (attempt 1) resumed it on the
// 01:33 ruling while a local session was building it.
const TAC_396_THREAD: Comment[] = [
  { id: '55ebb992', body: '**[FROM CLAUDE CODE]**\n\n[NEEDS-ACTION] TAC-396', createdAt: '2026-09-18T00:13:09.365Z', updatedAt: '2026-09-18T00:13:09.346Z' },
  { id: '751e9a34', body: '**[FROM CLAUDE CODE]**\n\n[DENIALS] TAC-396 run=35288433905 count=23', createdAt: '2026-09-18T00:13:42.078Z', updatedAt: '2026-09-18T00:13:42.047Z' },
  { id: '55bea2c5', body: '**[FROM CLAUDE CHAT — RULING]**\n\n**Reopening.** This ticket was marked Done with its `[NEEDS-ACTION]` never applied.', createdAt: '2026-09-18T01:33:27.001Z', updatedAt: '2026-09-18T01:33:26.970Z' },
]
const TAC_396_RULING_AT = '2026-09-18T01:33:27.001Z'
const INCIDENT_NOW = t('2026-09-18T02:34:18Z')
// The branches on GitHub at that moment that could be TAC-396's. The first
// was pushed by the build session that ran at 23:48; the local session's
// branch had no commit until 02:35:19.
const TAC_396_REFS: Ref[] = [
  { name: 'jaipal/tac-396-comment-provenance-module', at: t('2026-09-18T00:11:38Z'), email: CLAUDE_BOT },
  { name: 'main', at: t('2026-09-18T02:32:23Z'), email: 'noreply@github.com' },
]

const resume396 = (comments: Comment[] = TAC_396_THREAD) => ({
  id: 'uuid-396',
  identifier: 'TAC-396',
  newestId: '55bea2c5',
  newestAt: TAC_396_RULING_AT,
  mode: 'resume',
  state: 'In Progress',
  comments,
})

const start = (identifier: string, comments: Comment[] = []) => ({
  id: `uuid-${identifier}`,
  identifier,
  newestId: '',
  newestAt: '',
  mode: 'start',
  state: 'Ready',
  comments,
})

const ctx = (now: number, refs: Ref[] = [], openPrBranches: string[] | null = []) => ({
  now,
  liveHours: DEFAULT_LIVE_SESSION_HOURS,
  refs,
  openPrBranches,
})

describe('the 2026-09-17 incident: TAC-396 resumed under a local session', () => {
  it('is still NOT caught when the local session has written nothing: nothing can see it', () => {
    // The honest half. The local session had posted nothing and pushed
    // nothing at 02:34:18, so no check can see it. A hand-set In Progress
    // is not read as a claim (ruling 2(B) on TAC-448).
    expect(claimOf(resume396(), ctx(INCIDENT_NOW, TAC_396_REFS))).toBeNull()
  })

  it('is caught once the local session has posted its [CLAIM]', () => {
    const thread = [...TAC_396_THREAD, LOCAL_CLAIM('2026-09-18T02:31:00Z')]
    expect(claimOf(resume396(thread), ctx(INCIDENT_NOW, TAC_396_REFS))).toBe(
      "a local session's [CLAIM], last edited 2026-09-18T02:31:00Z",
    )
  })

  it('is caught once the local session has pushed, with no comment at all', () => {
    const refs = [...TAC_396_REFS, { name: 'jaipal/tac-396-ruling-wording', at: t('2026-09-18T02:35:19Z'), email: JAIPAL }]
    expect(claimOf(resume396(), ctx(t('2026-09-18T02:36:00Z'), refs))).toBe(
      'a commit on jaipal/tac-396-ruling-wording at 2026-09-18T02:35:19Z, after the ruling it would resume on',
    )
  })

  it("ignores the build session's own commit, even one after the ruling", () => {
    const refs = [{ ...TAC_396_REFS[0], at: t('2026-09-18T02:00:00Z') }]
    expect(claimOf(resume396(), ctx(INCIDENT_NOW, refs))).toBeNull()
  })

  it('names the build session by the identity it was seen committing as', () => {
    expect(BUILD_SESSION_COMMITTER).toBe(CLAUDE_BOT)
  })

  it("ignores the build workflow's own [RESUME-CLAIM]", () => {
    const thread = [...TAC_396_THREAD, cc('[RESUME-CLAIM] ruling=55bea2c5 run=35299836324', '2026-09-18T02:34:19.032Z')]
    expect(claimOf(resume396(thread), ctx(t('2026-09-18T02:38:00Z'), TAC_396_REFS))).toBeNull()
  })
})

describe('a local claim on a resume', () => {
  it('holds even when the ruling reached Linear after it', () => {
    // Jaipal answers in Slack, a local session claims and starts building,
    // and the Slack sync posts his answer to Linear later. The ruling's time
    // is the sync's, not his, so it must not release a working session.
    const before = [LOCAL_CLAIM('2026-09-18T01:00:00Z'), ...TAC_396_THREAD]
    expect(claimOf(resume396(before), ctx(INCIDENT_NOW))).toBe("a local session's [CLAIM], last edited 2026-09-18T01:00:00Z")
  })

  it('holds nothing once released, before or after the ruling', () => {
    // The session stopped to wait for Jaipal and handed the ticket back, so
    // the next session acts on his answer.
    for (const at of ['2026-09-18T01:00:00Z', '2026-09-18T02:00:00Z']) {
      expect(claimOf(resume396([...TAC_396_THREAD, RELEASED_CLAIM(at)]), ctx(INCIDENT_NOW))).toBeNull()
    }
  })

  it('dates a claim by its last edit', () => {
    const edited = [LOCAL_CLAIM('2026-09-18T01:00:00Z', '2026-09-18T02:00:00Z'), ...TAC_396_THREAD]
    expect(claimOf(resume396(edited), ctx(INCIDENT_NOW))).toMatch(/last edited 2026-09-18T02:00:00Z/)
  })

  it('stops counting once it is older than the live window', () => {
    const thread = [...TAC_396_THREAD, LOCAL_CLAIM('2026-09-18T02:00:00Z')]
    const later = t('2026-09-18T02:00:00Z') + DEFAULT_LIVE_SESSION_HOURS * HOUR + MINUTE
    expect(claimOf(resume396(thread), ctx(later))).toBeNull()
  })

  it('counts a commit when the ruling time cannot be read, rather than resuming blind', () => {
    const refs = [{ name: 'jaipal/tac-396-x', at: t('2026-09-18T01:00:00Z'), email: JAIPAL }]
    expect(claimOf({ ...resume396(), newestAt: '' }, ctx(INCIDENT_NOW, refs))).toMatch(/a commit on jaipal\/tac-396-x/)
    expect(claimOf(resume396(), ctx(INCIDENT_NOW, refs))).toBeNull()
  })
})

describe('a [POLLING-STATE] on a resume', () => {
  const ruling = '2026-09-18T02:30:00Z'
  const withPoll = (edited: string) => ({
    ...resume396([cc('[POLLING-STATE] iteration=3 nextWakeupAt=x sessionStartedAt=y', '2026-09-18T02:00:00Z', edited)]),
    newestAt: ruling,
  })

  it('counts while its session is still polling, even from before the ruling', () => {
    // Edited 4 minutes before now and 1 before the ruling: the chain wakes
    // within 5 minutes and will read the ruling itself.
    const now = t('2026-09-18T02:33:00Z')
    expect(claimOf(withPoll('2026-09-18T02:29:00Z'), ctx(now))).toBe(
      "a polling session's [POLLING-STATE], last edited 2026-09-18T02:29:00Z: it will pick the ruling up itself",
    )
  })

  it('stops counting once the chain has missed its wakeups', () => {
    const now = t('2026-09-18T02:29:00Z') + (POLL_HEARTBEAT_MINUTES + 1) * MINUTE
    expect(claimOf(withPoll('2026-09-18T02:29:00Z'), ctx(now))).toBeNull()
  })

  it('counts when it was edited after the ruling', () => {
    expect(claimOf(withPoll('2026-09-18T02:31:00Z'), ctx(t('2026-09-18T03:30:00Z')))).toMatch(/after the ruling/)
  })

  it('counts when it was touched at the ruling time itself', () => {
    // Linear returned TAC-396's ruling with updatedAt 31 ms before
    // createdAt: a trace posted with the ruling must not fall behind it.
    expect(claimOf(withPoll(ruling), ctx(t('2026-09-18T03:30:00Z')))).toMatch(/after the ruling/)
  })

  it('outlasts the longest gap between two polls', () => {
    // work-ticket.md polls at most every 300s. A heartbeat shorter than
    // twice that would read a live chain as dead between two wakeups.
    const doc = readFileSync(resolve(__dirname, '..', '..', '.claude/commands/work-ticket.md'), 'utf8')
    const cap = Number(doc.match(/cap at (\d+)\./)?.[1])
    expect(cap).toBeGreaterThan(0)
    expect(POLL_HEARTBEAT_MINUTES * 60).toBeGreaterThanOrEqual(2 * cap)
  })
})

describe('a start', () => {
  const NOW = t('2026-09-18T03:30:00Z')

  it('is claimed by any live local claim or polling state', () => {
    expect(claimOf(start('TAC-448', [LOCAL_CLAIM('2026-09-18T03:00:00Z')]), ctx(NOW))).toBe(
      "a local session's [CLAIM], last edited 2026-09-18T03:00:00Z",
    )
    expect(claimOf(start('TAC-448', [cc('[POLLING-STATE] iteration=0', '2026-09-18T03:22:33Z')]), ctx(NOW))).toBe(
      'a [POLLING-STATE], last edited 2026-09-18T03:22:33Z',
    )
  })

  it('reads a [POLLING-STATE] by its last edit, not when it was created', () => {
    const old = cc('[POLLING-STATE] iteration=9', '2026-09-17T20:00:00Z', '2026-09-18T03:25:00Z')
    expect(claimOf(start('TAC-448', [old]), ctx(NOW))).toMatch(/03:25:00Z/)
  })

  it('is not claimed by a dead one', () => {
    expect(claimOf(start('TAC-448', [LOCAL_CLAIM('2026-09-17T23:00:00Z')]), ctx(NOW))).toBeNull()
  })

  it('is not claimed by a released local claim', () => {
    expect(claimOf(start('TAC-448', [RELEASED_CLAIM('2026-09-18T03:20:00Z')]), ctx(NOW))).toBeNull()
  })

  it("ignores the build workflow's own [CLAIM], which names its run", () => {
    expect(claimOf(start('TAC-448', [cc('[CLAIM] TAC-448 run=35299836324', '2026-09-18T03:20:00Z')]), ctx(NOW))).toBeNull()
  })

  it('is claimed by a recent commit by anyone but the build session', () => {
    const refs = [{ name: 'jaipal/tac-448-claim-check', at: t('2026-09-18T03:10:00Z'), email: JAIPAL }]
    expect(claimOf(start('TAC-448'), ctx(NOW, refs))).toBe('a commit on jaipal/tac-448-claim-check at 2026-09-18T03:10:00Z')
    expect(claimOf(start('TAC-448'), ctx(NOW, [{ ...refs[0], email: BUILD_SESSION_COMMITTER }]))).toBeNull()
    expect(claimOf(start('TAC-448'), ctx(NOW, [{ ...refs[0], at: NOW - 4 * HOUR }]))).toBeNull()
  })

  it('reports the newest commit when the ticket has more than one branch', () => {
    const refs = [
      { name: 'jaipal/tac-448-a', at: t('2026-09-18T03:00:00Z'), email: JAIPAL },
      { name: 'jaipal/tac-448-b', at: t('2026-09-18T03:20:00Z'), email: JAIPAL },
    ]
    expect(claimOf(start('TAC-448'), ctx(NOW, refs))).toMatch(/jaipal\/tac-448-b/)
  })

  it('is claimed by an open PR, however old its branch', () => {
    const refs = [{ name: 'jaipal/tac-448-claim-check', at: NOW - 30 * HOUR, email: JAIPAL }]
    expect(claimOf(start('TAC-448'), ctx(NOW, refs, ['jaipal/TAC-448-claim-check']))).toBe(
      'an open PR from jaipal/TAC-448-claim-check',
    )
  })

  it('is not claimed when the open PRs could not be read', () => {
    expect(claimOf(start('TAC-448'), ctx(NOW, [], null))).toBeNull()
  })
})

describe('an open PR on a resume', () => {
  it('does not claim it: a ruling on a ticket with a PR is still the next session to act on', () => {
    // A [TURN-LIMIT] can land after the PR opened, and the resumed session
    // links the existing PR (work-ticket.md step 27).
    expect(claimOf(resume396(), ctx(INCIDENT_NOW, [], ['jaipal/tac-396-ruling-wording']))).toBeNull()
  })
})

describe('which comments are claims', () => {
  it('reads the prefix through escaped brackets, as comment-provenance does', () => {
    const escaped = { body: '**\\[FROM CLAUDE CODE\\]**\n\n\\[CLAIM\\] TAC-1 session=local', createdAt: '2026-09-18T03:00:00Z' }
    expect(sessionComments([escaped]).map((s) => s.marker)).toEqual(['CLAIM'])
  })

  it('never reads a human comment as a claim, whatever it says', () => {
    const human = { body: '[CLAIM] TAC-1 session=local', createdAt: '2026-09-18T03:00:00Z' }
    const chat = { body: '**[FROM CLAUDE CHAT]**\n\n[CLAIM] TAC-1', createdAt: '2026-09-18T03:00:00Z' }
    expect(sessionComments([human, chat])).toEqual([])
  })

  it('never reads a claim quoted inside another marker as a claim', () => {
    const plan = { body: '**[FROM CLAUDE CODE]**\n\n[PLAN] TAC-1\n\nThe session posts [CLAIM] first.', createdAt: '2026-09-18T03:00:00Z' }
    expect(sessionComments([plan])).toEqual([])
  })

  it('reads released only on the marker line', () => {
    expect(claimReleased('**[FROM CLAUDE CODE]**\n\n[CLAIM] TAC-1 session=local released')).toBe(true)
    expect(claimReleased('**[FROM CLAUDE CODE]**\n\n[CLAIM] TAC-1 session=local\n\nNot released yet.')).toBe(false)
    expect(sessionComments([RELEASED_CLAIM('2026-09-18T03:00:00Z')])).toEqual([])
  })

  it('tells the build workflow\'s claims from a local session\'s by the run they name', () => {
    expect(claimRun('**[FROM CLAUDE CODE]**\n\n[CLAIM] TAC-1 run=35299836324')).toBe('35299836324')
    expect(claimRun('**[FROM CLAUDE CODE]**\n\n[RESUME-CLAIM] ruling=abc run=123')).toBe('123')
    expect(claimRun('**[FROM CLAUDE CODE]**\n\n[CLAIM] TAC-1 session=local\n\nNot run=123 on this line.')).toBeNull()
  })

  it('skips a comment whose times cannot be read', () => {
    expect(sessionComments([{ body: '**[FROM CLAUDE CODE]**\n\n[CLAIM] TAC-1', createdAt: 'never' }])).toEqual([])
  })
})

describe('which branches are the ticket\'s', () => {
  it.each([
    ['jaipal/tac-448-claim-check', true],
    ['jaipal/TAC-448-claim-check', true],
    ['jaipal/tac-4480-other', false],
    ['jaipal/tac-44-other', false],
    ['jaipal/tac-448', false],
    ['someone/tac-448-x', false],
    ['main', false],
  ])('%s → %s', (name, expected) => {
    expect(isTicketBranch('TAC-448', name)).toBe(expected)
  })
})

describe('parseRefs', () => {
  it('reads name, time and committer from the for-each-ref format', () => {
    const text = `jaipal/tac-396-x\t1758162458\t<${BUILD_SESSION_COMMITTER}>\nHEAD\t1758162458\t<noreply@github.com>\n\n`
    expect(parseRefs(text)).toEqual([
      { name: 'jaipal/tac-396-x', at: 1758162458000, email: BUILD_SESSION_COMMITTER },
      { name: 'HEAD', at: 1758162458000, email: 'noreply@github.com' },
    ])
  })

  it('matches what git itself prints for that format', () => {
    // A real repository, not a fake: a fake git answers only the format its
    // author expected, which proves nothing about the format being right.
    // Run inside the pre-commit hook, git exports GIT_DIR and GIT_INDEX_FILE,
    // which would point every call at this repository: every GIT_ variable
    // goes, as in run-report.test.ts.
    const dir = mkdtempSync(join(tmpdir(), 'claims-refs-'))
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
    env.GIT_CONFIG_GLOBAL = '/dev/null'
    env.GIT_CONFIG_NOSYSTEM = '1'
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' })
    try {
      git('init', '-q', '-b', 'main')
      git('-c', 'user.name=Claude', '-c', `user.email=${BUILD_SESSION_COMMITTER}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'x')
      git('update-ref', 'refs/remotes/origin/jaipal/tac-1-x', 'HEAD')
      const refs = parseRefs(git('for-each-ref', `--format=${REF_FORMAT}`, 'refs/remotes/origin/'))
      expect(refs).toHaveLength(1)
      expect(refs[0].name).toBe('jaipal/tac-1-x')
      expect(refs[0].email).toBe(BUILD_SESSION_COMMITTER)
      expect(Math.abs(refs[0].at - Date.now())).toBeLessThan(HOUR)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('pickUnclaimed', () => {
  const NOW = t('2026-09-18T03:30:00Z')

  it('takes the next unclaimed ticket, so a claimed one never uses up the limit', () => {
    const claimed = start('TAC-448', [LOCAL_CLAIM('2026-09-18T03:22:00Z')])
    const { picked, skipped } = pickUnclaimed([claimed, start('TAC-438'), start('TAC-401')], ctx(NOW), 1)
    expect(picked.map((c) => c.identifier)).toEqual(['TAC-438'])
    expect(skipped).toEqual([{ identifier: 'TAC-448', mode: 'start', state: 'Ready', reason: expect.stringContaining('[CLAIM]') }])
  })

  it('keeps priority order and stops at the limit', () => {
    const { picked, skipped } = pickUnclaimed([start('TAC-1'), start('TAC-2'), start('TAC-3')], ctx(NOW), 2)
    expect(picked.map((c) => c.identifier)).toEqual(['TAC-1', 'TAC-2'])
    expect(skipped).toEqual([])
  })

  it('takes nothing when every candidate is claimed', () => {
    const { picked } = pickUnclaimed([start('TAC-448', [LOCAL_CLAIM('2026-09-18T03:22:00Z')])], ctx(NOW), 1)
    expect(picked).toEqual([])
  })
})

describe('status never decides a claim (TAC-466)', () => {
  // TAC-466 writes ticket status from the same "Find tickets to work" step
  // this claim check runs in, from a ticket's derived status. Neither claimOf
  // nor pickUnclaimed reads `.state` today — it rides along only to label a
  // skip in the log. This pins that as a property, so a future edit that
  // starts branching on it (treating a Ready For QA ticket as unclaimable,
  // say) fails here rather than shipping a second, less precise claim signal.
  const NOW = t('2026-09-18T03:30:00Z')

  it('claimOf gives the same answer whatever .state says', () => {
    const claimed = resume396()
    const unclaimed = { ...resume396([]), newestAt: '' }
    for (const state of ['Ready', 'In Progress', 'Ready For QA', 'Done', 'nonsense']) {
      expect(claimOf({ ...claimed, state }, ctx(INCIDENT_NOW, TAC_396_REFS))).toEqual(claimOf(claimed, ctx(INCIDENT_NOW, TAC_396_REFS)))
      expect(claimOf({ ...unclaimed, state }, ctx(NOW))).toEqual(claimOf(unclaimed, ctx(NOW)))
    }
  })

  it('pickUnclaimed gives the same answer whatever .state says', () => {
    const a = start('TAC-448', [LOCAL_CLAIM('2026-09-18T03:22:00Z')])
    const b = start('TAC-438')
    for (const state of ['Ready', 'In Progress', 'Ready For QA']) {
      const varied = pickUnclaimed([{ ...a, state }, { ...b, state }], ctx(NOW), 2)
      const base = pickUnclaimed([a, b], ctx(NOW), 2)
      expect(varied.picked.map((c) => c.identifier)).toEqual(base.picked.map((c) => c.identifier))
      expect(varied.skipped.map((s) => ({ ...s, state: undefined }))).toEqual(base.skipped.map((s) => ({ ...s, state: undefined })))
    }
  })
})

describe('run', () => {
  const NOW = t('2026-09-18T03:30:00Z')
  const MAIN = `main\t${t('2026-09-18T02:53:02Z') / 1000}\t<noreply@github.com>\n`
  const REFS_OUT = `${MAIN}jaipal/tac-448-claim-check\t${t('2026-09-18T03:10:00Z') / 1000}\t<${JAIPAL}>\n`
  const REFS_ARGS = ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/remotes/origin/']

  function invoke({
    candidates = [start('TAC-448'), start('TAC-438')] as unknown,
    env = { LIMIT: '1' } as Record<string, string>,
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
      now: NOW,
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
    })
    return { code, out: out.join(''), err: err.join(''), ghCalls }
  }

  it('prints the tickets taken, in the shape the claim loop reads, and says why one was skipped', () => {
    const r = invoke()
    expect(r.code).toBe(EXIT.OK)
    expect(JSON.parse(r.out)).toEqual([
      { id: 'uuid-TAC-438', identifier: 'TAC-438', newestId: '', mode: 'start', state: 'Ready', autoRestart: null },
    ])
    expect(r.err).toBe(
      'skipped TAC-448 (start, Ready): another session has it: a commit on jaipal/tac-448-claim-check at 2026-09-18T03:10:00Z.\n',
    )
  })

  it('passes a candidate\'s autoRestart through, null when absent (TAC-480)', () => {
    const withAutoRestart = { ...start('TAC-448'), autoRestart: { attempt: 1, headSha: 'aaa1111', body: 'x' } }
    const r = invoke({ candidates: [withAutoRestart], git: () => MAIN })
    expect(JSON.parse(r.out)).toEqual([
      { id: 'uuid-TAC-448', identifier: 'TAC-448', newestId: '', mode: 'start', state: 'Ready', autoRestart: { attempt: 1, headSha: 'aaa1111', body: 'x' } },
    ])
  })

  it('never prints comment bodies: the run log is public', () => {
    const r = invoke({ candidates: [start('TAC-1', [{ body: 'guest said something private', createdAt: '2026-09-18T03:00:00Z' }])] })
    expect(r.out + r.err).not.toContain('private')
  })

  it('takes nothing and fails when the branches cannot be read', () => {
    const r = invoke({ git: () => null })
    expect(r.code).toBe(EXIT.FAILED)
    expect(r.out).toBe('')
    expect(r.err).toContain('::error title=Claim check::')
  })

  it('takes nothing and fails when the branches come back without main', () => {
    // A checkout that fetched nothing from GitHub, where every commit signal
    // would be missing without a word. (A shallow checkout of main still
    // lists main; build-workflow.test.ts pins fetch-depth: 0 for that.)
    const r = invoke({ git: () => '' })
    expect(r.code).toBe(EXIT.FAILED)
    expect(r.out).toBe('')
    expect(r.err).toContain('::error title=Claim check::')
  })

  it('warns and carries on when the open PRs cannot be read', () => {
    const r = invoke({ gh: () => null, candidates: [start('TAC-438')] })
    expect(r.code).toBe(EXIT.OK)
    expect(JSON.parse(r.out).map((c: { identifier: string }) => c.identifier)).toEqual(['TAC-438'])
    expect(r.err).toContain('::warning title=Claim check::')
  })

  it('asks for the open PRs of the repository it runs for', () => {
    const r = invoke({ env: { LIMIT: '1', GITHUB_REPOSITORY: 'theanalogcompany/analog-guest' } })
    expect(r.ghCalls).toEqual([
      ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'headRefName', '--repo', 'theanalogcompany/analog-guest'],
    ])
  })

  it('skips a start with an open PR from the list gh returns', () => {
    const r = invoke({ git: () => MAIN, gh: () => JSON.stringify([{ headRefName: 'jaipal/tac-448-claim-check' }]) })
    expect(JSON.parse(r.out).map((c: { identifier: string }) => c.identifier)).toEqual(['TAC-438'])
    expect(r.err).toContain('an open PR from jaipal/tac-448-claim-check')
  })

  it('honours LIVE_SESSION_HOURS', () => {
    const r = invoke({ env: { LIMIT: '1', LIVE_SESSION_HOURS: '0.25' } })
    expect(JSON.parse(r.out).map((c: { identifier: string }) => c.identifier)).toEqual(['TAC-448'])
  })

  it.each([
    ['not JSON', { candidates: '{nope' }],
    ['not an array', { candidates: '{}' }],
    ['no LIMIT', { env: {} }],
    ['LIMIT 0', { env: { LIMIT: '0' } }],
    ['LIMIT 1.5', { env: { LIMIT: '1.5' } }],
    ['a bad window', { env: { LIMIT: '1', LIVE_SESSION_HOURS: 'three' } }],
  ])('refuses %s', (_why, opts) => {
    const r = invoke(opts as Parameters<typeof invoke>[0])
    expect(r.code).toBe(EXIT.USAGE)
    expect(r.out).toBe('')
  })
})
