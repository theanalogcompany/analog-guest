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
 * Pre-registered, evaluated in code (scripts/CLAUDE.md #5/#8):
 *   BAR     - per scenario: >= 2/3 samples have an assessor moveKey tag in
 *             {learn_name, understand_order} by the final turn. Tags are
 *             the instrument, never a '?' heuristic (a freelance question
 *             would fool a count - seen live).
 *   CEILING - every reply in every sample carries at most one question.
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
import { DEFAULT_RELATIONSHIP_GRAPH } from '@/lib/relationship/default-graph'
import {
  EMPTY_MEMORY,
  EMPTY_PROFILE,
  openMoves,
  renderOpenMoves,
} from '@/lib/relationship/profile'
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
  // The canonical failure: a bare low-content opener.
  { key: 'bare-hey', script: ['hey'] },
  // The aimless-question case from the playground: pleasantry answered,
  // the model asks SOMETHING - the bar is whether it serves an aim.
  { key: 'hi-then-good', script: ['hi', 'good'] },
  // Past the name: once first_name lands (turn 2), learn_name closes and
  // understand_order is the remaining first_contact aim - does the model
  // pick it up, or does the question budget go idle/freelance again? The
  // bar is understand_order SPECIFICALLY: the name tag alone cannot pass.
  {
    key: 'order-after-name',
    script: ['hey', 'Alex', 'nice to meet you too!'],
    target: ['understand_order'],
  },
]

const MISSION_REWRITE =
  'Make them glad they texted. A first message is an opening: meet it with light, specific interest in them - what they got, or what to call them - not pleasantry alone. One question at most, and drop it the moment they show hurry or trouble.'

const MOVES_DIRECTIVE =
  '\n\nPick ONE of these and work it into this reply naturally. Skip only if the guest shows trouble or hurry.'

// Round 3: learn_name's own timing clause ("right after being useful is the
// natural opening") defers the move forever on a thin opener - the model has
// not been useful yet, so the move text itself says wait. Reworded so the
// thin opener IS an opening.
const LEARN_NAME_REWRITE =
  '- Learn their name, early - a first exchange that goes well usually ends with it. A thin opener ("hey") is itself the opening: when there is nothing else to react to, a warm, casual ask for their name is the host\'s natural reply.'
const UNDERSTAND_ORDER_LINE =
  "- Learn what they order - what they got, or what they'd want. Curiosity about their taste, not a survey."

interface ArmSpec {
  arm: string
  overrides?: TurnOverrides
}

function buildArms(): ArmSpec[] {
  const movesText = renderOpenMoves(
    openMoves(
      DEFAULT_RELATIONSHIP_GRAPH,
      DEFAULT_RELATIONSHIP_GRAPH.initialState,
      EMPTY_PROFILE,
    ),
    EMPTY_MEMORY,
  )
  return [
    { arm: 'baseline' },
    { arm: 'mission', overrides: { mission: MISSION_REWRITE } },
    {
      arm: 'moves-directive',
      overrides: { openMovesText: movesText + MOVES_DIRECTIVE },
    },
    {
      arm: 'both',
      overrides: {
        mission: MISSION_REWRITE,
        openMovesText: movesText + MOVES_DIRECTIVE,
      },
    },
    {
      arm: 'name-goal',
      overrides: {
        openMovesText: `${LEARN_NAME_REWRITE}\n${UNDERSTAND_ORDER_LINE}`,
      },
    },
    {
      arm: 'name-goal+mission',
      overrides: {
        mission: MISSION_REWRITE,
        openMovesText: `${LEARN_NAME_REWRITE}\n${UNDERSTAND_ORDER_LINE}`,
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
          turns: s.turns,
        })
      }

      const failed = samples.filter((s) => s.disqualified !== null)
      const pursuing = samples.filter((s) => s.pursued).length
      const ceilingBreach = samples.some((s) => s.maxQuestions > 1)
      const verdict =
        failed.length > 0
          ? `DISQUALIFIED (${failed.length}/${SAMPLES} samples failed)`
          : ceilingBreach
            ? 'CEILING BREACHED (a reply carried more than one question)'
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
      console.log(`*** arm ${spec.arm}: passes BOTH scenarios ***\n`)
      anyArmPassedAll = true
    }
  }
  process.exit(anyArmPassedAll ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
