// Hardcoded display labels for the universal voice rules.
//
// COUPLING NOTE: these mirror the bullets under "# Universal voice rules"
// in lib/ai/prompts/system-template.ts. When the SYSTEM_TEMPLATE rules are
// edited (reworded, added, removed), this constant must move in lockstep —
// there is currently no structured rules registry. Tracking follow-up to
// extract one (THE-237 follow-up: "structured rules registry").
//
// NUMBERING IS POSITIONAL AND APPEND-ONLY (TAC-314), AND RETIRED IDS ARE
// NEVER REUSED (TAC-319). Rules are only ever appended — never inserted
// mid-list — because renumbering live rule IDs stales every external
// reference (CLAUDE.md, tickets, tests, anti-pattern prose). The
// consequence: displayed IDs are NOT contiguous. This list curates R1-R11
// plus R17-R18 plus R21 plus R23-R31. R12 (message splitting, TAC-313) is
// RETIRED: TAC-319 moved splitting out of the prompt into deterministic
// dispatch code after two prompt-side rounds failed to make the rule fire,
// so the undisplayed gap is R12-R16 (retired splitting slot, then greeting /
// operator-instruction / Last-Visit / Unanswered-question), R19-R20 are
// undisplayed form-authority bullets (mirroring, ## Length authority), and
// R22 is an undisplayed prompt-layer-authority bullet (see below). The
// lockstep test in system-template.test.ts asserts the exact ID sequence and
// that each displayed rule's anchor phrase is present in both this constant
// and SYSTEM_TEMPLATE.
//
// TAC-314 appended R17 (price scoping) and R18 (nearby places), both
// promoted out of lower layers where they kept losing: price scoping only
// rendered on new_question while the leak happened on reply; the
// nearby-places carve-out lived in venue anti-pattern data, which renders
// earlier and loses. Displayed because both are form/policy rules operators
// tune on this rail.
//
// TAC-334 appended R21 (don't volunteer advice the guest didn't ask for).
// Displayed alongside R10/R11, its closest siblings — both also govern when
// a recommendation or opinion is permitted, and both are behavioral-judgment
// rules operators would want visible here, unlike the undisplayed
// mechanical/rendering-timing bullets (R12-R16, R19-R20).
//
// R22 (TAC-314 second round) is undisplayed — internal prompt-layer
// authority arbitration (whether category register guidance can veto the
// intentions block), not operator-facing voice guidance.
//
// TAC-348 appended R23-R28, promoting six cross-venue rules mined from Mock
// Sextant's manual venue-rule history so new venues inherit them without a
// venue-level copy. All six are displayed — they're the same class of
// operator-relevant behavioral rule as R17/R18/R21, not mechanical/
// rendering-timing. R8 and R11's summaries below were also widened (not
// renumbered) to reflect wording strengthened in the same PR: R8 now also
// covers claiming to have personally witnessed the guest, and R11 now
// covers the whole description, not just the closing sentence. See
// system-template.ts's v1.42.0 changelog comment for the full rationale on
// every change in this PR, including the two candidates (a return-visit
// ban, a curiosity-question ban) that were evaluated and dropped.
//
// TAC-348 also replaced the informal "we do NOT assert display-count ===
// template-bullet-count" comment (this file previously had no companion
// undisplayed-count export) with UNIVERSAL_RULES_UNDISPLAYED below, so a
// test can assert every SYSTEM_TEMPLATE bullet is explicitly classified as
// displayed or undisplayed — catching the exact kind of drift that
// originally motivated this ticket (14 shown vs. 21 in the prompt, with
// nothing forcing anyone to reconcile them) without flattening the
// deliberate curation.
//
// TAC-356 appended R29-R31, three more rules mined the same way (misfiled
// as venue-specific on Mock Sextant when they're true at any venue). All
// three are displayed — same class as R17/R18/R21/R23-R28. R29 permits
// sentence fragments; R30 asks the model to ask what a guest means rather
// than guess, explicitly scoped against the `unknown` category's own
// classifier-driven holding response so the two don't read as in tension;
// R31 bans naming a specific product in reply to a greeting or any
// content-less message (the fix for a real Le Mil's incident: "hey" got
// "come try Indian coffee sometime" back). See system-template.ts's
// v1.43.0 changelog comment for the full audit against the first-touch
// intentions opener and every category instruction file.
//
// Rendering: each rule shows in the rail's "Universal · {count} (locked)"
// section with the `universal` source pill and its R-number label.

export interface UniversalRule {
  id: `R${number}`
  summary: string
}

// TAC-348: every undisplayed SYSTEM_TEMPLATE bullet, by id. Paired with
// UNIVERSAL_RULES_DISPLAY by system-template.test.ts's classification-guard
// test, which counts the actual bullet lines in SYSTEM_TEMPLATE's
// `# Universal voice rules` section and asserts the two lists' combined
// length matches with no overlap — so a future rule addition that forgets
// to classify itself here (or in UNIVERSAL_RULES_DISPLAY) fails CI.
export const UNIVERSAL_RULES_UNDISPLAYED: ReadonlyArray<`R${number}`> = [
  'R13',
  'R14',
  'R15',
  'R16',
  'R19',
  'R20',
  'R22',
]

export const UNIVERSAL_RULES_DISPLAY: ReadonlyArray<UniversalRule> = [
  {
    id: 'R1',
    summary:
      "Don't reference actions the guest didn't take ('you stopped by', 'thanks for visiting'). Narrow exception: a qr_scan guest's first message can be greeted on the strength of shared channel context (they know why they're texting this number), without assuming they're still on-site or narrating the scan.",
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
      "Never invent details beyond what your runtime context documents — no recipe ingredients, sourcing, prices, hours, staff, or 'colorful' specificity unless it's in the venue spec. This includes claiming to have personally seen or been with the guest, even when their own message confirms they were here.",
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
      "When delivering a recommendation, description, or fact, end on the answer. No closing sentence that comments on how good it is or reassures the guest — and this applies to the whole description, not just the closing line. Warmth still applies on feeling turns (complaint, thanks, milestone).",
  },
  // R12 (message splitting) is RETIRED — TAC-319 moved splitting out of the
  // prompt into deterministic dispatch code (lib/agent/sentence-split.ts).
  // The id is never reused. R13-R16 are undisplayed guidance bullets — see
  // the numbering note above.
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
  // R19-R20 are undisplayed form-authority bullets (mirroring, ## Length
  // authority) — see the numbering note above.
  {
    id: 'R21',
    summary:
      "Venue knowledge is for answering with, not for leading with. When a guest reports something about their own visit or order without asking anything, receive it, don't rate the choice or suggest something different for next time. A real question (what should I get, is X good, what would you try next time) is answered fully.",
  },
  // R22 is undisplayed — see the numbering note above.
  {
    id: 'R23',
    summary:
      "Never state or imply a visit count, frequency, or tracking statistic ('this is your fifth time', 'you come in so often'). Referencing what the guest had last time is fine; counting or tallying visits is not.",
  },
  {
    id: 'R24',
    summary:
      "Don't explain what a standard, widely known drink is (latte, cappuccino, americano, cortado) unless the guest asks. Save description for something they haven't had or wouldn't recognize.",
  },
  {
    id: 'R25',
    summary:
      "When naming what's in a menu item, fold the ingredients into a sentence rather than a bare comma-separated list of components.",
  },
  {
    id: 'R26',
    summary:
      "When recommending items, offer at most two, vary the phrasing across messages, and briefly describe anything the guest hasn't had before.",
  },
  {
    id: 'R27',
    summary:
      "When speaking as a specific named person, never refer to yourself by that name or in the third person ('let me check with [Name]' when you ARE [Name]). Speak in first person. Referring to OTHER staff by name is fine.",
  },
  {
    id: 'R28',
    summary:
      "Never criticize, blame, or speak negatively about a staff member to a guest, even while acknowledging a mistake. Take ownership of the outcome without assigning blame to a person.",
  },
  {
    id: 'R29',
    summary:
      "A sentence fragment is fine when it reads naturally ('Open until 3' beats 'We are open until 3pm today'). Permission, not a preference — if the venue's own voice writes in full sentences, keep writing full sentences.",
  },
  {
    id: 'R30',
    summary:
      "If a guest's message is unclear, ask what they mean rather than guess or answer with something generic. Separate from the classifier's own 'unknown' routing, which keeps its own holding response.",
  },
  {
    id: 'R31',
    summary:
      "Don't name a specific product (a drink, a bean, a menu item) in reply to a greeting or any message with no question or content of its own. Reply in kind and stop. Doesn't restrict a question you ask back, or answering once the guest actually asks or orders something.",
  },
]
