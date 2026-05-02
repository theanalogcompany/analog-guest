import { describe, expect, it } from 'vitest'
// Relative imports — vitest doesn't pick up Next's `@/*` alias under our setup.
import type { MessageCategory } from '../../types'
import { ACKNOWLEDGMENT_INSTRUCTIONS } from './acknowledgment'
import { CASUAL_CHATTER_INSTRUCTIONS } from './casual-chatter'
import { COMP_COMPLAINT_INSTRUCTIONS } from './comp-complaint'
import { EVENT_INVITE_INSTRUCTIONS } from './event-invite'
import { FOLLOW_UP_INSTRUCTIONS } from './follow-up'
import { getCategoryInstructions } from './index'
import { MANUAL_INSTRUCTIONS } from './manual'
import { MECHANIC_REQUEST_INSTRUCTIONS } from './mechanic-request'
import { NEW_QUESTION_INSTRUCTIONS } from './new-question'
import { OPT_OUT_INSTRUCTIONS } from './opt-out'
import { PERK_UNLOCK_INSTRUCTIONS } from './perk-unlock'
import { RECOMMENDATION_REQUEST_INSTRUCTIONS } from './recommendation-request'
import { REPLY_INSTRUCTIONS } from './reply'
import { WELCOME_INSTRUCTIONS } from './welcome'

// THE-228 added 4 new categories. Below the round-trip table makes the
// pairing explicit and asserts each new constant exports + reaches the
// switch. If any case is dropped (or a new MessageCategory member lands
// without a switch case), tsc fails first — these tests are belt-and-
// suspenders for the runtime contract.

const ROUND_TRIP_TABLE: Array<[MessageCategory, string]> = [
  ['welcome', WELCOME_INSTRUCTIONS],
  ['follow_up', FOLLOW_UP_INSTRUCTIONS],
  ['reply', REPLY_INSTRUCTIONS],
  ['new_question', NEW_QUESTION_INSTRUCTIONS],
  ['opt_out', OPT_OUT_INSTRUCTIONS],
  ['perk_unlock', PERK_UNLOCK_INSTRUCTIONS],
  ['event_invite', EVENT_INVITE_INSTRUCTIONS],
  ['manual', MANUAL_INSTRUCTIONS],
  ['acknowledgment', ACKNOWLEDGMENT_INSTRUCTIONS],
  ['comp_complaint', COMP_COMPLAINT_INSTRUCTIONS],
  ['mechanic_request', MECHANIC_REQUEST_INSTRUCTIONS],
  ['recommendation_request', RECOMMENDATION_REQUEST_INSTRUCTIONS],
  ['casual_chatter', CASUAL_CHATTER_INSTRUCTIONS],
]

describe('getCategoryInstructions — round-trip', () => {
  for (const [cat, expected] of ROUND_TRIP_TABLE) {
    it(`returns the right constant for ${cat}`, () => {
      expect(getCategoryInstructions(cat)).toBe(expected)
    })
  }

  it('every constant is non-empty', () => {
    for (const [cat, text] of ROUND_TRIP_TABLE) {
      expect(text.length, `${cat} instructions must be non-empty`).toBeGreaterThan(0)
    }
  })
})

describe('comp-complaint instructions (THE-228)', () => {
  it('directs the agent to acknowledge what was said', () => {
    expect(COMP_COMPLAINT_INSTRUCTIONS).toContain('Acknowledge what they said directly')
  })

  it('forbids over-promising a remedy without supporting context', () => {
    expect(COMP_COMPLAINT_INSTRUCTIONS).toContain('Do not promise a specific remedy')
    expect(COMP_COMPLAINT_INSTRUCTIONS).toContain('offering one you can\'t deliver is worse')
  })

  it('forbids performative sympathy', () => {
    expect(COMP_COMPLAINT_INSTRUCTIONS).toContain('Do not perform sympathy')
  })

  it('contains no em or en dashes (THE-225 prose hygiene)', () => {
    expect(COMP_COMPLAINT_INSTRUCTIONS).not.toMatch(/[—–]/)
  })
})

describe('mechanic-request instructions (THE-228)', () => {
  it('points the agent at the eligibility block', () => {
    expect(MECHANIC_REQUEST_INSTRUCTIONS).toContain(
      '"What this guest can access" block above',
    )
  })

  it('grants the agent authority for eligible mechanics', () => {
    expect(MECHANIC_REQUEST_INSTRUCTIONS).toContain('you have authority for what\'s listed')
  })

  it('forbids naming or revealing gating for ineligible mechanics', () => {
    expect(MECHANIC_REQUEST_INSTRUCTIONS).toContain('without naming the mechanic')
    expect(MECHANIC_REQUEST_INSTRUCTIONS).toContain('without revealing the gating rule')
  })

  it('forbids inventing perks that don\'t exist', () => {
    expect(MECHANIC_REQUEST_INSTRUCTIONS).toContain(
      'without inventing a perk that doesn\'t exist',
    )
  })

  it('contains no em or en dashes', () => {
    expect(MECHANIC_REQUEST_INSTRUCTIONS).not.toMatch(/[—–]/)
  })
})

describe('recommendation-request instructions (THE-228)', () => {
  it('anchors on what the venue is proud of', () => {
    expect(RECOMMENDATION_REQUEST_INSTRUCTIONS).toContain(
      'Anchor on what the venue is genuinely proud of',
    )
  })

  it('limits picks to one or two with optional context', () => {
    expect(RECOMMENDATION_REQUEST_INSTRUCTIONS).toContain('one or two specific picks')
  })

  it('forbids cataloging the menu', () => {
    expect(RECOMMENDATION_REQUEST_INSTRUCTIONS).toContain('Do not list every menu item')
    expect(RECOMMENDATION_REQUEST_INSTRUCTIONS).toContain('not a catalog')
  })

  it('contains no em or en dashes', () => {
    expect(RECOMMENDATION_REQUEST_INSTRUCTIONS).not.toMatch(/[—–]/)
  })
})

describe('casual-chatter instructions (THE-228)', () => {
  it('directs the agent to match energy and length', () => {
    expect(CASUAL_CHATTER_INSTRUCTIONS).toContain('Match their energy and length')
  })

  it('forbids pivoting to perks/events/service offers', () => {
    expect(CASUAL_CHATTER_INSTRUCTIONS).toContain(
      'don\'t pivot to perks, events, or a service offer',
    )
  })

  it('forbids reading service intent into chatter', () => {
    expect(CASUAL_CHATTER_INSTRUCTIONS).toContain(
      'Don\'t try to read a service intent into a friendly remark',
    )
  })

  it('contains no em or en dashes', () => {
    expect(CASUAL_CHATTER_INSTRUCTIONS).not.toMatch(/[—–]/)
  })
})
