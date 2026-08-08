// Hardcoded display labels for the universal voice rules R1–R12.
//
// COUPLING NOTE: these mirror the bullets under "# Universal voice rules"
// in lib/ai/prompts/system-template.ts. When the SYSTEM_TEMPLATE rules are
// edited (renumbered, reworded, added, removed), this constant must move
// in lockstep — there is currently no structured rules registry. Tracking
// follow-up to extract one (THE-237 follow-up: "structured rules registry").
// The system template carries three further guidance bullets after R12
// (greeting / operator-instruction / Last-Visit, numbered R13-R15 in
// system-template.test.ts); those are intentionally NOT surfaced here, so
// this curated list runs R1-R12. The lockstep test in
// system-template.test.ts asserts the IDs here are contiguous and that the
// R11 and R12 anchor phrases are present in both this constant and
// SYSTEM_TEMPLATE.
//
// TAC-313 added R12 (message splitting) as the 12th bullet, shifting
// greeting / operator / Last-Visit from R12-R14 to R13-R15. It is displayed
// rather than left in the undisplayed tail because splitting is message form,
// which is what operators tune on this rail.
//
// Rendering: each rule shows in the rail's "Universal · 12 (locked)"
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
      "A reply carrying more than one distinct beat arrives as separate messages — a pick and its description are two beats, two picks are two beats. A short factual answer stays one message. Splitting is the exception; most replies stay single.",
  },
]
