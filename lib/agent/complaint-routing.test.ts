// FIXTURES WRITTEN BEFORE THE MODULE (v1.24.0).
//
// Four times this session a test was written after the code and encoded the
// implementation's assumption instead of catching it — most damningly
// `returns false for unknown triggers (future-add safety)`, which asserted
// the exact opposite of its name for two months. So the expectations below
// are derived from PRODUCTION BODIES and the target behavior, and were
// committed to before complaint-routing.ts existed.
//
// The target behavior, per the founder:
//   1. Agent doesn't understand the problem yet  -> ONE clarifying question,
//      AUTO-SENDS. A question commits nothing and the guest should not wait
//      on an operator for it.
//   2. Agent understands the problem             -> warm, apologetic,
//      comp-forward draft that QUEUES for operator approval and pushes.
//
// So `clarifying` is the ONLY exemption from category routing, and every
// check below fails toward QUEUE. The asymmetry is deliberate: a queued
// question costs the guest latency; an auto-sent resolution costs the venue
// a comp it never authorized.

import { describe, expect, it } from 'vitest'

import { canAutoSendComplaintTurn } from './complaint-routing'

interface Fixture {
  label: string
  /** What the model emitted for complaintIntent. */
  intent: 'clarifying' | 'resolving' | 'none'
  body: string
  /** GeneratedMessageSchema.commitment — {} is the no-op shape. */
  commitment?: { type?: string; description?: string }
  /** True = auto-send is permitted. False = queue. */
  autoSend: boolean
  why: string
}

// The three bodies from the 2026-08-07 03:40 UTC UAT session that produced
// the cold-and-ungated regression, plus the 03:01 unauthorized-comp body.
const PRODUCTION_BODIES: Fixture[] = [
  {
    label: '03:40:11 turn 1 — clarifying question',
    intent: 'clarifying',
    body: 'What was off with it?',
    autoSend: true,
    why: 'the one turn that SHOULD auto-send: asks, commits nothing',
  },
  {
    label: '03:40:40 turn 2 — "Noted." (the cold regression)',
    intent: 'resolving',
    body: "Sour matcha's usually a sign something was off with the prep. Noted.",
    autoSend: false,
    why: 'understood the problem; must queue so the operator sees a warm draft instead',
  },
  {
    label: '03:41:30 turn 3 — refund refusal',
    intent: 'resolving',
    body: "That's not something I can do from here. If you want to talk it through, come by and we can sort it out in person.",
    autoSend: false,
    why: 'resolution turn; operator should decide whether to offer something',
  },
  {
    label: '03:01:42 the unauthorized comp',
    intent: 'resolving',
    body: "Matcha can be tricky to dial in. Come by and I'll have another made for you.",
    autoSend: false,
    why: 'the original incident — must never auto-send again',
  },
]

// Each of the four checks, isolated, so a regression names which one broke.
const BACKSTOP_CASES: Fixture[] = [
  {
    label: 'check 1 — intent=resolving overrides everything else',
    intent: 'resolving',
    body: 'What was off with it?',
    autoSend: false,
    why: 'even a bare question queues when the model says it is resolving',
  },
  {
    label: 'check 1 — intent=none is not an exemption',
    intent: 'none',
    body: 'What was off with it?',
    autoSend: false,
    why: 'only an explicit clarifying claim exempts; none/absent fails toward queue',
  },
  {
    label: 'check 2 — clarifying claim with no question mark',
    intent: 'clarifying',
    body: 'Tell me what went wrong with it.',
    autoSend: false,
    why: 'model claimed clarifying but the body does not ask; fail toward queue',
  },
  {
    label: 'check 3 — clarifying question carrying a forward commitment',
    intent: 'clarifying',
    body: "What was off with it? I'll have another made for you either way.",
    autoSend: false,
    why: 'complaint_commitment_floor grammar present; the promise dominates the question',
  },
  {
    label: 'check 4 — clarifying question carrying a commitment emission',
    intent: 'clarifying',
    body: 'What was off with it?',
    commitment: { type: 'comp', description: 'replacement matcha' },
    autoSend: false,
    why: 'structured commitment present; queue regardless of the question',
  },
  {
    label: 'empty commitment object is a no-op, not a commitment',
    intent: 'clarifying',
    body: 'What was off with it?',
    commitment: {},
    autoSend: true,
    why: '{} is the schema no-op shape and must not be read as a commitment',
  },
  {
    label: 'partial commitment (type without description) is not actionable',
    intent: 'clarifying',
    body: 'Which one was it?',
    commitment: { type: 'comp' },
    autoSend: true,
    why: 'mirrors commitment_type_gated, which requires a non-empty description',
  },
]

// Real clarifying questions from the production comp_complaint history.
// These must keep auto-sending or every complaint thread stalls at the door.
const HISTORICAL_QUESTIONS: Fixture[] = [
  {
    label: '2026-05-02 clarifying question',
    intent: 'clarifying',
    body: "what'd you order, the double or the single?",
    autoSend: true,
    why: 'production body; a question commits nothing',
  },
  {
    label: '2026-08-04 clarifying question',
    intent: 'clarifying',
    body: 'What happened with it? Too sweet, too grassy, something off with the temperature?',
    autoSend: true,
    why: 'production body; multi-option question is still a question',
  },
]

describe('canAutoSendComplaintTurn — production bodies', () => {
  for (const f of PRODUCTION_BODIES) {
    it(`${f.label}: ${f.autoSend ? 'auto-sends' : 'QUEUES'} — ${f.why}`, () => {
      expect(
        canAutoSendComplaintTurn({
          complaintIntent: f.intent,
          body: f.body,
          commitment: f.commitment ?? {},
        }),
      ).toBe(f.autoSend)
    })
  }
})

describe('canAutoSendComplaintTurn — the four checks in isolation', () => {
  for (const f of BACKSTOP_CASES) {
    it(`${f.label}: ${f.autoSend ? 'auto-sends' : 'QUEUES'} — ${f.why}`, () => {
      expect(
        canAutoSendComplaintTurn({
          complaintIntent: f.intent,
          body: f.body,
          commitment: f.commitment ?? {},
        }),
      ).toBe(f.autoSend)
    })
  }
})

describe('canAutoSendComplaintTurn — historical clarifying questions keep flowing', () => {
  for (const f of HISTORICAL_QUESTIONS) {
    it(`${f.label}: auto-sends — ${f.why}`, () => {
      expect(
        canAutoSendComplaintTurn({
          complaintIntent: f.intent,
          body: f.body,
          commitment: f.commitment ?? {},
        }),
      ).toBe(true)
    })
  }
})

describe('canAutoSendComplaintTurn — direction of failure', () => {
  // The single most important property. If this inverts, an unauthorized
  // comp auto-sends; the 2026-08-07 incident is what that costs.
  it('exactly one input combination auto-sends; everything else queues', () => {
    const intents = ['clarifying', 'resolving', 'none'] as const
    const bodies = ['Has a question?', 'No question here.']
    const commitments = [{}, { type: 'comp', description: 'x' }]
    const sends: string[] = []
    for (const complaintIntent of intents) {
      for (const body of bodies) {
        for (const commitment of commitments) {
          if (canAutoSendComplaintTurn({ complaintIntent, body, commitment })) {
            sends.push(`${complaintIntent}|${body}|${JSON.stringify(commitment)}`)
          }
        }
      }
    }
    expect(sends).toEqual(['clarifying|Has a question?|{}'])
  })
})
