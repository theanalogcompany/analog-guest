import { describe, expect, it } from 'vitest'
// Relative imports — vitest doesn't pick up Next's `@/*` alias under our setup.
import type { MessageCategory } from '../../types'
import { ACKNOWLEDGMENT_INSTRUCTIONS } from './acknowledgment'
import { CASUAL_CHATTER_INSTRUCTIONS } from './casual-chatter'
import { COMP_COMPLAINT_INSTRUCTIONS } from './comp-complaint'
import { EVENT_INVITE_INSTRUCTIONS } from './event-invite'
import { EVENT_QUESTION_INSTRUCTIONS } from './event-question'
import { FOLLOW_UP_INSTRUCTIONS } from './follow-up'
import { getCategoryInstructions } from './index'
import { MANUAL_INSTRUCTIONS } from './manual'
import { MECHANIC_REQUEST_INSTRUCTIONS } from './mechanic-request'
import { NEW_QUESTION_INSTRUCTIONS } from './new-question'
import { OPT_OUT_INSTRUCTIONS } from './opt-out'
import { PERK_INQUIRY_INSTRUCTIONS } from './perk-inquiry'
import { PERK_UNLOCK_INSTRUCTIONS } from './perk-unlock'
import { PERSONAL_HISTORY_QUESTION_INSTRUCTIONS } from './personal-history-question'
import { RECOMMENDATION_REQUEST_INSTRUCTIONS } from './recommendation-request'
import { REPLY_INSTRUCTIONS } from './reply'
import { UNKNOWN_INSTRUCTIONS } from './unknown'
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
  ['personal_history_question', PERSONAL_HISTORY_QUESTION_INSTRUCTIONS],
  ['perk_inquiry', PERK_INQUIRY_INSTRUCTIONS],
  ['event_question', EVENT_QUESTION_INSTRUCTIONS],
  ['unknown', UNKNOWN_INSTRUCTIONS],
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

// THE-232: Operator instruction reinforcement. The block is rendered by
// the serializer and lives in two category files: `manual` (the actual
// category for Command Center Follow Up button sends per
// triggerToCategory) and `follow_up` (defensive — if cron paths ever
// inherit operator notes in the future, the directive is already in place).
describe('manual instructions — Operator instruction reinforcement (THE-232)', () => {
  it('points at the Operator instruction block', () => {
    expect(MANUAL_INSTRUCTIONS).toContain(
      'When an "Operator instruction" block is present in the prompt',
    )
  })

  it('treats the instruction as the primary intent', () => {
    expect(MANUAL_INSTRUCTIONS).toContain('treat it as the primary intent')
  })

  it('directs grounding via runtime context', () => {
    expect(MANUAL_INSTRUCTIONS).toContain('Use runtime context')
  })

  it('no longer references the stale "additional context" framing', () => {
    expect(MANUAL_INSTRUCTIONS).not.toContain('The intent is in the additional context')
  })
})

describe('follow-up instructions — Operator instruction reinforcement (THE-232)', () => {
  it('points at the Operator instruction block', () => {
    expect(FOLLOW_UP_INSTRUCTIONS).toContain(
      'When an "Operator instruction" block is present in the prompt',
    )
  })

  it('treats the instruction as the primary intent', () => {
    expect(FOLLOW_UP_INSTRUCTIONS).toContain('treat it as the primary intent')
  })
})

describe('personal-history-question instructions (THE-233)', () => {
  it('points the agent at the ## Visit history block (TAC-234 rename)', () => {
    expect(PERSONAL_HISTORY_QUESTION_INSTRUCTIONS).toContain('"## Visit history" block')
  })

  it('forbids reciting the data back', () => {
    expect(PERSONAL_HISTORY_QUESTION_INSTRUCTIONS).toContain(
      'Do not recite ("I see you got X on Y at Z")',
    )
  })

  it('forbids fabrication of items / drinks / visit details', () => {
    expect(PERSONAL_HISTORY_QUESTION_INSTRUCTIONS).toContain(
      'Do not fabricate items, drinks, or visit details under any circumstance',
    )
  })

  it('provides admit-no-record fallbacks in the venue voice', () => {
    expect(PERSONAL_HISTORY_QUESTION_INSTRUCTIONS).toContain('haven\'t seen you in here yet')
    expect(PERSONAL_HISTORY_QUESTION_INSTRUCTIONS).toContain(
      'no record of you in the system, when were you in?',
    )
    expect(PERSONAL_HISTORY_QUESTION_INSTRUCTIONS).toContain(
      'first time meeting you, what brought you in?',
    )
  })

  it('contains no em or en dashes', () => {
    expect(PERSONAL_HISTORY_QUESTION_INSTRUCTIONS).not.toMatch(/[—–]/)
  })
})

describe('em-dash hygiene across category instructions (R3 self-consistency)', () => {
  it('reply has no em or en dashes', () => {
    expect(REPLY_INSTRUCTIONS).not.toMatch(/[—–]/)
  })

  it('welcome has no em or en dashes', () => {
    expect(WELCOME_INSTRUCTIONS).not.toMatch(/[—–]/)
  })

  it('follow-up has no em or en dashes', () => {
    expect(FOLLOW_UP_INSTRUCTIONS).not.toMatch(/[—–]/)
  })

  it('new-question has no em or en dashes', () => {
    expect(NEW_QUESTION_INSTRUCTIONS).not.toMatch(/[—–]/)
  })

  it('opt-out has no em or en dashes', () => {
    expect(OPT_OUT_INSTRUCTIONS).not.toMatch(/[—–]/)
  })

  it('event-invite has no em or en dashes', () => {
    expect(EVENT_INVITE_INSTRUCTIONS).not.toMatch(/[—–]/)
  })

  it('acknowledgment has no em or en dashes', () => {
    expect(ACKNOWLEDGMENT_INSTRUCTIONS).not.toMatch(/[—–]/)
  })

  it('perk-unlock has no em or en dashes', () => {
    expect(PERK_UNLOCK_INSTRUCTIONS).not.toMatch(/[—–]/)
  })

  it('manual has no em or en dashes', () => {
    expect(MANUAL_INSTRUCTIONS).not.toMatch(/[—–]/)
  })
})

describe('acknowledgment instructions — guest sign-off semantics (v1.10.0)', () => {
  it('frames the guest as wrapping up the thread', () => {
    expect(ACKNOWLEDGMENT_INSTRUCTIONS).toContain(
      'wrapping up the thread or signing off',
    )
  })

  it('directs the agent to mirror with a short close', () => {
    expect(ACKNOWLEDGMENT_INSTRUCTIONS).toContain('Mirror their energy with a short close')
    expect(ACKNOWLEDGMENT_INSTRUCTIONS).toContain('one to three words')
  })

  it('forbids pivoting or starting a new thread', () => {
    expect(ACKNOWLEDGMENT_INSTRUCTIONS).toContain('Do not pivot to a new topic')
    expect(ACKNOWLEDGMENT_INSTRUCTIONS).toContain('do not start a new thread')
  })

  it('no longer references "venue cannot respond" framing', () => {
    expect(ACKNOWLEDGMENT_INSTRUCTIONS).not.toContain('venue cannot respond')
    expect(ACKNOWLEDGMENT_INSTRUCTIONS).not.toContain('owner is busy')
  })
})

describe('unknown instructions — inbound catch-all (v1.10.0)', () => {
  it('frames the case as classifier failure or operator-attention needed', () => {
    expect(UNKNOWN_INSTRUCTIONS).toContain('classifier could not confidently categorize')
  })

  it('directs the agent to send a brief holding response', () => {
    expect(UNKNOWN_INSTRUCTIONS).toContain('brief, warm holding response')
  })

  it('directs the agent to reference what they asked', () => {
    expect(UNKNOWN_INSTRUCTIONS).toContain('Reference what they asked or said')
  })

  it('forbids invention or guessing', () => {
    expect(UNKNOWN_INSTRUCTIONS).toContain('Do not invent or guess')
  })

  it('contains no em or en dashes', () => {
    expect(UNKNOWN_INSTRUCTIONS).not.toMatch(/[—–]/)
  })
})

describe('perk-inquiry instructions (v1.10.0)', () => {
  it('frames as inbound asking about perks (distinct from perk_unlock)', () => {
    expect(PERK_INQUIRY_INSTRUCTIONS).toContain(
      'inbound side of perks, distinct from perk_unlock',
    )
  })

  it('points the agent at the eligibility block', () => {
    expect(PERK_INQUIRY_INSTRUCTIONS).toContain(
      '"What this guest can access" block above',
    )
  })

  it('forbids transactional language', () => {
    expect(PERK_INQUIRY_INSTRUCTIONS).toContain('"earned"')
    expect(PERK_INQUIRY_INSTRUCTIONS).toContain('"redeem"')
  })

  it('lands the principle: recognition not points', () => {
    expect(PERK_INQUIRY_INSTRUCTIONS).toContain('recognition, not points')
  })

  it('contains no em or en dashes', () => {
    expect(PERK_INQUIRY_INSTRUCTIONS).not.toMatch(/[—–]/)
  })
})

describe('event-question instructions (v1.10.0)', () => {
  it('frames as inbound asking about events (distinct from event_invite)', () => {
    expect(EVENT_QUESTION_INSTRUCTIONS).toContain(
      'inbound side of events, distinct from event_invite',
    )
  })

  it('directs the agent to pull from documented events', () => {
    expect(EVENT_QUESTION_INSTRUCTIONS).toContain('documented events')
  })

  it('forbids inventing or pivoting', () => {
    expect(EVENT_QUESTION_INSTRUCTIONS).toContain('rather than inventing one')
    expect(EVENT_QUESTION_INSTRUCTIONS).toContain('Do not pivot')
  })

  it('contains no em or en dashes', () => {
    expect(EVENT_QUESTION_INSTRUCTIONS).not.toMatch(/[—–]/)
  })
})
