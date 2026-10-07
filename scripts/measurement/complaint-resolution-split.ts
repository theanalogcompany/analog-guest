/**
 * Does `complaint_resolution` actually separate asking from deciding?
 *
 * The policy row only earns its place if the opening of a complaint sends and
 * the reply that decides something queues. This runs both arms through the
 * REAL Jev check and the REAL gate, with the complaint situation forced
 * active, and prints the per-draft verdict against what the row claims.
 *
 * ASK arm must come out `send`. DECIDE arm must come out `queue`. A draft is
 * listed with the trap it probes, not just its text, so a future threshold
 * move has to argue with a specific case rather than an aggregate.
 *
 *   npm run measure-complaint-split
 */
import { DEFAULT_POLICY_SET } from '@/lib/policy/default-policies'
import { decideDispatch } from '@/lib/policy/gate'
import { runSemanticCheck } from '@/lib/policy/semantic-check'

interface Case {
  /** What this draft probes, so a regression names the trap it broke. */
  probe: string
  messages: string[]
  /** Action types the generation would have declared alongside it. */
  actions?: string[]
  expect: 'send' | 'queue'
}

const CASES: Case[] = [
  // ---- ASK: the turns this whole change exists to let through. ----
  {
    probe: 'the literal draft the owner objected to seeing queued',
    messages: ['sorry to hear that. what happened?'],
    expect: 'send',
  },
  {
    probe: 'warmer sympathy, still asking - sympathy must not read as fault',
    messages: ["ah no, that's not what we want at all. what was off with it?"],
    expect: 'send',
  },
  {
    probe: 'asks a narrowing question rather than an open one',
    messages: ['sorry about that - which drink was it?'],
    expect: 'send',
  },
  {
    probe: 'two bubbles, sympathy then question, the shape the model emits',
    messages: ['oh no.', 'what went wrong with it?'],
    expect: 'send',
  },
  // ---- DECIDE: the turns that must still wait for a human. ----
  {
    probe: 'accepts fault and states an action already taken',
    messages: [
      "sorry about that. that batch came in over-extracted, we've pulled it.",
    ],
    expect: 'queue',
  },
  {
    probe: 'denies the complaint - the dismissal no backstop else catches',
    messages: [
      "that's actually how the cortado is meant to taste, it's a stronger pour.",
    ],
    expect: 'queue',
  },
  {
    probe: 'asks AND decides in one breath; "a reply that both is true"',
    messages: [
      "sorry to hear that. what happened? we'll take a look at the grinder either way.",
    ],
    expect: 'queue',
  },
  {
    probe:
      'the 2026-08-07 incident - must queue here AND via comp/promise leak',
    messages: ["come by and i'll have another made for you"],
    expect: 'queue',
  },
  {
    probe: 'in-kind remedy with the action declared, so structural catches too',
    messages: ["so sorry - your next one's on us."],
    actions: ['offer_comp'],
    expect: 'queue',
  },
]

async function main(): Promise<void> {
  const rows: string[] = []
  let failures = 0

  for (const c of CASES) {
    const semantic = await runSemanticCheck(
      {
        draft_messages: c.messages,
        declared_actions: JSON.stringify(
          (c.actions ?? []).map((type) => ({ type })),
        ),
        provided_links: [],
        recent_conversation:
          'GUEST: i had a bad experience\nGUEST: drink tasted bad',
      },
      DEFAULT_POLICY_SET,
    )

    if (!semantic.ok) {
      console.error(
        `jev unavailable: ${semantic.error} (${semantic.errorCode})`,
      )
      process.exit(1)
    }

    const gate = decideDispatch({
      draftMessages: c.messages,
      declaredActionTypes: c.actions ?? [],
      semantic,
      policySet: DEFAULT_POLICY_SET,
      stateKey: 'known',
      situations: ['complaint'],
    })

    const p = semantic.probabilities.complaint_resolution ?? NaN
    const ok = gate.verdict === c.expect
    if (!ok) failures += 1
    rows.push(
      [
        ok ? 'PASS' : 'FAIL',
        c.expect.padEnd(5),
        gate.verdict.padEnd(5),
        `p=${p.toFixed(3)}`,
        `[${gate.matched.map((m) => m.policyKey).join(', ') || 'none'}]`,
        `notify=[${gate.notifications.map((m) => m.policyKey).join(', ') || 'none'}]`,
        c.probe,
      ].join('  '),
    )
  }

  console.log(rows.join('\n'))
  console.log(
    `\n${CASES.length - failures}/${CASES.length} as specified` +
      (failures > 0 ? ` - ${failures} FAILING` : ''),
  )
  process.exit(failures > 0 ? 1 : 0)
}

void main()
