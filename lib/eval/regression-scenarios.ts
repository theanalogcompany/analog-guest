// The builtin regression scenario set and the one verdict definition.
//
// Scenarios live in `regression_scenarios` (migration 069) so humans can
// inspect, add and disable them from /admin/regression; this module is the
// seed those rows started from and the fallback when the table is missing
// (migration unapplied) or unreadable. The harness warns whenever it falls
// back - a silent fallback would let a disabled scenario keep running.
//
// `scenarioVerdict` is shared between the harness (which computes and stores
// verdicts) and anything re-deriving them, so two surfaces cannot disagree
// about what a pass is. Every measured lesson in lib/ai/v2/template.ts's
// changelog has a scenario here; a new lesson ships with a new scenario in
// the same change (.claude/rules/v2-template-regression.md).
//
// Pure module: type-only imports, no SDK init, importable by path from
// scripts and app code alike.

import type {
  RegressionSample,
  RegressionScenario,
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
    'question stacking - two real questions in one bubble, or three-plus across the reply. Rhetorical tags ("right?") are not questions, and one body question plus the own-bubble getting-to-know-you question is the decision-0007 shape and fine (owner-ruled 2026-10-05; v2.8.0 lesson)',
  'either-or':
    'hedged either/or question ("anything catch your eye, or want a nudge in a direction?") - an AI tell, a question asking permission for its own alternative. The normalizer strips the ", or ...?" tail at the generation seam, so a hit here means the strip missed (owner-ruled 2026-10-05)',
} satisfies Record<RegressionTell, string>

/** Falls back to the raw key for tells stored before a description existed. */
export function describeTell(tell: string): string {
  return tell in REGRESSION_TELL_DESCRIPTIONS
    ? REGRESSION_TELL_DESCRIPTIONS[tell as RegressionTell]
    : tell
}

export const BUILTIN_REGRESSION_SCENARIOS: RegressionScenario[] = [
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
