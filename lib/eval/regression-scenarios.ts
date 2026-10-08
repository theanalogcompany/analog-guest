// The regression scenario set, the overlay resolution, and the one verdict
// definition.
//
// REGRESSION_SCENARIOS below IS the set. A scenario's definition - script,
// bars, ceilings, lesson - lives here and nowhere else, so adding a test
// case is an edit to this array, reviewed in the PR that changes the
// template, with no SQL and no migration (decision 0011, migration 077).
//
// `regression_scenarios` in Postgres is an OVERLAY carrying one field,
// `enabled`, so a case can be silenced from /admin/regression without a
// deploy. `resolveScenarios` is the only place that merge happens; the
// harness and the admin loader both call it, so the two surfaces cannot
// disagree about which scenarios are live.
//
// It used to be the other way round - the table held definitions and this
// array was a fallback - and a scenario added here alone was inert, silently,
// because the fallback fires on an unreadable or empty table and never on a
// merely incomplete one. Two false greens in two days came from that
// (migrations 071 and 072 headers hold the measurements). The inversion is
// what makes a code-only scenario impossible to lose.
//
// `scenarioVerdict` is shared between the harness (which computes and stores
// verdicts) and anything re-deriving them, so two surfaces cannot disagree
// about what a pass is. Every measured lesson in lib/ai/v2/template.ts's
// changelog has a scenario here; a new lesson ships with a new scenario in
// the same change (.claude/rules/v2-template-regression.md).
//
// Pure module: no SDK init and no DB client, importable by path from scripts
// and app code alike. The one value import is the Zod schema, which pulls in
// nothing but zod.

import {
  type RegressionSample,
  type RegressionScenario,
  RegressionScenarioSchema,
} from '@/lib/schemas/regression'

/**
 * What each Layer A tell actually means - the failure, not just the key.
 * Shared by the harness output and /admin/regression so a breach line always
 * says what broke and which lesson it guards. Keys are the strings the
 * harness writes into RegressionBreach.tell; totality is enforced by the
 * union + `satisfies`, so adding a tell without a description fails tsc.
 */
export type RegressionTell =
  | 'emoji'
  | 'dash'
  | 'call-you'
  | 'how-can-i-help'
  | 'what-can-i-do'
  | 'two-questions'
  | 'either-or'
  | 'off-channel-redirect'

export const REGRESSION_TELL_DESCRIPTIONS = {
  emoji:
    'emoji in a guest-facing reply - the template bans emoji outright (v2.7.0; emoji cadence was the loudest AI tell)',
  dash: 'em dash or spaced en dash survived the output normalizer - AI typography a human texter never types',
  'call-you':
    'scripted assistant name-ask ("what should I call you?") instead of a natural name exchange (v2.8.0 lesson)',
  'how-can-i-help':
    'RETIRED TELL (owner-ruled 2026-10-05: okay to ask). Was: service-desk register ("how can I help?") where a host welcome belongs (v2.2.0 lesson). Kept so stored breaches from older runs still render',
  'what-can-i-do':
    'RETIRED TELL (owner-ruled 2026-10-05: okay to ask). Was: service-desk register ("what can I do for you?") where a host welcome belongs (v2.2.0 lesson). Kept so stored breaches from older runs still render',
  'two-questions':
    'question stacking - two SUBSTANTIVE questions in one bubble, or three-plus across the reply. A social check-in is not a substantive question (owner-ruled 2026-10-06 on "Alex, nice to meet you. how was this morning? what did you get?" - technically two, meaningfully one). Substantive-vs-phatic is a Jev judgment, not a pattern match: clause extraction stays deterministic, the classification is semantic (lib/eval/question-substance.ts). Rhetorical tags ("right?") are not questions, and one body question plus the own-bubble getting-to-know-you question is the decision-0007 shape and fine (owner-ruled 2026-10-05; v2.8.0 lesson)',
  'off-channel-redirect':
    'sent the guest to Instagram for something askable right here - the guest IS on Instagram (template v2.12.0). Deliberately narrow: only the preposition-led redirect forms ("through Instagram", "via Instagram", "DM us") and never the bare "on Instagram", which is how a legitimate announcement reads ("the date is posted on our Instagram"). An under-counting tell leaves a breach unseen; an over-counting one fails a correct reply, and the announcement form is the common case',
  'either-or':
    'hedged either/or question ("anything catch your eye, or want a nudge in a direction?") - an AI tell, a question asking permission for its own alternative. The normalizer strips the ", or ...?" tail at the generation seam, so a hit here means the strip missed (owner-ruled 2026-10-05)',
} satisfies Record<RegressionTell, string>

/** Falls back to the raw key for tells stored before a description existed. */
export function describeTell(tell: string): string {
  return tell in REGRESSION_TELL_DESCRIPTIONS
    ? REGRESSION_TELL_DESCRIPTIONS[tell as RegressionTell]
    : tell
}

/**
 * Every regression scenario, in author order. THE source of truth: nothing
 * reads a definition from the database. A retired scenario stays here with
 * `enabled: false` rather than being deleted - it is the record of a lesson
 * that was once measured, and its key still appears in stored run verdicts.
 */
export const REGRESSION_SCENARIOS: RegressionScenario[] = [
  {
    key: 'bare-hey',
    lesson:
      'Pursuit without a turn-one name ask on a thin opener. The first thing a guest ever gets is a welcome, not an intake question - and pursuit still has to land on turn 2+ (template v2.4.0, turn-one-move rounds 4-5).',
    script: [
      'hey',
      'haha just saw the number at the counter, figured i would text',
    ],
    target: ['learn_name', 'understand_order'],
    expectFirstName: null,
    noTurnOneNameAsk: true,
    expectReplyContains: null,
    forbidPolicyKeys: [],
    enabled: true,
  },
  {
    key: 'hi-then-good',
    lesson:
      'The round-5 falsification case: a low-content continuation ("all good") must not stall pursuit or pull the service-desk register (turn-one-move rounds 4-5). find_their_thing counts: on a guest with no order yet, a pointer offer is pursuit, not a stall (owner-ruled 2026-10-05).',
    script: ['hi', 'all good, just checking this out'],
    target: ['learn_name', 'understand_order', 'find_their_thing'],
    expectFirstName: null,
    noTurnOneNameAsk: true,
    expectReplyContains: null,
    forbidPolicyKeys: [],
    enabled: true,
  },
  {
    key: 'claude-name',
    lesson:
      'A guest named "Claude" is a guest, not the assistant. The opener invites a name exchange so the bare "Claude." lands as the answer; the bar is the assessor capturing first_name, not a judged reading (template v2.5.0).',
    script: [
      'hey! new around here, figured i should introduce myself',
      'Claude.',
    ],
    target: [],
    expectFirstName: 'Claude',
    noTurnOneNameAsk: false,
    expectReplyContains: null,
    forbidPolicyKeys: [],
    enabled: true,
  },
  {
    key: 'order-after-name',
    lesson:
      "The guest's message beats the stale brief: the name arrives volunteered mid-exchange, so learn_name closes and the order becomes the live aim - no re-ask (template v2.3.0).",
    script: ['hey', "i'm alex btw - was in this morning actually"],
    target: ['understand_order'],
    expectFirstName: 'Alex',
    noTurnOneNameAsk: false,
    expectReplyContains: null,
    forbidPolicyKeys: [],
    enabled: true,
  },
  {
    key: 'compliment-turn',
    lesson:
      'Register on a compliment reply - the turn that caught "what should I call you?" and two-question bursts (template v2.8.0).',
    script: ['hey', 'just had the cascara - that was something else actually'],
    target: [],
    expectFirstName: null,
    noTurnOneNameAsk: false,
    expectReplyContains: null,
    forbidPolicyKeys: [],
    enabled: true,
  },
  {
    key: 'bare-domain-link',
    lesson:
      'A bare domain in prose ("on lemils.com") is not a link, and provided_links is the CURATED venue_info.links allowlist, never derived from this turn\'s knowledge retrieval (TAC-509 rulings, lib/ai/url-detector.ts). Caught live 2026-10-05: the knowledge-derived allowlist missed the corpus\'s bare-domain form, so every draft mentioning the site queued on unverified_link at p=0.91 - and queued again on the next turn, because the gate is memoryless by design. comp_leak is forbidden too (owner-ruled 2026-10-05): "orders over $50 ship free" is a standing store policy from the knowledge, not a per-guest giveaway - it matched 3/3 before the criteria clause. The mention bar keeps this from passing vacuously on a reply that never names the site.',
    script: ['can i buy your coffee online?'],
    target: [],
    expectFirstName: null,
    noTurnOneNameAsk: false,
    expectReplyContains: 'lemils.com',
    forbidPolicyKeys: ['unverified_link', 'comp_leak'],
    enabled: true,
  },
  // ── knowledge retrieval, added 2026-10-06 with the lemils.com site ingest ──
  // Each bar is a DISTINCTIVE TOKEN that exists in exactly one corpus entry,
  // never a generic word. "Dogs are welcome" could be produced by a model
  // being agreeable about a question it cannot answer; "Butter and Rose" and
  // "Straus" cannot. That is the difference between asserting retrieval worked
  // and asserting the reply sounded right, and the whole reason these
  // scenarios exist: every one of them FAILED before the ingest, with
  // retrieval handing the model seating advice when asked about Wi-Fi.
  {
    key: 'knowledge-wifi',
    lesson:
      'Guest-phrased cafe question answered from the venue site. Pre-ingest this retrieved "window seats on weekdays for reading" - seating advice for a Wi-Fi question - because no corpus row carried the answer. The bar is "password" rather than "wifi": the entry says guests should ask the team for the current password, so the token can only come from that entry and not from a model being agreeable.',
    script: ['do u have wifi?'],
    target: [],
    expectFirstName: null,
    noTurnOneNameAsk: false,
    expectReplyContains: 'password',
    forbidPolicyKeys: [],
    enabled: true,
  },
  {
    key: 'knowledge-pastries',
    lesson:
      'Pre-ingest this retrieved "what Malenad tastes like" for a pastry question. "Butter and Rose" is the Foster City micro-bakery and appears in exactly one entry, so the bar cannot be met by a plausible guess. This fact was also one of the 11 lost when voicenote transcripts stopped being knowledge, and it is now sourced from the venue site instead (lib/rag/knowledge-source-roles.ts). MEASURED on v2.10.0 against a quorum of BAR_MIN=2: this bar hit 4/6 and 3/6 across two n=6 runs, and "Foster City" (the same entry\'s other unguessable token) 5/6 - all passing, so the bar was kept as pre-registered. This is the LOOSEST of the five knowledge bars and the one to watch. Recorded because a single sample reads it as a failure: the agent commonly answers with the full pastry list and "a micro-baker in Foster City" without naming the bakery, and the two tokens are complementary rather than nested (one run named the bakery and not the town). One such sample is not a bar failure.',
    script: ['what pastries do you have?'],
    target: [],
    expectFirstName: null,
    noTurnOneNameAsk: false,
    expectReplyContains: 'Butter and Rose',
    forbidPolicyKeys: [],
    enabled: true,
  },
  {
    key: 'knowledge-milk',
    lesson:
      'A dietary question needs the real answer, not a hedge. "Straus" is the organic A2 dairy and appears in one entry; a model with no retrieval would say "we have oat milk" or deflect, and both fail this bar. Guards the specific-fact half of retrieval rather than the register half.',
    script: ['what milk do you use?'],
    target: [],
    expectFirstName: null,
    noTurnOneNameAsk: false,
    expectReplyContains: 'Straus',
    forbidPolicyKeys: [],
    enabled: true,
  },
  {
    key: 'knowledge-cafe-address',
    lesson:
      'The fabricated-address case, and the reason for template v2.10.0. The cafe is at 1330 Polk St. That did NOT reach the prompt: run-turn.ts rendered the venue section as a 4000-char slice of the venue_info JSON, Le Mil\'s row is 22,258 chars, so the cut landed inside `menu` and menu was the only key the model ever saw. Measured 2026-10-05 on v2.9.0: "where are you located?" and "what\'s your address?" each returned a Polk Street number found nowhere in the venue\'s data, differing between two runs of the identical prompt, and the gate sent both. Retrieval cannot rescue this - the ingest added roughly ten stockist and farmers-market addresses, so all four chunks on this question are OTHER locations, and the one corpus row carrying the cafe\'s own address frames it as a grand opening on 15 August 2026, in the past. The bar is the address itself because nothing downstream can catch a fabricated fact.',
    script: ['where are you located?'],
    target: [],
    expectFirstName: null,
    noTurnOneNameAsk: false,
    expectReplyContains: '1330 Polk',
    forbidPolicyKeys: [],
    enabled: true,
  },
  {
    key: 'knowledge-outside-food',
    lesson:
      'The regression test for the self-dedupe bug. "Outside food and drinks are not permitted at Le Mil\'s cafe" was extracted correctly and then DROPPED as a 0.8966 duplicate of "walk-in only and does not take reservations" - a different fact entirely. Short policy sentences about one subject embed close because they share shape, and the numeric-and-names guard cannot save them because they carry neither. The fix is that entries from one source page are never collapsed (scripts/ingest-venue-site-pure.ts). NOTE on what this scenario now proves: the same fact is also in venue_info.amenities.notes, which template v2.10.0 renders into every prompt, so a pass no longer tells you the corpus row is back - it tells you the fact is reachable by some route. The corpus half is checked by re-crawling, not here.',
    script: ['can i bring my own food?'],
    target: [],
    expectFirstName: null,
    noTurnOneNameAsk: false,
    expectReplyContains: 'outside food',
    forbidPolicyKeys: [],
    enabled: true,
  },
  {
    key: 'recommendation-turn-one',
    lesson:
      'The OPEN taste-ask on turn one, answered. Measured 2026-10-06 on v2.10.0-draft: "what is a good first order?" returned a bare welcome 11/11 while retrieval had already handed the model the answer ("the cafe recommends SoFi with a pastry"), and the n=6 gate was GREEN throughout - all five knowledge-* scenarios are CLOSED factual questions (wifi, milk, address, outside food, pastry list), which the agent answers correctly even while broken, so nothing in the set pointed at an open recommendation. That is the template v2.11.0 defect and the reason the guest\'s own agenda became a move. The bar is a menu token because the failure names no menu item at all: broken scored 0/6, correct 5-6/6. The target set is the other half of the assertion - a fix that bought answering by killing move pursuit would pass a reply-only bar, and bare-hey alone would not catch it on an inbound that asks something.',
    script: ['what is a good first order?'],
    target: ['find_their_thing', 'understand_order', 'what_they_came_for'],
    expectFirstName: null,
    noTurnOneNameAsk: true,
    expectReplyContains: 'SoFi',
    forbidPolicyKeys: [],
    enabled: true,
  },
  {
    key: 'buyout-inquiry',
    lesson:
      'The guest is already on Instagram, so Instagram is never the answer to "where do I take this" (template v2.12.0). Caught live on Le Mil\'s: "best way to get the details sorted is through Instagram, @lemilscoffee", sent to a guest in the Instagram inbox. TWO causes, and the tell guards the one that outranks the other. The frame had carried SMS framing in three phrases since v2.0.0, so the model did not know where it was; that is fixed in copy. But the sentence itself came from a knowledge row - the ONLY buyout chunk retrieval returned for this exact script (rank 3 of 4, similarity 0.450, the others seating/laptops/landlord) - and knowledge renders in tier 1, after the frame, where it wins. That row was rewritten in place; its sibling saying "ask here" ranked below 30 on every buyout phrasing and could not have rescued it. The pricing bar is what keeps this from passing vacuously: a reply that never engages the buyout has not been tested, and "depends" is the fact all three surviving rows agree on.',
    script: ['can i rent out your space'],
    target: [],
    expectFirstName: null,
    noTurnOneNameAsk: true,
    expectReplyContains: 'depends',
    forbidPolicyKeys: [],
    enabled: true,
  },
  {
    key: 'service-desk',
    lesson:
      'RETIRED (owner-ruled 2026-10-05: the service-desk opener is okay to ask). Was: a thin opener gets a welcome, never "how can I help" / "what can I do for you" - the v2.2.0 lesson, watched since the explicit negative was cut in v2.8.0.',
    script: ['hi'],
    target: [],
    expectFirstName: null,
    noTurnOneNameAsk: true,
    expectReplyContains: null,
    forbidPolicyKeys: [],
    enabled: false,
  },
]

/** An overlay row: the only two columns `regression_scenarios` still owns. */
export interface ScenarioOverlayRow {
  key: string
  enabled: boolean
}

export interface ResolvedScenario extends RegressionScenario {
  /** True when an overlay row set `enabled`, rather than the code default. */
  enabledOverridden: boolean
}

export interface ResolvedScenarioSet {
  /** Every code scenario, in author order, with `enabled` resolved. */
  scenarios: ResolvedScenario[]
  /**
   * Overlay keys with no code definition. These do NOT run - the set is the
   * code array - and they are surfaced so an orphan row cannot sit in the
   * table looking like a guard. Reachable only by a hand-edit in Studio or
   * by deleting a scenario from the array without clearing its row.
   */
  orphanKeys: string[]
}

/**
 * Merge the code set with the overlay. The ONE definition of which scenarios
 * are live, called by both the harness and /admin/regression so the page and
 * the run cannot disagree.
 *
 * An overlay row's `enabled` wins over the code flag - that is the whole
 * point of the table, a no-deploy lever for silencing a case. Nothing else
 * about a row is read.
 */
export function resolveScenarios(
  overlay: readonly ScenarioOverlayRow[],
  scenarios: readonly RegressionScenario[] = REGRESSION_SCENARIOS,
): ResolvedScenarioSet {
  const overlayByKey = new Map(overlay.map((row) => [row.key, row]))
  const codeKeys = new Set(scenarios.map((s) => s.key))
  return {
    scenarios: scenarios.map((scenario) => {
      const row = overlayByKey.get(scenario.key)
      return {
        ...scenario,
        enabled: row?.enabled ?? scenario.enabled,
        enabledOverridden:
          row !== undefined && row.enabled !== scenario.enabled,
      }
    }),
    orphanKeys: overlay
      .map((row) => row.key)
      .filter((key) => !codeKeys.has(key)),
  }
}

/**
 * Does the code set satisfy its own schema? The array is a hand-edited
 * literal, so `tsc` checks its shape but not a key with a capital letter, an
 * empty script, or a nine-turn script. Offline boundary, so this fails
 * CLOSED and loudly at the caller: better than discovering it after an hour
 * of model calls. Returns one message per bad scenario, empty when clean.
 */
export function validateScenarioSet(
  scenarios: readonly RegressionScenario[] = REGRESSION_SCENARIOS,
): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const scenario of scenarios) {
    const parsed = RegressionScenarioSchema.strict().safeParse(scenario)
    if (!parsed.success) {
      problems.push(
        `${scenario.key}: ${parsed.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      )
    }
    if (seen.has(scenario.key)) problems.push(`${scenario.key}: duplicate key`)
    seen.add(scenario.key)
  }
  return problems
}

/**
 * The one verdict definition. Order is the severity order: a sample that
 * never ran poisons everything (a failure is never a zero), ceilings fail
 * whatever the rate, bars need their quorum.
 */
export function scenarioVerdict(
  scenario: Pick<
    RegressionScenario,
    | 'target'
    | 'expectFirstName'
    | 'noTurnOneNameAsk'
    | 'expectReplyContains'
    | 'forbidPolicyKeys'
  >,
  samples: RegressionSample[],
  barMin: number,
): string {
  const total = samples.length
  const disqualified = samples.filter((s) => s.disqualified !== null)
  if (disqualified.length > 0)
    return `DISQUALIFIED (${disqualified.length}/${total} samples failed)`

  const breached = samples.flatMap((s) => s.breaches)
  if (breached.length > 0) {
    const tells = [...new Set(breached.map((b) => b.tell))].join(', ')
    return `CEILING BREACHED (${breached.length} tell(s): ${tells})`
  }

  const turnOneAsks = samples.filter((s) => s.turnOneNameAsk).length
  if (scenario.noTurnOneNameAsk && turnOneAsks > 0)
    return `CEILING BREACHED (turn-one name ask, ${turnOneAsks}/${total})`

  if (scenario.forbidPolicyKeys.length > 0) {
    const hits = samples.flatMap((s) =>
      s.turns.flatMap((t) =>
        t.gateMatched.filter((k) => scenario.forbidPolicyKeys.includes(k)),
      ),
    )
    if (hits.length > 0)
      return `CEILING BREACHED (forbidden policy matched: ${[...new Set(hits)].join(', ')})`
  }

  if (scenario.expectFirstName !== null) {
    const captured = samples.filter(
      (s) =>
        (s.firstName ?? '').toLowerCase() ===
        scenario.expectFirstName?.toLowerCase(),
    ).length
    if (captured < total)
      return `BAR FAILED (first_name "${scenario.expectFirstName}" captured in ${captured}/${total})`
  }

  if (scenario.target.length > 0) {
    const pursuing = samples.filter((s) => s.pursued).length
    const quorum = Math.min(barMin, total)
    if (pursuing < quorum)
      return `BAR FAILED (pursuit ${pursuing}/${total}, need ${quorum})`
  }

  // The vacuity guard for gate assertions: a forbidden policy that never had
  // the chance to fire proves nothing, so the scenario also bars on the
  // reply actually mentioning the thing under test.
  if (scenario.expectReplyContains !== null) {
    const needle = scenario.expectReplyContains.toLowerCase()
    const mentioning = samples.filter((s) =>
      s.turns.some((t) =>
        t.reply.some((b) => b.toLowerCase().includes(needle)),
      ),
    ).length
    const quorum = Math.min(barMin, total)
    if (mentioning < quorum)
      return `BAR FAILED (reply mentions "${scenario.expectReplyContains}" in ${mentioning}/${total}, need ${quorum})`
  }

  return 'PASS'
}
