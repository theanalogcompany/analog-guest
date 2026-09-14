import { describe, expect, it } from 'vitest'
import {
  EVENT_ARMED_WINDOW_DAYS,
  FIRST_CONTACT_WINDOW_DAYS,
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
  'got_the_recommendation',
  'did_they_like_it',
  'learn_name',
  'are_they_local',
  'their_rhythm',
  'why_theyre_here',
]

const RULED_MIN_REPLIES = {
  got_the_recommendation: 3,
  did_they_like_it: 3,
  learn_name: 3,
  are_they_local: 5,
  their_rhythm: 8,
  why_theyre_here: 11,
} satisfies Record<Exclude<IntentionKey, 'understand_order'>, number>

// Which single fact, on its own, closes each intention. null = prompted-once
// is the only closure until TAC-385.
const SATISFIED_BY = {
  understand_order: 'hasQualifyingTransaction',
  got_the_recommendation: null,
  did_they_like_it: null,
  learn_name: 'hasFirstName',
  are_they_local: 'hasHomeBase',
  their_rhythm: null,
  why_theyre_here: null,
} satisfies Record<IntentionKey, keyof IntentionSatisfactionFacts | null>

const NO_FACTS: IntentionSatisfactionFacts = {
  hasQualifyingTransaction: false,
  hasFirstName: false,
  hasHomeBase: false,
}

describe('INTENTION_DEFINITIONS — shape', () => {
  it('keys every map entry by its own key', () => {
    for (const [mapKey, def] of Object.entries(INTENTION_DEFINITION_BY_KEY)) {
      expect(def.key, mapKey).toBe(mapKey)
    }
  })

  it('defines exactly the seven ruled intentions, in the ruled priority order', () => {
    expect(INTENTION_DEFINITIONS.map((d) => d.key)).toEqual(RULED_PRIORITY_ORDER)
    expect(INTENTION_KEYS).toEqual(RULED_PRIORITY_ORDER)
  })

  it('has distinct priorities, sorted ascending', () => {
    const priorities = INTENTION_DEFINITIONS.map((d) => d.priority)
    expect(new Set(priorities).size).toBe(priorities.length)
    expect([...priorities].sort((a, b) => a - b)).toEqual(priorities)
  })

  it('retires both TAC-324 keys', () => {
    expect(INTENTION_KEYS as readonly string[]).not.toContain('learn_first_order')
    expect(INTENTION_KEYS as readonly string[]).not.toContain('invite_contact_save')
  })

  it('every definition carries non-empty prose in all three text fields', () => {
    for (const def of INTENTION_DEFINITIONS) {
      expect(def.promptLine.trim().length, `${def.key} promptLine`).toBeGreaterThan(0)
      expect(def.classifierDescription.trim().length, `${def.key} classifierDescription`).toBeGreaterThan(0)
      expect(def.satisfactionLabel.trim().length, `${def.key} satisfactionLabel`).toBeGreaterThan(0)
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
    expect(def.armsOn).toEqual({ kind: 'qr_scan_enrollment' })
    expect(def.gate).toEqual({ kind: 'none' })
  })

  it('arms the event-armed pair off their events', () => {
    expect(INTENTION_DEFINITION_BY_KEY.got_the_recommendation.armsOn).toEqual({ kind: 'open_recommendation' })
    expect(INTENTION_DEFINITION_BY_KEY.did_they_like_it.armsOn).toEqual({ kind: 'recorded_order' })
  })

  // TAC-380 acceptance criteria, corrected 2026-09-14: first-contact intentions
  // never re-arm; event-armed ones re-arm on a strictly newer event. A literal
  // table, so changing which intentions re-arm has to change this line by line.
  it('re-arms exactly the two event-armed intentions', () => {
    const RULED_REARMS = {
      understand_order: false,
      got_the_recommendation: true,
      did_they_like_it: true,
      learn_name: false,
      are_they_local: false,
      their_rhythm: false,
      why_theyre_here: false,
    } satisfies Record<IntentionKey, boolean>
    for (const def of INTENTION_DEFINITIONS) {
      expect(rearmsOnNewerEvent(def.armsOn), def.key).toBe(RULED_REARMS[def.key])
    }
  })

  it('gates every other intention on the conversational signal with the ruled reply counts', () => {
    for (const [key, minReplies] of Object.entries(RULED_MIN_REPLIES)) {
      expect(INTENTION_DEFINITION_BY_KEY[key as IntentionKey].gate, key).toEqual({
        kind: 'conversational',
        defaultMinReplies: minReplies,
      })
    }
  })

  it('uses the ruled windows: 3 days for scan- and event-armed, 14 for first contact', () => {
    expect(UNDERSTAND_ORDER_WINDOW_DAYS).toBe(3)
    expect(EVENT_ARMED_WINDOW_DAYS).toBe(3)
    expect(FIRST_CONTACT_WINDOW_DAYS).toBe(14)
    for (const def of INTENTION_DEFINITIONS) {
      const expectedDays =
        def.armsOn.kind === 'first_contact'
          ? FIRST_CONTACT_WINDOW_DAYS
          : def.armsOn.kind === 'qr_scan_enrollment'
            ? UNDERSTAND_ORDER_WINDOW_DAYS
            : EVENT_ARMED_WINDOW_DAYS
      expect(def.expiresAfterMs, def.key).toBe(expectedDays * MS_PER_DAY)
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
    expect(INTENTION_DEFINITION_BY_KEY.understand_order.classifierDescription).not.toMatch(
      /drink\/food|how (their|the) (drink|food) was/i,
    )
    expect(INTENTION_DEFINITION_BY_KEY.did_they_like_it.classifierDescription).toMatch(/drink or food/i)
  })

  // Approved drafts, transcribed verbatim from the 2026-09-14 ruling.
  it('renders the approved promptLine drafts verbatim', () => {
    expect(Object.fromEntries(INTENTION_DEFINITIONS.map((d) => [d.key, d.promptLine]))).toEqual({
      understand_order: "You haven't heard what this guest ordered yet.",
      got_the_recommendation: "You suggested something to this guest and haven't heard whether they tried it.",
      did_they_like_it: 'You know what this guest ordered, but not whether they liked it.',
      learn_name: "You don't know this guest's name yet.",
      are_they_local: "You don't know whether this guest lives or works nearby.",
      their_rhythm: "You don't know what time of day this guest tends to come by.",
      why_theyre_here: "You don't know what brings this guest in.",
    })
  })
})

describe('isSatisfied truth table', () => {
  it('closes nothing when no fact is present', () => {
    for (const def of INTENTION_DEFINITIONS) {
      expect(def.isSatisfied(NO_FACTS), def.key).toBe(false)
    }
  })

  it.each(RULED_PRIORITY_ORDER)('%s is closed only by its own recorded fact', (key) => {
    const def = INTENTION_DEFINITION_BY_KEY[key]
    for (const fact of Object.keys(NO_FACTS) as (keyof IntentionSatisfactionFacts)[]) {
      expect(def.isSatisfied({ ...NO_FACTS, [fact]: true }), `${key} with ${fact}`).toBe(
        SATISFIED_BY[key] === fact,
      )
    }
  })
})
