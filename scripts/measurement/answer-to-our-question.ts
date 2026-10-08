// Is a short answer to our own question read as that answer? Classifies,
// retrieves, generates and runs the real gate. NOTHING IS SENT and nothing is
// written to the database.
//
// THE INCIDENT (phone test, 2026-10-07, le-mils-coffee-test): "how do i brew
// your beans" got "Depends on which beans" followed by an answer for two of
// them, and the guest's "budan" was classified `unknown` (0.29 against
// new_question at 0.27), held, and drafted as a product link. Three causes,
// one per stage: the classifier, the reply that asked and answered at once,
// and a corpus with no brewing row for that bean. The thread is in
// fixtures/answer-to-our-question.json, verbatim.
//
// THE BARS, pre-registered (approved 2026-10-07) and evaluated in code below:
//   - budan-exact, the real thread: never `unknown`, auto-sends every time,
//     and at least 9 in 10 carry the recipe and no product link.
//   - brew-exact, the turn before it: at least 9 in 10 are one clean question
//     or one answer for a default, never both.
//   - every other `answer` cell: never `unknown`. Those with a full turn must
//     also auto-send and say how that bean is brewed.
//   - CEILING, the `no-question` cells: four ordinary first-conversation
//     turns (the menu, an ingredient, the hours, an order they mention) where
//     nothing needs asking. No reply may ask anything. A fix that lets the
//     clarifying question through by letting every question through has not
//     fixed anything. Main's wording scored 0 asking in 24 on these.
//   - budan-no-history is the CONTROL and has no bar: a bare word with nothing
//     in front of it is still a bare word. It is printed so a wording that
//     made every one-word message confident would show.
//
// ABLATION ARMS, for finding the cause before changing anything:
//   --ablate history             the classifier sees no conversation
//   --ablate no-question-block   the turn is not a first conversation, which
//                                is what removes `## No questions this turn`.
//                                It is not a pure leave-one-out: the same flag
//                                gates the restraint inside the intentions
//                                block, which this harness leaves empty. The
//                                sentence-by-sentence runs that followed were
//                                made with a temporary switch in
//                                serializers.ts that did not ship; their
//                                figures are at WHICH_ONE_BAN there.
//   --ablate bare-query          retrieval's first arm searches with the bare
//                                message, as before the answer query. Done by
//                                taking the `?` out of our last message for
//                                the retrieval call only, which is what
//                                switches that query off; the contextual
//                                arm's text differs by that one character.
//
// WHAT IT CANNOT TELL YOU:
//   - The guest is neutralised (no visits, commitments, intentions, mechanics,
//     and never a demo guest), so this is the reset-guest case.
//   - The four post-generation checks do not run, as on a live inbound turn.
//   - The classifier is Jev with the Haiku fallback, as in production. A run
//     without JEV_API_KEY measures Haiku and says nothing about the incident;
//     the reasoning column shows which arm answered.
//   - The venue's open or closed line is whatever it is when this runs.
//
// TELEMETRY: run with NEXT_PUBLIC_POSTHOG_KEY and SLACK_ALERTS_WEBHOOK_URL
// set empty so the stages' events go inert.
//
//   npm run measure-answer-to-our-question -- --venue <slug> --guest <uuid> [--reps 10]

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import {
  classifyStage,
  generateStage,
  retrieveCorpusStage,
  retrieveKnowledgeWithContextStage,
  shouldRetrieveKnowledge,
} from '@/lib/agent/stages'
import type { RuntimeContext } from '@/lib/agent/types'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import type { RecentMessage } from '@/lib/ai/types'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { evaluateApprovalDecision } from '../onboarding/evaluate-approval-decision'
import { createRunLog } from './run-log'

type Ablation = 'none' | 'history' | 'no-question-block' | 'bare-query'

interface Line {
  direction: 'inbound' | 'outbound'
  body: string
}

interface Cell {
  id: string
  kind: 'answer' | 'brew' | 'control' | 'no-question'
  threads: string[]
  inbound: string
  fullTurn: boolean
  mustMatch?: string[]
  mustNotMatch?: string[]
}

interface Fixture {
  threads: Record<string, Line[]>
  cells: Cell[]
}

const FIXTURE_PATH = join(
  'scripts',
  'measurement',
  'fixtures',
  'answer-to-our-question.json',
)

/** Seconds between two lines of a constructed thread, newest ending 10s ago. */
const LINE_GAP_SECONDS = 10

function parseArgs() {
  const argv = process.argv.slice(2)
  const get = (flag: string) => {
    const i = argv.indexOf(flag)
    return i === -1 ? undefined : argv[i + 1]
  }
  const venue = get('--venue')
  const guest = get('--guest')
  const ablate = (get('--ablate') ?? 'none') as Ablation
  if (
    venue === undefined ||
    guest === undefined ||
    !['none', 'history', 'no-question-block', 'bare-query'].includes(ablate)
  ) {
    console.error(
      'usage: tsx scripts/measurement/answer-to-our-question.ts --venue <slug> --guest <uuid> [--reps 10] [--classify-reps 5] [--only id,id] [--classify-only] [--retrieve-only] [--ablate history|no-question-block|bare-query] [--arm <label>] [--out <path>] [--force]',
    )
    process.exit(2)
  }
  return {
    venue,
    guest,
    ablate,
    reps: Number(get('--reps') ?? 10),
    classifyReps: Number(get('--classify-reps') ?? 5),
    only: get('--only')?.split(',') ?? null,
    classifyOnly: argv.includes('--classify-only'),
    retrieveOnly: argv.includes('--retrieve-only'),
    arm: get('--arm') ?? (ablate === 'none' ? 'as-built' : `ablate-${ablate}`),
    out: get('--out'),
    force: argv.includes('--force'),
  }
}

function historyFor(fixture: Fixture, cell: Cell): RecentMessage[] {
  const lines = cell.threads.flatMap((name) => {
    const thread = fixture.threads[name]
    if (thread === undefined) throw new Error(`${cell.id}: no thread ${name}`)
    return thread
  })
  return lines.map((line, i) => ({
    direction: line.direction,
    body: line.body,
    createdAt: new Date(
      Date.now() - (lines.length - i) * LINE_GAP_SECONDS * 1000,
    ),
    delivery: 'delivered' as const,
  }))
}

interface Unit {
  category: string | null
  confidence: number | null
  reasoning: string | null
  action: string | null
  triggers: string[]
  body: string | null
  knowledge: string[]
  error: string | null
}

interface TurnInput {
  venueId: string
  guestId: string
  trace: ReturnType<typeof startAgentTrace>
  cell: Cell
  history: RecentMessage[]
  ablate: Ablation
  classifyOnly: boolean
  retrieveOnly: boolean
}

/** One inbound turn through the real stages and the real gate. */
async function runTurn(input: TurnInput): Promise<Unit> {
  const unit: Unit = {
    category: null,
    confidence: null,
    reasoning: null,
    action: null,
    triggers: [],
    body: null,
    knowledge: [],
    error: null,
  }
  try {
    const ctx: RuntimeContext = await buildRuntimeContext({
      agentRunId: randomUUID(),
      guestId: input.guestId,
      venueId: input.venueId,
      trace: input.trace,
      currentMessage: {
        id: randomUUID(),
        providerMessageId: `measurement-${randomUUID()}`,
        body: input.cell.inbound,
        receivedAt: new Date(),
        channel: 'instagram',
        referralSource: null,
      },
    })

    // The base guest is neutralised: the only thread a unit sees is the one
    // the fixture gives it.
    ctx.recentVisits = []
    ctx.guest.context = { observations: [], life_context: [] }
    ctx.guest.isDemo = false
    ctx.openIntentions = []
    ctx.pendingQuestion = null
    ctx.activeCommitments = []
    ctx.mechanics = []
    ctx.complaintFollowup = null
    ctx.visitCheckin = null
    ctx.openComplaintClarification = false
    // The incident was a first conversation, which is what renders
    // `## No questions this turn` on a turn with no open intention.
    ctx.firstConversation = input.ablate !== 'no-question-block'

    ctx.recentMessages = input.ablate === 'history' ? [] : input.history
    const classification = await classifyStage(ctx)
    ctx.recentMessages = input.history
    ctx.classification = classification
    unit.category = classification.category
    unit.confidence = classification.classifierConfidence
    unit.reasoning = classification.reasoning
    if (input.classifyOnly || !input.cell.fullTurn) return unit

    ctx.corpus = await retrieveCorpusStage(ctx)
    if (input.ablate === 'bare-query')
      ctx.recentMessages = input.history.map((m) => ({
        ...m,
        body: m.direction === 'outbound' ? m.body.replaceAll('?', '') : m.body,
      }))
    ctx.knowledgeCorpus = shouldRetrieveKnowledge(ctx)
      ? await retrieveKnowledgeWithContextStage(
          ctx,
          classification.category,
          input.cell.inbound,
        )
      : []
    ctx.recentMessages = input.history
    unit.knowledge = ctx.knowledgeCorpus.map((k) => k.text.slice(0, 70))
    if (input.retrieveOnly) return unit

    const gen = await generateStage(ctx, classification.category)
    if (gen.status !== 'success') {
      unit.error = `generate: ${gen.error}`
      return unit
    }
    unit.body = gen.result.body
    const decision = await evaluateApprovalDecision(ctx, gen.result)
    unit.action = decision.action
    if (decision.action === 'queue') unit.triggers = decision.triggers
  } catch (e) {
    unit.error = e instanceof Error ? e.message : String(e)
  }
  return unit
}

const BREW_METHOD = /pour over|french press|espresso|drip|moka|aeropress/i
const BEANS = ['budan', 'malenad', 'chikka', 'bhadra', 'estate secret']

/**
 * "One clean question, or one answer for a default, never both."
 *
 * A question is clean when the reply names no brewing method: it asked and
 * left the answering for the next turn. An answer is for a default when it
 * asks nothing, does not open on "depends", and is about at most one bean.
 * Read the bodies as well: this is a wording detector and will be wrong at
 * the edges in both directions.
 */
function brewShape(body: string): 'question' | 'default-answer' | 'both' {
  // The venue's measured voice drops the mark often enough to matter here.
  const asks = body.includes('?') || /^(which|what)\b/i.test(body.trim())
  const answers = BREW_METHOD.test(body)
  const beansNamed = BEANS.filter((b) => body.toLowerCase().includes(b)).length
  if (asks && !answers) return 'question'
  if (!asks && answers && !/\bdepends\b/i.test(body) && beansNamed <= 1)
    return 'default-answer'
  return 'both'
}

interface Tally {
  valid: number
  errors: number
  unknown: number
  sent: number
  good: number
}

async function main() {
  const args = parseArgs()
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture
  const cells = fixture.cells.filter(
    (c) => args.only === null || args.only.includes(c.id),
  )
  if (cells.length === 0) {
    console.error('✗ no cell matches --only')
    process.exit(2)
  }

  const supabase = createAdminClient()
  const { data: venue } = await supabase
    .from('venues')
    .select('id, slug')
    .eq('slug', args.venue)
    .maybeSingle()
  if (!venue) {
    console.error(`✗ venue ${args.venue} not found`)
    process.exit(1)
  }

  const log = createRunLog({
    name: 'answer-to-our-question',
    outputPath: args.out,
    force: args.force,
    meta: {
      arm: args.arm,
      ablate: args.ablate,
      promptVersion: PROMPT_VERSION,
      venue: venue.slug,
      guestId: args.guest,
      reps: args.reps,
      classifyReps: args.classifyReps,
      classifyOnly: args.classifyOnly,
      retrieveOnly: args.retrieveOnly,
      cells: cells.map((c) => c.id),
      note: 'classify, retrieve, generate and gate only; nothing sent, nothing written to the database',
    },
  })
  console.log(`arm: ${args.arm}   prompt ${PROMPT_VERSION}`)
  console.log(`run log: ${log.path}\n`)

  const trace = startAgentTrace({
    name: 'measurement.answer-to-our-question',
    agentRunId: randomUUID(),
    metadata: { venueId: venue.id, guestId: args.guest },
  })

  const tallies = new Map<string, Tally>()
  for (const cell of cells) {
    const full = cell.fullTurn && !args.classifyOnly
    const reps = full ? args.reps : args.classifyReps
    const tally: Tally = { valid: 0, errors: 0, unknown: 0, sent: 0, good: 0 }
    tallies.set(cell.id, tally)
    for (let rep = 0; rep < reps; rep += 1) {
      const unit = await runTurn({
        venueId: venue.id,
        guestId: args.guest,
        trace,
        cell,
        history: historyFor(fixture, cell),
        ablate: args.ablate,
        classifyOnly: args.classifyOnly,
        retrieveOnly: args.retrieveOnly,
      })
      let shape: string | null = null
      if (unit.error !== null) {
        tally.errors += 1
      } else {
        tally.valid += 1
        if (unit.category === 'unknown') tally.unknown += 1
        if (unit.action === 'send') tally.sent += 1
        if (full && unit.body !== null) {
          const body = unit.body
          if (cell.kind === 'brew') {
            shape = brewShape(body)
            if (shape !== 'both') tally.good += 1
          } else if (cell.kind === 'no-question') {
            shape = body.includes('?') ? 'ASKS' : 'asks-nothing'
            if (shape === 'asks-nothing') tally.good += 1
          } else {
            const has = (cell.mustMatch ?? []).every((p) =>
              new RegExp(p, 'i').test(body),
            )
            const hasNot = (cell.mustNotMatch ?? []).every(
              (p) => !new RegExp(p, 'i').test(body),
            )
            shape = has && hasNot ? 'on-topic' : 'off-topic'
            if (has && hasNot) tally.good += 1
          }
        }
      }
      log.appendUnit({
        rep,
        cell: cell.id,
        inbound: cell.inbound,
        shape,
        ...unit,
      })
      console.log(
        `${cell.id.padEnd(24)} rep${rep} ${(unit.category ?? 'ERROR').padEnd(14)} ${(unit.confidence ?? 0).toFixed(2)} ${(unit.action ?? '').padEnd(6)}${unit.triggers.join(',')} ${shape ?? ''} ${unit.error ?? (unit.body === null ? unit.reasoning : JSON.stringify(unit.body))}`,
      )
      if (unit.knowledge.length > 0 && (rep === 0 || args.retrieveOnly))
        for (const k of unit.knowledge) console.log(`${''.padEnd(26)}· ${k}`)
    }
  }

  await trace.flushAsync()

  console.log(`\narm: ${args.arm}   prompt ${PROMPT_VERSION}`)
  console.log(
    'cell                     kind     valid  errors  unknown  sent  good',
  )
  const failures: string[] = []
  for (const cell of cells) {
    const t = tallies.get(cell.id)!
    const full = cell.fullTurn && !args.classifyOnly
    console.log(
      `${cell.id.padEnd(24)} ${cell.kind.padEnd(8)} ${String(t.valid).padEnd(6)} ${String(t.errors).padEnd(7)} ${String(t.unknown).padEnd(8)} ${full ? String(t.sent).padEnd(5) : '-    '} ${full ? t.good : '-'}`,
    )
    if (cell.kind === 'control') continue
    // A failed unit is not a result: it disqualifies the cell.
    if (t.errors > 0) failures.push(`${cell.id}: ${t.errors} errored unit(s)`)
    if (t.valid === 0) {
      failures.push(`${cell.id}: no valid unit, not measured`)
      continue
    }
    if (cell.kind === 'answer' && t.unknown > 0)
      failures.push(`${cell.id}: ${t.unknown}/${t.valid} unknown, bar is 0`)
    if (!full) continue
    if (cell.kind === 'answer' && t.sent < t.valid)
      failures.push(`${cell.id}: ${t.sent}/${t.valid} auto-sent, bar is all`)
    if (cell.kind === 'no-question') {
      if (t.good < t.valid)
        failures.push(
          `CEILING ${cell.id}: ${t.valid - t.good}/${t.valid} asked something, ceiling is 0`,
        )
      continue
    }
    if (t.good < Math.ceil(t.valid * 0.9))
      failures.push(
        `${cell.id}: ${t.good}/${t.valid} ${cell.kind === 'brew' ? 'asked or answered, not both' : 'on topic with no product link'}, bar is 9 in 10`,
      )
  }

  console.log(`\nrun log: ${log.path}`)
  if (args.ablate !== 'none' || args.retrieveOnly) {
    console.log(
      'NO VERDICT: an ablation or retrieve-only run. Compare it with the as-built arm.',
    )
    return
  }
  if (failures.length > 0) {
    console.log(`VERDICT: FAIL\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('VERDICT: PASS. Read the bodies in the log before believing it.')
}

main().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
