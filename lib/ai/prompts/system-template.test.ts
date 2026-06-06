import { describe, expect, it } from 'vitest'
// Relative import: vitest doesn't pick up Next's `@/*` alias without a
// vitest.config.ts. Other tests in this repo use relative imports too.
import { PROMPT_VERSION, SYSTEM_TEMPLATE } from './system-template'

// Each universal voice rule (R1–R13) has a distinguishing phrase asserted
// here so a future edit that drops or rewords a rule beyond recognition
// fails loudly. THE-225 added R8/R9/R10 + strengthened R3. v1.9.0 added R11
// (greeting discipline) + R12 (operator instruction block usage), promoted
// the existing Last Visit guidance to R13, and anchored R2 to the ## Right
// now block. v1.10.0 is a category-instructions-layer change (acknowledgment
// rewrite, em-dash hygiene, classifier inbound/outbound split) — no
// SYSTEM_TEMPLATE body changes, just the version bump. v1.11.0 is a
// classifier-surface change (recent-conversation + guest-state context,
// temperature, 1000-char input cap, 3-tier confidence routing) — again
// no SYSTEM_TEMPLATE body changes, just the version bump. v1.12.0 is a
// knowledge_corpus surface change (tag split, tag-aware retrieval, always-
// render knowledge block) — also no SYSTEM_TEMPLATE body changes.

describe('PROMPT_VERSION', () => {
  it('is v1.21.0 (TAC-123: perk_unlock FollowupReason + perkBeingUnlocked wiring + multi-reason intake)', () => {
    expect(PROMPT_VERSION).toBe('v1.21.0')
  })
})

describe('SYSTEM_TEMPLATE — arrivalCapture id discipline (TAC-302, v1.18.0)', () => {
  it('teaches the model that referencesCommitmentId is the verbatim id segment', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      "verbatim 'id:' segment from the matching line in the ## Active commitments block",
    )
  })

  it('warns against paraphrasing or substituting the code value for the id', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      "copy it exactly, do not paraphrase, do not use the 'code:' value",
    )
  })

  it('marks the id as system-internal and never spoken to the guest', () => {
    expect(SYSTEM_TEMPLATE).toContain('NEVER read it aloud, NEVER include it in your reply text to the guest')
  })
})

describe('SYSTEM_TEMPLATE — arrivalCapture emission discipline (TAC-302 follow-up, v1.19.0)', () => {
  it('frames arrivalCapture as DETECTION, NOT COMMUNICATION', () => {
    expect(SYSTEM_TEMPLATE).toContain('THIS IS DETECTION, NOT COMMUNICATION')
  })

  it('reframes the emit condition as a co-occurrence of arrival intent AND active commitments', () => {
    expect(SYSTEM_TEMPLATE).toContain('Populate arrivalCapture whenever BOTH of the following are true')
  })

  it('covers confirmations and closers as arrival intent (not just direct time/direction statements)', () => {
    expect(SYSTEM_TEMPLATE).toContain('a confirmation of a previously-discussed time')
    expect(SYSTEM_TEMPLATE).toContain('a closer that confirms intent to arrive')
  })

  it('explicitly forbids the "I already asked for the heads-up" suppression reason', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      '"I already asked for the heads-up earlier in the thread" — IRRELEVANT',
    )
  })

  it('explicitly forbids the "guest is just confirming" suppression reason', () => {
    expect(SYSTEM_TEMPLATE).toContain('A CONFIRMATION IS A SIGNAL')
  })

  it('explicitly forbids the "end of conversation, no need" suppression reason', () => {
    expect(SYSTEM_TEMPLATE).toContain('END-OF-CONVERSATION IS WHEN ARRIVAL DETECTION MATTERS MOST')
  })

  it('explicitly forbids the "previous turn already set expected_arrival" suppression reason', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      '"Their previous turn already set the expected_arrival" — DOESN\'T MATTER',
    )
  })

  it('directs the model to STOP when it catches itself reasoning toward suppression', () => {
    expect(SYSTEM_TEMPLATE).toContain('"no need to capture again because…" — STOP')
  })

  it('decouples the conversational heads-up ask from the structured detection', () => {
    expect(SYSTEM_TEMPLATE).toContain('one-time courtesy in the venue\'s voice')
    expect(SYSTEM_TEMPLATE).toContain('structured detection that fires every time arrival intent is present')
  })

  it('includes the prod-matched worked example showing emission despite prior heads-up ask', () => {
    expect(SYSTEM_TEMPLATE).toContain('Worked example')
    expect(SYSTEM_TEMPLATE).toContain('ok i\'ll come in tomorrow around 8')
    expect(SYSTEM_TEMPLATE).toContain('even though the heads-up was already asked')
  })
})

describe('SYSTEM_TEMPLATE — Resource commitment self-flag (TAC-212, v1.14.0)', () => {
  it('contains the resource-commitment self-flag block header', () => {
    expect(SYSTEM_TEMPLATE).toContain('# Resource commitment self-flag')
  })

  it('directs the model to set requiresOperatorApproval=true on comp / discount / refund', () => {
    expect(SYSTEM_TEMPLATE).toContain('comp, discount, refund, or any monetary credit')
    expect(SYSTEM_TEMPLATE).toContain('set requiresOperatorApproval=true')
  })

  it('directs the model to populate a one-clause approvalReason when flagged', () => {
    expect(SYSTEM_TEMPLATE).toContain('one-clause reason in approvalReason')
  })

  it('cross-references the mechanic-eligibility approval annotation', () => {
    expect(SYSTEM_TEMPLATE).toContain('the runtime context\'s "## What this guest can access" block marks a mechanic as requiring operator approval')
  })

  it('directs the model to leave approvalReason empty when not flagging', () => {
    expect(SYSTEM_TEMPLATE).toContain('leave approvalReason as an empty string')
  })

  it('decouples the flag from voice fidelity', () => {
    expect(SYSTEM_TEMPLATE).toContain('independent of voice fidelity')
  })
})

describe('SYSTEM_TEMPLATE — voice vs knowledge', () => {
  it('explains the voice / knowledge split with the canonical phrase', () => {
    expect(SYSTEM_TEMPLATE).toContain('Voice vs knowledge')
    expect(SYSTEM_TEMPLATE).toContain('HOW to talk')
    expect(SYSTEM_TEMPLATE).toContain('WHAT IS TRUE')
  })
})

describe('SYSTEM_TEMPLATE — R1: actions the guest didn’t take', () => {
  it("calls out 'tapped in' / 'thanks for stopping by' as forbidden", () => {
    expect(SYSTEM_TEMPLATE).toContain('Don\'t reference actions the guest didn\'t take')
    expect(SYSTEM_TEMPLATE).toContain('tapped in')
    expect(SYSTEM_TEMPLATE).toContain('thanks for stopping by')
  })
})

describe('SYSTEM_TEMPLATE — R2: today\'s specific answer', () => {
  it('directs the agent to give today\'s answer for "now" questions', () => {
    expect(SYSTEM_TEMPLATE).toContain('today\'s specific answer')
    expect(SYSTEM_TEMPLATE).toContain('what time do you close')
  })

  it('anchors R2 to the ## Right now block in runtime context', () => {
    expect(SYSTEM_TEMPLATE).toContain('date and venue local time from the ## Right now block')
  })
})

describe('SYSTEM_TEMPLATE — R3: dash prohibition', () => {
  it('explicitly bans em dashes and en dashes (THE-225)', () => {
    // The literal phrase is the canonical anchor — if this changes, every
    // downstream artifact (fixture, regex backstop, dash_violation event
    // copy) needs review.
    expect(SYSTEM_TEMPLATE).toContain('Never use em dashes (—) or en dashes (–)')
  })

  it('declares R3 a hard rule', () => {
    expect(SYSTEM_TEMPLATE).toMatch(/Never use em dashes[\s\S]{0,200}This is a hard rule/)
  })

  it('includes the three rewrite examples', () => {
    expect(SYSTEM_TEMPLATE).toContain('we close at 11. come by anytime.')
    expect(SYSTEM_TEMPLATE).toContain('iced isn\'t on the menu. only hot.')
    expect(SYSTEM_TEMPLATE).toContain('anyway, welcome. what can I get you.')
  })

  it('explains why dashes are banned (AI tell, not in venue corpora)', () => {
    expect(SYSTEM_TEMPLATE).toContain('Em dashes read as AI writing in casual texts')
    expect(SYSTEM_TEMPLATE).toContain('don\'t appear in real venue voice corpora')
  })
})

describe('SYSTEM_TEMPLATE — R4: physical artifact framing', () => {
  it('forbids "in front of me" / "let me check my list"', () => {
    expect(SYSTEM_TEMPLATE).toContain('Never reference physical artifacts')
    expect(SYSTEM_TEMPLATE).toContain('in front of me')
    expect(SYSTEM_TEMPLATE).toContain('let me check my list')
  })
})

describe('SYSTEM_TEMPLATE — R5: alternative-channel redirects', () => {
  it('forbids redirecting guests to email/Instagram/etc. for answerable questions', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'Never refer guests to alternative channels for things the venue can answer',
    )
    // Resy carve-out for legitimate handoffs is part of the rule's nuance —
    // assert it stays present so a future edit doesn't accidentally turn R5
    // into an absolute prohibition.
    expect(SYSTEM_TEMPLATE).toContain('for reservations, use Resy')
  })
})

describe('SYSTEM_TEMPLATE — R6: yes/no answers', () => {
  it('directs the agent to answer yes/no questions with yes/no', () => {
    expect(SYSTEM_TEMPLATE).toContain('Answer yes/no questions with yes/no')
    expect(SYSTEM_TEMPLATE).toContain('over-thorough')
  })
})

describe('SYSTEM_TEMPLATE — R7: don\'t restate context', () => {
  it('forbids restating context covered earlier in the thread', () => {
    expect(SYSTEM_TEMPLATE).toContain('Don\'t restate context already covered in the conversation')
  })
})

describe('SYSTEM_TEMPLATE — R8: don\'t invent details (THE-225)', () => {
  it('forbids inventing facts beyond runtime context', () => {
    expect(SYSTEM_TEMPLATE).toContain('Never invent details beyond what your runtime context documents')
  })

  it('enumerates colorful-specificity examples that are forbidden', () => {
    // The parenthetical list anchors what kind of "colorful" detail R8 means.
    // We assert two distinct ones so a partial-edit doesn't silently shrink
    // the list to a single example.
    expect(SYSTEM_TEMPLATE).toContain('family recipe')
    expect(SYSTEM_TEMPLATE).toContain('the line is short today')
  })

  it('reminds the agent it isn\'t physically anywhere', () => {
    expect(SYSTEM_TEMPLATE).toContain('The agent isn\'t physically anywhere')
    expect(SYSTEM_TEMPLATE).toContain('Don\'t claim to see, hear, smell, or be near anything')
  })

  it('offers the dash-free fallback phrasings', () => {
    expect(SYSTEM_TEMPLATE).toContain('\'not sure,\'')
    expect(SYSTEM_TEMPLATE).toContain('\'no idea,\'')
    expect(SYSTEM_TEMPLATE).toContain('\'let me find out.\'')
  })

  // THE-233 tightened R8 with explicit named-product coverage.
  it('explicitly forbids naming undocumented menu items / drinks / dishes / perks / events / off-menu', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'any named menu item, drink, dish, perk, event, or off-menu item that isn\'t documented in the venue spec or runtime context',
    )
  })

  it('lands the punch line: if the name isn\'t there, don\'t name it', () => {
    expect(SYSTEM_TEMPLATE).toContain('If a product name isn\'t there, don\'t name it.')
  })
})

describe('SYSTEM_TEMPLATE — R9: admit uncertainty, don\'t deflect (THE-225)', () => {
  it('directs the agent to say so directly when no confident answer exists', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'If you don\'t have a confident answer to what the guest asked, say so directly',
    )
  })

  it('forbids pivoting to unrelated venue info as deflection', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'Never pivot to unrelated venue info, upcoming events, or perks as a deflection',
    )
  })

  it('includes the weather + gluten-free worked examples', () => {
    expect(SYSTEM_TEMPLATE).toContain('open mic is next Saturday')
    expect(SYSTEM_TEMPLATE).toContain('every menu item that happens to lack gluten')
  })

  it('lands the principle: a non-sequitur is worse than uncertainty', () => {
    expect(SYSTEM_TEMPLATE).toContain('A non-sequitur is worse than admitting uncertainty')
  })

  it('contains no em or en dashes inside the rule body (R3 self-consistency)', () => {
    // Slice out R9's prose by anchoring on its opening clause + the next rule
    // boundary (R10 starts with "When recommending other places").
    const start = SYSTEM_TEMPLATE.indexOf(
      'If you don\'t have a confident answer to what the guest asked',
    )
    const end = SYSTEM_TEMPLATE.indexOf('When recommending other places')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const r9Body = SYSTEM_TEMPLATE.slice(start, end)
    expect(r9Body).not.toMatch(/[—–]/)
  })
})

describe('SYSTEM_TEMPLATE — R10: only documented venue recommendations (THE-225)', () => {
  it('limits recommendations to documented venues', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'only name venues explicitly mentioned in the venue spec',
    )
  })

  it('forbids inventing or conflating venue names', () => {
    expect(SYSTEM_TEMPLATE).toContain('Do not invent plausible-sounding names')
    expect(SYSTEM_TEMPLATE).toContain('Do not conflate similarly-named places')
  })

  it('offers natural-decline fallbacks for undocumented asks', () => {
    expect(SYSTEM_TEMPLATE).toContain('I\'d ask around')
    expect(SYSTEM_TEMPLATE).toContain('I don\'t go out much past here')
  })
})

describe('SYSTEM_TEMPLATE — R11: greeting discipline', () => {
  it('limits greetings to first message or after long silence', () => {
    expect(SYSTEM_TEMPLATE).toContain('Open with a greeting only on the first message of a thread')
    expect(SYSTEM_TEMPLATE).toContain('multi-day silence')
  })

  it('directs the agent to start with the answer otherwise', () => {
    expect(SYSTEM_TEMPLATE).toContain('Otherwise start with the answer')
  })

  it('includes the oat-milk worked example', () => {
    expect(SYSTEM_TEMPLATE).toContain('do you have oat milk')
    expect(SYSTEM_TEMPLATE).toContain('yeah, oat and almond')
  })

  it('lands the principle: greeting on every turn reads as scripted', () => {
    expect(SYSTEM_TEMPLATE).toContain('Greeting on every turn reads as scripted')
  })

  it('contains no em or en dashes inside the rule body (R3 self-consistency)', () => {
    // Slice from R11's opening clause to the next rule (operator instruction).
    const start = SYSTEM_TEMPLATE.indexOf('Open with a greeting only on the first message')
    const end = SYSTEM_TEMPLATE.indexOf('If your runtime context includes a ## Operator instruction')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const r11Body = SYSTEM_TEMPLATE.slice(start, end)
    expect(r11Body).not.toMatch(/[—–]/)
  })
})

describe('SYSTEM_TEMPLATE — R12: Operator instruction block usage (THE-232)', () => {
  it('introduces the Operator instruction block', () => {
    expect(SYSTEM_TEMPLATE).toContain('If your runtime context includes a ## Operator instruction block')
  })

  it('frames the operator note as intent, not output', () => {
    expect(SYSTEM_TEMPLATE).toContain('directive for what to communicate, not the message to send verbatim')
    expect(SYSTEM_TEMPLATE).toContain('operator\'s wording is intent, not output')
  })

  it('forbids echoing the operator phrasing', () => {
    expect(SYSTEM_TEMPLATE).toContain('Don\'t echo the operator\'s phrasing')
  })

  it('forbids meta-acknowledgment of the instruction', () => {
    expect(SYSTEM_TEMPLATE).toContain('\'got it,\'')
    expect(SYSTEM_TEMPLATE).toContain('\'here\'s a reminder:\'')
  })

  it('forbids referring to the operator', () => {
    expect(SYSTEM_TEMPLATE).toContain('\'I was asked to tell you\'')
  })

  it('includes the open-mic worked example', () => {
    expect(SYSTEM_TEMPLATE).toContain('remind them about open mic next Saturday')
    expect(SYSTEM_TEMPLATE).toContain('open mic this saturday at 8. you should come')
  })

  it('contains no em or en dashes inside the rule body (R3 self-consistency)', () => {
    // Slice from operator instruction opening to the next rule (Last Visit).
    const start = SYSTEM_TEMPLATE.indexOf('If your runtime context includes a ## Operator instruction')
    const end = SYSTEM_TEMPLATE.indexOf('The Last Visit block tells you')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const opBody = SYSTEM_TEMPLATE.slice(start, end)
    expect(opBody).not.toMatch(/[—–]/)
  })
})

describe('SYSTEM_TEMPLATE — R13: Last Visit block usage (THE-229)', () => {
  it('introduces the Last Visit block', () => {
    expect(SYSTEM_TEMPLATE).toContain('The Last Visit block tells you what the guest most recently ordered')
  })

  it('directs the agent to reference items naturally, not recite', () => {
    expect(SYSTEM_TEMPLATE).toContain('Refer to what they had')
    expect(SYSTEM_TEMPLATE).toContain('Do not recite the data back')
  })

  it('forbids volunteering the date unless asked', () => {
    expect(SYSTEM_TEMPLATE).toContain('Do not volunteer the date unless the guest asks about timing')
  })

  it('caps references at one item', () => {
    expect(SYSTEM_TEMPLATE).toContain('Do not list multiple items if you reference at all')
    expect(SYSTEM_TEMPLATE).toContain('Pick one')
  })

  it('contains no em or en dashes inside the rule body (R3 self-consistency)', () => {
    // Slice from the Last Visit opening clause to end-of-template; assert dash-free.
    const start = SYSTEM_TEMPLATE.indexOf('The Last Visit block tells you')
    expect(start).toBeGreaterThan(-1)
    const lvBody = SYSTEM_TEMPLATE.slice(start)
    // The body runs to the next # heading (the "# Voice imperative" block).
    const end = lvBody.indexOf('\n# ')
    const slice = end === -1 ? lvBody : lvBody.slice(0, end)
    expect(slice).not.toMatch(/[—–]/)
  })
})