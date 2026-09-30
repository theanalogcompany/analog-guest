import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_KEYS,
  answerPartOf,
  countQuestions,
  identityClaims,
  isAllowedKey,
  scoreConversation,
  scoreTurn,
  splitQuestions,
  summarize,
  type TurnInput,
} from './first-visit-question-budget-score'

// TAC-567. EVERY BAR IN THIS RUN IS AN ABSOLUTE ZERO, so the only thing that
// makes a reported zero evidence is a detector that demonstrably fires. Each
// detector below is driven from BOTH sides: the clean case AND the exact defect
// the ticket was filed for, transcribed from the device transcript.
const VENUE = "Le Mil's"

const turn = (over: Partial<TurnInput> = {}): TurnInput => ({
  stage: 'reply',
  body: 'we close at 3 today.',
  tail: '',
  attributedTo: [],
  raisedKeys: [],
  failed: false,
  ...over,
})

describe('splitQuestions', () => {
  it('finds nothing in a reply that asks nothing', () => {
    expect(splitQuestions('that one keeps the lights on.')).toEqual([])
    expect(countQuestions('that one keeps the lights on.')).toBe(0)
  })

  // THE DEVICE CASE, verbatim from the ticket: the body invented a question and
  // TAC-554's bubble added a second. If this returns 1 the whole run is blind to
  // bar 2.
  //
  // NOTE THE FIRST EXCERPT CARRIES ITS LEAD-IN, and that is the real copy rather
  // than a defect here. There is no `.!` before "how'd", which is exactly why
  // TAC-554 had to move the question into its own field instead of asking dispatch
  // to split it. THE COUNT is what both bars read; the excerpt is for human
  // reading, and the harness prints the whole body beside it.
  it('finds both questions in the turn this ticket was filed for', () => {
    const body =
      "that's a good one to start with 🌸 how'd you like it? by the way, what's your name?"
    expect(countQuestions(body)).toBe(2)
    expect(splitQuestions(body)).toEqual([
      "that's a good one to start with 🌸 how'd you like it?",
      "by the way, what's your name?",
    ])
  })

  // Le Mil's writes lowercase, and lib/agent/sentence-split.ts needs a capitalised
  // opener - it returns 1 for every reply at this venue. A scorer built on it
  // would be blind to the question, which is the trap recorded in
  // lib/ai/prompts/CLAUDE.md. This asserts the lowercase case explicitly.
  it('reads a lowercase reply, where the dispatch splitter cannot', () => {
    expect(splitQuestions('nice. you nearby?')).toEqual(['you nearby?'])
  })

  it('trims each question back to its own sentence, not the whole reply', () => {
    expect(
      splitQuestions('we roast it ourselves. it is a light one. how was it?'),
    ).toEqual(['how was it?'])
  })

  it('ignores a question mark with nothing in front of it', () => {
    expect(splitQuestions('??')).toEqual([])
    expect(splitQuestions('?')).toEqual([])
  })

  it('does not count trailing text after the last question', () => {
    expect(splitQuestions('what did you get? hope it was good.')).toEqual([
      'what did you get?',
    ])
  })
})

describe('identityClaims', () => {
  // THE OPENER FROM THE DEVICE TRANSCRIPT. Bar 3 exists for this sentence.
  it('catches the opener the ticket was filed for', () => {
    const claims = identityClaims(
      "hey, welcome! you've reached Le Mil's on Polk Street 👋",
      VENUE,
    )
    expect(claims.map((c) => c.label)).toContain("you've reached")
    expect(claims.some((c) => c.tier === 'strict')).toBe(true)
  })

  it('catches the curly apostrophe the model actually writes', () => {
    expect(
      identityClaims('you’ve reached us', VENUE).map((c) => c.label),
    ).toEqual(["you've reached"])
  })

  it('catches "you have reached" spelled out', () => {
    expect(identityClaims('you have reached us', VENUE)).toHaveLength(1)
  })

  it('catches the channel claim the old Instagram copy licensed', () => {
    expect(
      identityClaims("you're texting the shop", VENUE).map((c) => c.label),
    ).toEqual(["you're texting/messaging"])
    expect(identityClaims('you’re messaging us', VENUE)).toHaveLength(1)
  })

  // THE SECOND TIER, and it is separate because it is a judgement call. A bar must
  // never fail on a judgement call without a human seeing the sentence, so these
  // are counted and printed apart from the strict ones.
  it.each([
    ["this is Le Mil's, what did you get?", 'this is <venue>'],
    ["welcome to Le Mil's! what did you get?", 'welcome to <venue>'],
    ["Le Mil's here. what did you get?", '<venue> here'],
  ])('flags %s as an equivalent claim', (body, label) => {
    const claims = identityClaims(body, VENUE)
    expect(claims.map((c) => c.label)).toContain(label)
    expect(claims.every((c) => c.tier === 'equivalent')).toBe(true)
  })

  // The venue's apostrophe arrives as ' or U+2019 depending on who typed it, and
  // the model re-punctuates freely. A pattern that only matched one form would
  // under-count, and the error would flatter the arm.
  it('matches the venue name whichever apostrophe the model used', () => {
    expect(identityClaims('welcome to Le Mil’s!', "Le Mil's")).toHaveLength(1)
    expect(identityClaims("welcome to Le Mil's!", 'Le Mil’s')).toHaveLength(1)
  })

  // THE CLEAN OPENER, which is what the ruling asks for. The venue name is not
  // itself the defect; claiming identity is. This is the false-positive guard: if
  // it fires here the run cannot report a real zero.
  it('passes an opener that greets and asks the order', () => {
    expect(
      identityClaims('hey, welcome! what did you get today?', VENUE),
    ).toEqual([])
  })

  it('does not invent a venue pattern when the name is blank', () => {
    expect(identityClaims('welcome to  ! this is  ', '  ')).toEqual([])
  })
})

describe('the allowed two', () => {
  it('is the ruled set and nothing else', () => {
    expect([...ALLOWED_KEYS]).toEqual(['understand_order', 'learn_name'])
  })

  // TAC-568 moved are_they_new_here behind the warm close, so the scorer's bar
  // moved with it. Named explicitly rather than left to the list above: a run
  // scored before 2026-09-30 counted this key as on-target, so a figure carried
  // across that date is comparing two different bars.
  it('treats are_they_new_here as off-target now (TAC-568)', () => {
    expect([...ALLOWED_KEYS]).not.toContain('are_they_new_here')
  })

  // WHAT MAKES THE BAR ABOVE CORRECT RATHER THAN MERELY STRICT. The intention is
  // allowed on a first conversation once the close has gone out, so this scorer
  // is only right while the harnesses feeding it model the PRE-close flow. That
  // is an input to production code, not a claim in a comment, so it is read off
  // the harness sources - a harness switched to `warmCloseSent: true` would make
  // this constant wrong, and nothing else would say so.
  it.each(['first-visit-question.ts', 'first-visit-question-budget.ts'])(
    '%s drives the derivation with warmCloseSent: false',
    (file) => {
      const src = readFileSync(join(import.meta.dirname, file), 'utf8')
      expect(src).toContain('warmCloseSent: false,')
      expect(src).not.toContain('warmCloseSent: true')
    },
  )

  it.each([
    'are_they_local',
    'their_rhythm',
    'why_theyre_here',
    'did_they_like_it',
    'got_the_recommendation',
  ])('%s is not allowed', (key) => {
    expect(isAllowedKey(key)).toBe(false)
  })
})

describe('answerPartOf', () => {
  it('slices the tail off, because body ends with it by construction', () => {
    expect(
      answerPartOf(
        "nice one. by the way, what's your name?",
        "by the way, what's your name?",
      ),
    ).toBe('nice one. ')
  })

  it('returns the whole body when no question was asked', () => {
    expect(answerPartOf('nice one.', '')).toBe('nice one.')
  })

  // If the identity ever breaks, count the whole body rather than half of it: a
  // broken invariant should be visible as an over-count, never as a silent zero.
  it('falls back to the whole body when the tail is not its suffix', () => {
    expect(answerPartOf('nice one.', 'what is your name?')).toBe('nice one.')
  })
})

describe('scoreTurn', () => {
  // BAR 2, and this is the exact turn the ticket was filed for: the body invented
  // "how'd you like it?" and TAC-554's bubble added the name question on top.
  it('flags a body question plus an intention bubble as two questions', () => {
    const v = scoreTurn(
      turn({
        body: "that's a good one to start with 🌸 how'd you like it? by the way, what's your name?",
        tail: "by the way, what's your name?",
        attributedTo: ['did_they_like_it'],
        raisedKeys: ['learn_name'],
      }),
    )
    expect(v.questionCount).toBe(2)
    expect(v.twoQuestions).toBe(true)
    expect(v.offTargetKeys).toEqual(['did_they_like_it'])
  })

  it('does not flag the bubble alone as two questions', () => {
    const v = scoreTurn(
      turn({
        body: "that one's a good start. by the way, what's your name?",
        tail: "by the way, what's your name?",
        raisedKeys: ['learn_name'],
      }),
    )
    expect(v.questionCount).toBe(1)
    expect(v.twoQuestions).toBe(false)
    expect(v.offTargetKeys).toEqual([])
  })

  it('does not flag a lone body question as two questions', () => {
    const v = scoreTurn(
      turn({
        body: 'what did you get today?',
        attributedTo: ['understand_order'],
      }),
    )
    expect(v.questionCount).toBe(1)
    expect(v.twoQuestions).toBe(false)
  })

  // THE FALSE POSITIVE THE FIRST SMOKE RUN PRODUCED, pinned so it cannot come
  // back. A statement sitting in front of the bubble with no terminator between
  // them used to be swallowed into the question excerpt and judged; reading the
  // tail structurally leaves the statement out of the ballot entirely.
  it('does not judge a statement that runs into the bubble', () => {
    const v = scoreTurn(
      turn({
        body: "glad you came in 😊 we've got that comp and the SoFi recommendation still waiting whenever you're ready to come back by the way, what's your name?",
        tail: "by the way, what's your name?",
        attributedTo: [],
        raisedKeys: ['learn_name'],
      }),
    )
    expect(v.questionCount).toBe(1)
    expect(v.twoQuestions).toBe(false)
    expect(v.offTargetKeys).toEqual([])
    expect(v.unattributedQuestion).toBe(false)
  })

  it('names an attributed key outside the ruled three', () => {
    expect(
      scoreTurn(
        turn({
          body: 'do you live around here?',
          attributedTo: ['are_they_local'],
        }),
      ).offTargetKeys,
    ).toEqual(['are_they_local'])
  })

  // The tail is judged by production's gate, so an off-target key can arrive from
  // either judge and both must reach the bar.
  it('names an off-target key the production gate recorded on the tail', () => {
    expect(
      scoreTurn(
        turn({
          body: 'nice. what time do you usually come by?',
          tail: 'what time do you usually come by?',
          raisedKeys: ['their_rhythm'],
        }),
      ).offTargetKeys,
    ).toEqual(['their_rhythm'])
  })

  it('accepts both of the ruled keys', () => {
    expect(
      scoreTurn(
        turn({
          body: 'what did you get?',
          attributedTo: ['understand_order'],
          raisedKeys: ['learn_name'],
        }),
      ).offTargetKeys,
    ).toEqual([])
  })

  // The same turn, with the key TAC-568 removed, is now a finding. This is the
  // arm that proves the change above reaches the scorer rather than only the
  // constant.
  it('reports are_they_new_here as off-target (TAC-568)', () => {
    expect(
      scoreTurn(
        turn({
          body: 'first time in?',
          attributedTo: [],
          raisedKeys: ['are_they_new_here'],
        }),
      ).offTargetKeys,
    ).toEqual(['are_they_new_here'])
  })

  it('dedupes an off-target key both judges reported', () => {
    expect(
      scoreTurn(
        turn({
          attributedTo: ['are_they_local'],
          raisedKeys: ['are_they_local'],
        }),
      ).offTargetKeys,
    ).toEqual(['are_they_local'])
  })

  // THE HALF A JUDGE-ONLY READ MISSES: an invented question matching no intention
  // description is still a question the ruling does not allow.
  it('flags a body question the full ballot attributed to nothing', () => {
    const v = scoreTurn(turn({ body: 'how has your morning been?' }))
    expect(v.offTargetKeys).toEqual([])
    expect(v.unattributedQuestion).toBe(true)
  })

  it('does not call the bubble unattributed when the gate judged it', () => {
    expect(
      scoreTurn(
        turn({
          body: "nice. by the way, what's your name?",
          tail: "by the way, what's your name?",
          raisedKeys: ['learn_name'],
        }),
      ).unattributedQuestion,
    ).toBe(false)
  })

  it('does not flag a reply that asked nothing', () => {
    const v = scoreTurn(turn({ body: 'glad it landed.' }))
    expect(v.questionCount).toBe(0)
    expect(v.unattributedQuestion).toBe(false)
    expect(v.twoQuestions).toBe(false)
  })
})

describe('scoreConversation', () => {
  const clean: TurnInput[] = [
    {
      stage: 'opener',
      body: 'hey, welcome! what did you get today?',
      tail: '',
      attributedTo: ['understand_order'],
      raisedKeys: ['understand_order'],
      failed: false,
    },
    {
      stage: 'name',
      body: "that one's a good start. by the way, what's your name?",
      tail: "by the way, what's your name?",
      attributedTo: [],
      raisedKeys: ['learn_name'],
      failed: false,
    },
    // TAC-568: THE RULED FLOW ENDS HERE, on the name. The third turn this
    // fixture used to carry asked "first time in?" and is now off-target - see
    // the arm below, which keeps that exact turn as the DEFECT case rather than
    // deleting the evidence.
    {
      stage: 'nice-to-meet-you',
      body: 'Jaipal, nice to meet you',
      tail: '',
      attributedTo: [],
      raisedKeys: [],
      failed: false,
    },
  ]

  it('passes the ruled flow', () => {
    const v = scoreConversation(clean, VENUE)
    expect(v.clean).toBe(true)
    expect(v.questionCount).toBe(2)
    expect(v.twoQuestionTurns).toBe(0)
    expect(v.offTargetKeys).toEqual([])
    expect(v.openerIdentityClaims).toEqual([])
  })

  // THE SAME CONVERSATION WITH TAC-567'S THIRD QUESTION STILL ON IT. It scored
  // clean until 2026-09-30 and must not now, or the scorer cannot tell the two
  // rulings apart on the runs that exist to compare them.
  it('fails the old three-question flow (TAC-568)', () => {
    const withNewHere: TurnInput[] = [
      clean[0]!,
      clean[1]!,
      {
        stage: 'new-here',
        body: 'Jaipal, glad you came by. first time in, or have you been coming a while?',
        tail: 'first time in, or have you been coming a while?',
        attributedTo: [],
        raisedKeys: ['are_they_new_here'],
        failed: false,
      },
    ]
    const v = scoreConversation(withNewHere, VENUE)
    expect(v.clean).toBe(false)
    expect(v.offTargetKeys).toEqual(['are_they_new_here'])
  })

  it('collects every question in order, for the verbatim report', () => {
    expect(scoreConversation(clean, VENUE).questions).toEqual([
      'what did you get today?',
      "by the way, what's your name?",
    ])
  })

  // THE FULL DEVICE TRANSCRIPT, reconstructed. If this scored clean the run would
  // certify the bug it was written to catch.
  it('fails the conversation the ticket was filed for', () => {
    const v = scoreConversation(
      [
        {
          stage: 'opener',
          body: "hey, welcome! you've reached Le Mil's on Polk Street 👋 what did you get today?",
          tail: '',
          attributedTo: ['understand_order'],
          raisedKeys: ['understand_order'],
          failed: false,
        },
        {
          stage: 'name',
          body: "that's a good one to start with 🌸 how'd you like it? by the way, what's your name?",
          tail: "by the way, what's your name?",
          attributedTo: ['did_they_like_it'],
          raisedKeys: ['learn_name'],
          failed: false,
        },
      ],
      VENUE,
    )
    expect(v.clean).toBe(false)
    expect(v.twoQuestionTurns).toBe(1)
    expect(v.offTargetKeys).toEqual(['did_they_like_it'])
    expect(v.openerIdentityClaims.map((c) => c.label)).toContain(
      "you've reached",
    )
  })

  // BAR 3 READS THE OPENER ONLY. Later turns are a different question, and
  // sweeping the whole conversation would fail the arm for a sentence the ruling
  // does not govern.
  it('reads identity claims from the opener alone', () => {
    const v = scoreConversation(
      [
        { ...clean[0]!, body: 'hey, welcome! what did you get?' },
        { ...clean[1]!, body: "you've reached us any time.", tail: '' },
      ],
      VENUE,
    )
    expect(v.openerIdentityClaims).toEqual([])
  })

  it('invalidates a conversation with a failed turn', () => {
    const v = scoreConversation([{ ...clean[0]!, failed: true }], VENUE)
    expect(v.invalid).toBe(true)
    expect(v.clean).toBe(false)
  })

  it('invalidates a conversation with no turns at all', () => {
    expect(scoreConversation([], VENUE).invalid).toBe(true)
  })
})

describe('summarize', () => {
  const okTurn: TurnInput = {
    stage: 'opener',
    body: 'hey, welcome! what did you get today?',
    tail: '',
    attributedTo: ['understand_order'],
    raisedKeys: ['understand_order'],
    failed: false,
  }
  const ok = () => scoreConversation([okTurn], VENUE)

  it('passes when every bar is zero across valid conversations', () => {
    const s = summarize([ok(), ok()])
    expect(s.valid).toBe(2)
    expect(s.pass).toBe(true)
  })

  // CONVENTION 5 AND 6, and it has fired twice in this repo: a wholly broken run
  // reports every bar at zero, because every bar counts a bad thing. Without the
  // valid-count clause this prints PASS.
  it('fails a run where every conversation was invalid', () => {
    const dead = scoreConversation([{ ...okTurn, failed: true }], VENUE)
    const s = summarize([dead, dead])
    expect(s.valid).toBe(0)
    expect(s.invalid).toBe(2)
    expect(s.pass).toBe(false)
  })

  it.each([
    [
      'an off-target body question',
      {
        ...okTurn,
        body: 'do you live nearby?',
        attributedTo: ['are_they_local'],
        raisedKeys: [],
      },
    ],
    [
      'an off-target question on the bubble',
      {
        ...okTurn,
        body: 'nice. what time do you come by?',
        tail: 'what time do you come by?',
        attributedTo: [],
        raisedKeys: ['their_rhythm'],
      },
    ],
    [
      'two questions in one turn',
      {
        ...okTurn,
        body: "how was it? by the way, what's your name?",
        tail: "by the way, what's your name?",
        attributedTo: ['did_they_like_it'],
        raisedKeys: ['learn_name'],
      },
    ],
    [
      'an unattributed invented question',
      {
        ...okTurn,
        body: 'how has your day been?',
        attributedTo: [],
        raisedKeys: [],
      },
    ],
  ])('fails the run on %s', (_label, bad) => {
    expect(summarize([ok(), scoreConversation([bad], VENUE)]).pass).toBe(false)
  })

  it('fails the run on an identity claim in the opener, at either tier', () => {
    for (const body of ["you've reached Le Mil's", "welcome to Le Mil's"]) {
      const s = summarize([
        ok(),
        scoreConversation(
          [{ ...okTurn, body, attributedTo: [], raisedKeys: [] }],
          VENUE,
        ),
      ])
      expect(s.pass, body).toBe(false)
    }
  })

  // THE FLOOR, and this is the case every bar in this run is blind to: the agent
  // asks NOTHING. All three bars count a bad thing, so a silent run sweeps them
  // and would print PASS without this.
  it('fails a run where the agent asked nothing at all', () => {
    const silent = scoreConversation(
      [{ ...okTurn, body: 'hey, welcome!', attributedTo: [], raisedKeys: [] }],
      VENUE,
    )
    const s = summarize([silent, silent, silent])
    expect(s.valid).toBe(3)
    expect(s.offTargetConversations).toBe(0)
    expect(s.twoQuestionTurns).toBe(0)
    expect(s.strictIdentityConversations).toBe(0)
    expect(s.cleanConversations).toBe(3)
    // Every bar clean, and it still fails.
    expect(s.orderAskedConversations).toBe(0)
    expect(s.floorMet).toBe(false)
    expect(s.pass).toBe(false)
  })

  // The floor is a ratio, so it has to bite at the boundary rather than only at
  // zero. Four conversations require ceil(4 * 0.8) = 4.
  it('fails a run where the order question went missing in one of four', () => {
    const silent = scoreConversation(
      [{ ...okTurn, body: 'hey, welcome!', attributedTo: [], raisedKeys: [] }],
      VENUE,
    )
    const s = summarize([ok(), ok(), ok(), silent])
    expect(s.orderAskedConversations).toBe(3)
    expect(s.orderAskedRequired).toBe(4)
    expect(s.floorMet).toBe(false)
    expect(s.pass).toBe(false)
  })

  it('meets the floor when every conversation asked the order', () => {
    const s = summarize([ok(), ok(), ok(), ok()])
    expect(s.orderAskedConversations).toBe(4)
    expect(s.floorMet).toBe(true)
    expect(s.pass).toBe(true)
  })

  // The floor reads BOTH judges, so an order question that arrived as the bubble
  // rather than in the body still counts.
  it('counts the order question whichever judge saw it', () => {
    const viaBubble = scoreConversation(
      [
        {
          ...okTurn,
          body: 'hey, welcome! what did you get?',
          tail: 'what did you get?',
          attributedTo: [],
          raisedKeys: ['understand_order'],
        },
      ],
      VENUE,
    )
    expect(viaBubble.askedKeys).toEqual(['understand_order'])
    expect(summarize([viaBubble]).floorMet).toBe(true)
  })

  it('counts invalid conversations without letting them fail the bars', () => {
    const dead = scoreConversation(
      [{ ...okTurn, body: "you've reached us", failed: true }],
      VENUE,
    )
    const s = summarize([ok(), dead])
    expect(s.invalid).toBe(1)
    expect(s.strictIdentityConversations).toBe(0)
    expect(s.pass).toBe(true)
  })
})
