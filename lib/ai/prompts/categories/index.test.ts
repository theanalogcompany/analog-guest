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

describe('comp-complaint instructions (v1.24.0 register)', () => {
  // This file has now caused two production failures in OPPOSITE directions,
  // and the assertions below are written so a revert toward either one fails.
  //
  //   v1.3.0-v1.22.0  "unless ... eligible mechanics support it" read as
  //                   permission -> unauthorized comp auto-sent 2026-08-07.
  //   v1.23.0         prohibition-first + a stopping license -> "Sour
  //                   matcha's usually a sign something was off with the
  //                   prep. Noted." forty minutes later.
  //
  // v1.24.0 removes the prohibitions entirely and lets the approval gate be
  // the brake. Deleting an assertion here should require deleting the reason.

  it('opens on understanding, not on a rule', () => {
    expect(COMP_COMPLAINT_INSTRUCTIONS).toContain('First, understand what actually happened')
  })

  it('authorizes exactly one genuine apology', () => {
    // "once, and mean it" carries the entire anti-stacking intent of the
    // deleted "Do not perform sympathy or pile on apologies" rule. It is
    // deliberately NOT restated as a separate prohibition — that is how this
    // file drifts back into a list of things not to do.
    expect(COMP_COMPLAINT_INSTRUCTIONS).toContain('say sorry for it, once, and mean it')
  })

  it('makes the comp the default remedy, framed as an invitation', () => {
    expect(COMP_COMPLAINT_INSTRUCTIONS).toContain('come back and have another one on us')
    expect(COMP_COMPLAINT_INSTRUCTIONS).toContain('invitation rather than a payout')
  })

  it('names the goal as winning the guest back', () => {
    expect(COMP_COMPLAINT_INSTRUCTIONS).toContain('trying to win back')
    expect(COMP_COMPLAINT_INSTRUCTIONS).toContain('a bad visit put right well')
  })

  it('forbids the diagnostic register that produced the cold turn', () => {
    // "Sour matcha's usually a sign something was off with the prep" was
    // exactly this: explaining the prep instead of addressing the person.
    expect(COMP_COMPLAINT_INSTRUCTIONS).toContain('not explaining what went wrong in the prep')
  })

  it('mirrors the gate: a question alone is a complete turn', () => {
    // The shape understand -> apologize -> make it up maps onto
    // complaintIntent clarifying -> resolving, which is what decides
    // auto-send vs queue. Prompt and routing must tell the same story.
    expect(COMP_COMPLAINT_INSTRUCTIONS).toContain('ask one real question and send only that')
  })

  it('defers to the eligibility block rather than hardcoding what is offerable', () => {
    // That block is conditioned on willBeReviewed, so this pointer is what
    // keeps the instruction correct on BOTH the reviewed and unreviewed paths.
    expect(COMP_COMPLAINT_INSTRUCTIONS).toContain('"What this guest can access" block')
  })

  it('carries none of the deleted prohibitions', () => {
    // Regression guard in the cold direction. Each of these strings produced
    // or reinforced the 2026-08-07 03:40 "Noted." reply.
    expect(COMP_COMPLAINT_INSTRUCTIONS).not.toContain('Do not perform sympathy')
    expect(COMP_COMPLAINT_INSTRUCTIONS).not.toContain('No remedy of any kind is yours to offer')
    expect(COMP_COMPLAINT_INSTRUCTIONS).not.toContain('IS a complete response')
  })

  it('still names the specific thing raised (length directive removed, TAC-314)', () => {
    expect(COMP_COMPLAINT_INSTRUCTIONS).toContain('Name the specific thing they raised')
    expect(COMP_COMPLAINT_INSTRUCTIONS).not.toContain('Keep it short')
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

  it('directs specific picks without prescribing a count (TAC-314)', () => {
    // The pick COUNT is venue policy (Sextant's AP[28] caps at two and
    // rotates delivery shapes); a count here overrode it into a template.
    expect(RECOMMENDATION_REQUEST_INSTRUCTIONS).toContain('Name specific picks')
    expect(RECOMMENDATION_REQUEST_INSTRUCTIONS).not.toMatch(/one or two/i)
  })

  it('forbids cataloging the menu', () => {
    expect(RECOMMENDATION_REQUEST_INSTRUCTIONS).toContain('not a catalog')
  })

  it('contains no em or en dashes', () => {
    expect(RECOMMENDATION_REQUEST_INSTRUCTIONS).not.toMatch(/[—–]/)
  })
})

describe('casual-chatter instructions (THE-228)', () => {
  it('carries no mirroring directive (universal R19 owns it, TAC-314)', () => {
    expect(CASUAL_CHATTER_INSTRUCTIONS).not.toContain('Match their energy')
    expect(CASUAL_CHATTER_INSTRUCTIONS).toContain('Stay in voice')
  })

  // TAC-327: these two lines were PURSUIT-DUPLICATE — an absolute ban on
  // pivoting to perks/events/a service offer, restating (more strictly than)
  // what the first-touch intentions block already states conditionally.
  // Named in the direction that matters, per this file's own established
  // pattern (see NEW_QUESTION_INSTRUCTIONS below): the ban must be ABSENT
  // from the category layer, not present. Restraint on raising perks/events
  // now lives exclusively in lib/agent/intentions/, correctly conditional.
  it('no longer forbids pivoting to perks/events/service offers (TAC-327: PURSUIT belongs to intentions)', () => {
    expect(CASUAL_CHATTER_INSTRUCTIONS).not.toContain(
      'don\'t pivot to perks, events, or a service offer',
    )
  })

  it('no longer forbids reading service intent into chatter (TAC-327: PURSUIT belongs to intentions)', () => {
    expect(CASUAL_CHATTER_INSTRUCTIONS).not.toContain(
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

  it('frames the turn as a close, without word-count prescriptions (TAC-314)', () => {
    expect(ACKNOWLEDGMENT_INSTRUCTIONS).toContain('This is a close, not an opening')
    expect(ACKNOWLEDGMENT_INSTRUCTIONS).not.toContain('one to three words')
  })

  it('forbids pivoting to an invented topic, unqualified', () => {
    // Unqualified deliberately (TAC-330 case 2 fix): an early draft read "do
    // not pivot... on your own initiative", which picked the wrong axis —
    // raising a held goal is exactly as much "her own initiative" as
    // inventing a topic from nothing. The ban stays plain; the carve-out
    // lives entirely in the jurisdictional sentence that follows, not in a
    // qualifier on the ban itself.
    expect(ACKNOWLEDGMENT_INSTRUCTIONS).toContain('Do not pivot to a new topic')
    expect(ACKNOWLEDGMENT_INSTRUCTIONS).not.toContain('on your own initiative')
    // Canary against a revert to the pre-TAC-330 absolute phrasing, which had
    // no carve-out at all and silently vetoed goal state.
    expect(ACKNOWLEDGMENT_INSTRUCTIONS).not.toContain('do not start a new thread')
  })

  it('carries the goal-state jurisdictional carve-out (TAC-330 case 2)', () => {
    // Scoped to "a goal you're already carrying," not "whatever the rest of
    // this prompt tells you" — the broad version would have quietly
    // re-authorized venue_info, the exact content that beat the intention in
    // case 2. Asserted verbatim: this sentence is load-bearing the same way
    // the intentions block's own non-steering paragraph is.
    expect(ACKNOWLEDGMENT_INSTRUCTIONS).toContain(
      "This is register guidance, how a close should sound, not authority over whether you act on a goal you're already carrying: that call belongs elsewhere, and this line has no say in it.",
    )
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

  it('directs the agent to send a warm holding response (no length directive, TAC-314)', () => {
    expect(UNKNOWN_INSTRUCTIONS).toContain('warm holding response')
    expect(UNKNOWN_INSTRUCTIONS).not.toContain('brief')
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

  it('forbids the sales pivot; invention is R8 territory now (TAC-314)', () => {
    // The category-local "say so plainly rather than inventing one" was
    // disclosure policy — R8 + # Knowledge gaps own that on every category.
    // The no-sales-pressure pivot is topic/behavior and stays.
    expect(EVENT_QUESTION_INSTRUCTIONS).not.toContain('rather than inventing one')
    expect(EVENT_QUESTION_INSTRUCTIONS).toContain('Do not pivot to suggesting they come anyway')
  })

  it('contains no em or en dashes', () => {
    expect(EVENT_QUESTION_INSTRUCTIONS).not.toMatch(/[—–]/)
  })
})

// TAC-313 UAT fix #2. The leak was not a missing price rule — Mock Sextant has
// "Don't volunteer prices" as an anti-pattern and it emitted $7.95 anyway. The
// instruction below asks for a copy of a section where 69/69 menu items carry a
// price, and category instructions render LAST in the system prompt, so this
// outranked the venue's ban. The fix scopes what comes out of the pull.
describe('NEW_QUESTION_INSTRUCTIONS — after the TAC-314 promotion', () => {
  it('no longer carries category-local price scoping (moved to universal R17)', () => {
    // The category-local rule only ever rendered on new_question turns; the
    // price that leaked in UAT was on a `reply` turn. R17 in SYSTEM_TEMPLATE
    // owns this now, on every category — compose-prompt.test.ts asserts the
    // assembled prompt carries it for reply and recommendation_request too.
    expect(NEW_QUESTION_INSTRUCTIONS).not.toContain('price is not part of the answer')
    expect(NEW_QUESTION_INSTRUCTIONS).not.toContain('lists a price on every menu item')
  })

  it('still forbids guessing prices that are not listed (kept: anti-invention, not disclosure)', () => {
    // Deliberate keep per TAC-314: R17 governs volunteering REAL prices; this
    // governs FABRICATING ones that are not listed. R8 territory.
    expect(NEW_QUESTION_INSTRUCTIONS).toContain('Do not guess prices')
  })

  it('routes an unanswerable question to # Knowledge gaps, not a promise', () => {
    expect(NEW_QUESTION_INSTRUCTIONS).toContain('handle it per the # Knowledge gaps block')
  })

  it('no longer offers to ask someone or get back to the guest', () => {
    // Named in the direction that matters: the promise must be ABSENT.
    expect(NEW_QUESTION_INSTRUCTIONS).not.toContain('get back to them')
    expect(NEW_QUESTION_INSTRUCTIONS).not.toContain('ask someone')
  })
})

// ---------------------------------------------------------------------------
// TAC-314: the category layer loses structural authority.
// ---------------------------------------------------------------------------
//
// Governing principle: a category block governs what the turn is ABOUT. It may
// not prescribe message structure, length, sentence count, splitting, hedging
// policy, or disclosure policy — those belong to the universal layer, which
// renders in SYSTEM_TEMPLATE for every category. Category blocks render LAST,
// so a form directive here outranks every layer above it; that is how "Keep it
// short, one or two short sentences total" kept R12 at zero splits across five
// UAT turns while every test was green.

describe('category blocks carry no form authority (TAC-314)', () => {
  // One entry per instruction constant — all 17. The regex is the union of
  // every length/count phrasing removed by the TAC-314 sweep; a new category
  // block that reintroduces one fails here by construction. Both deliberate
  // keeps (personal_history no-record handling, comp_complaint question shape)
  // pass on CONTENT, not via an exemption: neither contains a length pattern.
  const FORBIDDEN_FORM =
    /keep it short|keep the answer direct and short|short sentences? total|one short (line|message)|at or below the length|stay short|one to three words|one or two short (lines|sentences)|match their energy and length|match the energy and length/i

  it.each(ROUND_TRIP_TABLE)('%s has no length or sentence-count directive', (_cat, text) => {
    expect(text).not.toMatch(FORBIDDEN_FORM)
  })

  it('reply and unknown carry no TAC-308 survivor phrasing', () => {
    for (const block of [REPLY_INSTRUCTIONS, UNKNOWN_INSTRUCTIONS]) {
      expect(block).not.toContain('get back to you')
      expect(block).not.toContain('offer to find out')
    }
    // reply gets the same routing new_question got in #111.
    expect(REPLY_INSTRUCTIONS).toContain('handle it per the # Knowledge gaps block')
  })

  it('recommendation_request prescribes topic, not shape or hedging', () => {
    expect(RECOMMENDATION_REQUEST_INSTRUCTIONS).not.toContain('say so plainly')
    // No pick count — the cap and rotation shapes are venue policy (AP[28]),
    // which the category layer was overriding into a two-pick template.
    expect(RECOMMENDATION_REQUEST_INSTRUCTIONS).not.toMatch(/one or two/i)
    // The anti-catalog topic scoping stays.
    expect(RECOMMENDATION_REQUEST_INSTRUCTIONS).toContain('not a catalog')
  })
})

// ---------------------------------------------------------------------------
// TAC-327: the category layer loses PURSUIT authority.
// ---------------------------------------------------------------------------
//
// Governing principle, sibling to TAC-314's FORM boundary above: a category
// block governs REGISTER — how to sound, how long, how literal, what shape
// the reply takes for this kind of turn. It may not prescribe PURSUIT — what
// goals are open, or the restraint around raising them — because that is the
// first-touch intentions block's job (lib/agent/intentions/), and intentions
// states its restraint CONDITIONALLY ("only raise one if the conversation
// opens a natural door"). An ABSOLUTE ban living in a category block outranks
// that conditional restraint by construction (category blocks render last),
// which is exactly how casual_chatter silently suppressed the intentions
// block's own correctly-conditional restraint on every single turn,
// including first touch, where it mattered most.
//
// The test below is intentionally narrow (mirrors the SPECIFIC deleted
// phrasing, not a generic "no pursuit-shaped words anywhere" rule) because
// two lines elsewhere in this file are DELIBERATE KEEPS, not leaks:
// event_question's "come anyway" and follow_up's "push a return visit"
// restrain a goal (generic return-visit nudging) that no current intention
// models, so there is nothing for them to duplicate — see CLAUDE.md
// "Category instruction layer carries NO pursuit authority (TAC-327)" for
// the full classification.
//
// acknowledgment's return-visit/new-topic ban was a THIRD keep of this kind
// until TAC-330 (case 2, live UAT): it was safe only by COINCIDENCE with the
// current two intentions, not by design, and the coincidence broke — a bare
// one-word reply classified as `acknowledgment` instead of `reply`, and the
// absolute ban silently vetoed `learn_first_order` on exactly the turn it
// was supposed to be free to raise. Resolved by narrowing, not deleting
// (`lib/ai/prompts/categories/acknowledgment.ts` carries the full history):
// the return-visit half stays absolute, the new-topic half now carries an
// explicit jurisdictional carve-out for goal state. See CLAUDE.md for the
// updated classification.
// THIS IS A LITERAL-REVERT CANARY, NOT A SEMANTIC GUARD: it catches the
// exact two deleted phrases (whitespace/comma-tolerant) coming back verbatim
// or via a copy-paste revert. A differently-worded reintroduction of the
// same restraint (e.g. "don't nudge toward perks unprompted") would pass
// this sweep silently — a broader regex isn't achievable without immediately
// false-positiving on the three legitimate keeps above. Human review at the
// next audit is still what catches a reworded leak, same as TAC-314's
// FORBIDDEN_FORM sweep above it.
describe('category blocks carry no pursuit authority (TAC-327)', () => {
  const FORBIDDEN_PURSUIT = /pivot to perks,?\s*events,?\s*or a service offer|service intent into a friendly remark/i

  it.each(ROUND_TRIP_TABLE)('%s has no pursuit-of-intentions restraint language', (_cat, text) => {
    expect(text).not.toMatch(FORBIDDEN_PURSUIT)
  })

  it('deliberate keeps are unaffected: event_question and follow_up still restrain generic return-visit nudging', () => {
    // Not a duplicate of anything intentions currently models (no
    // plant_next_visit-style intention exists) — deleting these would leave
    // a real gap, not remove a leak. See CLAUDE.md for the full rationale.
    expect(EVENT_QUESTION_INSTRUCTIONS).toContain('Do not pivot to suggesting they come anyway')
    expect(FOLLOW_UP_INSTRUCTIONS).toContain('Do not push a return visit explicitly')
  })

  it('acknowledgment still bans an invented pivot, but no longer vetoes goal state (TAC-330)', () => {
    // No longer a "deliberate keep" — the coincidence it relied on broke
    // (case 2) and was fixed by narrowing. The return-visit ban is untouched
    // (no current mechanism conflicts with it); the new-topic ban is now
    // unqualified and jurisdictionally scoped rather than absolute.
    expect(ACKNOWLEDGMENT_INSTRUCTIONS).toContain('Do not pivot to a new topic')
    expect(ACKNOWLEDGMENT_INSTRUCTIONS).toContain('do not push for a return visit')
    expect(ACKNOWLEDGMENT_INSTRUCTIONS).toContain(
      "not authority over whether you act on a goal you're already carrying",
    )
  })
})
