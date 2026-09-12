import { describe, expect, it } from 'vitest'
// Relative import: vitest doesn't pick up Next's `@/*` alias without a
// vitest.config.ts. Other tests in this repo use relative imports too.
import { PROMPT_VERSION, SYSTEM_TEMPLATE } from './system-template'
import {
  UNIVERSAL_RULES_DISPLAY,
  UNIVERSAL_RULES_UNDISPLAYED,
} from '../../../app/admin/(authed)/voices/[slug]/_lib/universal-rules'

// Each universal voice rule (R1–R14) has a distinguishing phrase asserted
// here so a future edit that drops or rewords a rule beyond recognition
// fails loudly. THE-225 added R8/R9/R10 + strengthened R3. v1.9.0 added R11
// (greeting discipline) + R12 (operator instruction block usage), promoted
// the existing Last Visit guidance to R13, and anchored R2 to the ## Right
// now block. v1.22.0 (TAC-305) inserted a new R11 (deliver the answer, no
// sentiment-closer) as the 11th bullet and shifted greeting / operator /
// Last-Visit to R12 / R13 / R14 — the curated UNIVERSAL_RULES_DISPLAY tracks
// R1–R11 only; the lockstep test below asserts they stay aligned. v1.10.0 is
// a category-instructions-layer change (acknowledgment rewrite, em-dash
// hygiene, classifier inbound/outbound split) — no SYSTEM_TEMPLATE body
// changes, just the version bump. v1.11.0 is a classifier-surface change
// (recent-conversation + guest-state context, temperature, 1000-char input
// cap, 3-tier confidence routing) — again no SYSTEM_TEMPLATE body changes,
// just the version bump. v1.12.0 is a knowledge_corpus surface change (tag
// split, tag-aware retrieval, always-render knowledge block) — also no
// SYSTEM_TEMPLATE body changes.

describe('PROMPT_VERSION', () => {
  it('is v1.44.0 (TAC-359: three more universal rules R32-R34 — already-in-conversation, first-visit recommendation shape, cannot take orders)', () => {
    expect(PROMPT_VERSION).toBe('v1.44.0')
  })
})

// Lockstep guard (TAC-305): the curated UNIVERSAL_RULES_DISPLAY in the Voices
// rail and the `# Universal voice rules` block in SYSTEM_TEMPLATE are dual
// sources of truth with no shared registry. This catches the failure mode
// where a rule is added/reworded in one source but not the other. This
// describe block does NOT assert display-count === template-bullet-count:
// the template legitimately carries mechanical/rendering-timing bullets
// (greeting / operator / Last-Visit / Unanswered-question / mirroring /
// Length authority / prompt-layer authority) that the display intentionally
// omits. The guards here are (a) the exact positional id sequence and (b)
// select rules' anchor phrases present in BOTH sources. R1-R10 summaries are
// paraphrases (not substrings) of their template bullets, so they are not
// asserted phrase-for-phrase; a structured per-rule anchor field would be
// needed for full coverage and is deferred to the rules-registry extraction
// (THE-237 follow-up). TAC-348 (decision d) adds a SEPARATE guard, in its
// own describe block below ("universal rule classification completeness"),
// that every actual template bullet is classified into EITHER
// UNIVERSAL_RULES_DISPLAY OR UNIVERSAL_RULES_UNDISPLAYED — that's the guard
// against the original "14 shown vs 21 in the prompt, nothing forcing
// reconciliation" bug this ticket started from, without flattening the
// deliberate curation into a raw count-equality assertion.
describe('UNIVERSAL_RULES_DISPLAY ↔ SYSTEM_TEMPLATE lockstep (TAC-305, numbering policy TAC-314)', () => {
  it('exposes the exact expected id sequence — positional, append-only, NOT contiguous', () => {
    // R-numbers are template bullet positions, rules are only ever APPENDED
    // (TAC-314), and retired ids are never reused (TAC-319): renumbering or
    // recycling live rule IDs stales every external reference. R12 (message
    // splitting) is RETIRED — TAC-319 moved splitting into deterministic
    // dispatch code — and R13-R16 are the undisplayed guidance bullets
    // (greeting / operator-instruction / Last-Visit / Unanswered-question);
    // R19-R20 are the undisplayed form-authority bullets. So the displayed
    // sequence has a deliberate gap. The old assertion here demanded
    // contiguity, which would have forced exactly the renumbering the policy
    // forbids. TAC-334 appends R21 at the end, after the R19-R20 gap.
    // TAC-348 appends R23-R28 after that (R22 stays undisplayed). TAC-356
    // appends R29-R31 after that. TAC-359 appends R32-R34 after that.
    const ids = UNIVERSAL_RULES_DISPLAY.map((r) => r.id)
    expect(ids).toEqual([
      'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11',
      'R17', 'R18', 'R21', 'R23', 'R24', 'R25', 'R26', 'R27', 'R28',
      'R29', 'R30', 'R31', 'R32', 'R33', 'R34',
    ])
  })

  it('curates 26 rules ending at R34 (TAC-359)', () => {
    expect(UNIVERSAL_RULES_DISPLAY).toHaveLength(26)
    expect(UNIVERSAL_RULES_DISPLAY.at(-1)?.id).toBe('R34')
  })

  it('shares the R11 anchor phrase across both sources', () => {
    const r11 = UNIVERSAL_RULES_DISPLAY.find((r) => r.id === 'R11')
    expect(r11).toBeDefined()
    // The display summary and the template prose both speak to ending the
    // delivery turn on the answer rather than a sentiment-closer.
    expect(r11?.summary).toContain('end on the answer')
    expect(SYSTEM_TEMPLATE).toContain('Let it stand')
  })


  it('shares the R17 price-scoping anchor across both sources (TAC-314)', () => {
    const r17 = UNIVERSAL_RULES_DISPLAY.find((r) => r.id === 'R17')
    expect(r17).toBeDefined()
    expect(r17?.summary).toContain('not part of an answer unless')
    expect(SYSTEM_TEMPLATE).toContain('Price is not part of an answer unless the guest asked')
    expect(SYSTEM_TEMPLATE).toContain('Describing a drink is not asking its price')
  })

  it('shares the R18 nearby-places anchor across both sources (TAC-314)', () => {
    const r18 = UNIVERSAL_RULES_DISPLAY.find((r) => r.id === 'R18')
    expect(r18).toBeDefined()
    expect(r18?.summary).toContain('speak with the same confidence')
    expect(SYSTEM_TEMPLATE).toContain(
      "speak with the same confidence you'd use about the menu",
    )
    expect(SYSTEM_TEMPLATE).toContain('never fill the gap from general knowledge')
  })

  it('shares the R21 anchor phrase across both sources (TAC-334)', () => {
    const r21 = UNIVERSAL_RULES_DISPLAY.find((r) => r.id === 'R21')
    expect(r21).toBeDefined()
    expect(r21?.summary).toContain('answering with, not for leading with')
    expect(SYSTEM_TEMPLATE).toContain(
      'Venue knowledge is for answering with, not for leading with',
    )
    expect(SYSTEM_TEMPLATE).toContain(
      "Don't rate the choice, compare it to other options, or suggest something different for next time",
    )
  })

  // TAC-348: the same cross-source anchor treatment for the six newly
  // promoted rules and the two strengthened ones, so none of these edits can
  // silently drift between the two sources the way the ticket's own
  // motivating bug (14 shown vs 21 in the prompt) did.
  it('shares the R23 anchor phrase across both sources (TAC-348)', () => {
    const r23 = UNIVERSAL_RULES_DISPLAY.find((r) => r.id === 'R23')
    expect(r23).toBeDefined()
    expect(r23?.summary).toContain('visit count')
    expect(SYSTEM_TEMPLATE).toContain('Never state or imply a visit count, frequency')
  })

  it('shares the R24 anchor phrase across both sources (TAC-348)', () => {
    const r24 = UNIVERSAL_RULES_DISPLAY.find((r) => r.id === 'R24')
    expect(r24).toBeDefined()
    expect(r24?.summary).toContain('standard, widely known drink')
    expect(SYSTEM_TEMPLATE).toContain("Don't explain what a standard, widely known drink is")
  })

  it('shares the R25 anchor phrase across both sources (TAC-348)', () => {
    const r25 = UNIVERSAL_RULES_DISPLAY.find((r) => r.id === 'R25')
    expect(r25).toBeDefined()
    expect(r25?.summary).toContain('comma-separated list')
    expect(SYSTEM_TEMPLATE).toContain("Don't drop into a bare comma-separated list of components.")
  })

  it('shares the R26 anchor phrase across both sources (TAC-348)', () => {
    const r26 = UNIVERSAL_RULES_DISPLAY.find((r) => r.id === 'R26')
    expect(r26).toBeDefined()
    expect(r26?.summary).toContain('at most two')
    expect(SYSTEM_TEMPLATE).toContain('When recommending items, offer at most two.')
  })

  it('shares the R27 anchor phrase across both sources (TAC-348)', () => {
    const r27 = UNIVERSAL_RULES_DISPLAY.find((r) => r.id === 'R27')
    expect(r27).toBeDefined()
    expect(r27?.summary).toContain('[Name]')
    expect(SYSTEM_TEMPLATE).toContain("Saying 'let me check with [Name]' or '[Name] said to try the cortado' when you ARE [Name] is wrong")
  })

  it('shares the R28 anchor phrase across both sources (TAC-348)', () => {
    const r28 = UNIVERSAL_RULES_DISPLAY.find((r) => r.id === 'R28')
    expect(r28).toBeDefined()
    expect(r28?.summary).toContain('criticize, blame')
    expect(SYSTEM_TEMPLATE).toContain('Never criticize, blame, or speak negatively about a staff member')
  })

  // TAC-356: the same cross-source anchor treatment for the three newly
  // promoted rules, mirroring the TAC-348 pattern immediately above.
  it('shares the R29 anchor phrase across both sources (TAC-356)', () => {
    const r29 = UNIVERSAL_RULES_DISPLAY.find((r) => r.id === 'R29')
    expect(r29).toBeDefined()
    expect(r29?.summary).toContain('sentence fragment is fine')
    expect(SYSTEM_TEMPLATE).toContain('A sentence fragment is fine when it reads naturally')
  })

  it('shares the R30 anchor phrase across both sources (TAC-356)', () => {
    const r30 = UNIVERSAL_RULES_DISPLAY.find((r) => r.id === 'R30')
    expect(r30).toBeDefined()
    expect(r30?.summary).toContain('ask what they mean')
    expect(SYSTEM_TEMPLATE).toContain("ask what they mean rather than guess at an interpretation")
  })

  it('shares the R31 anchor phrase across both sources (TAC-356)', () => {
    const r31 = UNIVERSAL_RULES_DISPLAY.find((r) => r.id === 'R31')
    expect(r31).toBeDefined()
    expect(r31?.summary).toContain('specific product')
    expect(SYSTEM_TEMPLATE).toContain('Do not name a specific product (a drink, a bean, a menu item)')
  })

  // TAC-359: the same cross-source anchor treatment for the three newly
  // promoted rules, mirroring the TAC-348/TAC-356 pattern above.
  it('shares the R32 anchor phrase across both sources (TAC-359)', () => {
    const r32 = UNIVERSAL_RULES_DISPLAY.find((r) => r.id === 'R32')
    expect(r32).toBeDefined()
    expect(r32?.summary).toContain('reach out')
    expect(SYSTEM_TEMPLATE).toContain('Never tell the guest to send a message, reach out, or get in touch')
  })

  it('shares the R33 anchor phrase across both sources (TAC-359)', () => {
    const r33 = UNIVERSAL_RULES_DISPLAY.find((r) => r.id === 'R33')
    expect(r33).toBeDefined()
    expect(r33?.summary).toContain('first step')
    expect(SYSTEM_TEMPLATE).toContain('recommend only the first step')
  })

  it('shares the R34 anchor phrase across both sources (TAC-359)', () => {
    const r34 = UNIVERSAL_RULES_DISPLAY.find((r) => r.id === 'R34')
    expect(r34).toBeDefined()
    expect(r34?.summary).toContain('cannot place, confirm, or take an order')
    expect(SYSTEM_TEMPLATE).toContain('You cannot place, confirm, or take an order.')
  })

  it('shares the R8-strengthened anchor phrase across both sources (TAC-348)', () => {
    const r8 = UNIVERSAL_RULES_DISPLAY.find((r) => r.id === 'R8')
    expect(r8).toBeDefined()
    expect(r8?.summary).toContain('personally seen or been with the guest')
    expect(SYSTEM_TEMPLATE).toContain('claiming to have seen, noticed, or been with the guest')
  })

  it('shares the R11-strengthened anchor phrase across both sources (TAC-348)', () => {
    const r11 = UNIVERSAL_RULES_DISPLAY.find((r) => r.id === 'R11')
    expect(r11).toBeDefined()
    expect(r11?.summary).toContain('the whole description, not just the closing line')
    expect(SYSTEM_TEMPLATE).toContain("This isn't only about the last sentence.")
  })

  // TAC-324, added per QA suggestion: R1's overall summary is a paraphrase
  // (per this file's own header comment) and isn't held to the same
  // full-anchor standard as R11/R17/R18 above. The NEW qr_scan carve-out
  // sentence is new voice text, not a paraphrase, so it gets the same
  // cross-checked-anchor treatment those three get, closing the gap QA
  // flagged rather than leaving R1 the one displayed rule with no lockstep
  // coverage on its most recent edit.
  it('shares the R1 qr_scan carve-out anchor across both sources (TAC-324, reworded TAC-329)', () => {
    const r1 = UNIVERSAL_RULES_DISPLAY.find((r) => r.id === 'R1')
    expect(r1).toBeDefined()
    expect(r1?.summary).toContain('qr_scan')
    expect(r1?.summary).toContain('shared channel context')
    expect(SYSTEM_TEMPLATE).toContain('treat the channel itself as the shared context')
    expect(SYSTEM_TEMPLATE).toContain('Do not narrate the scan or thank them for it')
  })
})

// TAC-314: the template used to carry a SECOND `# Universal voice rules`
// heading — bare, contentless, immediately followed by `# Guest context
// capture`, 31 lines before the real section. A heading that promises the
// authority layer and delivers a different topic dilutes the exact layer this
// ticket makes authoritative. Deleted; this pins it deleted.
describe('SYSTEM_TEMPLATE — single universal-rules heading (TAC-314)', () => {
  it('contains exactly one # Universal voice rules heading', () => {
    const matches = SYSTEM_TEMPLATE.match(/^# Universal voice rules$/gm) ?? []
    expect(matches).toHaveLength(1)
  })

  it('keeps the four undisplayed guidance bullets and the two form-authority bullets', () => {
    // R13-R16 must survive TAC-314 untouched (append-only numbering depends
    // on their positions staying fixed), and R19/R20 fill the gaps the
    // category strip left.
    expect(SYSTEM_TEMPLATE).toContain('Open with a greeting only on the first message')
    expect(SYSTEM_TEMPLATE).toContain('## Operator instruction block')
    expect(SYSTEM_TEMPLATE).toContain('The Last Visit block tells you')
    expect(SYSTEM_TEMPLATE).toContain('## Unanswered question block')
    expect(SYSTEM_TEMPLATE).toContain('Match the register and length of what the guest sent')
    expect(SYSTEM_TEMPLATE).toContain('only authority on how long a message should be')
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

  it('does not use "see you then" or "see you tomorrow" in the guest-utterance example list (TAC-340)', () => {
    // Same leak as acknowledgment.ts's guest sign-off list (see that file's
    // TAC-340 comment): a guest-example string that doubles as a plausible
    // agent line. Canary against reintroducing it here, not a claim this
    // block caused the observed incident.
    expect(SYSTEM_TEMPLATE).not.toContain('see you then')
    expect(SYSTEM_TEMPLATE).not.toContain('sounds good — see you tomorrow')
  })
})

describe('SYSTEM_TEMPLATE — Resource commitment self-flag (TAC-212, v1.14.0)', () => {
  it('contains the resource-commitment self-flag block header', () => {
    expect(SYSTEM_TEMPLATE).toContain('# Resource commitment self-flag')
  })

  // v1.23.0: this assertion previously locked the MONETARY enumeration
  // ('comp, discount, refund, or any monetary credit') that caused the
  // 2026-08-07 incident. The model read that list literally, concluded an
  // in-kind remake was none of those, and auto-sent free product on a refund
  // request. The test passed throughout, because it asserted the presence of
  // the defective wording. Now asserts the value-transfer framing instead.
  it('tests for value transfer, not monetary instruments', () => {
    expect(SYSTEM_TEMPLATE).toContain('ANYTHING OF VALUE')
    expect(SYSTEM_TEMPLATE).toContain('product, service, or money they did not pay for')
    expect(SYSTEM_TEMPLATE).toContain('It does not matter whether money changes hands')
    expect(SYSTEM_TEMPLATE).toContain('set requiresOperatorApproval=true')
  })

  it('names the in-kind remedies the monetary framing missed', () => {
    for (const remedy of ['A remake', 'a replacement', 'a redo']) {
      expect(SYSTEM_TEMPLATE).toContain(remedy)
    }
    // The exact rationalization from the incident trace, pre-empted by name.
    expect(SYSTEM_TEMPLATE).toContain('just service recovery')
  })

  // Guards the over-fire direction. A self-flag that queues "let me find out"
  // would stall complaint threads on turns that commit nothing, which is a
  // worse failure than the one v1.23.0 fixes.
  it('carves out information-only promises so the widening does not over-fire', () => {
    expect(SYSTEM_TEMPLATE).toContain('promises that only cost you effort')
    expect(SYSTEM_TEMPLATE).toContain('commit information, not resources')
  })

  it('teaches comp to cover in-kind replacement, with the incident as the example', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      '"Come by and I\'ll have another made for you" is commitment.type = "comp"',
    )
    expect(SYSTEM_TEMPLATE).toContain('not limited to money or credit')
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

  // TAC-324: narrow, tightly-bounded exception — the one case where Sana
  // legitimately knows the guest just took a real action (scanned the
  // venue's QR sign). Gated at the runtime-context level (build-runtime-context.ts
  // + buildAiRuntime), not by this text alone; the text just teaches the
  // model what to do when that signal is present.
  //
  // TAC-329: the RATIONALE for the exception was reworded from physical-
  // presence framing ("greet them as someone present, the way you'd greet a
  // person standing in front of you") to channel-context framing ("treat the
  // channel itself as the shared context"). The prior framing licensed
  // present-tense location assumptions and was observed producing "Password's
  // on the board when you get here" sent to a guest who had already left. The
  // gate (the condition that triggers the exception) is unchanged.
  it('carves out a narrow exception for a qr_scan guest\'s first message', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      "when the context says this is the guest's first message after they scanned a sign at the venue",
    )
    expect(SYSTEM_TEMPLATE).toContain('treat the channel itself as the shared context')
    expect(SYSTEM_TEMPLATE).toContain("without assuming they're still on-site")
  })

  // This is the register R1's carve-out must NOT license — permission to
  // know the guest is present is not permission to narrate the mechanism
  // that told Sana so. A first-touch send that says "thanks for scanning"
  // would be exactly the software-talking-about-itself failure this rule
  // exists to prevent everywhere else.
  it('explicitly forbids narrating the scan or thanking the guest for it', () => {
    expect(SYSTEM_TEMPLATE).toContain('Do not narrate the scan or thank them for it')
  })

  it('restates that the rest of the rule is unchanged by the exception', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      "Everything else in this rule holds: never assume a visit, a tap, or an interaction the message or history doesn't confirm.",
    )
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

  // TAC-308 dropped 'let me find out.' from this list. It was one of three
  // places the template taught the agent to promise a follow-up it had no
  // machinery to deliver; the promise is now forbidden outright and the
  // # Knowledge gaps block routes the turn to an operator instead.
  it('offers the dash-free fallback phrasings, without the promise', () => {
    expect(SYSTEM_TEMPLATE).toContain('\'not sure,\'')
    expect(SYSTEM_TEMPLATE).toContain('\'no idea.\'')
    expect(SYSTEM_TEMPLATE).toContain(
      'Never promise to find out and come back',
    )
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
  // TAC-308 rewrote this rule's opening. It used to endorse
  // "let me find out and get back to you" by name — the exact phrase behind
  // thirteen unkept promises in production. The anti-deflection half is
  // unchanged; the promise half is now a prohibition.
  it('forbids the promise and the invented deadline', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'never say you\'ll find out and get back to them, and never name a time an answer will arrive',
    )
    expect(SYSTEM_TEMPLATE).not.toContain('let me find out and get back to you')
  })

  it('forbids pivoting to unrelated venue info as deflection', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'never pivot to unrelated venue info, upcoming events, or perks as a deflection',
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
      'When you don\'t have a confident answer, never pivot',
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

describe('SYSTEM_TEMPLATE — R11: deliver the answer, no sentiment-closer (TAC-305)', () => {
  it('directs the agent to end delivery turns on the answer, not a sentiment-closer', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'When delivering a recommendation, a description, or a fact',
    )
    expect(SYSTEM_TEMPLATE).toContain('Let it stand')
  })

  it('frames the observed closers as the shape to avoid, not a fixed banlist', () => {
    expect(SYSTEM_TEMPLATE).toContain('trust me on this one')
    expect(SYSTEM_TEMPLATE).toContain('Those are the shape to avoid, not a fixed list')
  })

  it('carves out emotional turns so warmth is retained (over-firing guard)', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'When the guest brings a feeling, like a complaint, thanks, or a milestone',
    )
    expect(SYSTEM_TEMPLATE).toContain('meeting it warmly is the answer')
  })

  it('contains no em or en dashes inside the rule body (R3 self-consistency)', () => {
    // Slice from R11's opening clause to the next rule (greeting discipline).
    const start = SYSTEM_TEMPLATE.indexOf('When delivering a recommendation, a description, or a fact')
    const end = SYSTEM_TEMPLATE.indexOf('Open with a greeting only on the first message')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const r11Body = SYSTEM_TEMPLATE.slice(start, end)
    expect(r11Body).not.toMatch(/[—–]/)
  })
})

// TAC-324: label corrected from R12 to R13. R12 is the retired splitting
// slot (TAC-319) — this bullet (greeting discipline) sits one further down
// the undisplayed R12-R16 range than its old label reflected. Pure rename,
// no assertion content changes.
describe('SYSTEM_TEMPLATE — R13: greeting discipline', () => {
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
    // Slice from R12's opening clause to the next rule (operator instruction).
    const start = SYSTEM_TEMPLATE.indexOf('Open with a greeting only on the first message')
    const end = SYSTEM_TEMPLATE.indexOf('If your runtime context includes a ## Operator instruction')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const r12Body = SYSTEM_TEMPLATE.slice(start, end)
    expect(r12Body).not.toMatch(/[—–]/)
  })
})

// TAC-324: label corrected from R13 to R14, same reason as the greeting
// block above — pure rename, no assertion content changes.
describe('SYSTEM_TEMPLATE — R14: Operator instruction block usage (THE-232)', () => {
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

// TAC-324: label corrected from R14 to R15 (same off-by-one as the two
// blocks above), AND the rule itself is scoped in this ticket — the one-item
// cap now binds explicitly to backward references to past visits, with a
// forward recommendation carved out as a separate act. Substance otherwise
// unchanged from THE-229.
describe('SYSTEM_TEMPLATE — R15: Last Visit block usage, scoped to backward references (THE-229, TAC-324)', () => {
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

  it('caps references at one PAST item', () => {
    expect(SYSTEM_TEMPLATE).toContain('do not list multiple past items if you reference at all')
    expect(SYSTEM_TEMPLATE).toContain('Pick one')
  })

  // TAC-324: the scoping fix. R15 was always about the ## Visit history
  // block; the wording just never said so. Acknowledging what they had is a
  // BACKWARD reference (what this cap polices); recommending something for
  // next time is a FORWARD move and isn't a reference to their history at
  // all, so it doesn't count against the one-item cap.
  it('binds the cap explicitly to backward references to past visits', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'This cap is about backward references to past visits specifically',
    )
  })

  it('carves out a forward recommendation as a separate act not counted against the cap', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'A recommendation for next time is a separate, forward move and does not count against this cap',
    )
    expect(SYSTEM_TEMPLATE).toContain(
      'You can reference one thing they had and still recommend something new in the same message',
    )
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
describe('SYSTEM_TEMPLATE — # Knowledge gaps (TAC-308, v1.25.0)', () => {
  it('carries the block header and the required emission field', () => {
    expect(SYSTEM_TEMPLATE).toContain('# Knowledge gaps')
    expect(SYSTEM_TEMPLATE).toContain('The output field "knowledgeGap"')
  })

  // The draft is what an operator corrects, so "let me find out" as a body
  // would hand them nothing to work with. This is the instruction that makes
  // the prefilled card useful.
  it('requires a best-attempt ANSWER in the body, not a holding line', () => {
    expect(SYSTEM_TEMPLATE).toContain('still write your best attempt at the answer in the body')
    expect(SYSTEM_TEMPLATE).toContain('Do not write "let me find out" as the body')
  })

  it('tells the model the body is reviewed before the guest sees it', () => {
    expect(SYSTEM_TEMPLATE).toContain('That text is NOT sent to the guest')
  })

  // Without this the gate would fire on "what's the weather" and create a
  // card no operator can action.
  it('excludes questions nobody at the venue could answer either', () => {
    expect(SYSTEM_TEMPLATE).toContain('Nobody at the venue could answer it either')
    expect(SYSTEM_TEMPLATE).toContain('That is a complete reply, not a gap')
  })

  it('forbids the promise and the deadline outright', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'Never tell the guest you will find out and get back to them',
    )
    expect(SYSTEM_TEMPLATE).toContain('Never say when an answer will arrive')
  })

  // The regression this whole ticket exists to prevent. Three separate sites
  // taught this phrase; none may survive.
  it('contains NO instruction endorsing the unkeepable promise anywhere', () => {
    expect(SYSTEM_TEMPLATE).not.toContain('let me find out and get back to you')
    expect(SYSTEM_TEMPLATE).not.toContain("say 'let me find out' without the artifact framing")
    expect(SYSTEM_TEMPLATE).not.toContain("'let me find out.'")
  })

  it('points the physical-artifact rule at the block instead of the promise', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'handle it per the # Knowledge gaps block above, and never with the artifact framing',
    )
  })
})

describe('SYSTEM_TEMPLATE — ## Unanswered question rule (TAC-308, v1.25.0)', () => {
  it('tells the agent not to re-promise while one is outstanding', () => {
    expect(SYSTEM_TEMPLATE).toContain('If your runtime context includes an ## Unanswered question block')
    expect(SYSTEM_TEMPLATE).toContain("don't state or invent a deadline for it")
  })
})

// TAC-319 round 3: after two prompt-side rounds (v1.30.0's two-job test and a
// canceled late-position re-surfacing) failed to make the model split
// reliably, splitting moved OUT of the prompt into deterministic dispatch
// code (lib/agent/sentence-split.ts). This describe pins the removal: the
// prompt must carry no trace of the delimiter, the beat taxonomy, or the
// macchiato worked example, and the display mirror must no longer list R12.
describe('SYSTEM_TEMPLATE — splitting removed from the prompt (TAC-319, v1.31.0)', () => {
  it('carries no delimiter token anywhere', () => {
    expect(SYSTEM_TEMPLATE).not.toContain('[[BREAK]]')
    expect(SYSTEM_TEMPLATE).not.toContain('BREAK')
  })

  it('carries no beat taxonomy', () => {
    expect(SYSTEM_TEMPLATE).not.toContain('distinct beat')
    expect(SYSTEM_TEMPLATE).not.toContain('one complete job')
    expect(SYSTEM_TEMPLATE).not.toContain('one complete thought')
    expect(SYSTEM_TEMPLATE).not.toContain('two beats')
  })

  it('carries no macchiato worked example', () => {
    expect(SYSTEM_TEMPLATE).not.toContain('Espresso with a small dollop of foam on top')
    expect(SYSTEM_TEMPLATE).not.toContain('stronger than a cortado')
  })

  it('carries no separate-messages instruction', () => {
    expect(SYSTEM_TEMPLATE).not.toContain('separate messages')
    expect(SYSTEM_TEMPLATE).not.toContain('Most replies carry a single job')
  })

  it('no longer lists R12 in the display mirror', () => {
    expect(UNIVERSAL_RULES_DISPLAY.find((r) => r.id === 'R12')).toBeUndefined()
  })

  // The Frosty Gandhi pick example lived inside R12 and leaves with it; the
  // greeting rule (the old 13th bullet) must survive as the block's neighbor
  // so the deletion took exactly one bullet.
  it('deleted exactly the splitting bullet, not its neighbors', () => {
    expect(SYSTEM_TEMPLATE).not.toContain('Frosty Gandhi')
    expect(SYSTEM_TEMPLATE).toContain('When delivering a recommendation, a description, or a fact')
    expect(SYSTEM_TEMPLATE).toContain('Open with a greeting only on the first message')
  })
})

// R21 (TAC-334): closes a gap R11 does not cover. R11 governs how a
// delivered recommendation, description, or fact ENDS; it never fires on a
// turn that isn't delivering one in the first place. R21's trigger is
// scoped to a guest statement containing no question, so a recommendation
// request or opinion request never reaches the prohibition — by construction
// of the trigger clause, not by an exception bolted onto it (the TAC-330
// first-draft failure mode this rule deliberately avoids).
describe('SYSTEM_TEMPLATE — R21: no volunteered advice on an unprompted guest statement (TAC-334)', () => {
  it('states venue knowledge is for answering with, not leading with', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'Venue knowledge is for answering with, not for leading with',
    )
  })

  it('scopes the trigger to a guest statement made without asking anything', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'When a guest tells you something about their own visit or order without asking anything',
    )
  })

  it('frames the trigger examples as illustrative, not exhaustive', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'like what they got, that they finished something, or how it went',
    )
    expect(SYSTEM_TEMPLATE).toContain('Those are examples, not the full list')
  })

  it('prohibits rating, comparing, or proposing an alternative', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      "Don't rate the choice, compare it to other options, or suggest something different for next time",
    )
  })

  // First live UAT (Mock Sextant) found the trigger clause holding cleanly
  // but the rating clause alone letting "Cortado's the right call" through
  // on an order-report turn. Sharpened with named examples + a "not a fixed
  // list" hedge, the same construction R11 already uses for its own closer
  // examples, using the two strings actually observed rather than invented
  // ones.
  it('names the observed rating phrases as the shape to avoid, not a fixed banlist (post-UAT sharpening)', () => {
    expect(SYSTEM_TEMPLATE).toContain('good pick')
    expect(SYSTEM_TEMPLATE).toContain('the right call')
    expect(SYSTEM_TEMPLATE).toContain(
      "A response that praises the guest's order reads as customer-service script",
    )
    expect(SYSTEM_TEMPLATE).toContain('Those are the shape to avoid, not a fixed list')
  })

  it('names the door-opening questions the trigger excludes (overcorrection guard)', () => {
    expect(SYSTEM_TEMPLATE).toContain("'what should I get,'")
    expect(SYSTEM_TEMPLATE).toContain("'is the cortado good,'")
    expect(SYSTEM_TEMPLATE).toContain("'what would you try next time.'")
  })

  it('answers a genuine next-time question in full (UAT case 4 anchor)', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'If the guest then asks what to try next, answer it fully',
    )
  })

  it('contains no em or en dashes inside the rule body (R3 self-consistency)', () => {
    // R21 was the last bullet in the block when this test was written; R22
    // (TAC-314 second round) now sits between it and the next heading, so
    // this range also covers R22's body. That's fine for this assertion —
    // R3 self-consistency should hold across the whole tail, not just R21.
    const start = SYSTEM_TEMPLATE.indexOf('Venue knowledge is for answering with, not for leading with')
    const end = SYSTEM_TEMPLATE.indexOf('# Voice imperative')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const tailBody = SYSTEM_TEMPLATE.slice(start, end)
    expect(tailBody).not.toMatch(/[—–]/)
  })
})

// R22 (TAC-314, second round): promoted from acknowledgment.ts's TAC-330
// case-2 carve-out sentence. The principle — a category's register guidance
// is never authority over whether the model acts on an open intention — is
// general, not acknowledgment-specific, so it moved to the universal layer
// where it protects every category rather than just the one it was first
// observed failing on. Undisplayed (same tier as R13-R16): this is
// prompt-layer authority arbitration, not operator-facing voice guidance.
describe('SYSTEM_TEMPLATE — R22: category register guidance carries no goal-state authority (TAC-314)', () => {
  it('states the jurisdictional boundary between register guidance and goal-pursuit authority', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      "A category instruction's register guidance (how a close, decline, or answer should sound) is never authority over whether you act on an open goal from the ## What you're hoping to get to block; that call belongs to that block alone.",
    )
  })

  it('names the intentions block by its rendered heading, not a paraphrase', () => {
    // Matches formatOpenIntentions's actual header string (serializers.ts) so
    // the two can't silently drift if the block is ever renamed.
    expect(SYSTEM_TEMPLATE).toContain("## What you're hoping to get to")
  })

  // TAC-348 appended R23-R28 after R22, so R22 is no longer the LAST bullet
  // in the block — it's now immediately followed by the six new rules, then
  // the section break. Rewritten to pin that adjacency instead of asserting
  // R22 is terminal. TAC-356 appended R29-R31 after that, and TAC-359
  // appended R32-R34 after that, so the count grows again each time (still
  // the same adjacency shape, just more lines).
  it('is immediately followed by exactly R23-R34, then # Voice imperative', () => {
    const r22Idx = SYSTEM_TEMPLATE.indexOf("A category instruction's register guidance")
    const voiceImperativeIdx = SYSTEM_TEMPLATE.indexOf('# Voice imperative')
    expect(r22Idx).toBeGreaterThan(-1)
    expect(voiceImperativeIdx).toBeGreaterThan(r22Idx)
    const between = SYSTEM_TEMPLATE.slice(r22Idx, voiceImperativeIdx).trim()
    // R22 itself, plus R23-R34 — exactly thirteen bullet lines, then nothing
    // but whitespace before the heading.
    expect(between.split('\n').filter((line) => line.trim().length > 0)).toHaveLength(13)
  })

  it('is undisplayed: UNIVERSAL_RULES_DISPLAY has no R22 entry', () => {
    expect(UNIVERSAL_RULES_DISPLAY.some((r) => r.id === 'R22')).toBe(false)
  })
})

// R23-R28 (TAC-348): promoted from Mock Sextant's manual venue rules. See
// system-template.ts's v1.42.0 changelog for the full audit + rationale,
// including the two candidates dropped in plan review (a universal
// return-visit ban, a universal curiosity-question ban).
describe('SYSTEM_TEMPLATE — R23: no visit-count or tracking language (TAC-348)', () => {
  it('bans stating or implying a visit count, frequency, or tracking statistic', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'Never state or imply a visit count, frequency, or any statistic about how often the guest has been here',
    )
    expect(SYSTEM_TEMPLATE).toContain("'this is your fifth time'")
  })

  it('is explicitly scoped against R15 (Last Visit) so the two do not collide', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      "Referencing what the guest had last time is fine when it fits; counting or tallying visits is not. That's the Last Visit guidance, a separate thing.",
    )
  })

  it('contains no em or en dashes inside the rule body (R3 self-consistency)', () => {
    const start = SYSTEM_TEMPLATE.indexOf('Never state or imply a visit count')
    const end = SYSTEM_TEMPLATE.indexOf("Don't explain what a standard, widely known drink is")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(SYSTEM_TEMPLATE.slice(start, end)).not.toMatch(/[—–]/)
  })
})

describe('SYSTEM_TEMPLATE — R24: no over-explaining standard drinks (TAC-348)', () => {
  it("bans explaining a standard drink unless asked", () => {
    expect(SYSTEM_TEMPLATE).toContain(
      "Don't explain what a standard, widely known drink is (latte, cappuccino, americano, cortado) unless the guest asks what it is.",
    )
  })

  it('carves out unfamiliar items as the place description belongs', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      "Save description for something the guest hasn't had or wouldn't recognize.",
    )
  })

  it('contains no em or en dashes inside the rule body (R3 self-consistency)', () => {
    const start = SYSTEM_TEMPLATE.indexOf("Don't explain what a standard, widely known drink is")
    const end = SYSTEM_TEMPLATE.indexOf("When naming what's in a menu item")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(SYSTEM_TEMPLATE.slice(start, end)).not.toMatch(/[—–]/)
  })
})

describe('SYSTEM_TEMPLATE — R25: clause, not a bare comma list, for menu ingredients (TAC-348)', () => {
  it('directs folding ingredients into a sentence', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      "When naming what's in a menu item, fold the ingredients into a sentence rather than listing them.",
    )
  })

  it('bans a bare comma-separated component list, with a worked example', () => {
    expect(SYSTEM_TEMPLATE).toContain("'a latte with oat milk and a shot of vanilla' reads as venue voice")
    expect(SYSTEM_TEMPLATE).toContain("'Latte. Oat milk, vanilla.' reads like a spec sheet")
    expect(SYSTEM_TEMPLATE).toContain("Don't drop into a bare comma-separated list of components.")
  })

  it('does not reintroduce the retired R12 worked example', () => {
    // This content used to live inside R12 (message splitting, TAC-313),
    // deleted wholesale when TAC-319 retired that rule. Confirms the
    // re-promoted content uses a fresh example, not the old one.
    expect(SYSTEM_TEMPLATE).not.toContain('Frosty Gandhi')
  })

  it('contains no em or en dashes inside the rule body (R3 self-consistency)', () => {
    const start = SYSTEM_TEMPLATE.indexOf("When naming what's in a menu item")
    const end = SYSTEM_TEMPLATE.indexOf('When recommending items, offer at most two')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(SYSTEM_TEMPLATE.slice(start, end)).not.toMatch(/[—–]/)
  })
})

describe('SYSTEM_TEMPLATE — R26: recommend at most two, vary phrasing, describe the unfamiliar one (TAC-348)', () => {
  it('caps recommendations at two', () => {
    expect(SYSTEM_TEMPLATE).toContain('When recommending items, offer at most two.')
  })

  it('directs varied phrasing across messages, without an unverifiable popularity claim', () => {
    expect(SYSTEM_TEMPLATE).toContain("'try the X', 'X is good if you want something Y'")
    // Dropped in plan review: claims a popularity the agent can't actually know.
    expect(SYSTEM_TEMPLATE).not.toContain('a lot of people like X')
  })

  it('directs describing only the unfamiliar item', () => {
    expect(SYSTEM_TEMPLATE).toContain("Briefly describe any item the guest hasn't had before; skip the description for something they already know.")
  })

  it('contains no em or en dashes inside the rule body (R3 self-consistency)', () => {
    const start = SYSTEM_TEMPLATE.indexOf('When recommending items, offer at most two')
    const end = SYSTEM_TEMPLATE.indexOf('When you are speaking as a specific named person')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(SYSTEM_TEMPLATE.slice(start, end)).not.toMatch(/[—–]/)
  })
})

describe('SYSTEM_TEMPLATE — R27: never third-person yourself as a named person (TAC-348)', () => {
  it('bans self-reference by name or in the third person, scoped to speaking-as-a-named-person', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'When you are speaking as a specific named person (the persona has a name), never refer to yourself by that name or in the third person.',
    )
  })

  // TAC-348 code review: the first draft used real pilot venue names
  // (Himanshu, Sana) here, violating the ticket's own "no venue-specific
  // names" acceptance criterion — SYSTEM_TEMPLATE renders into EVERY
  // venue's prompt, so a real name from one venue would have leaked into
  // every other venue's system prompt. Fixed to a generic [Name] placeholder
  // before shipping; this test guards against reintroducing a real name.
  it('names the failure pattern with a generic placeholder, no real venue-specific name', () => {
    expect(SYSTEM_TEMPLATE).toContain("'let me check with [Name]'")
    expect(SYSTEM_TEMPLATE).toContain("'[Name] said to try the cortado'")
    expect(SYSTEM_TEMPLATE).toContain('when you ARE [Name] is wrong')
    expect(SYSTEM_TEMPLATE).not.toContain('Himanshu')
    expect(SYSTEM_TEMPLATE).not.toMatch(/'Sana said to try/)
  })

  it('carves out referring to OTHER staff by name as fine — this is a self-reference rule only', () => {
    expect(SYSTEM_TEMPLATE).toContain('Referring to OTHER staff by name is fine; this rule is only about referring to yourself.')
  })

  it('contains no em or en dashes inside the rule body (R3 self-consistency)', () => {
    const start = SYSTEM_TEMPLATE.indexOf('When you are speaking as a specific named person')
    const end = SYSTEM_TEMPLATE.indexOf('Never criticize, blame, or speak negatively about a staff member')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(SYSTEM_TEMPLATE.slice(start, end)).not.toMatch(/[—–]/)
  })
})

describe('SYSTEM_TEMPLATE — R28: never blame or criticize staff to a guest (TAC-348)', () => {
  it('bans criticizing, blaming, or speaking negatively about staff, named or unnamed', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'Never criticize, blame, or speak negatively about a staff member to a guest, named or unnamed, even while acknowledging a mistake',
    )
  })

  it('names the observed failure phrase and directs ownership without blame', () => {
    expect(SYSTEM_TEMPLATE).toContain("'that response from the barista wasn't okay' is not acceptable")
    expect(SYSTEM_TEMPLATE).toContain('Take ownership of the outcome without assigning blame to a person.')
  })

  // TAC-356 appended R29-R31 after R28, so R28 is no longer the LAST bullet
  // in the block. Rewritten to pin adjacency to the new rules instead of
  // asserting R28 is terminal — same treatment R22's own test got in
  // TAC-348 when R23-R28 landed after it. TAC-359 appended R32-R34 after
  // that, so the count grows again.
  it('is immediately followed by exactly R29-R34, then # Voice imperative (TAC-359)', () => {
    const r28Idx = SYSTEM_TEMPLATE.indexOf('Never criticize, blame, or speak negatively about a staff member')
    const voiceImperativeIdx = SYSTEM_TEMPLATE.indexOf('# Voice imperative')
    expect(r28Idx).toBeGreaterThan(-1)
    expect(voiceImperativeIdx).toBeGreaterThan(r28Idx)
    const between = SYSTEM_TEMPLATE.slice(r28Idx, voiceImperativeIdx).trim()
    // R28 itself, plus R29-R34 — exactly seven bullet lines, then nothing
    // but whitespace before the heading.
    expect(between.split('\n').filter((line) => line.trim().length > 0)).toHaveLength(7)
  })

  it('contains no em or en dashes inside the rule body (R3 self-consistency)', () => {
    const start = SYSTEM_TEMPLATE.indexOf('Never criticize, blame, or speak negatively about a staff member')
    const end = SYSTEM_TEMPLATE.indexOf('A sentence fragment is fine when it reads naturally')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(SYSTEM_TEMPLATE.slice(start, end)).not.toMatch(/[—–]/)
  })
})

// R29-R31 (TAC-356): three more rules mined the same way TAC-348 mined
// R23-R28 — misfiled as venue-specific on Mock Sextant when they're true at
// any venue. See system-template.ts's v1.43.0 changelog for the full audit
// against the first-touch intentions opener and every category instruction
// file, including the two dropped-nothing outcome and the one scoping
// carve-out (R30 against the `unknown` category).
describe('SYSTEM_TEMPLATE — R29: sentence fragments are permitted, not mandated (TAC-356)', () => {
  it('permits a fragment with the worked example', () => {
    expect(SYSTEM_TEMPLATE).toContain('A sentence fragment is fine when it reads naturally.')
    expect(SYSTEM_TEMPLATE).toContain("'Open until 3' beats 'We are open until 3pm today.'")
  })

  it('states this is permission, not a mandate, and defers to a full-sentence venue voice', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'This is permission, not a preference: it does not ask you to clip every reply short, and it never overrides this venue\'s own voice.',
    )
    expect(SYSTEM_TEMPLATE).toContain(
      "If the venue's persona and corpus write in full sentences, keep writing full sentences.",
    )
  })

  it('contains no em or en dashes inside the rule body (R3 self-consistency)', () => {
    const start = SYSTEM_TEMPLATE.indexOf('A sentence fragment is fine when it reads naturally')
    const end = SYSTEM_TEMPLATE.indexOf("If a guest's message is unclear")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(SYSTEM_TEMPLATE.slice(start, end)).not.toMatch(/[—–]/)
  })
})

describe('SYSTEM_TEMPLATE — R30: ask what a guest means rather than guess (TAC-356)', () => {
  it('directs asking rather than guessing or defaulting to something generic', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      "ask what they mean rather than guess at an interpretation or answer with something generic that does not actually engage with what they said.",
    )
    expect(SYSTEM_TEMPLATE).toContain('a vague reference, a typo that changes the meaning, wording that could go two ways')
  })

  // This is the one real interaction the audit found: unknown.ts's
  // classifier-driven holding response is a different, system-decided kind
  // of "unclear" (routing confidence, not content ambiguity) and must not
  // read as in tension with this rule. Scoped explicitly in the rule body,
  // the same technique R23 used against R15.
  it('is explicitly scoped against the unknown category so the two do not collide', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      "This is separate from the classifier's own low-confidence routing: when the message has already been classified 'unknown,' follow that category's holding response instead of asking here.",
    )
  })

  it('contains no em or en dashes inside the rule body (R3 self-consistency)', () => {
    const start = SYSTEM_TEMPLATE.indexOf("If a guest's message is unclear")
    const end = SYSTEM_TEMPLATE.indexOf('Do not name a specific product')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(SYSTEM_TEMPLATE.slice(start, end)).not.toMatch(/[—–]/)
  })
})

describe('SYSTEM_TEMPLATE — R31: no product names in reply to a greeting or content-less message (TAC-356)', () => {
  it('bans naming a specific product in reply to a greeting or content-less message, with a reply-in-kind directive', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'Do not name a specific product (a drink, a bean, a menu item) in reply to a greeting or to any message that carries no question and no content of its own',
    )
    expect(SYSTEM_TEMPLATE).toContain('Reply in kind and stop.')
  })

  // Audited against the first-touch opener (TAC-324/329): the opener only
  // ever asks a question, never names a product, so the two are compatible
  // by construction. This carve-out states that compatibility in the rule
  // body itself rather than leaving it to be inferred.
  it('does not restrict a question asked back, or answering once the guest actually asks or orders something', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      "This does not restrict a question you ask back, like the first-touch opener's question about whether this is the guest's first visit.",
    )
    expect(SYSTEM_TEMPLATE).toContain(
      'It also does not restrict answering once the guest actually asks or orders something.',
    )
  })

  // TAC-359 appended R32-R34 after R31, so R31 is no longer the LAST bullet
  // in the block. Rewritten to pin adjacency instead of asserting R31 is
  // terminal — same treatment R22's and R28's own tests got when rules
  // landed after them.
  it('is immediately followed by exactly R32, R33, R34, then # Voice imperative (TAC-359)', () => {
    const r31Idx = SYSTEM_TEMPLATE.indexOf('Do not name a specific product')
    const voiceImperativeIdx = SYSTEM_TEMPLATE.indexOf('# Voice imperative')
    expect(r31Idx).toBeGreaterThan(-1)
    expect(voiceImperativeIdx).toBeGreaterThan(r31Idx)
    const between = SYSTEM_TEMPLATE.slice(r31Idx, voiceImperativeIdx).trim()
    // R31 itself, plus R32-R34 — exactly four bullet lines, then nothing but
    // whitespace before the heading.
    expect(between.split('\n').filter((line) => line.trim().length > 0)).toHaveLength(4)
  })

  it('contains no em or en dashes inside the rule body (R3 self-consistency)', () => {
    const start = SYSTEM_TEMPLATE.indexOf('Do not name a specific product')
    const end = SYSTEM_TEMPLATE.indexOf('Never tell the guest to send a message')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(SYSTEM_TEMPLATE.slice(start, end)).not.toMatch(/[—–]/)
  })
})

// R32-R34 (TAC-359): three more rules mined the same way TAC-348 mined
// R23-R28 and TAC-356 mined R29-R31 — misfiled as venue-specific on Le
// Mil's when they're true at any venue. See system-template.ts's v1.44.0
// changelog for the full audit, including the invite_contact_save
// compatibility check (R32), the render-order rationale for directing
// rather than prohibiting (R33), and the two R34 carve-outs plus the
// genericization fix applied during review (an early draft leaked a
// venue-specific drink name and assumed counter service).
describe('SYSTEM_TEMPLATE — R32: already in the conversation (TAC-359)', () => {
  it('bans telling the guest to message, reach out, or get in touch as a separate action', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'Never tell the guest to send a message, reach out, or get in touch as if that were a separate, future action.',
    )
    expect(SYSTEM_TEMPLATE).toContain('If you have a question, ask it directly and expect the answer here.')
  })

  // Checked against lib/agent/intentions/definitions.ts's invite_contact_save,
  // which legitimately invites a guest to save the number and text again
  // later — a blanket ban would fight it. Not assertable against
  // SYSTEM_TEMPLATE alone since the intention text lives in a different
  // module; the carve-out sentence below is the compatibility mechanism.
  it('carries an explicit carve-out for inviting future contact, and a boundary against the alt-channels rule', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'It also does not restrict inviting them to save this number or text again in the future for a different visit.',
    )
    expect(SYSTEM_TEMPLATE).toContain(
      'This is different from the alternative-channels rule above, which is about routing the guest elsewhere.',
    )
  })

  it('contains no em or en dashes inside the rule body (R3 self-consistency)', () => {
    const start = SYSTEM_TEMPLATE.indexOf('Never tell the guest to send a message')
    const end = SYSTEM_TEMPLATE.indexOf('When venue knowledge describes a first-visit order')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(SYSTEM_TEMPLATE.slice(start, end)).not.toMatch(/[—–]/)
  })
})

describe('SYSTEM_TEMPLATE — R33: first-visit recommendation shape (TAC-359)', () => {
  it('directs compressing a sequence to one step rather than prohibiting sequences outright', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'When venue knowledge describes a first-visit order as a sequence or progression, recommend only the first step.',
    )
    expect(SYSTEM_TEMPLATE).toContain('do not name items the knowledge marks as unavailable or coming soon')
  })

  it('bans naming a bundled-free item as a separate recommendation', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'Never name something that already comes included with something else you just recommended in the same message',
    )
  })

  // Boundary against R26 (offer at most two items), the same technique R23
  // uses against R15: R26 governs how many, R33 governs how one is framed.
  it('states its boundary against the at-most-two-items cap (R26)', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'This is separate from the at-most-two-items cap above; that governs how many, this governs how one is framed.',
    )
  })

  it('contains no em or en dashes inside the rule body (R3 self-consistency)', () => {
    const start = SYSTEM_TEMPLATE.indexOf('When venue knowledge describes a first-visit order')
    const end = SYSTEM_TEMPLATE.indexOf('You cannot place, confirm, or take an order')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(SYSTEM_TEMPLATE.slice(start, end)).not.toMatch(/[—–]/)
  })
})

describe('SYSTEM_TEMPLATE — R34: cannot take orders (TAC-359)', () => {
  it('bans placing, confirming, or acknowledging an order, with a generic example', () => {
    expect(SYSTEM_TEMPLATE).toContain('You cannot place, confirm, or take an order.')
    expect(SYSTEM_TEMPLATE).toContain(
      "If a guest tells you the specifics of what they want ('a large oat latte, extra hot'), do not accept or acknowledge it as an order",
    )
    expect(SYSTEM_TEMPLATE).toContain('tell them to place it with the venue directly, the way this venue actually takes orders')
  })

  // Decision: a hold applies only to an item that already exists and can be
  // set aside. A made-to-order drink is not held, it is made, so prep
  // instructions stay on the order-taking side, not the hold side.
  it('carves out # Commitments holds, scoped to items that already exist', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'This does not restrict offering a comp or holding aside an item that already exists (see # Commitments).',
    )
    expect(SYSTEM_TEMPLATE).toContain(
      'A made-to-order drink is not held, it is made, so prep instructions like this stay on the order-taking side.',
    )
  })

  // TAC-323's extract-reported-order.ts fires only on past-tense reports of
  // an order already placed. Points at R21 (venue-knowledge-receiving)
  // rather than restating its content, per the redundancy pass.
  it('carves out a guest reporting an order already placed, by pointing at R21 rather than restating it', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      'It also does not restrict a guest reporting an order they already placed, which the venue-knowledge rule above already covers',
    )
  })

  it('is free of venue-specific product names and ingredients from the motivating case', () => {
    const start = SYSTEM_TEMPLATE.indexOf('You cannot place, confirm, or take an order')
    const end = SYSTEM_TEMPLATE.indexOf('# Voice imperative')
    const body = SYSTEM_TEMPLATE.slice(start, end).toLowerCase()
    for (const term of ['sofi', 'masala jaggery', 'jaggery', 'pink panther', 'khari', 'nankhatai']) {
      expect(body).not.toContain(term)
    }
  })

  it('is the last bullet in the universal block, immediately before # Voice imperative', () => {
    const r34Idx = SYSTEM_TEMPLATE.indexOf('You cannot place, confirm, or take an order')
    const voiceImperativeIdx = SYSTEM_TEMPLATE.indexOf('# Voice imperative')
    expect(r34Idx).toBeGreaterThan(-1)
    expect(voiceImperativeIdx).toBeGreaterThan(r34Idx)
    const between = SYSTEM_TEMPLATE.slice(r34Idx, voiceImperativeIdx).trim()
    expect(between.split('\n').filter((line) => line.trim().length > 0)).toHaveLength(1)
  })

  it('contains no em or en dashes inside the rule body (R3 self-consistency)', () => {
    const start = SYSTEM_TEMPLATE.indexOf('You cannot place, confirm, or take an order')
    const end = SYSTEM_TEMPLATE.indexOf('# Voice imperative')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(SYSTEM_TEMPLATE.slice(start, end)).not.toMatch(/[—–]/)
  })
})

describe('SYSTEM_TEMPLATE — R8 strengthened: no claiming to have personally witnessed the guest (TAC-348)', () => {
  it('bans claiming to have seen, noticed, or been with the guest, even when confirmed by their own message', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      "This includes claiming to have seen, noticed, or been with the guest, like 'I saw you earlier' or 'glad you came in today' stated as something you personally witnessed, even when the guest's own message confirms they were here.",
    )
    expect(SYSTEM_TEMPLATE).toContain(
      'You can respond to what they tell you; you cannot claim to have observed it yourself.',
    )
  })

  it('every pre-existing R8 assertion still holds (pure addition, nothing removed)', () => {
    expect(SYSTEM_TEMPLATE).toContain('Never invent details beyond what your runtime context documents')
    expect(SYSTEM_TEMPLATE).toContain('family recipe')
    expect(SYSTEM_TEMPLATE).toContain('the line is short today')
    expect(SYSTEM_TEMPLATE).toContain("If a product name isn't there, don't name it.")
  })
})

describe('SYSTEM_TEMPLATE — R11 strengthened: no flourish anywhere in the description, not just the closer (TAC-348)', () => {
  it('widens the prohibition from the closing sentence to the whole description', () => {
    expect(SYSTEM_TEMPLATE).toContain("This isn't only about the last sentence.")
    expect(SYSTEM_TEMPLATE).toContain(
      'Describe an item plainly the first time too: say what\'s good once, in one clause, and stop.',
    )
  })

  it('gives a worked example of a mid-description flourish', () => {
    expect(SYSTEM_TEMPLATE).toContain(
      "'The oat latte has a really lovely, rounded sweetness to it' is the same flourish as a sentiment closer, just moved earlier in the sentence.",
    )
  })

  it('every pre-existing R11 assertion still holds (pure addition, nothing removed)', () => {
    expect(SYSTEM_TEMPLATE).toContain('trust me on this one')
    expect(SYSTEM_TEMPLATE).toContain('Those are the shape to avoid, not a fixed list')
    expect(SYSTEM_TEMPLATE).toContain('Let it stand')
  })
})

// TAC-348 decision (d): replaces the informal "we do NOT assert
// display-count === template-bullet-count" comment with an enforced
// classification-completeness guard. Every ACTUAL bullet line in
// SYSTEM_TEMPLATE's `# Universal voice rules` section must be explicitly
// classified as displayed (UNIVERSAL_RULES_DISPLAY) or undisplayed
// (UNIVERSAL_RULES_UNDISPLAYED) — not a count-equality assertion against the
// template (which would force every mechanical/rendering-timing bullet onto
// the operator rail), but a completeness assertion that a future rule
// addition can't silently skip classifying itself into either list.
describe('SYSTEM_TEMPLATE — universal rule classification completeness (TAC-348)', () => {
  it('every bullet line in the block is classified as displayed or undisplayed, with no overlap', () => {
    const blockStart = SYSTEM_TEMPLATE.indexOf('# Universal voice rules')
    const blockEnd = SYSTEM_TEMPLATE.indexOf('# Voice imperative')
    expect(blockStart).toBeGreaterThan(-1)
    expect(blockEnd).toBeGreaterThan(blockStart)
    const block = SYSTEM_TEMPLATE.slice(blockStart, blockEnd)
    const bulletLines = block.split('\n').filter((line) => line.startsWith('- '))

    const displayedIds = UNIVERSAL_RULES_DISPLAY.map((r) => r.id)
    const undisplayedIds = UNIVERSAL_RULES_UNDISPLAYED
    const allClassifiedIds = [...displayedIds, ...undisplayedIds]

    // No id classified twice.
    expect(new Set(allClassifiedIds).size).toBe(allClassifiedIds.length)
    // Every actual bullet line has a classification, and vice versa — the
    // combined classified set is exactly as large as the actual bullet count.
    expect(allClassifiedIds).toHaveLength(bulletLines.length)
  })

  // Code review (TAC-348): the count+no-duplicates check above would still
  // pass if UNIVERSAL_RULES_UNDISPLAYED held the right COUNT of ids but a
  // wrong one (a typo, a swapped id) — the displayed side's exact sequence
  // is already pinned by the lockstep test above, so pinning the undisplayed
  // side's exact set here closes that gap completely.
  it('UNIVERSAL_RULES_UNDISPLAYED is exactly the mechanical/rendering-timing rule ids', () => {
    expect([...UNIVERSAL_RULES_UNDISPLAYED].sort()).toEqual([
      'R13', 'R14', 'R15', 'R16', 'R19', 'R20', 'R22',
    ])
  })
})
