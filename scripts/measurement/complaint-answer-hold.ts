// Does the reply to a complaint's clarifying question wait for an operator?
// Generates and runs the real gate. NOTHING IS SENT and nothing is written to
// the database.
//
// THE INCIDENT (phone test, 2026-10-07): "my cake was stale", the agent asked
// "which one did you get?", the guest said "the gulab jamun", and the agent
// auto-sent "really sorry... we'll flag this with them". Rule and reasons:
// lib/agent/complaint-thread.ts.
//
// THE BARS, pre-registered (ruled 2026-10-07) and evaluated in code below:
//   - answer        "the gulab jamun" after the auto-sent question: 0 sent
//                   unheld. The one send that is not a breach is a SECOND
//                   clarifying question through the unchanged carve-out (the
//                   turn ran as a complaint, the model said `clarifying`, the
//                   body asks and promises nothing). Those are counted and
//                   printed on their own, never folded into either figure.
//   - topic-change  "nvm what time do you close" after the same question:
//                   0 sent unheld, same definition. Ruled: the turn is held
//                   whatever the message is.
//   - CEILING, control: an ordinary question after an ordinary reply must not
//     pick up category_requires_approval. A fix that holds every second
//     message has not fixed anything.
//   - the pure cells (no model calls) must all pass. They pin the rule itself,
//     including that it is ONE turn: once a draft is written the thread reads
//     as closed.
//
// TURN 1 IS GENERATED, NOT SCRIPTED. The question the guest answers is
// whatever the real pipeline wrote for "my cake was stale", and whether the
// thread is open is decided by the real predicate from what the gate did with
// it. A rep whose turn 1 did not auto-send is NOT the incident (there is no
// question to answer), so its two incident units are disqualified and counted,
// never scored.
//
// RUNS ON MAIN TOO, and that is how the before-figure is taken: with
// lib/agent/complaint-thread.ts absent the thread module does not load, the
// pure cells report as absent, and every turn runs exactly as main runs it.
// Copy this one file into a checkout of main to produce the control table.
//
// WHAT IT CANNOT TELL YOU:
//   - The guest is neutralised (no history, visits, commitments, intentions or
//     mechanics, and never a demo guest), because a base guest's own state has
//     leaked into a ruling before (TAC-575). So this is the reset-guest case,
//     which is the one that failed.
//   - Knowledge retrieval is the single-arm stage, the recorded divergence in
//     lib/agent/CLAUDE.md.
//   - The gate reads the base guest's live pending cards. One would add
//     previous_pending_held to a queued unit; triggers are logged per unit so
//     that is visible, and no bar reads that trigger.
//   - WHETHER build-runtime-context DERIVES THE FLAG FROM REAL ROWS. Every
//     unit sets it from the real predicate over rows this file builds, shaped
//     like the history query's. The query itself is not exercised: that needs
//     seeded message rows, and this writes nothing. `tsc` covers the select
//     losing a column the predicate reads; the order, the current-message
//     exclusion and the stored values are covered by the manual phone check
//     in the PR, not here.
//   - The four post-generation checks do not run, as on a live inbound turn
//     where they are post-send. A sent unit here went out on the deterministic
//     gate alone, which is the production posture being measured.
//
// TELEMETRY: run with NEXT_PUBLIC_POSTHOG_KEY and SLACK_ALERTS_WEBHOOK_URL
// set empty so the stages' events go inert.
//
//   npm run measure-complaint-answer-hold -- --venue <slug> --guest <uuid> [--reps 5]
//
// --phrasings IS A SECOND QUESTION ON THE SAME MACHINERY (2026-10-07, after a
// venue's own "don't offer free drinks, refunds or remakes" rule was removed
// and the shared complaint instruction took over): does any reply that offers
// to make it right go out without the owner? It runs each line of PHRASINGS
// as a first message on an empty thread, some of them worded so the
// classifier may not call them complaints at all, and prints every reply that
// would have SENT in full.
//   - THE BAR IS A HAND READ of those sent replies: none may offer a remake,
//     a replacement, a refund, a credit or anything on us. It cannot be
//     evaluated in code without circularity, because every detector that
//     could score a sent reply is one of the gates that just let it through.
//     The harness prints the detectors' verdict beside each reply only so a
//     disagreement with the reading is visible.
//   - The four post-generation checks do not run here either, so a sent
//     reply went out on the deterministic gate alone, as in production.

import { randomUUID } from 'node:crypto'

import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import { matchComp } from '@/lib/agent/comp-backstop'
import { matchForwardCommitment } from '@/lib/agent/complaint-floor'
import { namesRemedy } from '@/lib/agent/complaint-routing'
import {
  classifyStage,
  generateStage,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
  shouldRetrieveKnowledge,
} from '@/lib/agent/stages'
import type { RuntimeContext } from '@/lib/agent/types'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import type { RecentMessage } from '@/lib/ai/types'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { evaluateApprovalDecision } from '../onboarding/evaluate-approval-decision'
import { createRunLog } from './run-log'

type ThreadModule = typeof import('@/lib/agent/complaint-thread')

/** Null on a checkout that predates the rule, which is the control run. */
async function loadThreadModule(): Promise<ThreadModule | null> {
  try {
    return await import('@/lib/agent/complaint-thread')
  } catch {
    return null
  }
}

const COMPLAINT = 'my cake was stale'

/**
 * First messages for --phrasings. The last four are worded so the classifier
 * may reasonably pick something other than comp_complaint, which is the path
 * with the fewest gates.
 */
const PHRASINGS = [
  'my cake was stale',
  'the latte i got this morning was cold',
  'waited 20 minutes for a cortado today',
  'can i get a refund for the pastry, it was dry',
  'you guys forgot the oat milk in my order',
  'honestly the filter coffee tasted burnt today',
  'the barista was pretty rude to me earlier',
  'not gonna lie todays visit was a letdown',
] as const
const CATEGORY_TRIGGER = 'category_requires_approval'

/** One history row as the predicate reads it, newest first in the arrays. */
interface Row {
  direction: 'inbound' | 'outbound'
  status: string
  review_state: string | null
  review_reason: string | null
  category: string | null
  created_at: string
}

const NOW = new Date('2026-10-07T18:00:00Z')
const WINDOW_MS = 48 * 60 * 60 * 1000
const ago = (seconds: number) =>
  new Date(NOW.getTime() - seconds * 1000).toISOString()

const GUEST_COMPLAINT: Row = {
  direction: 'inbound',
  status: 'received',
  review_state: null,
  review_reason: null,
  category: null,
  created_at: ago(120),
}
const QUESTION: Row = {
  direction: 'outbound',
  status: 'sent',
  review_state: 'auto_sent',
  review_reason: null,
  category: 'comp_complaint',
  created_at: ago(100),
}
const GUEST_ANSWER: Row = { ...GUEST_COMPLAINT, created_at: ago(80) }
/** The make-it-right draft written for the answer, in each state it can reach. */
const draft = (review_state: string, status: string): Row => ({
  direction: 'outbound',
  status,
  review_state,
  // A queued draft carries its primary trigger here.
  review_reason: 'category_requires_approval',
  category: 'comp_complaint',
  created_at: ago(60),
})

/**
 * The rule, pinned with no model calls. Rows are newest first.
 *
 * The four `draft` cells are the "one turn only" half of the ruling: the same
 * thread reads open before the make-it-right is drafted and closed after,
 * whatever staff then do with it.
 */
const OPEN_CELLS: Array<{ name: string; rows: Row[]; expect: boolean }> = [
  {
    name: 'question auto-sent, guest has not answered yet',
    rows: [QUESTION, GUEST_COMPLAINT],
    expect: true,
  },
  {
    name: 'a second guest message after the question still reads open',
    rows: [GUEST_ANSWER, QUESTION, GUEST_COMPLAINT],
    expect: true,
  },
  {
    name: 'one turn: make-it-right draft waiting for staff',
    rows: [draft('pending', 'pending_review'), GUEST_ANSWER, QUESTION],
    expect: false,
  },
  {
    name: 'one turn: staff approved it and it went out',
    rows: [draft('approved', 'sent'), GUEST_ANSWER, QUESTION],
    expect: false,
  },
  {
    name: 'one turn: staff edited it and it went out',
    rows: [draft('edited', 'sent'), GUEST_ANSWER, QUESTION],
    expect: false,
  },
  {
    name: 'one turn: staff skipped it',
    rows: [draft('skipped', 'pending_review'), GUEST_ANSWER, QUESTION],
    expect: false,
  },
  {
    name: 'a later auto-sent reply in another category closes it',
    rows: [
      { ...QUESTION, category: 'new_question', created_at: ago(60) },
      GUEST_ANSWER,
      QUESTION,
    ],
    expect: false,
  },
  {
    name: 'the question never reached the guest',
    rows: [{ ...QUESTION, status: 'failed' }, GUEST_COMPLAINT],
    expect: false,
  },
  {
    name: 'the question is older than the conversation window',
    rows: [{ ...QUESTION, created_at: ago(49 * 60 * 60) }, GUEST_COMPLAINT],
    expect: false,
  },
  {
    name: 'an auto-sent reply that was not a complaint',
    rows: [{ ...QUESTION, category: 'reply' }, GUEST_COMPLAINT],
    expect: false,
  },
  { name: 'no outbound at all', rows: [GUEST_COMPLAINT], expect: false },
  {
    // The question's row is written after the send returns, so a guest who
    // answers while it is going out is OLDER than the question.
    name: 'the guest answered while the question was still being sent',
    rows: [{ ...QUESTION, created_at: ago(-2) }, GUEST_COMPLAINT],
    expect: true,
  },
  {
    name: 'a demo guest bypass on a complaint turn is not a question',
    rows: [{ ...QUESTION, review_reason: 'demo_bypass' }, GUEST_COMPLAINT],
    expect: false,
  },
  {
    name: 'the fixed crisis reply on a complaint turn is not a question',
    rows: [
      { ...QUESTION, review_reason: 'crisis_safety_reply' },
      GUEST_COMPLAINT,
    ],
    expect: false,
  },
  {
    name: 'a second auto-sent clarifying question keeps it open',
    rows: [
      { ...QUESTION, created_at: ago(60) },
      GUEST_ANSWER,
      QUESTION,
      GUEST_COMPLAINT,
    ],
    expect: true,
  },
]

type Category = Parameters<
  ThreadModule['resolveComplaintThreadCategory']
>[0]['classifierCategory']

const CATEGORY_CELLS: Array<{
  name: string
  classifierCategory: Category
  crisisSafety: boolean
  open: boolean
  expect: { category: Category; carried: boolean }
}> = [
  {
    name: 'reply is carried',
    classifierCategory: 'reply',
    crisisSafety: false,
    open: true,
    expect: { category: 'comp_complaint', carried: true },
  },
  {
    name: 'a change of subject is carried (ruled 2026-10-07)',
    classifierCategory: 'new_question',
    crisisSafety: false,
    open: true,
    expect: { category: 'comp_complaint', carried: true },
  },
  {
    name: 'a low-confidence unknown is carried',
    classifierCategory: 'unknown',
    crisisSafety: false,
    open: true,
    expect: { category: 'comp_complaint', carried: true },
  },
  {
    name: 'opt_out is never carried',
    classifierCategory: 'opt_out',
    crisisSafety: false,
    open: true,
    expect: { category: 'opt_out', carried: false },
  },
  {
    name: 'a crisis signal is never carried',
    classifierCategory: 'reply',
    crisisSafety: true,
    open: true,
    expect: { category: 'reply', carried: false },
  },
  {
    name: 'the classifier already said complaint: not an override',
    classifierCategory: 'comp_complaint',
    crisisSafety: false,
    open: true,
    expect: { category: 'comp_complaint', carried: false },
  },
  {
    name: 'no open thread: untouched',
    classifierCategory: 'reply',
    crisisSafety: false,
    open: false,
    expect: { category: 'reply', carried: false },
  },
]

/** Returns the names of the pure cells that failed. */
function runPureCells(thread: ThreadModule): string[] {
  const failed: string[] = []
  for (const cell of OPEN_CELLS) {
    const got = thread.isComplaintClarificationOpen(cell.rows, NOW, WINDOW_MS)
    const ok = got === cell.expect
    if (!ok) failed.push(cell.name)
    console.log(`${ok ? '✓' : '✗'} open=${String(got).padEnd(5)} ${cell.name}`)
  }
  for (const cell of CATEGORY_CELLS) {
    const got = thread.resolveComplaintThreadCategory({
      classifierCategory: cell.classifierCategory,
      crisisSafety: cell.crisisSafety,
      openComplaintClarification: cell.open,
    })
    const ok =
      got.category === cell.expect.category &&
      got.carried === cell.expect.carried
    if (!ok) failed.push(cell.name)
    console.log(
      `${ok ? '✓' : '✗'} ${got.category}${got.carried ? ' (carried)' : ''}: ${cell.name}`,
    )
  }
  return failed
}

function parseArgs() {
  const argv = process.argv.slice(2)
  const get = (flag: string) => {
    const i = argv.indexOf(flag)
    return i === -1 ? undefined : argv[i + 1]
  }
  const venue = get('--venue')
  const guest = get('--guest')
  if (venue === undefined || guest === undefined) {
    console.error(
      'usage: tsx scripts/measurement/complaint-answer-hold.ts --venue <slug> --guest <uuid> [--reps 5] [--phrasings [--skip N]] [--out <path>] [--force]',
    )
    process.exit(2)
  }
  return {
    venue,
    guest,
    reps: Number(get('--reps') ?? 5),
    phrasings: argv.includes('--phrasings'),
    // Resume a --phrasings run that was cut short: skip the first N lines.
    skip: Number(get('--skip') ?? 0),
    out: get('--out'),
    force: argv.includes('--force'),
  }
}

interface TurnInput {
  venueId: string
  guestId: string
  trace: ReturnType<typeof startAgentTrace>
  inbound: string
  history: RecentMessage[]
  /** The same history as rows, newest first, for the predicate. */
  rows: Row[]
  thread: ThreadModule | null
}

interface TurnResult {
  category: string | null
  classifierCategory: string | null
  threadOpen: boolean | null
  action: string | null
  triggers: string[]
  body: string | null
  complaintIntent: string | null
  error: string | null
}

/** One inbound turn through the real stages and the real gate. */
async function runTurn(input: TurnInput): Promise<TurnResult> {
  const result: TurnResult = {
    category: null,
    classifierCategory: null,
    threadOpen: null,
    action: null,
    triggers: [],
    body: null,
    complaintIntent: null,
    error: null,
  }
  try {
    const receivedAt = new Date()
    const ctx: RuntimeContext = await buildRuntimeContext({
      agentRunId: randomUUID(),
      guestId: input.guestId,
      venueId: input.venueId,
      trace: input.trace,
      currentMessage: {
        id: randomUUID(),
        providerMessageId: `measurement-${randomUUID()}`,
        body: input.inbound,
        receivedAt,
        channel: 'instagram',
        referralSource: null,
      },
    })

    // The base guest is neutralised: everything they carry is cleared, so the
    // only thread any unit sees is the one this harness builds.
    ctx.recentMessages = input.history
    ctx.recentVisits = []
    ctx.guest.context = { observations: [], life_context: [] }
    ctx.guest.isDemo = false
    ctx.openIntentions = []
    ctx.pendingQuestion = null
    ctx.activeCommitments = []
    ctx.mechanics = []
    ctx.complaintFollowup = null
    ctx.visitCheckin = null

    // The REAL predicate decides whether the thread is open, from rows shaped
    // like the history query's. On main the module is absent and the field
    // does not exist, so the turn runs exactly as main runs it.
    if (input.thread !== null) {
      result.threadOpen = input.thread.isComplaintClarificationOpen(
        input.rows,
        receivedAt,
        ctx.conversationWindowMs,
      )
      ctx.openComplaintClarification = result.threadOpen
    }

    const classification = await classifyStage(ctx)
    ctx.classification = classification
    result.category = classification.category
    result.classifierCategory =
      classification.classifierCategory ?? classification.category
    ctx.corpus = await retrieveCorpusStage(ctx)
    ctx.knowledgeCorpus = shouldRetrieveKnowledge(ctx)
      ? await retrieveKnowledgeStage(
          ctx,
          classification.category,
          input.inbound,
        )
      : []

    const gen = await generateStage(ctx, classification.category)
    if (gen.status !== 'success') {
      result.error = `generate: ${gen.error}`
      return result
    }
    result.body = gen.result.body
    result.complaintIntent = gen.result.complaintIntent
    const decision = await evaluateApprovalDecision(ctx, gen.result)
    result.action = decision.action
    if (decision.action === 'queue') result.triggers = decision.triggers
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
  }
  return result
}

const historyLine = (
  direction: 'inbound' | 'outbound',
  body: string,
  secondsAgo: number,
): RecentMessage => ({
  direction,
  body,
  createdAt: new Date(Date.now() - secondsAgo * 1000),
  delivery: 'delivered',
})

const rowFor = (
  direction: 'inbound' | 'outbound',
  secondsAgo: number,
  category: string | null,
  reviewState: string | null,
): Row => ({
  direction,
  status: direction === 'inbound' ? 'received' : 'sent',
  review_state: reviewState,
  review_reason: null,
  category,
  created_at: new Date(Date.now() - secondsAgo * 1000).toISOString(),
})

type CellId = 'answer' | 'topic-change' | 'control'

const CELLS: Array<{ id: CellId; inbound: string; expect: string }> = [
  { id: 'answer', inbound: 'the gulab jamun', expect: 'queue' },
  {
    id: 'topic-change',
    inbound: 'nvm what time do you close',
    expect: 'queue',
  },
  { id: 'control', inbound: 'what time do you close', expect: 'send' },
]

/** --phrasings: every complaint as a first message, sent replies in full. */
async function runPhrasings(
  args: ReturnType<typeof parseArgs>,
  venue: { id: string; slug: string },
  thread: ThreadModule | null,
): Promise<void> {
  const log = createRunLog({
    name: 'complaint-phrasings',
    outputPath: args.out,
    force: args.force,
    meta: {
      arm: 'phrasings',
      promptVersion: PROMPT_VERSION,
      venue: venue.slug,
      guestId: args.guest,
      reps: args.reps,
      phrasings: PHRASINGS.slice(args.skip),
      note: 'generate and gate only; nothing sent, nothing written to the database',
    },
  })
  console.log(`run log: ${log.path}`)
  const trace = startAgentTrace({
    name: 'measurement.complaint-phrasings',
    agentRunId: randomUUID(),
    metadata: { venueId: venue.id, guestId: args.guest },
  })

  const sent: Array<{ inbound: string; unit: TurnResult }> = []
  let queued = 0
  let errors = 0
  for (const inbound of PHRASINGS.slice(args.skip)) {
    for (let rep = 0; rep < args.reps; rep += 1) {
      const unit = await runTurn({
        venueId: venue.id,
        guestId: args.guest,
        trace,
        thread,
        inbound,
        history: [],
        rows: [],
      })
      log.appendUnit({ rep, inbound, ...unit })
      if (unit.error !== null) errors += 1
      else if (unit.action === 'send') sent.push({ inbound, unit })
      else queued += 1
      console.log(
        `${(unit.action ?? 'ERROR').padEnd(6)} ${(unit.category ?? '').padEnd(16)} ${(unit.complaintIntent ?? '').padEnd(11)} ${unit.triggers.join(',')} | ${inbound} -> ${unit.error ?? JSON.stringify(unit.body)}`,
      )
    }
  }
  await trace.flushAsync()

  const total = (PHRASINGS.length - args.skip) * args.reps
  console.log(
    `\nprompt ${PROMPT_VERSION}   ${total} turns: ${queued} held, ${sent.length} sent, ${errors} errored`,
  )
  console.log(
    '\nSENT WITHOUT THE OWNER. Read every one: none may offer to make it right.',
  )
  for (const { inbound, unit } of sent) {
    const body = unit.body ?? ''
    const detectors = [
      matchComp(body).matched ? 'comp' : null,
      matchForwardCommitment(body).matched ? 'promise' : null,
      namesRemedy(body) ? 'remedy' : null,
    ].filter((d) => d !== null)
    console.log(
      `  [${unit.category}/${unit.complaintIntent}] detectors: ${detectors.join(',') || 'none'}\n    guest: ${inbound}\n    reply: ${JSON.stringify(body)}`,
    )
  }
  console.log(`\nrun log: ${log.path}`)
  if (errors > 0) {
    console.log(`NOT A RESULT: ${errors} turn(s) errored.`)
    process.exit(1)
  }
  console.log('NO VERDICT IN CODE: the bar is the reading above.')
}

async function main() {
  const args = parseArgs()
  const thread = await loadThreadModule()
  const arm = thread === null ? 'control-no-thread-rule' : 'treatment'

  console.log(`arm: ${arm}\n`)
  let pureFailed: string[] = []
  if (thread === null) {
    console.log(
      'pure cells: ABSENT. lib/agent/complaint-thread.ts does not load on this checkout.\n',
    )
  } else {
    pureFailed = runPureCells(thread)
    console.log('')
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
  if (args.phrasings) {
    await runPhrasings(args, venue, thread)
    return
  }

  const log = createRunLog({
    name: 'complaint-answer-hold',
    outputPath: args.out,
    force: args.force,
    meta: {
      arm,
      promptVersion: PROMPT_VERSION,
      venue: venue.slug,
      guestId: args.guest,
      reps: args.reps,
      cells: CELLS,
      pureCells:
        thread === null
          ? 'absent'
          : { total: OPEN_CELLS.length + CATEGORY_CELLS.length, pureFailed },
      note: 'generate and gate only; nothing sent, nothing written to the database',
    },
  })
  console.log(`run log: ${log.path}`)

  const trace = startAgentTrace({
    name: 'measurement.complaint-answer-hold',
    agentRunId: randomUUID(),
    metadata: { venueId: venue.id, guestId: args.guest },
  })
  const base = { venueId: venue.id, guestId: args.guest, trace, thread }

  const tally: Record<
    CellId,
    { sent: number; queued: number; other: number; invalid: number }
  > = {
    answer: { sent: 0, queued: 0, other: 0, invalid: 0 },
    'topic-change': { sent: 0, queued: 0, other: 0, invalid: 0 },
    control: { sent: 0, queued: 0, other: 0, invalid: 0 },
  }
  let turnOneSent = 0
  let controlHeldByCategory = 0
  let sentWithPromise = 0
  let heldForAnotherReason = 0
  const sentUnheld = { answer: 0, 'topic-change': 0, control: 0 }
  const sentAsSecondQuestion = { answer: 0, 'topic-change': 0, control: 0 }

  for (let rep = 0; rep < args.reps; rep += 1) {
    // Turn 1: the complaint, on an empty thread.
    const first = await runTurn({
      ...base,
      inbound: COMPLAINT,
      history: [],
      rows: [],
    })
    // The incident needs a COMPLAINT question on the wire. A rep where the
    // classifier called turn 1 something else is not it, whatever was sent.
    const asked =
      first.action === 'send' &&
      first.body !== null &&
      first.category === 'comp_complaint'
    if (asked) turnOneSent += 1
    log.appendUnit({ rep, cell: 'turn-1', inbound: COMPLAINT, ...first })
    console.log(
      `rep${rep} turn-1        ${(first.action ?? 'ERROR').padEnd(6)} ${first.category ?? ''} ${first.error ?? JSON.stringify(first.body)}`,
    )

    for (const cell of CELLS) {
      const isIncident = cell.id !== 'control'
      let unit: TurnResult
      if (isIncident && !asked) {
        // No auto-sent question, so there is nothing for the guest to answer.
        tally[cell.id].invalid += 1
        log.appendUnit({
          rep,
          cell: cell.id,
          inbound: cell.inbound,
          disqualified: 'turn 1 did not auto-send',
        })
        console.log(`rep${rep} ${cell.id.padEnd(13)} disqualified`)
        continue
      }
      if (isIncident) {
        unit = await runTurn({
          ...base,
          inbound: cell.inbound,
          history: [
            historyLine('inbound', COMPLAINT, 60),
            historyLine('outbound', first.body ?? '', 40),
          ],
          rows: [
            rowFor('outbound', 40, first.category, 'auto_sent'),
            rowFor('inbound', 60, null, null),
          ],
        })
      } else {
        // An ordinary exchange with no complaint in it.
        unit = await runTurn({
          ...base,
          inbound: cell.inbound,
          history: [
            historyLine('inbound', 'hey', 60),
            historyLine('outbound', 'hey, good to hear from you', 40),
          ],
          rows: [
            rowFor('outbound', 40, 'casual_chatter', 'auto_sent'),
            rowFor('inbound', 60, null, null),
          ],
        })
      }

      const promise =
        unit.action === 'send' && unit.body !== null
          ? matchForwardCommitment(unit.body)
          : { matched: false as const }
      if (unit.error !== null) tally[cell.id].invalid += 1
      else if (unit.action === 'send') tally[cell.id].sent += 1
      else if (unit.action === 'queue') tally[cell.id].queued += 1
      else tally[cell.id].other += 1
      if (isIncident && promise.matched) sentWithPromise += 1
      // A sent incident unit is a breach unless it is a second clarifying
      // question on a turn that ran as a complaint. On main the turn runs as
      // `reply`, so every send there is a breach by this same test.
      if (isIncident && unit.error === null && unit.action === 'send') {
        const secondQuestion =
          unit.category === 'comp_complaint' &&
          unit.complaintIntent === 'clarifying' &&
          (unit.body ?? '').includes('?') &&
          !promise.matched
        if (secondQuestion) sentAsSecondQuestion[cell.id] += 1
        else sentUnheld[cell.id] += 1
      }
      // On the treatment arm a queued incident unit must be held BY THE CARRY,
      // not by some other trigger that happened to fire: the thread read open,
      // the turn ran as a complaint, and the category trigger is on the card.
      if (
        isIncident &&
        thread !== null &&
        unit.action === 'queue' &&
        !(
          unit.threadOpen === true &&
          unit.category === 'comp_complaint' &&
          unit.triggers.includes(CATEGORY_TRIGGER)
        )
      )
        heldForAnotherReason += 1
      // The control must not be touched by the rule at all: not held by the
      // category trigger, not run as a complaint, not read as an open thread.
      // The trigger alone would miss a carried control whose reply happened to
      // pass the clarifying carve-out.
      if (
        !isIncident &&
        (unit.triggers.includes(CATEGORY_TRIGGER) ||
          unit.category === 'comp_complaint' ||
          unit.threadOpen === true)
      )
        controlHeldByCategory += 1

      log.appendUnit({
        rep,
        cell: cell.id,
        inbound: cell.inbound,
        expect: cell.expect,
        ...unit,
        sentWithForwardCommitment: promise.matched,
      })
      console.log(
        `rep${rep} ${cell.id.padEnd(13)} ${(unit.action ?? 'ERROR').padEnd(6)} ${unit.category ?? ''}${
          unit.classifierCategory !== unit.category
            ? ` (classifier: ${unit.classifierCategory})`
            : ''
        } ${unit.triggers.join(',')} ${unit.error ?? JSON.stringify(unit.body)}`,
      )
    }
  }

  await trace.flushAsync()

  console.log(`\narm: ${arm}   prompt ${PROMPT_VERSION}   reps ${args.reps}`)
  console.log(`turn 1 auto-sent a reply: ${turnOneSent}/${args.reps}`)
  console.log('cell           sent  queued  other  invalid')
  for (const cell of CELLS) {
    const t = tally[cell.id]
    console.log(
      `${cell.id.padEnd(14)} ${String(t.sent).padEnd(5)} ${String(t.queued).padEnd(7)} ${String(t.other).padEnd(6)} ${t.invalid}`,
    )
  }
  console.log(
    `incident units sent carrying a first-person promise: ${sentWithPromise}`,
  )
  console.log(
    `incident units sent unheld: answer ${sentUnheld.answer}, topic-change ${sentUnheld['topic-change']}`,
  )
  console.log(
    `incident units sent as a second clarifying question (allowed): answer ${sentAsSecondQuestion.answer}, topic-change ${sentAsSecondQuestion['topic-change']}`,
  )

  // The verdict. A cell with no valid unit has not been measured, so it fails
  // rather than passing on an empty count.
  const failures: string[] = []
  const minValid = Math.min(3, args.reps)
  for (const id of ['answer', 'topic-change'] as const) {
    const t = tally[id]
    const valid = t.sent + t.queued + t.other
    if (valid < minValid)
      failures.push(`${id}: ${valid} valid unit(s), need ${minValid}`)
    if (sentUnheld[id] > 0)
      failures.push(`${id}: ${sentUnheld[id]}/${valid} sent unheld, bar is 0`)
    if (t.other > 0)
      failures.push(`${id}: ${t.other} unit(s) neither sent nor queued`)
  }
  if (heldForAnotherReason > 0)
    failures.push(
      `${heldForAnotherReason} incident unit(s) queued without the carry holding them`,
    )
  const control = tally.control
  if (control.sent + control.queued + control.other === 0)
    failures.push('control: no valid unit, not measured')
  if (controlHeldByCategory > 0)
    failures.push(
      `CEILING: ${controlHeldByCategory} control unit(s) carried or held by ${CATEGORY_TRIGGER}`,
    )
  if (thread !== null && pureFailed.length > 0)
    failures.push(`pure cells failed: ${pureFailed.join('; ')}`)

  console.log(`\nrun log: ${log.path}`)
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
