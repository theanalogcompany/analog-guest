// Hardcoded display labels for the universal voice rules.
//
// COUPLING NOTE: these mirror the bullets under "# Universal voice rules"
// in lib/ai/prompts/system-template.ts. When the SYSTEM_TEMPLATE rules are
// edited (reworded, added, removed), this constant must move in lockstep —
// there is currently no structured rules registry. Tracking follow-up to
// extract one (THE-237 follow-up: "structured rules registry").
//
// NUMBERING IS POSITIONAL AND APPEND-ONLY (TAC-314). An R-number is the
// bullet's position in the template block, and rules are only ever APPENDED —
// never inserted mid-list — because renumbering live rule IDs stales every
// external reference (CLAUDE.md, tickets, tests, anti-pattern prose). The
// consequence: displayed IDs are NOT contiguous. This list curates R1-R12
// plus R17-R18; R13-R16 are the four undisplayed guidance bullets (greeting /
// operator-instruction / Last-Visit / Unanswered-question) and R19-R20 are
// undisplayed form-authority bullets (mirroring, ## Length authority). The
// lockstep test in system-template.test.ts asserts the exact ID sequence and
// that each displayed rule's anchor phrase is present in both this constant
// and SYSTEM_TEMPLATE.
//
// TAC-313 added R12 (message splitting). TAC-314 appended R17 (price
// scoping) and R18 (nearby places), both promoted out of lower layers where
// they kept losing: price scoping only rendered on new_question while the
// leak happened on reply; the nearby-places carve-out lived in venue
// anti-pattern data, which renders earlier and loses. Displayed because both
// are form/policy rules operators tune on this rail. TAC-319 rewrote R12's
// beat taxonomy to the two-job test (v1.30.0); the summary here shares the
// verbatim anchor "one complete job" with the template bullet, asserted by
// the lockstep test.
//
// Rendering: each rule shows in the rail's "Universal · {count} (locked)"
// section with the `universal` source pill and its R-number label.

export interface UniversalRule {
  id: `R${number}`
  summary: string
}

export const UNIVERSAL_RULES_DISPLAY: ReadonlyArray<UniversalRule> = [
  {
    id: 'R1',
    summary:
      "Don't reference actions the guest didn't take ('you stopped by', 'thanks for visiting').",
  },
  {
    id: 'R2',
    summary:
      "Default to today's specific answer when guests ask about 'now' — don't generalize.",
  },
  {
    id: 'R3',
    summary:
      'Never use em dashes (—) or en dashes (–). Use periods, commas, or shorter sentences instead.',
  },
  {
    id: 'R4',
    summary:
      "Don't reference physical artifacts the agent doesn't have ('in front of me', 'looking at it').",
  },
  {
    id: 'R5',
    summary:
      "Don't refer guests to alt channels (email, Instagram, 'next time you're in') for things the venue can answer.",
  },
  {
    id: 'R6',
    summary:
      "Answer yes/no questions with yes/no first; don't enumerate options.",
  },
  {
    id: 'R7',
    summary:
      "Don't restate context already covered earlier in the conversation.",
  },
  {
    id: 'R8',
    summary:
      "Never invent details beyond what your runtime context documents — no recipe ingredients, sourcing, prices, hours, staff, or 'colorful' specificity unless it's in the venue spec.",
  },
  {
    id: 'R9',
    summary:
      "When you don't have a confident answer, don't pivot to unrelated venue info as a deflection — and never promise to find out and get back to them, or name a time an answer will arrive.",
  },
  {
    id: 'R10',
    summary:
      "When recommending other venues, only name places explicitly mentioned in the venue spec or recommendations data. Don't invent plausible-sounding names.",
  },
  {
    id: 'R11',
    summary:
      "When delivering a recommendation, description, or fact, end on the answer. No closing sentence that comments on how good it is or reassures the guest. Warmth still applies on feeling turns (complaint, thanks, milestone).",
  },
  {
    id: 'R12',
    summary:
      "A reply carrying more than one distinct beat arrives as separate messages. A beat is one complete job: a pick and its description are two beats, a definition and its comparison are two beats even when short. A single-job answer stays one message.",
  },
  // R13-R16 are undisplayed guidance bullets — see the numbering note above.
  {
    id: 'R17',
    summary:
      "Price is not part of an answer unless the guest asked what something costs. Describing a drink is not asking its price.",
  },
  {
    id: 'R18',
    summary:
      "Documented nearby places are in-domain: name them and speak with the same confidence you'd use about the menu, no hedge. Hedge only when nothing is documented, and never fill the gap from general knowledge.",
  },
]
