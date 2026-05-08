// Hardcoded display labels for the universal voice rules R1–R10.
//
// COUPLING NOTE: these mirror the bullets under "# Universal voice rules"
// in lib/ai/prompts/system-template.ts. When the SYSTEM_TEMPLATE rules are
// edited (renumbered, reworded, added, removed), this constant must move
// in lockstep — there is currently no structured rules registry. Tracking
// follow-up to extract one (THE-237 follow-up: "structured rules registry").
//
// Rendering: each rule shows in the rail's "Universal · 10 (locked)"
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
      "If you don't have a confident answer, say so directly. Don't pivot to unrelated venue info as a deflection.",
  },
  {
    id: 'R10',
    summary:
      "When recommending other venues, only name places explicitly mentioned in the venue spec or recommendations data. Don't invent plausible-sounding names.",
  },
]
