/**
 * judge-variance.ts - does the judge score the SAME reply the same way on
 * repeat calls?
 *
 * Motivated by judge-v1.1.0: one greeting shape drew initiative 4/3/2
 * across three runs, and untested host_ownership wobbled 3-vs-4 on
 * identical "no problem arose" reasoning. Noise that size whipsaws any
 * variant comparison, so every judge prompt change reruns this gate (this
 * run gates judge-v1.2.0: merged working_the_room axis + explicit tested
 * flag).
 *
 * K judge calls per frozen case. Inputs are fixtures built through the
 * engine's own renderers (composePrompt over the default graph), so every
 * point of spread is judge noise, not input noise.
 *
 * Pre-registered, evaluated in code (scripts/CLAUDE.md #5/#8):
 *   BAR - per case, per axis: `tested` unanimous across the K calls, and
 *         where unanimously tested, score spread (max - min) <= 1.
 *   A failed judge call DISQUALIFIES its case - a failure is not a sample.
 */

import { composePrompt, type HistoryTurn } from '@/lib/ai/v2/compose'
import { DEFAULT_RELATIONSHIP_GRAPH } from '@/lib/relationship/default-graph'
import {
  EMPTY_MEMORY,
  EMPTY_PROFILE,
  openMoves,
  renderGuestProfile,
  renderInteractionMemory,
  renderOpenMoves,
} from '@/lib/relationship/profile'
import {
  JUDGE_AXES,
  JUDGE_ENABLED,
  JUDGE_PROMPT_VERSION,
  judgeResponse,
} from '@/lib/eval/judge'
import { createRunLog } from './run-log'

const K = 8
const MAX_SPREAD = 1
const VENUE_NAME = "Le Mil's Coffee"

interface VarianceCase {
  key: string
  /** Why this case is in the set. */
  why: string
  history: HistoryTurn[]
  inbound: string
  reply: string[]
}

// Case 1 is the measured noise source (initiative 4/3/2 on this shape).
// Case 2 is the owner-ruled good reply from the real Himanshu conversation
// (2026-10-01, Le Mil's Instagram DM) - a known-5 shape that should also
// come back tight.
const CASES: VarianceCase[] = [
  {
    key: 'bare-hey-greeting',
    why: 'the shape that drew initiative 4/3/2 under judge-v1.1.0',
    history: [],
    inbound: 'hey',
    reply: ["hey! welcome 👋 how's it going?"],
  },
  {
    key: 'lore-then-name-ask',
    why: 'the owner-ruled good v1 reply; a known-good anchor',
    history: [
      { role: 'user', text: "Hi Le Mil's!" },
      { role: 'assistant', text: 'hey, welcome!\n👋\nwhat did you just get?' },
    ],
    inbound: 'Pink panther',
    reply: [
      "cascara, kokum syrup, tonic, butterfly pea foam. it's Himanshu's personal favorite for a reason",
      "by the way, what's your name?",
    ],
  },
  {
    key: 'greeting-door-opener',
    why: 'the owner-ruled v1 opener: advances on turn 1 - the counter-anchor to bare-hey restraint, so the axis must hold both readings apart',
    history: [],
    inbound: "Hi Le Mil's!",
    reply: ['hey, welcome!', '👋', 'what did you just get?'],
  },
]

/** The situation brief exactly as the engine renders it for a new guest. */
function buildBrief(history: HistoryTurn[], inbound: string): string {
  const graph = DEFAULT_RELATIONSHIP_GRAPH
  const state = graph.states.find((s) => s.key === graph.initialState)
  if (state === undefined) throw new Error('default graph has no initial state')
  const composed = composePrompt({
    venueName: VENUE_NAME,
    speakerClause: '',
    venueProfile: VENUE_NAME,
    voicePack: '',
    knowledge: '',
    history,
    stateLabel: state.label,
    stateKey: state.key,
    mission: state.mission,
    guestProfile: renderGuestProfile(EMPTY_PROFILE),
    interactionMemory: renderInteractionMemory(EMPTY_MEMORY),
    openMoves: renderOpenMoves(
      openMoves(graph, state.key, EMPTY_PROFILE),
      EMPTY_MEMORY,
    ),
    inboundMessages: [inbound],
  })
  const brief = composed.guestState
  if (brief.length === 0) throw new Error('brief rendered empty')
  return brief
}

function transcript(c: VarianceCase): string {
  return [
    ...c.history.map(
      (t) => `${t.role === 'user' ? 'GUEST' : 'VENUE'}: ${t.text}`,
    ),
    `GUEST: ${c.inbound}`,
    ...c.reply.map((m) => `VENUE (this reply): ${m}`),
  ].join('\n')
}

async function main(): Promise<void> {
  // Refuse rather than produce a clean-looking run over nothing: this harness
  // is the variance GATE, and "spread 0 across 0 judgments" would print as a
  // pass. A disabled judge is a handoff, not a condition to work around.
  if (!JUDGE_ENABLED)
    throw new Error(
      'JUDGE_ENABLED is false (lib/eval/judge.ts) - the judge is switched off, so there is no variance to measure. Flip it back on first.',
    )

  const log = createRunLog({
    name: 'judge-variance',
    meta: {
      arm: `judge-variance-k${K}`,
      judgeVersion: JUDGE_PROMPT_VERSION,
      k: K,
      maxSpread: MAX_SPREAD,
      cases: CASES.map((c) => c.key),
    },
  })
  console.log(`run log: ${log.path}`)
  console.log(`judge ${JUDGE_PROMPT_VERSION} · K=${K} per case\n`)

  let anyFailed = false
  for (const c of CASES) {
    console.log(`=== ${c.key} (${c.why}) ===`)
    const brief = buildBrief(c.history, c.inbound)
    const input = {
      replyMessages: c.reply,
      transcript: transcript(c),
      situationBrief: brief,
      venueName: VENUE_NAME,
    }

    const results = await Promise.all(
      Array.from({ length: K }, () => judgeResponse(input)),
    )
    const failures = results.filter((r) => !r.ok)
    for (const [i, r] of results.entries()) {
      log.appendUnit({
        caseKey: c.key,
        call: i + 1,
        ok: r.ok,
        ...(r.ok
          ? {
              // Explanations ride along for diagnosis: a breach without
              // them left the 19:16 bimodal unreadable from the log alone.
              axes: Object.fromEntries(
                Object.entries(r.data.axes).map(([k, v]) => [
                  k,
                  {
                    tested: v.tested,
                    score: v.score,
                    explanation: v.explanation,
                  },
                ]),
              ),
            }
          : { error: r.error }),
      })
    }
    if (failures.length > 0) {
      // Convention #5: a failed call is not a sample; the case cannot be
      // read as low-variance off the calls that happened to succeed.
      const verdict = `DISQUALIFIED (${failures.length}/${K} judge calls failed)`
      console.log(`${verdict}\n`)
      log.appendUnit({ caseKey: c.key, summary: true, verdict })
      anyFailed = true
      continue
    }
    const oks = results.flatMap((r) => (r.ok ? [r.data] : []))

    const breaches: string[] = []
    for (const axis of JUDGE_AXES) {
      const testedValues = oks.map((o) => o.axes[axis].tested)
      const unanimous = testedValues.every((t) => t === testedValues[0])
      const scores = oks.map((o) => o.axes[axis].score)
      const line = oks
        .map((o) => (o.axes[axis].tested ? String(o.axes[axis].score) : 'n/a'))
        .join(' ')
      if (!unanimous) {
        breaches.push(`${axis}: tested flag split (${line})`)
        console.log(`  ${axis.padEnd(18)} ${line}  << tested SPLIT`)
        continue
      }
      if (!testedValues[0]) {
        console.log(`  ${axis.padEnd(18)} ${line}`)
        continue
      }
      const spread = Math.max(...scores) - Math.min(...scores)
      if (spread > MAX_SPREAD)
        breaches.push(`${axis}: spread ${spread} (${line})`)
      console.log(
        `  ${axis.padEnd(18)} ${line}  spread ${spread}${spread > MAX_SPREAD ? '  << BREACH' : ''}`,
      )
    }

    const verdict =
      breaches.length === 0 ? 'PASS' : `FAIL (${breaches.join('; ')})`
    console.log(`${c.key}: ${verdict}\n`)
    log.appendUnit({ caseKey: c.key, summary: true, verdict, breaches })
    if (breaches.length > 0) anyFailed = true
  }

  process.exit(anyFailed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
