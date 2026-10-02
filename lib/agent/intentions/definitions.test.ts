import { describe, expect, it } from 'vitest'
import {
  EVENT_ARMED_WINDOW_DAYS,
  FIRST_CONTACT_WINDOW_DAYS,
  type FirstConversationPolicy,
  INTENTION_DEFINITION_BY_KEY,
  INTENTION_DEFINITIONS,
  INTENTION_KEYS,
  type IntentionKey,
  type IntentionSatisfactionFacts,
  rearmsOnNewerEvent,
  UNDERSTAND_ORDER_WINDOW_DAYS,
} from './definitions'

const MS_PER_DAY = 24 * 60 * 60 * 1000

// Every expectation below is a LITERAL transcribed from the 2026-09-14 rulings
// on TAC-380, never read back out of the definitions. A test that derives its
// expectation from the thing under test can only confirm that thing equals
// itself.
//
// What each guard buys, stated plainly because this repo has a history of tests
// whose rationale was never true:
//   - `satisfies Record<IntentionKey, …>` on the source map catches a MISSING definition
//   - the truth table catches a CHANGED predicate
//   - the required fields catch a MISSING label
//   - nothing catches a label that is simply WRONG about a predicate nobody touched

const RULED_PRIORITY_ORDER: readonly IntentionKey[] = [
  'understand_order',
  // TAC-558, priority 15. Sits between understand_order and
  // got_the_recommendation: first in line among everything it can actually meet,
  // and never able to meet understand_order at all (a transaction satisfies that
  // one). See its priority comment in definitions.ts.
  'are_they_new_here',
  'got_the_recommendation',
  'did_they_like_it',
  'learn_name',
  'are_they_local',
  'their_rhythm',
  'why_theyre_here',
]

const RULED_MIN_REPLIES = {
  are_they_new_here: 3,
  got_the_recommendation: 3,
  did_they_like_it: 3,
  learn_name: 3,
  are_they_local: 5,
  their_rhythm: 8,
  why_theyre_here: 11,
} satisfies Record<Exclude<IntentionKey, 'understand_order'>, number>

// Which facts, EACH ON ITS OWN, close each intention. An empty list means
// prompted-once is the only closure until TAC-385.
//
// A LIST rather than one fact since TAC-558, which closes on either of two
// independent proxies: the record already showing a repeat visit, or the guest's
// own account being on file. A single-fact table could not express that, and
// widening it is better than exempting the key from the truth table below.
const SATISFIED_BY = {
  understand_order: ['hasQualifyingTransaction'],
  are_they_new_here: ['hasRepeatVisitsOnRecord', 'hasVenueHistoryOnFile'],
  got_the_recommendation: [],
  did_they_like_it: [],
  learn_name: ['hasFirstName'],
  are_they_local: ['hasHomeBase'],
  their_rhythm: [],
  why_theyre_here: [],
} satisfies Record<IntentionKey, readonly (keyof IntentionSatisfactionFacts)[]>

const NO_FACTS: IntentionSatisfactionFacts = {
  hasQualifyingTransaction: false,
  hasFirstName: false,
  hasHomeBase: false,
  hasRepeatVisitsOnRecord: false,
  hasVenueHistoryOnFile: false,
}

describe('INTENTION_DEFINITIONS — shape', () => {
  it('keys every map entry by its own key', () => {
    for (const [mapKey, def] of Object.entries(INTENTION_DEFINITION_BY_KEY)) {
      expect(def.key, mapKey).toBe(mapKey)
    }
  })

  it('defines exactly the eight ruled intentions, in the ruled priority order', () => {
    expect(INTENTION_DEFINITIONS.map((d) => d.key)).toEqual(
      RULED_PRIORITY_ORDER,
    )
    expect(INTENTION_KEYS).toEqual(RULED_PRIORITY_ORDER)
  })

  it('has distinct priorities, sorted ascending', () => {
    const priorities = INTENTION_DEFINITIONS.map((d) => d.priority)
    expect(new Set(priorities).size).toBe(priorities.length)
    expect([...priorities].sort((a, b) => a - b)).toEqual(priorities)
  })

  it('retires both TAC-324 keys', () => {
    expect(INTENTION_KEYS as readonly string[]).not.toContain(
      'learn_first_order',
    )
    expect(INTENTION_KEYS as readonly string[]).not.toContain(
      'invite_contact_save',
    )
  })

  it('every definition carries non-empty prose in all three text fields', () => {
    for (const def of INTENTION_DEFINITIONS) {
      expect(
        def.promptLine.trim().length,
        `${def.key} promptLine`,
      ).toBeGreaterThan(0)
      expect(
        def.classifierDescription.trim().length,
        `${def.key} classifierDescription`,
      ).toBeGreaterThan(0)
      expect(
        def.satisfactionLabel.trim().length,
        `${def.key} satisfactionLabel`,
      ).toBeGreaterThan(0)
    }
  })

  it('satisfactionLabel is distinct from the other two text fields', () => {
    for (const def of INTENTION_DEFINITIONS) {
      expect(def.satisfactionLabel, def.key).not.toBe(def.promptLine)
      expect(def.satisfactionLabel, def.key).not.toBe(def.classifierDescription)
    }
  })
})

describe('INTENTION_DEFINITIONS — arming, gates and windows (rulings 2–4)', () => {
  it('arms understand_order on a qr_scan enrollment and leaves it ungated', () => {
    const def = INTENTION_DEFINITION_BY_KEY.understand_order
    expect(def.armsOn).toEqual({ kind: 'visit_confirmed' })
    expect(def.gate).toEqual({ kind: 'none' })
  })

  // TAC-558. Pinned as its OWN kind rather than reusing recorded_order, which is
  // the mistake this guards: that kind takes the NEWEST order and holds it until
  // the conversation ends, which would push this question out of the counter
  // session it exists for.
  it('arms are_they_new_here off the first recorded order, on the replies-only gate', () => {
    const def = INTENTION_DEFINITION_BY_KEY.are_they_new_here
    expect(def.armsOn).toEqual({ kind: 'first_recorded_order' })
    expect(def.armsOn).not.toEqual({ kind: 'recorded_order' })
    expect(def.gate).toEqual({
      kind: 'replies_only',
      defaultMinReplies: 3,
      firstMessageMinReplies: 3,
    })
  })

  it('arms the event-armed pair off their events', () => {
    expect(INTENTION_DEFINITION_BY_KEY.got_the_recommendation.armsOn).toEqual({
      kind: 'open_recommendation',
    })
    expect(INTENTION_DEFINITION_BY_KEY.did_they_like_it.armsOn).toEqual({
      kind: 'recorded_order',
    })
  })

  // TAC-380 acceptance criteria, corrected 2026-09-14: first-contact intentions
  // never re-arm; event-armed ones re-arm on a strictly newer event. A literal
  // table, so changing which intentions re-arm has to change this line by line.
  it('re-arms exactly the two event-armed intentions', () => {
    const RULED_REARMS = {
      understand_order: false,
      are_they_new_here: false,
      got_the_recommendation: true,
      did_they_like_it: true,
      learn_name: false,
      are_they_local: false,
      their_rhythm: false,
      why_theyre_here: false,
    } satisfies Record<IntentionKey, boolean>
    for (const def of INTENTION_DEFINITIONS) {
      expect(rearmsOnNewerEvent(def.armsOn), def.key).toBe(
        RULED_REARMS[def.key],
      )
    }
  })

  // TAC-436 ruling 2 split this in two. The reply counts are unchanged; what
  // changed is WHICH intentions also wait on the response-rate floor. A literal
  // table, not derived from armsOn, so that a definition switched between the
  // two gate kinds fails here rather than passing against a rule that now
  // describes it.
  it('gates each intention on the ruled kind, with the ruled reply counts', () => {
    const RULED_GATE_KIND = {
      are_they_new_here: 'replies_only',
      got_the_recommendation: 'conversational',
      did_they_like_it: 'conversational',
      learn_name: 'replies_only',
      are_they_local: 'replies_only',
      their_rhythm: 'replies_only',
      why_theyre_here: 'replies_only',
    } satisfies Record<Exclude<IntentionKey, 'understand_order'>, string>

    for (const [key, minReplies] of Object.entries(RULED_MIN_REPLIES)) {
      const gate = INTENTION_DEFINITION_BY_KEY[key as IntentionKey].gate
      expect(gate.kind, key).toBe(
        RULED_GATE_KIND[key as keyof typeof RULED_GATE_KIND],
      )
      expect(gate, key).toMatchObject({ defaultMinReplies: minReplies })
    }
  })

  // TAC-436 audit question 1, ruled 2026-09-17: "explicit per intention, not a
  // blanket zero for replies_only". learn_name alone is free in the opening
  // exchange; the other three repeat their ongoing count, which waives nothing.
  //
  // A LITERAL table. Deriving the expectation from the definitions would pass
  // against any value at all, which is the whole failure this pins.
  it('waives the reply count on a first-ever message for learn_name ONLY', () => {
    const RULED_FIRST_MESSAGE = {
      are_they_new_here: 3,
      learn_name: 0,
      are_they_local: 5,
      their_rhythm: 8,
      why_theyre_here: 11,
    } as const

    for (const [key, expected] of Object.entries(RULED_FIRST_MESSAGE)) {
      const gate = INTENTION_DEFINITION_BY_KEY[key as IntentionKey].gate
      expect(gate.kind, key).toBe('replies_only')
      expect(gate, key).toMatchObject({ firstMessageMinReplies: expected })
    }
  })

  // The three non-learn_name waivers must stay INERT: a first-message count
  // below the ongoing one would silently widen the ruling.
  it('never lets a first-message count sit below the ongoing one, except learn_name', () => {
    for (const def of INTENTION_DEFINITIONS) {
      if (def.gate.kind !== 'replies_only') continue
      if (def.key === 'learn_name') continue
      expect(def.gate.firstMessageMinReplies, def.key).toBe(
        def.gate.defaultMinReplies,
      )
    }
  })

  // A LITERAL table since TAC-558, no longer derived from armsOn.kind. That
  // derivation encoded "an order-armed intention gets the event window", which
  // are_they_new_here breaks deliberately: it arms off an order and carries the
  // 14-day first-contact window, because the question is about the guest rather
  // than a perishable event. Derived, this test would have demanded the wrong
  // number and looked like the definition was at fault.
  it('uses the ruled window per intention', () => {
    expect(UNDERSTAND_ORDER_WINDOW_DAYS).toBe(3)
    expect(EVENT_ARMED_WINDOW_DAYS).toBe(3)
    expect(FIRST_CONTACT_WINDOW_DAYS).toBe(14)

    const RULED_WINDOW_DAYS = {
      understand_order: UNDERSTAND_ORDER_WINDOW_DAYS,
      are_they_new_here: FIRST_CONTACT_WINDOW_DAYS,
      got_the_recommendation: EVENT_ARMED_WINDOW_DAYS,
      did_they_like_it: EVENT_ARMED_WINDOW_DAYS,
      learn_name: FIRST_CONTACT_WINDOW_DAYS,
      are_they_local: FIRST_CONTACT_WINDOW_DAYS,
      their_rhythm: FIRST_CONTACT_WINDOW_DAYS,
      why_theyre_here: FIRST_CONTACT_WINDOW_DAYS,
    } satisfies Record<IntentionKey, number>

    for (const def of INTENTION_DEFINITIONS) {
      expect(def.expiresAfterMs, def.key).toBe(
        RULED_WINDOW_DAYS[def.key] * MS_PER_DAY,
      )
    }
  })
})

describe('INTENTION_DEFINITIONS — rule interactions', () => {
  // Ruling 2. R23 bans stating a visit frequency, and the real trip is the turn
  // AFTER the question, when the model uses the answer ("since you're in most
  // mornings"). Time of day avoids it structurally; frequency cannot.
  it('scopes their_rhythm to time of day, never frequency (R23)', () => {
    const def = INTENTION_DEFINITION_BY_KEY.their_rhythm
    const frequency = /how often|how many|times a|frequen|usual(ly)? come in/i
    expect(def.promptLine).not.toMatch(frequency)
    expect(def.promptLine).toMatch(/time of day/i)
  })

  // Ruling 5's classifier fix: drink or food quality belongs to
  // did_they_like_it. Left on understand_order, a "how was your drink?" send
  // would close the wrong intention.
  it("keeps drink/food quality out of understand_order's classifier description", () => {
    expect(
      INTENTION_DEFINITION_BY_KEY.understand_order.classifierDescription,
    ).not.toMatch(/drink\/food|how (their|the) (drink|food) was/i)
    expect(
      INTENTION_DEFINITION_BY_KEY.did_they_like_it.classifierDescription,
    ).toMatch(/drink or food/i)
  })

  // Approved drafts, transcribed verbatim from the 2026-09-14 ruling, and for
  // learn_name from TAC-541's of 2026-09-26.
  it('renders the approved promptLine drafts verbatim', () => {
    expect(
      Object.fromEntries(
        INTENTION_DEFINITIONS.map((d) => [d.key, d.promptLine]),
      ),
    ).toEqual({
      understand_order: "You haven't heard what this guest ordered yet.",
      are_they_new_here:
        "You don't know whether this guest is on their first visit or has been coming here for a while.",
      got_the_recommendation:
        "You suggested something to this guest and haven't heard whether they tried it.",
      did_they_like_it:
        'You know what this guest ordered, but not whether they liked it.',
      learn_name:
        'You don\'t know this guest\'s name yet. Asked at all, it goes on the end as a light aside, always with something softening it in front, the way "by the way, what\'s your name?" reads. A bare "what\'s your name?" tacked onto a reply about something else is the one shape to avoid: without the softener in front of it, it reads as a demand rather than an aside.',
      are_they_local:
        "You don't know whether this guest lives or works nearby.",
      their_rhythm:
        "You don't know what time of day this guest tends to come by.",
      why_theyre_here: "You don't know what brings this guest in.",
    })
  })

  // TAC-541 ruling 3. The generic restraint paragraph says "one short question
  // on the end is fine" for every intention alike, and on a name that produced
  // a bare "what's your name?" bolted onto an unrelated reply; the guest's own
  // "why?" is the evidence. The shape is pinned as ONE CONTIGUOUS LITERAL, not
  // fragments: per TAC-409 a sentence can be reversed while every asserted
  // fragment survives.
  it("carries the name ask's approved shape, contiguously", () => {
    expect(INTENTION_DEFINITION_BY_KEY.learn_name.promptLine).toContain(
      'Asked at all, it goes on the end as a light aside, always with something softening it in front, the way "by the way, what\'s your name?" reads.',
    )
  })

  // THE TIGHTENING, measured rather than guessed. The shaping above took the
  // bare-ask rate from 19/20 (the pre-TAC-541 line, control arm) to 6/18, and
  // all six survivors were ONE shape: an unrelated reply with a bare "what's
  // your name?" bolted on the end. Ruled 2026-09-26 to name that shape
  // explicitly rather than leave "never a bare question standing on its own",
  // which the model can read as "never as its own message".
  it('rules out the bare-question-bolted-on shape by name', () => {
    expect(INTENTION_DEFINITION_BY_KEY.learn_name.promptLine).toContain(
      'A bare "what\'s your name?" tacked onto a reply about something else is the one shape to avoid: without the softener in front of it, it reads as a demand rather than an aside.',
    )
  })

  // THE LOAD-BEARING HALF, and the reason "Asked at all" is worded that way.
  // promptLine's contract is a STATE the agent is in, never an instruction to
  // execute, and whether to ask at all stays the restraint paragraph's call.
  // A mutant rewriting this to "Ask their name, as a light aside" keeps the
  // shape and breaks the contract, so the shape assertion above cannot catch
  // it on its own.
  it('states the name ask as a conditional shape, never as an instruction to ask', () => {
    const line = INTENTION_DEFINITION_BY_KEY.learn_name.promptLine
    expect(line).toMatch(/^You don't know this guest's name yet\./)
    expect(line).toContain('Asked at all,')
    expect(line).not.toMatch(
      /^Ask\b|\. Ask (their|the guest's|for their) name/i,
    )
  })

  // TAC-558, ruled verbatim 2026-09-29. THE ORIGINAL WORDING, ruled back after a
  // second one measured worse. Pinned as one contiguous literal above; these
  // guard the properties a reworded line could lose while still reading
  // plausibly.
  //
  // BOTH SIDES, and this is the one that carries the on-target rate. A second
  // wording that named NEITHER side ("This guest's history with the café before
  // today is unknown to you.") halved it: 10/20 for this line against 4/20 and
  // 6/20, because a line that does not say what to ask produced questions about
  // where the guest lives and what their name is, each of which closes this
  // intention prompted-once having learned nothing.
  //
  // Asserted as two contiguous clauses rather than loose substrings, because per
  // TAC-409 a sentence can be reversed while every asserted fragment survives.
  it('names both sides of the new-or-regular question', () => {
    const line = INTENTION_DEFINITION_BY_KEY.are_they_new_here.promptLine
    expect(line).toContain('is on their first visit')
    expect(line).toContain('has been coming here for a while')
  })

  // A STATE, never an instruction - promptLine's whole contract. A mutant
  // rewriting this to "Ask whether this is their first visit" keeps both sides
  // and breaks the contract, so the assertion above cannot catch it alone.
  it('states the new-or-regular goal as a state, never as an instruction to ask', () => {
    const line = INTENTION_DEFINITION_BY_KEY.are_they_new_here.promptLine
    expect(line).toMatch(/^You don't know whether/)
    expect(line).not.toMatch(/^Ask\b|\bAsk (whether|if|them|the guest)\b/i)
  })

  // NEWNESS, NEVER DURATION (ruling, 2026-09-29). A line about how LONG a guest
  // has been coming invites "a couple of years, few times a month", and the model
  // states it back on the next turn - the R23 trip their_rhythm was scoped to
  // time of day to avoid. "history before today" asks nothing about frequency.
  it('keeps frequency and duration out of the line', () => {
    const line =
      INTENTION_DEFINITION_BY_KEY.are_they_new_here.promptLine.toLowerCase()
    expect(line).not.toContain('how long')
    expect(line).not.toContain('how often')
    expect(line).not.toMatch(/\bevery week\b|\bhow many\b|\btimes a\b/)
  })

  // Every OTHER line stays a bare state. TAC-541 shaped one intention, and the
  // next reader should have to decide rather than copy: a second line growing
  // a worked example is a change, not a tidy.
  it('leaves every other promptLine a bare state with no worked example', () => {
    for (const def of INTENTION_DEFINITIONS) {
      if (def.key === 'learn_name') continue
      expect(def.promptLine, def.key).not.toContain('"')
      expect(def.promptLine, def.key).not.toMatch(/Asked at all/i)
    }
  })
})

// TAC-567, ruled by Jaipal 2026-09-30 and amended the same day by TAC-568: what
// a guest's FIRST conversation may ask, and when.
//
// THE EXPECTATION IS A LITERAL TRANSCRIBED FROM THE RULING, never read back out
// of the definitions, for the reason stated at the top of this file. Written as
// an exhaustive record keyed by IntentionKey rather than as arrays, so adding an
// intention fails `tsc` here until someone decides which side it is on - the
// same totality argument as the source map's own `satisfies`.
const ON_FIRST_CONVERSATION = {
  // The reason the guest scanned at all.
  understand_order: 'allowed',
  // The one thing it is natural to ask for on a first hello, and since TAC-568
  // the moment the first conversation closes on.
  learn_name: 'allowed',
  // TAC-568's amendment. NOT 'suppressed': removing it from the first
  // conversation entirely would mean never asking it at all, because it closes
  // on hasRepeatVisitsOnRecord and the second visit already satisfies it.
  are_they_new_here: 'after_warm_close',
  got_the_recommendation: 'suppressed',
  did_they_like_it: 'suppressed',
  are_they_local: 'suppressed',
  their_rhythm: 'suppressed',
  why_theyre_here: 'suppressed',
} satisfies Record<IntentionKey, FirstConversationPolicy>

describe('onFirstConversation (TAC-567, amended by TAC-568)', () => {
  it.each(INTENTION_KEYS)('%s matches the ruling', (key) => {
    expect(INTENTION_DEFINITION_BY_KEY[key].onFirstConversation).toBe(
      ON_FIRST_CONVERSATION[key],
    )
  })

  // The counts are asserted separately from the per-key table on purpose. The
  // table catches a flipped policy; this catches one flipped on one intention
  // and compensated on another, which the table would report as two failures and
  // a careless fix could turn into one.
  it('allows exactly two outright, defers one, and suppresses five', () => {
    const by = (p: FirstConversationPolicy) =>
      INTENTION_DEFINITIONS.filter((d) => d.onFirstConversation === p).map(
        (d) => d.key,
      )
    expect(by('allowed')).toEqual(['understand_order', 'learn_name'])
    expect(by('after_warm_close')).toEqual(['are_they_new_here'])
    expect(by('suppressed')).toHaveLength(5)
    // Totality, stated rather than assumed: every intention carries one of the
    // three, so the three counts have to add back to the whole set.
    expect(
      by('allowed').length +
        by('after_warm_close').length +
        by('suppressed').length,
    ).toBe(INTENTION_DEFINITIONS.length)
  })

  // TAC-568's amendment, asserted on its own because this one policy is what the
  // ruled first-visit flow turns on, and because it was 'suppressed' for about
  // half an hour. Either wrong value is a real regression with a real symptom:
  // 'allowed' brings back the visit that stalls on "nice to meet you",
  // 'suppressed' means the question is never asked at all.
  it('defers are_they_new_here to after the warm close, rather than dropping it', () => {
    const def = INTENTION_DEFINITION_BY_KEY.are_they_new_here
    expect(def.onFirstConversation).toBe('after_warm_close')
    // Still fully defined, still armed the same way, still expiring the same
    // way: deferral is about WHEN inside one conversation, not about retiring it.
    expect(def.armsOn.kind).toBe('first_recorded_order')
    expect(def.promptLine.length).toBeGreaterThan(0)
    expect(def.expiresAfterMs).toBeGreaterThan(0)
  })

  // THE REASON THE AMENDMENT EXISTS, pinned as a property rather than left in a
  // comment. are_they_new_here closes on hasRepeatVisitsOnRecord, so a guest on
  // their second visit already satisfies it. That is what makes "not on a first
  // conversation" and "never" the same sentence for this intention - and it is
  // a fact about its own isSatisfied, so it is checked there.
  it('is satisfied by a repeat visit, which is why deferring beats suppressing', () => {
    const def = INTENTION_DEFINITION_BY_KEY.are_they_new_here
    expect(
      def.isSatisfied({ ...NO_FACTS, hasRepeatVisitsOnRecord: true }),
    ).toBe(true)
  })

  // WHAT THIS RULES OUT, and it is the reason the policy lives on the definition
  // rather than being inferred. The two unconditionally-allowed intentions share
  // no arming kind, and one of those kinds also appears among the suppressed, so
  // there is no structural property this could be read off. A future reader
  // looking for one should find this test instead.
  it('is not inferable from armsOn or from the gate', () => {
    const allowedArmings = new Set(
      INTENTION_DEFINITIONS.filter(
        (d) => d.onFirstConversation === 'allowed',
      ).map((d) => d.armsOn.kind),
    )
    const suppressedArmings = new Set(
      INTENTION_DEFINITIONS.filter(
        (d) => d.onFirstConversation === 'suppressed',
      ).map((d) => d.armsOn.kind),
    )
    const shared = [...allowedArmings].filter((k) => suppressedArmings.has(k))
    expect(shared.length).toBeGreaterThan(0)
  })
})

describe('isSatisfied truth table', () => {
  it('closes nothing when no fact is present', () => {
    for (const def of INTENTION_DEFINITIONS) {
      expect(def.isSatisfied(NO_FACTS), def.key).toBe(false)
    }
  })

  it.each(RULED_PRIORITY_ORDER)(
    '%s is closed only by its own recorded fact',
    (key) => {
      const def = INTENTION_DEFINITION_BY_KEY[key]
      for (const fact of Object.keys(
        NO_FACTS,
      ) as (keyof IntentionSatisfactionFacts)[]) {
        expect(
          def.isSatisfied({ ...NO_FACTS, [fact]: true }),
          `${key} with ${fact}`,
        ).toBe((SATISFIED_BY[key] as readonly string[]).includes(fact))
      }
    },
  )
})
