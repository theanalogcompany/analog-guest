import { describe, expect, it } from 'vitest'
import { commentMarker } from './comment-provenance.mjs'
import { checkCommentBody } from './linear-cli.mjs'
import {
  DEFAULT_MAX_AUTO_RESTARTS,
  EXIT,
  USAGE,
  decideAutoRestart,
  parseAutoRestartClaim,
  parseHeadState,
  renderAutoRestartClaim,
  renderAutoRestartLimit,
  run,
} from './turn-limit-restart.mjs'

type Comment = { body: string; createdAt: string }

const cc = (markerLine: string, at: string): Comment => ({ body: `**[FROM CLAUDE CODE]**\n\n${markerLine}`, createdAt: at })
const human = (body: string, at: string): Comment => ({ body, createdAt: at })
const turnLimit = (at: string, head: string | null, commits: number) =>
  cc(`[TURN-LIMIT] TAC-1 head=${head ?? 'none'} commits=${commits}\n\nReply here to continue.`, at)
const autoRestart = (at: string, attempt: number, headSha: string | null, bound = 2) =>
  cc(`[AUTO-RESTART] TAC-1 attempt=${attempt}/${bound} headSha=${headSha ?? 'none'} run=1`, at)

describe('parseHeadState', () => {
  it('reads head and commits off a [TURN-LIMIT] marker line', () => {
    expect(parseHeadState(turnLimit('2026-09-18T03:25:53Z', '8f2a0eb', 1).body)).toEqual({ head: '8f2a0eb', commits: 1 })
  })

  it('reads head=none as no branch', () => {
    expect(parseHeadState(turnLimit('2026-09-18T03:25:53Z', null, 0).body)).toEqual({ head: null, commits: 0 })
  })

  it('is null for a comment that is not [TURN-LIMIT]', () => {
    expect(parseHeadState(cc('[RESUME-CLAIM] ruling=x run=1', '2026-09-18T03:00:00Z').body)).toBeNull()
  })

  it('is null for a [TURN-LIMIT] notice from before this ticket, with neither field', () => {
    expect(parseHeadState(cc('[TURN-LIMIT] TAC-1', '2026-09-18T03:00:00Z').body)).toBeNull()
  })

  it('never matches a marker quoted mid-body', () => {
    expect(parseHeadState(cc('[PLAN] TAC-1\n\nMentions [TURN-LIMIT] head=x commits=1 in prose.', '2026-09-18T03:00:00Z').body)).toBeNull()
  })
})

describe('parseAutoRestartClaim', () => {
  it('reads attempt and headSha off an [AUTO-RESTART] marker line', () => {
    expect(parseAutoRestartClaim(autoRestart('2026-09-18T03:30:00Z', 1, '700e8af').body)).toEqual({ attempt: 1, headSha: '700e8af' })
  })

  it('reads headSha=none as no branch', () => {
    expect(parseAutoRestartClaim(autoRestart('2026-09-18T03:30:00Z', 1, null).body)).toEqual({ attempt: 1, headSha: null })
  })

  it('is null for a comment that is not [AUTO-RESTART]', () => {
    expect(parseAutoRestartClaim(turnLimit('2026-09-18T03:00:00Z', 'x', 1).body)).toBeNull()
  })
})

describe('decideAutoRestart', () => {
  it('does nothing when the newest comment is not [TURN-LIMIT]', () => {
    const comments = [cc('[PLAN] TAC-1', '2026-09-18T03:00:00Z'), human('Approved.', '2026-09-18T03:05:00Z')]
    expect(decideAutoRestart({ comments, bound: 2 })).toEqual({ restart: false, reason: 'not-turn-limited' })
  })

  it('does nothing on an empty thread', () => {
    expect(decideAutoRestart({ comments: [], bound: 2 })).toEqual({ restart: false, reason: 'not-turn-limited' })
  })

  // TAC-325, 2026-09-18: run 35299836324's third attempt stopped at 121
  // turns having pushed one commit, 8f2a0eb, onto a branch with no prior
  // [TURN-LIMIT]. Fetched from Linear for this ticket (TAC-480) and matches
  // the plan's own citation.
  it('restarts a first turn-limited attempt that pushed a commit (TAC-325)', () => {
    const comments = [
      human('Approved. Build it.', '2026-09-18T02:00:00Z'),
      cc('[CLAIM] TAC-325 run=35299836324', '2026-09-18T02:05:00Z'),
      turnLimit('2026-09-18T03:25:53Z', '8f2a0eb', 1),
    ]
    expect(decideAutoRestart({ comments, bound: 2 })).toEqual({ restart: true, attempt: 1, head: '8f2a0eb' })
  })

  it('never restarts a first attempt that pushed nothing', () => {
    const comments = [human('Approved.', '2026-09-18T02:00:00Z'), turnLimit('2026-09-18T03:25:53Z', null, 0)]
    expect(decideAutoRestart({ comments, bound: 2 })).toEqual({ restart: false, reason: 'no-progress', attempt: 0 })
  })

  // TAC-376, 2026-09-18: the first stopped-at-limit run (35309886778) pushed
  // 700e8af and eca3dbb (2 commits, head 700e8af). No [AUTO-RESTART] existed
  // yet on the real ticket — this mechanism didn't exist — so this fixture
  // is the real notice with no prior claim.
  it('restarts a first turn-limited attempt on a real TAC-376-shaped thread', () => {
    const comments = [
      human('Approved. Build it.', '2026-09-18T05:09:43.548Z'),
      cc('[CLAIM] TAC-376 run=35309886778', '2026-09-18T05:12:52.250Z'),
      turnLimit('2026-09-18T05:29:32.907Z', '700e8af', 2),
    ]
    expect(decideAutoRestart({ comments, bound: 2 })).toEqual({ restart: true, attempt: 1, head: '700e8af' })
  })

  // The real second episode's [TURN-LIMIT] (06:04:26.341Z, run 35311679124)
  // pushed 574f0dc, 2b4bda0, 700e8af, eca3dbb — 4 commits, head 574f0dc.
  // TAC-376 was actually resumed by a manually named dispatch, not this
  // mechanism (it did not exist yet), so there is no real [AUTO-RESTART] to
  // read between the two real notices. This synthesizes one — attempt=1,
  // headSha=700e8af, the first episode's real head — to check the second
  // decision in isolation. It is not a real Linear comment.
  it('restarts a second attempt whose branch moved since the first (TAC-376, synthetic claim)', () => {
    const comments = [
      human('Approved. Build it.', '2026-09-18T05:09:43.548Z'),
      cc('[CLAIM] TAC-376 run=35309886778', '2026-09-18T05:12:52.250Z'),
      turnLimit('2026-09-18T05:29:32.907Z', '700e8af', 2),
      autoRestart('2026-09-18T05:30:00Z', 1, '700e8af'),
      turnLimit('2026-09-18T06:04:26.341Z', '574f0dc', 4),
    ]
    expect(decideAutoRestart({ comments, bound: 2 })).toEqual({ restart: true, attempt: 2, head: '574f0dc' })
  })

  it('never restarts again when the branch has not moved since the claimed attempt', () => {
    const comments = [
      human('Approved. Build it.', '2026-09-18T05:09:43.548Z'),
      turnLimit('2026-09-18T05:29:32.907Z', '700e8af', 2),
      autoRestart('2026-09-18T05:30:00Z', 1, '574f0dc'),
      turnLimit('2026-09-18T06:04:26.341Z', '574f0dc', 4),
    ]
    expect(decideAutoRestart({ comments, bound: 2 })).toEqual({ restart: false, reason: 'no-progress', attempt: 1 })
  })

  it('stops once the bound is reached, whatever the branch did', () => {
    const comments = [
      human('Approved. Build it.', '2026-09-18T05:09:43.548Z'),
      turnLimit('2026-09-18T05:29:32.907Z', 'aaa1111', 2),
      autoRestart('2026-09-18T05:30:00Z', 1, 'aaa1111'),
      turnLimit('2026-09-18T06:04:26Z', 'bbb2222', 4),
      autoRestart('2026-09-18T06:04:30Z', 2, 'bbb2222'),
      turnLimit('2026-09-18T06:40:00Z', 'ccc3333', 6),
    ]
    expect(decideAutoRestart({ comments, bound: 2 })).toEqual({ restart: false, reason: 'bound-reached', attempt: 2 })
  })

  it('resets the count and the progress reference at the most recent human reply', () => {
    const comments = [
      human('First ruling.', '2026-09-18T01:00:00Z'),
      turnLimit('2026-09-18T02:00:00Z', 'aaa1111', 1),
      autoRestart('2026-09-18T02:01:00Z', 1, 'aaa1111'),
      turnLimit('2026-09-18T03:00:00Z', 'aaa1111', 1),
      autoRestart('2026-09-18T03:01:00Z', 2, 'aaa1111'),
      human('Second ruling: continue.', '2026-09-18T04:00:00Z'),
      turnLimit('2026-09-18T05:00:00Z', 'bbb2222', 1),
    ]
    // Two prior [AUTO-RESTART]s exist, but both predate the second human
    // reply: the budget is fresh and the reference commit is the ticket's,
    // not the pre-ruling attempts'.
    expect(decideAutoRestart({ comments, bound: 2 })).toEqual({ restart: true, attempt: 1, head: 'bbb2222' })
  })

  it('is unaffected by bookkeeping comments interleaved in the thread', () => {
    const comments = [
      human('Approved.', '2026-09-18T02:00:00Z'),
      cc('[CLAIM] TAC-1 run=1', '2026-09-18T02:05:00Z'),
      turnLimit('2026-09-18T03:00:00Z', 'aaa1111', 1),
      autoRestart('2026-09-18T03:01:00Z', 1, 'aaa1111'),
      cc('[DENIALS] TAC-1 run=2 count=1', '2026-09-18T03:30:00Z'),
      turnLimit('2026-09-18T04:00:00Z', 'bbb2222', 2),
    ]
    expect(decideAutoRestart({ comments, bound: 2 })).toEqual({ restart: true, attempt: 2, head: 'bbb2222' })
  })
})

describe('the two comment bodies', () => {
  it('[AUTO-RESTART] is a comment the Linear helper accepts, with its own marker', () => {
    const body = renderAutoRestartClaim({ ticket: 'TAC-1', attempt: 1, bound: 2, headSha: '8f2a0eb', runId: '35299836324' })
    expect(checkCommentBody(body)).toMatchObject({ ok: true })
    expect(commentMarker(body)).toBe('AUTO-RESTART')
    expect(body).toContain('[AUTO-RESTART] TAC-1 attempt=1/2 headSha=8f2a0eb run=35299836324')
  })

  it('[AUTO-RESTART-LIMIT] is a comment the Linear helper accepts, with its own marker, naming a split', () => {
    const body = renderAutoRestartLimit({ ticket: 'TAC-1', attempt: 2, bound: 2, runId: '1' })
    expect(checkCommentBody(body)).toMatchObject({ ok: true })
    expect(commentMarker(body)).toBe('AUTO-RESTART-LIMIT')
    expect(body).toContain('[AUTO-RESTART-LIMIT] TAC-1 attempt=2/2 run=1')
    expect(body).toContain('resumed automatically 2 times')
    expect(body).toContain('split it instead of replying')
  })

  it('round-trips through parseAutoRestartClaim', () => {
    const body = renderAutoRestartClaim({ ticket: 'TAC-1', attempt: 1, bound: 2, headSha: '8f2a0eb', runId: '1' })
    expect(parseAutoRestartClaim(body)).toEqual({ attempt: 1, headSha: '8f2a0eb' })
  })
})

describe('run', () => {
  const captured = () => {
    const out: string[] = []
    const err: string[] = []
    return { out, err, stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) }
  }
  const call = (stdin: string, env: Record<string, string> = {}) => {
    const io = captured()
    const code = run({ env, stdin, stdout: io.stdout, stderr: io.stderr })
    return { code, out: io.out.join(''), err: io.err.join('') }
  }

  const start = { id: 'u1', identifier: 'TAC-1', newestId: '', mode: 'start', comments: [] }
  const resume = { id: 'u2', identifier: 'TAC-2', newestId: 'x', mode: 'resume', comments: [] }

  it('passes start and resume candidates through unchanged', () => {
    const { code, out } = call(JSON.stringify([start, resume]))
    expect(code).toBe(EXIT.OK)
    expect(JSON.parse(out)).toEqual({ candidates: [start, resume], exhausted: [] })
  })

  it('upgrades a turn-limited candidate that made progress to resume, carrying autoRestart', () => {
    const candidate = {
      id: 'u3',
      identifier: 'TAC-325',
      newestId: 't1',
      mode: 'turn-limited',
      comments: [human('Approved.', '2026-09-18T02:00:00Z'), turnLimit('2026-09-18T03:25:53Z', '8f2a0eb', 1)],
    }
    const { code, out } = call(JSON.stringify([candidate]), { GITHUB_RUN_ID: '35306017791' })
    expect(code).toBe(EXIT.OK)
    const parsed = JSON.parse(out)
    expect(parsed.exhausted).toEqual([])
    expect(parsed.candidates).toHaveLength(1)
    expect(parsed.candidates[0].mode).toBe('resume')
    expect(parsed.candidates[0].autoRestart.attempt).toBe(1)
    expect(parsed.candidates[0].autoRestart.headSha).toBe('8f2a0eb')
    expect(commentMarker(parsed.candidates[0].autoRestart.body)).toBe('AUTO-RESTART')
  })

  it('drops a turn-limited candidate whose last attempt made no progress', () => {
    const candidate = {
      id: 'u4',
      identifier: 'TAC-1',
      newestId: 't1',
      mode: 'turn-limited',
      comments: [human('Approved.', '2026-09-18T02:00:00Z'), turnLimit('2026-09-18T03:00:00Z', null, 0)],
    }
    const { out } = call(JSON.stringify([candidate]))
    expect(JSON.parse(out)).toEqual({ candidates: [], exhausted: [] })
  })

  it('moves an exhausted turn-limited candidate to exhausted, with a postable body', () => {
    const candidate = {
      id: 'u5',
      identifier: 'TAC-1',
      newestId: 't2',
      mode: 'turn-limited',
      hasNeedsDecision: true,
      comments: [
        human('Approved.', '2026-09-18T02:00:00Z'),
        turnLimit('2026-09-18T03:00:00Z', 'aaa1111', 1),
        autoRestart('2026-09-18T03:01:00Z', 1, 'aaa1111'),
        turnLimit('2026-09-18T04:00:00Z', 'bbb2222', 2),
        autoRestart('2026-09-18T04:01:00Z', 2, 'bbb2222'),
        turnLimit('2026-09-18T05:00:00Z', 'ccc3333', 3),
      ],
    }
    const { out } = call(JSON.stringify([candidate]), { GITHUB_RUN_ID: '9' })
    const parsed = JSON.parse(out)
    expect(parsed.candidates).toEqual([])
    expect(parsed.exhausted).toHaveLength(1)
    expect(parsed.exhausted[0]).toMatchObject({ id: 'u5', identifier: 'TAC-1', hasNeedsDecision: true })
    expect(commentMarker(parsed.exhausted[0].body)).toBe('AUTO-RESTART-LIMIT')
  })

  it('defaults hasNeedsDecision to true when the candidate omits it', () => {
    const candidate = {
      id: 'u6',
      identifier: 'TAC-1',
      newestId: 't2',
      mode: 'turn-limited',
      comments: [
        turnLimit('2026-09-18T03:00:00Z', 'aaa1111', 1),
        autoRestart('2026-09-18T03:01:00Z', 1, 'aaa1111'),
        turnLimit('2026-09-18T04:00:00Z', 'bbb2222', 2),
        autoRestart('2026-09-18T04:01:00Z', 2, 'bbb2222'),
        turnLimit('2026-09-18T05:00:00Z', 'ccc3333', 3),
      ],
    }
    const { out } = call(JSON.stringify([candidate]))
    expect(JSON.parse(out).exhausted[0].hasNeedsDecision).toBe(true)
  })

  it('honours MAX_AUTO_RESTARTS', () => {
    const candidate = {
      id: 'u7',
      identifier: 'TAC-1',
      newestId: 't1',
      mode: 'turn-limited',
      comments: [turnLimit('2026-09-18T03:00:00Z', 'aaa1111', 1)],
    }
    const { out } = call(JSON.stringify([candidate]), { MAX_AUTO_RESTARTS: '1' })
    expect(JSON.parse(out).candidates[0].autoRestart.body).toContain('attempt=1/1')
  })

  it('defaults MAX_AUTO_RESTARTS to 2', () => {
    expect(DEFAULT_MAX_AUTO_RESTARTS).toBe(2)
  })

  it.each([
    ['not JSON', '{nope'],
    ['not an array', '{}'],
  ])('refuses %s', (_why, stdin) => {
    const { code, out } = call(stdin)
    expect(code).toBe(EXIT.USAGE)
    expect(out).toBe('')
  })

  it('refuses a bad MAX_AUTO_RESTARTS', () => {
    const { code, err } = call('[]', { MAX_AUTO_RESTARTS: 'two' })
    expect(code).toBe(EXIT.USAGE)
    expect(err).toContain('usage:')
  })

  it('exposes its own usage text', () => {
    expect(USAGE).toContain('scripts/turn-limit-restart.mjs')
  })
})
