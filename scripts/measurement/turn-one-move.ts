/**
 * turn-one-move.ts - which prompt tweak makes the model pursue a declared
 * aim on a thin first exchange, instead of pleasantry ("how's it going?")
 * or a freelance probe ("stopping by soon or just exploring?")?
 *
 * Owner-set goal (2026-10-04): experiment with cutting/tweaking prompt
 * sections until the model does one of the two open first_contact moves.
 * Root-cause hypothesis from the playground: the first_contact mission's
 * "without demanding their attention" is the LAST word on the subject
 * (later beats earlier) and the moves header's "or none" is a wide exit,
 * so the model's question budget goes unanchored.
 *
 * Arms, one lever at a time (overrides only - code untouched during
 * screening; the winning copy lands in the real artifact and the baseline
 * arm is rerun as confirmation):
 *
 *   baseline         current template + current graph copy
 *   mission          first_contact mission rewritten to name the aims
 *   moves-directive  the rendered aims plus a trailing "pick ONE" line
 *   both             both levers
 *   name-goal        learn_name goal without its self-deferring timing clause
 *   name-goal+mission  both
 *
 * OUTCOME (runs of 2026-10-04 20:34-20:36): mission and moves-directive
 * moved nothing on bare-hey (0/3 everywhere; the model freelanced "what
 * brings you in" - an aim not even open at first_contact). name-goal alone
 * went 3/3. Landed as template v2.4.0 ("or none" exit cut from the moves
 * header) + the learn_name goal rewording in default-graph.ts; baseline
 * then passed BOTH scenarios 3/3.
 *
 * ROUND 4 (owner-ruled 2026-10-04 evening): the round-3 winner overshot.
 * "a warm, casual ask for their name is the host's natural reply" scripts
 * the ask, and the model obeys it literally - the entire first reply to
 * "hi" became "hey! welcome - what do I call you?", which reads abrupt.
 * Ruling: move goals must specify the GOAL and the GAP only - no scripted
 * ask, no scripted timing - and the model decides which gap to fill when.
 * The name must NOT be asked in the first reply; pursuit must still happen
 * across the exchange. Arms iterate the gap wording (and one arm the
 * mission) until both hold.
 *
 * ROUND 4 OUTCOME (runs 2026-10-04 23:06-23:19Z): baseline breached
 * ceiling 2 on every scenario (9/9 samples asked turn one - instrument
 * validated). gap-pure breached on bare-hey and hi-then-good (1/3 each).
 * gap-value never asked - 0/3 pursuit on hi-then-good, the pre-registered
 * risk; family dead. gap+mission closest: PASS hi-then-good (2/3) and
 * order-after-name (3/3), but 1/3 turn-one asks on bare-hey.
 *
 * ROUND 5: the residual turn-one pressure is in GAP_NAME itself - "the
 * welcome, the memory, the recognition all attach to it" tells the model
 * the WELCOME needs the name, which licenses asking inside it. One lever
 * at a time: gap2 drops the welcome from the attach-list; mission2
 * sharpens the first-touch clause so the welcome is complete in itself.
 *
 * ROUND 5 OUTCOME (run 2026-10-04T23:26Z): gap2+mission passed ALL
 * scenarios - 0 turn-one asks and 0 ceiling-1 breaches across 9 samples.
 * Both levers are needed: gap2-pure breached hi-then-good (1/3) and
 * round-4 gap+mission breached bare-hey (1/3), each alone. mission2
 * ("complete in itself") breached hi-then-good 3/3 - wording dead.
 * Winning copy = GAP_NAME_2 + GAP_ORDER goals and MISSION_WELCOME;
 * landed in default-graph.ts (owner-approved 2026-10-04 evening).
 *
 * CONFIRMATION (run 2026-10-04T23:38Z) FALSIFIED the round-5 pass on
 * hi-then-good: baseline on the landed copy asked turn one 3/3 there
 * (bare-hey and order-after-name stayed clean). The composed prompt was
 * verified CHARACTER-IDENTICAL to the winning override (scripts/CLAUDE.md
 * #9), so round 5's 0/3 vs the confirmation's 3/3 is sampling variance at
 * n=3 - pooled, "hi" breaches ~3/6. Root cause found by reading the
 * breach bodies (#7): every breach in every round is the verbatim voice
 * pack exemplar "just so we know what to call you 🙂" - voice_corpus row
 * 8d090421 (operator_approve, 2026-09-26). A static corpus exemplar
 * outranks any move-goal wording; fixing it is a voice_corpus data
 * decision (owner), not another wording arm. The landed copy stands on
 * its own result: bare-hey went 9/9 breaches -> 0/6 with pursuit intact.
 *
 * Pre-registered, evaluated in code (scripts/CLAUDE.md #5/#8):
 *   BAR       - per scenario: >= 2/3 samples have an assessor moveKey tag
 *               in the scenario's target set by the final turn. Tags are
 *               the instrument, never a '?' heuristic (a freelance question
 *               would fool a count - seen live).
 *   CEILING 1 - every reply in every sample carries at most one question.
 *   CEILING 2 - no sample's FIRST reply carries a learn_name tag: the
 *               first thing a guest ever gets is a welcome, not an intake
 *               question. (Every scenario opens thin, so this applies to
 *               all of them.) Baseline is expected to breach this - it is
 *               the defect reproducing, which validates the instrument.
 *   A sample with a failed generation or assessor DISQUALIFIES its arm for
 *   that scenario - a failure is not a zero.
 */

import { createAdminClient } from '@/lib/db/admin'
import {
  runTurn,
  type PlaygroundSession,
  type TurnOverrides,
} from '@/lib/relationship/run-turn'
import type { HistoryTurn } from '@/lib/ai/v2/compose'
import { EMPTY_MEMORY, EMPTY_PROFILE } from '@/lib/relationship/profile'
import { V2_PROMPT_VERSION } from '@/lib/ai/v2/template'
import { ASSESSOR_PROMPT_VERSION } from '@/lib/relationship/assessor'
import { createRunLog } from './run-log'

const TARGET_MOVES = new Set(['learn_name', 'understand_order'])
const SAMPLES = 3
const BAR_MIN_PURSUING = 2

interface Scenario {
  key: string
  script: string[]
  /** Moves that satisfy the bar; omit for the default TARGET_MOVES pair. */
  target?: string[]
}

const SCENARIOS: Scenario[] = [
  // The canonical thin opener, extended a turn: with the first reply now
  // required to be a welcome, pursuit has to land on turn 2+ - a one-turn
  // script could only measure the ceiling, never the bar.
  {
    key: 'bare-hey',
    script: [
      'hey',
      'haha just saw the number at the counter, figured i would text',
    ],
  },
  // The aimless-question case from the playground. Turn-2 line is a
  // low-content continuation that answers almost any welcome shape - the
  // round-3 'good' only parsed as a reply to "how's it going?".
  { key: 'hi-then-good', script: ['hi', 'all good, just checking this out'] },
  // Past the name: the guest volunteers it plus a visit (turn 2), so
  // learn_name is satisfied mid-exchange and understand_order is the live
  // aim - does the model pick it up, or does the question budget go
  // idle/freelance again? The bar is understand_order SPECIFICALLY: the
  // name tag alone cannot pass.
  {
    key: 'order-after-name',
    script: ['hey', "i'm alex btw - was in this morning actually"],
    target: ['understand_order'],
  },
]

// Round 5 arms: still goal-and-gap only in the moves; etiquette may live in
// the mission (the arm the ruling allows to iterate). One lever at a time so
// a pass is attributable.
//
// gap2-pure    the de-pressured gap alone - the most emergent candidate.
// gap2+mission the de-pressured gap plus the round-4 mission (the round-4
//              near-winner with the hypothesized leak fixed).
// gap+mission2 the round-4 gap unchanged, mission sharpened - isolates
//              whether the mission lever alone can hold the ceiling.

const GAP_NAME =
  '- Their name. You do not have it yet, and it is the hinge of everything later - the welcome, the memory, the recognition all attach to it.'
const GAP_NAME_2 =
  '- Their name. You do not have it yet, and everything you remember about them later - the memory, the recognition - attaches to it.'
const GAP_ORDER =
  '- What they order with us - what they got this visit, or what they usually get. You do not know yet. If they have not been in, there is nothing to ask about.'
const MISSION_WELCOME =
  'Make the guest comfortable interacting with you. Establish a recognizable personality and a welcoming atmosphere without demanding their attention. The first thing a guest ever gets from you is a welcome in the house voice; your curiosity about them earns its turn as the exchange warms up.'
const MISSION_WELCOME_2 =
  "Make the guest comfortable interacting with you. Establish a recognizable personality and a welcoming atmosphere without demanding their attention. You are the host: a stranger's first word gets a welcome that is complete in itself, and your curiosity about them earns its turn as the exchange warms up."

interface ArmSpec {
  arm: string
  overrides?: TurnOverrides
}

function buildArms(): ArmSpec[] {
  return [
    // Control: the landed round-3 copy. Breached ceiling 2 on 9/9 samples
    // in round 4 - instrument validated; rerun only as the post-landing
    // confirmation.
    { arm: 'baseline' },
    {
      arm: 'gap2-pure',
      overrides: { openMovesText: `${GAP_NAME_2}\n${GAP_ORDER}` },
    },
    {
      arm: 'gap2+mission',
      overrides: {
        mission: MISSION_WELCOME,
        openMovesText: `${GAP_NAME_2}\n${GAP_ORDER}`,
      },
    },
    {
      arm: 'gap+mission2',
      overrides: {
        mission: MISSION_WELCOME_2,
        openMovesText: `${GAP_NAME}\n${GAP_ORDER}`,
      },
    },
  ]
}

function questionCount(messages: string[]): number {
  return messages.join(' ').split('?').length - 1
}

interface SampleOutcome {
  disqualified: string | null
  pursued: boolean
  maxQuestions: number
  /** Ceiling 2: the first reply carried a learn_name tag - the abrupt ask. */
  turnOneNameAsk: boolean
  turns: Array<{ inbound: string; reply: string[]; tagged: string[] }>
}

async function runSample(
  venueId: string,
  script: string[],
  target: Set<string>,
  overrides: TurnOverrides | undefined,
): Promise<SampleOutcome> {
  let session: PlaygroundSession = {
    profile: EMPTY_PROFILE,
    memory: EMPTY_MEMORY,
    facts: { visitCount: 0, replyCount: 0, daysSinceLastContact: null },
  }
  let history: HistoryTurn[] = []
  const outcome: SampleOutcome = {
    disqualified: null,
    pursued: false,
    maxQuestions: 0,
    turnOneNameAsk: false,
    turns: [],
  }

  for (const inbound of script) {
    const trace = await runTurn({
      venueId,
      guestId: null,
      inbound: [inbound],
      sessionHistory: history,
      session,
      overrides,
    })
    if (!trace.generation.ok) {
      outcome.disqualified = `generation failed: ${trace.generation.error}`
      return outcome
    }
    const assessor =
      trace.assessor !== null && trace.assessor.ok ? trace.assessor : null
    if (assessor === null) {
      outcome.disqualified = 'assessor failed'
      return outcome
    }
    const reply = trace.generation.output.messages
    const tagged = assessor.result.output.memoryEntries
      .map((e) => e.moveKey.trim())
      .filter((k) => k.length > 0)
    outcome.turns.push({ inbound, reply, tagged })
    outcome.maxQuestions = Math.max(outcome.maxQuestions, questionCount(reply))
    if (outcome.turns.length === 1 && tagged.includes('learn_name'))
      outcome.turnOneNameAsk = true
    if (tagged.some((k) => target.has(k))) outcome.pursued = true

    history = [
      ...history,
      { role: 'user' as const, text: inbound },
      ...reply.map((text) => ({ role: 'assistant' as const, text })),
    ]
    session = assessor.nextSession
  }
  return outcome
}

async function main(): Promise<void> {
  // argv: [arms csv] [scenarios csv] - both optional, default all. The
  // scenario filter exists for iteration cost only; a PASS claim for an arm
  // requires a run over ALL scenarios (the exit code enforces it: filtered
  // runs cannot pass both).
  const armFilter = process.argv[2]?.split(',').filter((s) => s.length > 0)
  const arms = buildArms().filter(
    (a) => armFilter === undefined || armFilter.includes(a.arm),
  )
  const scenarioFilter = process.argv[3]?.split(',').filter((s) => s.length > 0)
  const scenarios = SCENARIOS.filter(
    (s) => scenarioFilter === undefined || scenarioFilter.includes(s.key),
  )
  const venueName = "Le Mil's Coffee"
  const supabase = createAdminClient()
  const { data: venue, error } = await supabase
    .from('venues')
    .select('id, name')
    .ilike('name', venueName)
    .maybeSingle()
  if (error || !venue) {
    console.error(`venue "${venueName}" not found: ${error?.message ?? ''}`)
    process.exit(1)
  }

  const log = createRunLog({
    name: 'turn-one-move',
    meta: {
      arm: arms.map((a) => a.arm).join('+'),
      venue: venue.name,
      samples: SAMPLES,
      barMinPursuing: BAR_MIN_PURSUING,
      scenarios: SCENARIOS.map((s) => s.key),
      promptVersion: V2_PROMPT_VERSION,
      assessorVersion: ASSESSOR_PROMPT_VERSION,
    },
  })
  console.log(`run log: ${log.path}\n`)

  let anyArmPassedAll = false
  for (const spec of arms) {
    let scenariosPassed = 0
    for (const scenario of scenarios) {
      console.log(`=== arm ${spec.arm} · scenario ${scenario.key} ===`)
      const target = new Set(scenario.target ?? [...TARGET_MOVES])
      const samples = await Promise.all(
        Array.from({ length: SAMPLES }, () =>
          runSample(venue.id, scenario.script, target, spec.overrides),
        ),
      )
      for (const [i, s] of samples.entries()) {
        for (const t of s.turns) {
          console.log(`  [s${i + 1}] GUEST: ${t.inbound}`)
          for (const m of t.reply) console.log(`       VENUE: ${m}`)
          console.log(`       tagged: ${t.tagged.join(', ') || '(none)'}`)
        }
        if (s.disqualified)
          console.log(`  [s${i + 1}] FAILED: ${s.disqualified}`)
        log.appendUnit({
          arm: spec.arm,
          scenario: scenario.key,
          sample: i + 1,
          disqualified: s.disqualified,
          pursued: s.pursued,
          maxQuestions: s.maxQuestions,
          turnOneNameAsk: s.turnOneNameAsk,
          turns: s.turns,
        })
      }

      const failed = samples.filter((s) => s.disqualified !== null)
      const pursuing = samples.filter((s) => s.pursued).length
      const ceilingBreach = samples.some((s) => s.maxQuestions > 1)
      const abruptBreach = samples.some((s) => s.turnOneNameAsk)
      const verdict =
        failed.length > 0
          ? `DISQUALIFIED (${failed.length}/${SAMPLES} samples failed)`
          : ceilingBreach
            ? 'CEILING BREACHED (a reply carried more than one question)'
            : abruptBreach
              ? 'ABRUPT (a first reply asked for the name)'
              : pursuing >= BAR_MIN_PURSUING
                ? `PASS (${pursuing}/${SAMPLES} pursued a target move)`
                : `FAIL (${pursuing}/${SAMPLES} pursued a target move)`
      console.log(`  -> ${verdict}\n`)
      log.appendUnit({
        arm: spec.arm,
        scenario: scenario.key,
        summary: true,
        verdict,
      })
      if (verdict.startsWith('PASS')) scenariosPassed += 1
    }
    if (
      scenariosPassed === SCENARIOS.length &&
      scenarios.length === SCENARIOS.length
    ) {
      console.log(`*** arm ${spec.arm}: passes ALL scenarios ***\n`)
      anyArmPassedAll = true
    }
  }
  process.exit(anyArmPassedAll ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
