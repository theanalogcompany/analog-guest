import { describe, expect, it } from 'vitest'
// Relative import: vitest doesn't pick up Next's `@/*` alias without a
// vitest.config.ts. Other tests in this repo use relative imports too.
import { PROMPT_VERSION, SYSTEM_TEMPLATE } from './system-template'

// Each universal voice rule (R1–R10) has a distinguishing phrase asserted
// here so a future edit that drops or rewords a rule beyond recognition
// fails loudly. THE-225 added R8/R9/R10 + strengthened R3.

describe('PROMPT_VERSION', () => {
  it('is v1.2.0 (THE-225)', () => {
    expect(PROMPT_VERSION).toBe('v1.2.0')
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
      'Don\'t refer guests to alternative channels for things the venue can answer',
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
