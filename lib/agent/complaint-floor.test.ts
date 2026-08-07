// Fixtures are the COMPLETE set of comp_complaint outbounds in production at
// the time this module was written (2026-05-02 .. 2026-08-07, 12 rows), not a
// hand-written sample. `expected` is the ground-truth answer to "does this
// reply commit a venue resource?", judged per row; `floorQueues` is what the
// predicate must do.
//
// Keeping real bodies means a future widening of FORWARD_COMMITMENT_PATTERNS
// gets measured against actual venue voice rather than invented phrasings —
// the precision/recall numbers in the module docstring are reproducible from
// this file.

import { describe, expect, it } from 'vitest'

import {
  FLOOR_CATEGORIES,
  isFloorCategory,
  matchForwardCommitment,
} from './complaint-floor'

interface Fixture {
  date: string
  body: string
  /** Ground truth: does this reply actually commit a venue resource? */
  commitsResource: boolean
  /** What the floor predicate must do with it. */
  floorQueues: boolean
  note?: string
}

const HISTORY: Fixture[] = [
  {
    date: '2026-05-02',
    body: "what'd you order, the double or the single?",
    commitsResource: false,
    floorQueues: false,
    note: 'pure clarifying question — must stay fast',
  },
  {
    date: '2026-05-02',
    body: "not how it works. but come in, i'll make it right.",
    commitsResource: true,
    floorQueues: true,
    note: 'ungated in production; the pattern predates R11 by two months',
  },
  {
    date: '2026-05-03',
    body: "yeah, you said. come in, i'll make it right.",
    commitsResource: true,
    floorQueues: true,
  },
  {
    date: '2026-05-31',
    body: "That's not right, sorry. Burnt and sour usually means something went sideways on the pull. Come back when you can and the next one's on us.",
    commitsResource: true,
    floorQueues: false,
    note: 'floor MISSES this (no first-person modal) — already caught by commitment_type_gated',
  },
  {
    date: '2026-06-01',
    body: "Really sorry about yesterday. A refund isn't something I can do over text, but tell me what happened and I'll make it right.",
    commitsResource: true,
    floorQueues: true,
    note: "matches on \"I'll make it right\", NOT on the \"I can\" inside the refusal — see negation tests",
  },
  {
    date: '2026-07-03',
    body: "Sorry about that, it shouldn't leave the bar cold. Next visit, let me know when you're here and we'll make it right.",
    commitsResource: true,
    floorQueues: true,
  },
  {
    date: '2026-07-07',
    body: "Sorry about that again. We're closed for the evening now, but come by tomorrow and I'll make it right.",
    commitsResource: true,
    floorQueues: true,
    note: 'only caught in production because hold_all_outbound happened to be on',
  },
  {
    date: '2026-08-04',
    body: 'What happened with it? Too sweet, too grassy, something off with the temperature?',
    commitsResource: false,
    floorQueues: false,
    note: 'pure clarifying question — must stay fast',
  },
  {
    date: '2026-08-04',
    body: "Fair, that's a common one. I don't have the sourcing details in front of me on the matcha, let me find out and get back to you. If sweet is the issue, I can also ask them to pull back on the syrup next time.",
    commitsResource: false,
    floorQueues: true,
    note: 'ACCEPTED FALSE POSITIVE — prompt-endorsed information stall',
  },
  {
    date: '2026-08-05',
    body: "Still trying to get the exact sourcing on the matcha. I hear you on the urgency. Give me a bit more time and I'll come back with a real answer, not a guess.",
    commitsResource: false,
    floorQueues: true,
    note: 'ACCEPTED FALSE POSITIVE — information stall',
  },
  {
    date: '2026-08-07',
    body: 'What was off with it? I want to make sure I understand before we figure out next steps.',
    commitsResource: false,
    floorQueues: false,
    note: 'turn 1 of the incident thread — correctly passes, commits nothing',
  },
  {
    date: '2026-08-07',
    body: "Matcha can be tricky to dial in. Come by and I'll have another made for you.",
    commitsResource: true,
    floorQueues: true,
    note: 'THE INCIDENT — auto-sent in production with review_reason NULL',
  },
]

describe('matchForwardCommitment — against the full production history', () => {
  for (const f of HISTORY) {
    it(`${f.date}: ${f.floorQueues ? 'queues' : 'passes'} — ${f.note ?? f.body.slice(0, 40)}`, () => {
      expect(matchForwardCommitment(f.body).matched).toBe(f.floorQueues)
    })
  }

  it('catches the 2026-08-07 incident that shipped unreviewed', () => {
    const incident = HISTORY.find((f) => f.note?.startsWith('THE INCIDENT'))
    expect(incident).toBeDefined()
    expect(matchForwardCommitment(incident!.body).matched).toBe(true)
  })

  // Locks the measured numbers in the module docstring. If a future widening
  // changes these, the docstring is stale and must move with it.
  it('holds its measured precision: 8 queued, 6 true positives, 2 false positives', () => {
    const queued = HISTORY.filter((f) => matchForwardCommitment(f.body).matched)
    const tp = queued.filter((f) => f.commitsResource)
    const fp = queued.filter((f) => !f.commitsResource)
    expect(queued).toHaveLength(8)
    expect(tp).toHaveLength(6)
    expect(fp).toHaveLength(2)
  })

  // The latency property: complaint threads must not stall on questions.
  it('lets every pure-question turn through', () => {
    const questions = HISTORY.filter((f) => f.body.includes('?') && !f.commitsResource)
    expect(questions.length).toBeGreaterThanOrEqual(3)
    for (const q of questions) {
      expect(matchForwardCommitment(q.body).matched, `should pass: ${q.body}`).toBe(false)
    }
  })
})

// The bug that nearly shipped: \b(i can)\b matches "I can't" because the
// apostrophe is a non-word character. Queueing refusals is a worse failure
// than the one this module fixes.
describe('matchForwardCommitment — negations and refusals must NOT match', () => {
  const REFUSALS = [
    "I can't do that over text",
    "we can't comp that",
    "A refund isn't something I can do over text",
    'I will not be able to do that',
    'I will never charge for that',
    "I won't charge you",
    'Not something we do on request, sorry.',
    // Regression: /\bwe'?ll\b/ with an OPTIONAL apostrophe matches the word
    // "well". This exact production body (2026-08-07 03:00:01) failed the
    // first draft of this module.
    "We don't do holds on bags, but we're usually well stocked.",
    'Glad it went well for you.',
    // Same flaw on the first person: optional apostrophe matches "ill".
    'Sorry to hear you were ill last week.',
  ]
  for (const body of REFUSALS) {
    it(`does not match: "${body}"`, () => {
      expect(matchForwardCommitment(body).matched).toBe(false)
    })
  }
})

describe('matchForwardCommitment — genuine commitments must match', () => {
  const COMMITMENTS = [
    "Come by and I'll have another made for you",
    "we'll make it right",
    // The three phrasings that justify keeping `let me` despite its
    // false-positive cost — COMP_PATTERNS does not cover any of them.
    'let me make you a fresh one',
    'let me get you another one',
    'let me take care of that for you',
    'I will have one ready for you',
    "I'm going to comp that",
    // Curly apostrophes: iOS guests send them and they appear in production
    // inbound bodies, so the contraction patterns must accept both forms.
    'Come by and I’ll have another made for you',
    'we’ll make it right',
  ]
  for (const body of COMMITMENTS) {
    it(`matches: "${body}"`, () => {
      expect(matchForwardCommitment(body).matched).toBe(true)
    })
  }

  it('reports which pattern fired, for the operator queue and PostHog', () => {
    const r = matchForwardCommitment("Come by and I'll have another made for you")
    expect(r.matched).toBe(true)
    if (r.matched) expect(r.pattern).toContain('ll')
  })
})

describe('isFloorCategory', () => {
  it('covers comp_complaint', () => {
    expect(isFloorCategory('comp_complaint')).toBe(true)
  })

  // Structural guarantee for the two regression cases: "can i get a free
  // drink" and "any chance you can hold a bag" both classify as
  // mechanic_request, so the floor cannot queue an ordinary perk refusal
  // regardless of how the reply is worded.
  it('does NOT cover mechanic_request — perk refusals must stay auto-send', () => {
    expect(isFloorCategory('mechanic_request')).toBe(false)
  })

  it('does not cover unrelated categories or undefined', () => {
    expect(isFloorCategory('reply')).toBe(false)
    expect(isFloorCategory('follow_up')).toBe(false)
    expect(isFloorCategory('recommendation_request')).toBe(false)
    expect(isFloorCategory(undefined)).toBe(false)
  })

  it('scope stays deliberately narrow — widening it holds more from guests', () => {
    expect(FLOOR_CATEGORIES.size).toBe(1)
  })
})
