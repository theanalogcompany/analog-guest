import { describe, expect, it } from 'vitest'
import { EXIT, LABEL_FOR_MARKER, USAGE, newestTurn, pendingQuestionLabel, reconcile, run } from './pending-question.mjs'

const bot = (marker: string, body = '', createdAt = '2026-01-01T00:00:00Z') => ({
  body: `**[FROM CLAUDE CODE]**\n\n[${marker}] TAC-1${body ? `\n\n${body}` : ''}`,
  createdAt,
})
const human = (body: string, createdAt = '2026-01-01T00:00:00Z') => ({ body, createdAt })
const chatRuling = (body: string, createdAt = '2026-01-01T00:00:00Z') => ({
  body: `**[FROM CLAUDE CHAT — RULING]**\n\n${body}`,
  createdAt,
})
const chatPlain = (body: string, createdAt = '2026-01-01T00:00:00Z') => ({
  body: `**[FROM CLAUDE CHAT]**\n\n${body}`,
  createdAt,
})

describe('newestTurn', () => {
  it('returns null for an empty thread', () => {
    expect(newestTurn([])).toBeNull()
    expect(newestTurn(undefined)).toBeNull()
  })

  it('skips bookkeeping to find the real newest turn', () => {
    const plan = bot('PLAN', '', '2026-01-01T00:00:00Z')
    const claim = bot('CLAIM', 'run=1', '2026-01-02T00:00:00Z')
    expect(newestTurn([plan, claim])).toBe(plan)
  })

  it('skips a plain CHAT comment, which is context and answers nothing', () => {
    const plan = bot('PLAN', '', '2026-01-01T00:00:00Z')
    const chat = chatPlain('Just some context, not a decision.', '2026-01-02T00:00:00Z')
    expect(newestTurn([plan, chat])).toBe(plan)
  })

  it('does not skip a CHAT — RULING comment: that one is a real reply', () => {
    const plan = bot('PLAN', '', '2026-01-01T00:00:00Z')
    const ruling = chatRuling('Approved.', '2026-01-02T00:00:00Z')
    expect(newestTurn([plan, ruling])).toBe(ruling)
  })

  it('does not skip an unprefixed human reply', () => {
    const plan = bot('PLAN', '', '2026-01-01T00:00:00Z')
    const reply = human('Go ahead.', '2026-01-02T00:00:00Z')
    expect(newestTurn([plan, reply])).toBe(reply)
  })

  it('sorts by createdAt regardless of input order', () => {
    const older = bot('PLAN', '', '2026-01-01T00:00:00Z')
    const newer = human('Go ahead.', '2026-01-02T00:00:00Z')
    expect(newestTurn([newer, older])).toBe(newer)
  })

  it('returns null when every comment is bookkeeping or context chat', () => {
    const claim = bot('CLAIM', 'run=1')
    const chat = chatPlain('Just context.')
    expect(newestTurn([claim, chat])).toBeNull()
  })
})

describe('pendingQuestionLabel', () => {
  it('maps every marker in LABEL_FOR_MARKER', () => {
    for (const [marker, label] of Object.entries(LABEL_FOR_MARKER)) {
      expect(pendingQuestionLabel([bot(marker)])).toBe(label)
    }
  })

  it('returns Needs Decision for an AUDIT with a real numbered question', () => {
    const audit = bot('AUDIT', '**3. QUESTIONS**\n\n1. A real question.\n\n**4. FINDINGS**\n\nNone.')
    expect(pendingQuestionLabel([audit])).toBe('Needs Decision')
  })

  it('returns null for a clean AUDIT ("None.")', () => {
    const audit = bot('AUDIT', '**3. QUESTIONS**\n\nNone.\n\n**4. FINDINGS**\n\nNone.')
    expect(pendingQuestionLabel([audit])).toBeNull()
  })

  it('returns null when nothing is pending: no comments at all', () => {
    expect(pendingQuestionLabel([])).toBeNull()
    expect(pendingQuestionLabel(undefined)).toBeNull()
  })

  it('returns null when a ruling answered the newest question', () => {
    const plan = bot('PLAN', '', '2026-01-01T00:00:00Z')
    const ruling = chatRuling('Approved. Build it.', '2026-01-02T00:00:00Z')
    expect(pendingQuestionLabel([plan, ruling])).toBeNull()
  })

  it('returns null when an unprefixed human reply is the newest turn', () => {
    const needsInput = bot('NEEDS-INPUT', '', '2026-01-01T00:00:00Z')
    const reply = human('Option 1.', '2026-01-02T00:00:00Z')
    expect(pendingQuestionLabel([needsInput, reply])).toBeNull()
  })

  it('never restores a label for HUMAN-REVIEW-REQUIRED: no label belongs there by design', () => {
    expect(pendingQuestionLabel([bot('HUMAN-REVIEW-REQUIRED')])).toBeNull()
  })

  it.each(['BUILD-SKIPPED', 'AUDIT-SKIPPED', 'SILENT-RUN', 'TURN-LIMIT', 'FINDING', 'CANCELLED'])(
    'does not flag %s: it resolves by an edit or a fixed cause, never by a reply',
    (marker) => {
      expect(pendingQuestionLabel([bot(marker)])).toBeNull()
    },
  )

  it('a CHAT — RULING comment answering a PLAN is not itself mistaken for a pending marker', () => {
    // The ruling has no CC prefix, so pendingQuestionLabel's own
    // isBotComment(turn.body) check is what stops it here — proven by
    // checking the newest turn really is the ruling, not the plan.
    const plan = bot('PLAN', '', '2026-01-01T00:00:00Z')
    const ruling = chatRuling('Approved.', '2026-01-02T00:00:00Z')
    expect(newestTurn([plan, ruling])?.body).toContain('RULING')
    expect(pendingQuestionLabel([plan, ruling])).toBeNull()
  })

  // Reconstructed from TAC-396's real 2026-09-18 thread (see
  // build-workflow.test.ts's "the selection's jq, run on a fixture" for the
  // same shape used there): NEEDS-ACTION, then a ruling, then a local
  // session's CLAIM. Proves the transition (pending -> not pending), not
  // just one static value.
  it('TAC-396-shaped thread: pending before the ruling, answered after', () => {
    const needsAction = bot('NEEDS-ACTION', '', '2026-09-17T00:00:00Z')
    expect(pendingQuestionLabel([needsAction])).toBe('Needs Action')

    const ruling = chatRuling('Reopening.', '2026-09-18T01:33:00Z')
    expect(pendingQuestionLabel([needsAction, ruling])).toBeNull()

    // The build workflow's own [CLAIM], posted after the ruling to start
    // resuming, must not make the ticket look pending again.
    const claim = bot('CLAIM', 'run=1', '2026-09-18T01:34:00Z')
    expect(pendingQuestionLabel([needsAction, ruling, claim])).toBeNull()
  })

  // Reconstructed from TAC-325's shape on 2026-09-17: a PLAN posted, then
  // Needs Decision cleared by hand with no reply — the exact incident this
  // ticket exists to stop repeating. The label is gone; the check must
  // still say the ticket is pending.
  it('TAC-325-shaped thread: a PLAN with the label hand-cleared and no reply is still pending', () => {
    const plan = bot('PLAN', 'Scope and approach...', '2026-09-17T10:00:00Z')
    expect(pendingQuestionLabel([plan])).toBe('Needs Decision')
  })
})

describe('reconcile', () => {
  it('includes only the candidates with a pending label, in order', () => {
    const pending = { id: 'uuid-1', identifier: 'TAC-1', comments: [bot('PLAN')] }
    const clean = { id: 'uuid-2', identifier: 'TAC-2', comments: [human('Go ahead.')] }
    const alsoPending = { id: 'uuid-3', identifier: 'TAC-3', comments: [bot('NEEDS-ACTION')] }
    expect(reconcile([pending, clean, alsoPending])).toEqual([
      { id: 'uuid-1', identifier: 'TAC-1', label: 'Needs Decision' },
      { id: 'uuid-3', identifier: 'TAC-3', label: 'Needs Action' },
    ])
  })

  it('returns an empty array, not nothing, when nothing is pending', () => {
    expect(reconcile([{ id: 'uuid-1', identifier: 'TAC-1', comments: [human('Go ahead.')] }])).toEqual([])
    expect(reconcile([])).toEqual([])
    expect(reconcile(undefined)).toEqual([])
  })
})

describe('run', () => {
  function invoke(stdin: string) {
    const out: string[] = []
    const err: string[] = []
    const code = run({ stdin, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) })
    return { code, out: out.join(''), err: err.join('') }
  }

  it('prints the pending candidates as JSON', () => {
    const candidates = [{ id: 'uuid-1', identifier: 'TAC-1', comments: [bot('PLAN')] }]
    const r = invoke(JSON.stringify(candidates))
    expect(r.code).toBe(EXIT.OK)
    expect(JSON.parse(r.out)).toEqual([{ id: 'uuid-1', identifier: 'TAC-1', label: 'Needs Decision' }])
    expect(r.err).toBe('')
  })

  it('prints an empty array, not nothing, when nothing is pending', () => {
    const r = invoke(JSON.stringify([{ id: 'uuid-1', identifier: 'TAC-1', comments: [] }]))
    expect(JSON.parse(r.out)).toEqual([])
  })

  it('refuses non-JSON stdin as a usage error', () => {
    const r = invoke('not json')
    expect(r.code).toBe(EXIT.USAGE)
    expect(r.out).toBe('')
    expect(r.err).toContain(USAGE)
  })

  it('refuses a non-array payload', () => {
    const r = invoke('{}')
    expect(r.code).toBe(EXIT.USAGE)
  })
})
