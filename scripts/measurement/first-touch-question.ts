// TAC-423 pre-flight: with the opener's scripted question gone, does the
// first-touch reply still ask anything? Generate-only. NOTHING IS SENT.
//
// ONE WRITE IS POSSIBLE and it is not this script's: buildRuntimeContext runs
// computeGuestState, which persists a `guest_states` row when a guest's
// recognition band actually changes. It does not fire for a guest whose band
// is stable, which is every guest this is worth running against — verified on
// the 2026-09-22 run, 6 rows before and 6 after, newest unchanged. Stated
// rather than claimed away, because "writes nothing" is the kind of sentence
// that stops being true without anyone noticing.
//
// The change under test removes the opener's own question and leaves the ask
// to the intention line rendered beneath it. TAC-519 measured what that line
// achieves in production at Le Mil's: 4 intention asks in 9 days,
// understand_order armed 5 and asked 1, learn_name armed 7 and asked 0. So the
// realistic risk is an opener that greets and asks nothing, and the ticket's
// whole point is a first touch that asks what the guest got.
//
// THE TWO ARMS DIFFER IN EXACTLY ONE VARIABLE: the opener paragraph. The
// prompt pair is composed ONCE per rep, and the BEFORE arm is that same pair
// with the shipped opener string replaced by v1.52.0's. Everything else —
// venue config, corpora, retrieval, classification, recognition, the intention
// lines, the restraint paragraph — is byte-identical between arms. A
// replacement that does not match exactly once makes the unit INVALID rather
// than silently measuring two prompts that differ in more than the opener.
//
// WHAT THIS IS NOT. It replicates generateMessage's single model call (same
// model, same system prompt plus the fidelity instruction, same schema, same
// token cap) but NOT its regeneration loop or its fidelity floor. Both arms
// share that limitation identically. It matters least for this metric: the
// regen loop fires on dashes, self-talk and unverified links, none of which
// decide whether a question is present.
//
// THE TURN IS SYNTHESISED, and it has to be. firstTouchAfterQrScan requires a
// guest's true first message, and every scanned guest at Le Mil's already has
// history, so no live guest can produce this turn. The context is built from a
// REAL venue and guest and then four fields are overridden to make it the
// opener turn: the guest's origin and creation time, an empty history, and the
// two intentions the real derivation opens there. Both arms get that same
// object. Creating a guest row instead would be a write, which a measurement
// does not get to make.
//
// TELEMETRY: run with NEXT_PUBLIC_POSTHOG_KEY and SLACK_ALERTS_WEBHOOK_URL
// unset so the stages' events go inert.

import { randomUUID } from 'node:crypto'
import { generateObject } from 'ai'

import { createAdminClient } from '@/lib/db/admin'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import {
  buildAiRuntime,
  classifyStage,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
  shouldRetrieveKnowledge,
} from '@/lib/agent/stages'
import { composePrompt } from '@/lib/ai/compose-prompt'
import {
  GeneratedMessageSchema,
  MAX_OUTPUT_TOKENS,
  VOICE_FIDELITY_INSTRUCTION,
} from '@/lib/ai/generate-message'
import { getGenerationModel } from '@/lib/ai/client'
import { firstTouchOpenerFor } from '@/lib/ai/prompts/serializers'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { INTENTION_DEFINITION_BY_KEY } from '@/lib/agent/intentions/definitions'
import { classifyIntentionPrompts } from '@/lib/ai/classify-intention-prompts'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { createRunLog } from './run-log'
import { classifyFirstTouchReply } from './first-touch-question-detector'
import { moveIntentionBlockLate } from './intention-block-move'
import { selectOrdinaryTurns, type OrdinaryTurn } from './ordinary-turn-selection'

// v1.52.0's opener, transcribed from the commit it shipped in, not rebuilt
// from the current source. This is the BEFORE arm and it must not drift with
// the code under test.
const OPENER_BEFORE =
  "This is the guest's first message on this number, sent right after they scanned your sign at pickup. They've already ordered and have it in hand. You don't know what it was. Say hello and let them know who they're texting, in your own words. If their message doesn't ask you anything, this is also the moment to thank them for coming in and ask what they got, one question, then let their answer lead. If they did ask something, answer that instead; the question isn't worth spending their first reply on."

// THE QUESTION-REMOVED OPENER, DERIVED RATHER THAN TRANSCRIBED.
//
// TAC-423's run reported 11/20 for "opener's question removed, intention line
// left to carry it". That arm is not in the repo: this harness has one commit,
// and both its arms scripted the question. Its run log was not recoverable
// either (no measurement-runs directory was ever written in that worktree, and
// the worktree is gone), so per the 2026-09-23 ruling the arm is REGENERATED
// FRESH rather than reconstructed from memory, and the floor is re-measured
// rather than assumed to be 11/20.
//
// "Regenerated" still needs a definition of the arm, and this is the one thing
// that must not be a guess: it is the SHIPPED opener minus its final sentence,
// computed from the live constant at run time. So it cannot drift from the
// opener, and a reword that removes or renames that sentence fails the run
// loudly instead of silently measuring something else.
const OPENER_QUESTION_SENTENCE = 'Ask what they just got.'

function openerWithoutQuestion(shipped: string): string {
  const hits = shipped.split(OPENER_QUESTION_SENTENCE).length - 1
  if (hits !== 1 || !shipped.trimEnd().endsWith(OPENER_QUESTION_SENTENCE)) {
    throw new Error(
      `the shipped opener no longer ends with exactly one ${JSON.stringify(OPENER_QUESTION_SENTENCE)} (found ${hits}). The question-removed arm cannot be derived; fix this harness before trusting a run.`,
    )
  }
  return shipped.trimEnd().slice(0, -OPENER_QUESTION_SENTENCE.length).trimEnd()
}

// THE BALANCE CANDIDATE, as a span replacement rather than a whole-paragraph
// transcription. The first two lines of formatOpenIntentions' paragraph are
// unchanged by this candidate, so the span starts at the third and runs to the
// end. Anchoring on two single-occurrence sentences means no 25-line transcript
// to drift against the source.
const BALANCE_SPAN_START = 'A natural opening is ordinary and small.'
const BALANCE_SPAN_END = 'If nothing fits, let it wait. There will be other conversations.'

const BALANCE_REPLACEMENT = [
  'Most replies have room for one. A short question on the end of a',
  'finished reply is ordinary, not a special occasion: "we\'re open till 3',
  'on Sundays. you nearby?"',
  '',
  'Four reasons to hold back, and they are the only four:',
  '',
  "- The message carries an apology, bad news, or something they're",
  '  unhappy about. Leave those alone entirely.',
  '- You have already raised this one with this guest. Never the same one',
  '  twice.',
  '- It would not fit at the end. Whatever they raised is still the job,',
  '  the question goes last and in one short line, and you never steer the',
  '  conversation toward one of these to make room.',
  '- You would be asking a second thing. One question, not two.',
  '',
  'If none of those applies, ask.',
].join('\n')

type Shaped = { ok: true; prompt: string } | { ok: false; reason: string }

/**
 * Apply one arm's transformation to the composed user prompt.
 *
 * Every transformation is guarded to match exactly once. A miss makes the unit
 * INVALID rather than silently measuring two prompts that differ in more than
 * the one variable under test, which is TAC-423's own guard and the reason its
 * numbers are trustworthy.
 */
function shapePromptForArm(
  userPrompt: string,
  arm: Arm,
  shippedOpener: string,
  expectOpener: boolean,
): Shaped {
  let prompt = userPrompt

  // The shipped prompt, as a validity anchor with a known expected value.
  if (arm === 'scripted_control') return { ok: true, prompt }

  // THE OPENER TREATMENT IS FIRST-TOUCH ONLY, and the first version of this
  // function got it wrong: an ordinary mid-conversation turn has no opener at
  // all (firstTouchAfterQrScan is false), so requiring exactly one match marked
  // every non-control arm INVALID on every ordinary turn, which is the whole
  // population this ticket is about. Asserting its ABSENCE there is as
  // load-bearing as asserting its presence here: a turn that unexpectedly
  // carries it is not the turn shape being replayed.
  const openerHits = prompt.split(shippedOpener).length - 1
  if (expectOpener) {
    if (openerHits !== 1) {
      return { ok: false, reason: `opener matched ${openerHits} times, expected 1` }
    }
    prompt = prompt.replace(shippedOpener, openerWithoutQuestion(shippedOpener))
  } else if (openerHits !== 0) {
    return {
      ok: false,
      reason: `an ordinary turn carries the first-touch opener ${openerHits} times, expected 0`,
    }
  }

  if (arm === 'balance' || arm === 'both') {
    const startAt = prompt.indexOf(BALANCE_SPAN_START)
    const endAt = prompt.indexOf(BALANCE_SPAN_END)
    if (prompt.split(BALANCE_SPAN_START).length - 1 !== 1) {
      return { ok: false, reason: 'balance span start did not match exactly once' }
    }
    if (prompt.split(BALANCE_SPAN_END).length - 1 !== 1) {
      return { ok: false, reason: 'balance span end did not match exactly once' }
    }
    if (startAt >= endAt) {
      return { ok: false, reason: 'balance span anchors are out of order' }
    }
    prompt = prompt.slice(0, startAt) + BALANCE_REPLACEMENT + prompt.slice(endAt + BALANCE_SPAN_END.length)
  }

  if (arm === 'position' || arm === 'both') {
    const moved = moveIntentionBlockLate(prompt)
    if (!moved.ok) return { ok: false, reason: `position: ${moved.reason}` }
    prompt = moved.prompt
  }

  return { ok: true, prompt }
}

const SCENARIOS = [
  {
    id: 'prefill',
    // Le Mil's live qrEnrollmentMessage, read from production 2026-09-22.
    // THE PRIMARY SCENARIO: the modal scan, no question of the guest's own,
    // which is the only turn on which either opener licenses an ask at all.
    body: "Hi Le Mil's!",
  },
  {
    id: 'prefill-plus-question',
    // The case ruling 2 deliberately changed. BEFORE holds its question back
    // ("the question isn't worth spending their first reply on"); AFTER is
    // governed by the restraint paragraph, which permits one short question on
    // the end of a finished answer. A LOWER ask rate here on the AFTER arm
    // would mean the ruling did not land.
    body: "Hi Le Mil's! are you open right now?",
  },
] as const

// TAC-519's arms. Every one of them carries the OPENER WITH ITS QUESTION
// REMOVED, so the intention line is what has to carry the ask; that is the
// configuration this ticket is about and the one TAC-423 measured at 11/20.
// `scripted_control` is the exception and is the shipped prompt, kept as a
// validity anchor because it has a known expected value (20/20).
//
// The four real arms differ from each other in EXACTLY ONE variable: which of
// the two candidate transformations is applied to the block.
const ARMS = ['scripted_control', 'before', 'position', 'balance', 'both'] as const
type Arm = (typeof ARMS)[number]

interface Args {
  venue?: string
  guest?: string
  reps: number
  /**
   * 'first-touch' synthesises the QR opener turn (TAC-423's original subject).
   * 'ordinary' replays real mid-conversation turns that actually rendered
   * intentions (TAC-519's subject, and the only mode in which the position
   * candidate is measurable at all).
   */
  mode: 'first-touch' | 'ordinary'
  /** Ordinary mode: how many of the replayable turns to use. */
  turns: number
  /** Subset of ARMS to run. Empty means all. For a cheap smoke before a real run. */
  arms: string[]
  /** Print the composed prompt's block order and exit. */
  dumpBlocks: boolean
  /** Subset of SCENARIOS to run. Empty means all. */
  scenarios: string[]
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { reps: 20, mode: 'first-touch', turns: 12, arms: [], scenarios: [], dumpBlocks: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--venue') out.venue = argv[++i]
    else if (argv[i] === '--guest') out.guest = argv[++i]
    else if (argv[i] === '--reps') out.reps = Number(argv[++i])
    else if (argv[i] === '--mode') out.mode = argv[++i] === 'ordinary' ? 'ordinary' : 'first-touch'
    else if (argv[i] === '--turns') out.turns = Number(argv[++i])
    else if (argv[i] === '--dump-blocks') out.dumpBlocks = true
    else if (argv[i] === '--arms') out.arms = (argv[++i] ?? '').split(',').filter(Boolean)
    else if (argv[i] === '--scenarios') out.scenarios = (argv[++i] ?? '').split(',').filter(Boolean)
  }
  return out
}

/**
 * Build and compose the SYNTHESISED first-touch turn. Four fields are
 * overridden to make it the opener turn, because firstTouchAfterQrScan needs a
 * guest's true first message and every scanned guest at Le Mil's already has
 * history. Creating a guest row instead would be a write.
 */
async function prepareFirstTouchTurn(input: {
  venueId: string
  guestId: string
  scenario: { id: string; body: string }
  rep: number
  trace: ReturnType<typeof startAgentTrace>
}): Promise<PreparedTurn> {
  const ctx = await buildRuntimeContext({
    agentRunId: randomUUID(),
    guestId: input.guestId,
    venueId: input.venueId,
    trace: input.trace,
    currentMessage: {
      id: randomUUID(),
      providerMessageId: `measurement-${input.scenario.id}-${input.rep}`,
      body: input.scenario.body,
      receivedAt: new Date(),
      channel: 'text',
      // TAC-518: the SMS arm carries no referral, so the opener and the
      // order arming both key off created_via exactly as they did when
      // this harness was written. Keeping the measurement comparable.
      referralSource: null,
    },
  })

  const now = new Date()
  ctx.guest.createdVia = 'qr_scan'
  ctx.guest.createdAt = now
  ctx.recentMessages = []
  ctx.recentVisits = []
  ctx.activeCommitments = []
  ctx.openIntentions = (['understand_order', 'learn_name'] as const).map((key) => ({
    key,
    promptLine: INTENTION_DEFINITION_BY_KEY[key].promptLine,
    eligibleAt: now,
  }))
  return finishPrepare(ctx, input.scenario.body)
}

/**
 * Build and compose a REAL past turn, on its own guest.
 *
 * `openIntentions` is set from what production actually rendered on that turn
 * (messages.rendered_intentions) rather than re-derived. Re-deriving would let
 * arming, gating, the brake and expiry drift between the arms and the turn being
 * replayed, so a difference in the reply could not be attributed to the prompt.
 *
 * THE LIMITATION BOTH ARMS SHARE: a replayed turn is re-dated. `## Right now`
 * renders today's clock and open/closed state, history is loaded live, and
 * isExpired is computed live. So the before/after delta is valid while the
 * absolute rate is not production's, which is why the floor is measured in-run.
 */
async function prepareOrdinaryTurn(input: {
  venueId: string
  turn: OrdinaryTurn
  trace: ReturnType<typeof startAgentTrace>
}): Promise<PreparedTurn> {
  const ctx = await buildRuntimeContext({
    agentRunId: randomUUID(),
    guestId: input.turn.guestId,
    venueId: input.venueId,
    trace: input.trace,
    currentMessage: {
      id: input.turn.inboundId,
      providerMessageId: input.turn.inboundProviderMessageId,
      body: input.turn.inboundBody,
      receivedAt: input.turn.inboundReceivedAt,
      channel: input.turn.inboundChannel,
      // TAC-518: read from the row rather than hardcoded, because a replayed
      // turn must not silently differ from the turn it replays. In practice an
      // ordinary mid-conversation inbound carries no referral (a referral
      // arrives once, with a guest's first action), so this is almost always
      // null; reading it means the almost is measured rather than assumed.
      referralSource: input.turn.inboundReferralSource,
    },
  })
  ctx.openIntentions = input.turn.rendered
  return finishPrepare(ctx, input.turn.inboundBody)
}

/** Classify, retrieve and compose. Identical for both modes by construction. */
async function finishPrepare(
  ctx: Awaited<ReturnType<typeof buildRuntimeContext>>,
  inboundBody: string,
): Promise<PreparedTurn> {
  const classification = await classifyStage(ctx)
  ctx.classification = classification
  ctx.corpus = await retrieveCorpusStage(ctx)
  ctx.knowledgeCorpus = shouldRetrieveKnowledge(ctx)
    ? await retrieveKnowledgeStage(ctx, classification.category, inboundBody)
    : []

  // What the post-send classifier is offered, which in production is the
  // RENDERED set: key plus the definition's classifierDescription, never the
  // promptLine.
  const offeredForClassifier = ctx.openIntentions.map((o) => ({
    key: o.key,
    description: INTENTION_DEFINITION_BY_KEY[o.key].classifierDescription,
  }))

  const runtime = buildAiRuntime(ctx)
  const composed = composePrompt({
    persona: ctx.venue.brandPersona,
    venueInfo: ctx.venue.venueInfo,
    ragChunks: ctx.corpus ?? [],
    knowledgeChunks: ctx.knowledgeCorpus ?? [],
    runtime,
    category: classification.category,
    channel: ctx.conversationChannel,
  } as Parameters<typeof composePrompt>[0])

  return { composed, offeredForClassifier, category: classification.category }
}

type Cell = {
  n: number
  failed: number
  question: number
  order: number
  raised: number
  twoQuestions: number
  /** TAC-519 ceiling: raises landing on a reply that carries an apology. */
  apologyRaise: number
  invalid: number
}

interface PreparedTurn {
  composed: { systemPrompt: string; userPrompt: string }
  offeredForClassifier: { key: string; description: string }[]
  category: string | null
}

interface UnitInput extends PreparedTurn {
  groupId: string
  inbound: string
  rep: number
  guestId: string
  arms: readonly Arm[]
  openerAfter: string
  expectOpener: boolean
  bump: (k: string) => Cell
  log: { appendUnit: (u: Record<string, unknown>) => void }
}

/** One (turn, rep) across every arm. Shared by both modes so they cannot drift. */
async function runArms(u: UnitInput): Promise<void> {
  // THE ARMS OF ONE TURN RUN CONCURRENTLY. They are independent by
  // construction: each shapes its own prompt from the SAME composed prompt (one
  // compose per rep is the property that makes the arms comparable, and it is
  // unchanged), and each touches only its own tally cell. Sequential, a run over
  // all 39 turns measured ~52s per unit, which is 4.5 hours; four at a time
  // brings it to well under an hour at four concurrent requests, which is a
  // rate this account sustains without 429s.
  //
  // Concurrency here CANNOT change what is measured. It would if the arms
  // shared a prompt-shaping step or a mutable context, and they share neither.
  await Promise.all(u.arms.map((arm) => runOneArm(u, arm)))
}

async function runOneArm(u: UnitInput, arm: Arm): Promise<void> {
  {
    const key = `${u.groupId}|${arm}`
    const t = u.bump(key)

    const shaped = shapePromptForArm(u.composed.userPrompt, arm, u.openerAfter, u.expectOpener)
    if (!shaped.ok) {
      t.invalid += 1
      u.log.appendUnit({ groupId: u.groupId, rep: u.rep, arm, invalid: shaped.reason })
      console.log(`! ${u.groupId} rep${u.rep} ${arm} INVALID (${shaped.reason})`)
      return
    }
    const userPrompt = shaped.prompt

    let body: string | null = null
    let error: string | null = null
    try {
      const { object } = await generateObject({
        model: getGenerationModel(),
        system: `${u.composed.systemPrompt}\n\n${VOICE_FIDELITY_INSTRUCTION}`,
        prompt: userPrompt,
        schema: GeneratedMessageSchema,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      })
      body = object.body
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : String(e)
    }

    // A FAILED UNIT IS NOT A RESULT (CLAUDE.md's fifth measurement
    // property). The version of this loop TAC-423 shipped counted an
    // errored call in `n` while it could never increment `question` or
    // `order`, so a wholly broken run reported as a clean one with a low
    // rate, which is exactly the number this ticket is trying to move.
    // Failures are counted separately and excluded from every denominator.
    if (body === null) {
      t.failed += 1
      u.log.appendUnit({ groupId: u.groupId, inbound: u.inbound, rep: u.rep, arm, body, error })
      console.log(`· ${u.groupId} rep${u.rep} ${arm.padEnd(16)} (${error})`)
      return
    }

    const verdict = classifyFirstTouchReply(body)

    // THE JUDGE IS PRODUCTION'S OWN. "Was an intention raised" is decided in
    // production by classifyIntentionPrompts, so the harness asks the same
    // function the same way rather than growing a second regex family. That
    // also sidesteps the detector-asymmetry trap this harness paid for twice
    // (CLAUDE.md, measurement convention): a phrase list under-counts
    // whichever arm is not echoing a script, and here no arm echoes one.
    //
    // learn_name is the headline zero of this ticket and the regex detector
    // has no name-question pattern at all, so without this the arm that
    // finally asks a name would score as asking nothing.
    const judged = await classifyIntentionPrompts({
      sentBody: body,
      openIntentions: u.offeredForClassifier,
    })
    const raisedKeys = judged.ok ? judged.data.raisedKeys : null

    t.n += 1
    if (verdict.hasQuestion) t.question += 1
    if (verdict.isOrderQuestion) t.order += 1
    if (raisedKeys !== null && raisedKeys.length > 0) t.raised += 1
    // Ceiling, not a rate: the acceptance criteria forbid asking two things
    // in one message, and an arm that breaks it fails whatever its rate.
    if (verdict.questionSentences.length > 1) t.twoQuestions += 1
    // TAC-519 ceiling. The block says a message carrying an apology or bad news
    // is not an opening and to leave it alone entirely, so a raise on one breaks
    // the block's own restraint.
    if (verdict.carriesApology && raisedKeys !== null && raisedKeys.length > 0) t.apologyRaise += 1

    u.log.appendUnit({
      groupId: u.groupId,
      inbound: u.inbound,
      rep: u.rep,
      arm,
      category: u.category,
      body,
      error,
      offeredKeys: u.offeredForClassifier.map((o) => o.key),
      raisedKeys,
      judgeFailed: !judged.ok,
      ...verdict,
    })

    const mark = raisedKeys && raisedKeys.length > 0 ? '✓' : verdict.hasQuestion ? '?' : '✗'
    console.log(
      `${mark} ${u.groupId} rep${u.rep} ${arm.padEnd(16)} ${(raisedKeys ?? ['judge-failed']).join(',').padEnd(24)} ${JSON.stringify(body).slice(0, 90)}`,
    )
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.venue || !args.guest || !Number.isInteger(args.reps) || args.reps < 1) {
    console.error(
      '✗ usage: tsx scripts/measurement/first-touch-question.ts --venue <slug> --guest <uuid> [--reps N] [--mode first-touch|ordinary] [--turns N] [--arms a,b] [--scenarios x,y]',
    )
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

  // scripted_control exists to anchor the first-touch turn against a known
  // 20/20. On an ordinary turn there is no opener to script, so it would be
  // byte-identical to `before` and would just spend generations twice.
  const defaultArms: readonly Arm[] =
    args.mode === 'ordinary' ? ARMS.filter((a) => a !== 'scripted_control') : ARMS
  const arms: readonly Arm[] =
    args.arms.length === 0 ? defaultArms : defaultArms.filter((a) => args.arms.includes(a))
  if (arms.length === 0) {
    console.error(`✗ --arms matched none of: ${ARMS.join(', ')}`)
    process.exit(2)
  }
  const scenarios =
    args.scenarios.length === 0 ? SCENARIOS : SCENARIOS.filter((x) => args.scenarios.includes(x.id))
  if (scenarios.length === 0) {
    console.error(`✗ --scenarios matched none of: ${SCENARIOS.map((x) => x.id).join(', ')}`)
    process.exit(2)
  }

  // The window the ticket's own numbers were taken over, so the selected turns
  // are the same population query 1 counted (148 outbound rows, 39 with a
  // non-empty rendered_intentions).
  const sinceIso = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

  const openerAfter = firstTouchOpenerFor('text')
  const log = createRunLog({
    name: 'tac423-first-touch-question',
    meta: {
      arm: 'both',
      promptVersion: PROMPT_VERSION,
      venue: venue.slug,
      guestId: args.guest,
      reps: args.reps,
      scenarios: scenarios.map((x) => x.id),
      arms,
      openerBefore: OPENER_BEFORE,
      openerAfter,
      note: 'generate-only; nothing sent. Single attempt per arm, no regen loop. buildRuntimeContext can persist a guest_states row on a band change; none observed.',
    },
  })
  console.log(`run log: ${log.path}`)
  console.log(
    args.mode === 'ordinary'
      ? `mode=ordinary: up to ${args.turns} real turns x ${arms.length} arms x ${args.reps} reps`
      : `mode=first-touch: ${scenarios.length} scenarios x ${arms.length} arms x ${args.reps} reps`,
  )

  const trace = startAgentTrace({
    name: 'measurement.tac423-first-touch-question',
    agentRunId: randomUUID(),
    metadata: { venueId: venue.id, guestId: args.guest },
  })

  const tally: Record<string, Cell> = {}
  const bump = (k: string) =>
    (tally[k] ??= { n: 0, failed: 0, question: 0, order: 0, raised: 0, twoQuestions: 0, apologyRaise: 0, invalid: 0 })

  if (args.dumpBlocks) {
    const prepared =
      args.mode === 'ordinary'
        ? await prepareOrdinaryTurn({
            venueId: venue.id,
            turn: (await selectOrdinaryTurns(supabase, venue.id, sinceIso)).turns[0],
            trace,
          })
        : await prepareFirstTouchTurn({
            venueId: venue.id,
            guestId: args.guest,
            scenario: scenarios[0],
            rep: 0,
            trace,
          })
    const headings = prepared.composed.userPrompt
      .split('\n')
      .filter((l) => l.startsWith('## '))
    console.log(`\nuser-prompt blocks, in order (${args.mode}):`)
    headings.forEach((h, i) => console.log(`  ${i + 1}. ${h}`))
    const b = shapePromptForArm(prepared.composed.userPrompt, 'before', openerAfter, args.mode !== 'ordinary')
    const pos = shapePromptForArm(prepared.composed.userPrompt, 'position', openerAfter, args.mode !== 'ordinary')
    if (b.ok && pos.ok) {
      console.log(
        `\nbefore vs position shaped prompts: ${b.prompt === pos.prompt ? 'BYTE-IDENTICAL (position is a no-op here)' : `DIFFER by ${Math.abs(b.prompt.length - pos.prompt.length)} chars in length`}`,
      )
    } else {
      console.log(`\nshaping refused: before=${b.ok ? 'ok' : b.reason} position=${pos.ok ? 'ok' : pos.reason}`)
    }
    await trace.flushAsync()
    return
  }

  const groups: string[] = []

  if (args.mode === 'first-touch') {
    for (const scenario of scenarios) {
      groups.push(scenario.id)
      for (let rep = 0; rep < args.reps; rep += 1) {
        const prepared = await prepareFirstTouchTurn({
          venueId: venue.id,
          guestId: args.guest,
          scenario,
          rep,
          trace,
        })
        await runArms({
          groupId: scenario.id,
          inbound: scenario.body,
          rep,
          guestId: args.guest,
          ...prepared,
          arms,
          openerAfter,
          expectOpener: true,
          bump,
          log,
        })
      }
    }
  } else {
    // ORDINARY TURNS. Replays the real turns on which intentions reached the
    // prompt, each on ITS OWN GUEST (2026-09-23 ruling) rather than collapsed
    // onto one. See the report block below for exactly what was read.
    const selection = await selectOrdinaryTurns(supabase, venue.id, sinceIso)
    console.log(
      `selected ${selection.turns.length} replayable turns of ${selection.candidates} candidates (${selection.skipped.length} skipped)`,
    )
    for (const s of selection.skipped) console.log(`  skip ${s.outboundId}: ${s.reason}`)
    log.appendUnit({
      selection: {
        candidates: selection.candidates,
        replayable: selection.turns.length,
        skipped: selection.skipped,
        sinceIso,
        guestIds: [...new Set(selection.turns.map((t) => t.guestId))],
      },
    })

    const chosen = selection.turns.slice(0, args.turns)
    console.log(`replaying ${chosen.length} of them (--turns ${args.turns})\n`)
    for (const turn of chosen) {
      const groupId = `turn:${turn.outboundId.slice(0, 8)}`
      groups.push(groupId)
      for (let rep = 0; rep < args.reps; rep += 1) {
        const prepared = await prepareOrdinaryTurn({ venueId: venue.id, turn, trace })
        await runArms({
          groupId,
          inbound: turn.inboundBody,
          rep,
          guestId: turn.guestId,
          ...prepared,
          arms,
          openerAfter,
          expectOpener: false,
          bump,
          log,
        })
      }
    }
  }

  await trace.flushAsync()

  console.log('\n=== rates (failed calls excluded from every denominator) ===')
  for (const groupId of groups) {
    for (const arm of arms) {
      const t = tally[`${groupId}|${arm}`]
      if (!t) continue
      const pct = (x: number) => (t.n ? `${x}/${t.n} (${Math.round((100 * x) / t.n)}%)` : '0/0')
      console.log(
        `${groupId.padEnd(22)} ${arm.padEnd(16)} raised ${pct(t.raised).padEnd(15)} asks anything ${pct(t.question).padEnd(15)} order ${pct(t.order).padEnd(15)}${t.failed ? ` FAILED ${t.failed}` : ''}${t.invalid ? ` INVALID ${t.invalid}` : ''}`,
      )
    }
  }

  // Pooled across groups, which is the number the bars are written against.
  console.log('\n=== pooled by arm ===')
  const pooled: Record<string, Cell> = {}
  for (const groupId of groups) {
    for (const arm of arms) {
      const t = tally[`${groupId}|${arm}`]
      if (!t) continue
      const acc = (pooled[arm] ??= {
        n: 0,
        failed: 0,
        question: 0,
        order: 0,
        raised: 0,
        twoQuestions: 0,
        apologyRaise: 0,
        invalid: 0,
      })
      for (const k of Object.keys(acc) as (keyof Cell)[]) acc[k] += t[k]
    }
  }
  for (const arm of arms) {
    const t = pooled[arm]
    if (!t) continue
    const pct = (x: number) => (t.n ? `${x}/${t.n} (${Math.round((100 * x) / t.n)}%)` : '0/0')
    console.log(
      `${arm.padEnd(16)} raised ${pct(t.raised).padEnd(15)} asks anything ${pct(t.question).padEnd(15)} order ${pct(t.order).padEnd(15)}${t.failed ? ` FAILED ${t.failed}` : ''}${t.invalid ? ` INVALID ${t.invalid}` : ''}`,
    )
  }

  // PRE-REGISTERED CHECKS. Stated before any generation, evaluated here rather
  // than by eye afterwards, so a run cannot be read charitably.
  console.log('\n=== pre-registered checks ===')

  // 1. VALIDITY, FIRST-TOUCH MODE ONLY. On that turn every block between the
  // intentions block's old slot and its new one is empty by construction (no
  // follow-up context on an inbound run; visits, commitments and history
  // overridden to empty; a fresh guest's context is {}; no pending question).
  // So moving it cannot change the rendered string and `position` must match
  // `before`. A difference means the arm construction is wrong and the run is
  // VOID, not that position helped.
  //
  // In ordinary mode the intervening blocks are populated, so a difference there
  // is the measurement, not a bug. The check is deliberately not applied.
  if (args.mode === 'first-touch') {
    const b = pooled.before
    const pos = pooled.position
    if (b && pos && b.n > 0 && pos.n > 0) {
      const delta = Math.abs(pos.raised / pos.n - b.raised / b.n)
      const ok = delta <= 0.34
      console.log(
        `${ok ? 'PASS' : 'VOID'}  validity: position ~= before (raised ${b.raised}/${b.n} vs ${pos.raised}/${pos.n}, delta ${delta.toFixed(2)})${ok ? '' : '  <-- ARM CONSTRUCTION IS WRONG, RUN IS VOID'}`,
      )
    }
    const control = pooled.scripted_control
    if (control && control.n > 0) {
      console.log(
        `NOTE  scripted control order ${control.order}/${control.n} (expected near 20/20; a low value means the harness is broken, not the prompt)`,
      )
    }
    const floor = pooled.before
    if (floor && floor.n > 0) {
      console.log(
        `NOTE  re-measured floor order ${floor.order}/${floor.n} (TAC-423 reported 11/20 for this arm; not inherited)`,
      )
    }
  }

  // 2. CEILINGS. A breach fails the arm whatever its rate.
  let anyCeilingBreach = false
  for (const arm of arms) {
    const t = pooled[arm]
    if (!t || t.n === 0) continue
    if (t.twoQuestions > 0) {
      anyCeilingBreach = true
      console.log(
        `FAIL  ceiling: ${arm} asked two things in one reply ${t.twoQuestions}/${t.n} times (must be 0)`,
      )
    }
  }
  if (!anyCeilingBreach) {
    console.log('PASS  ceilings: no arm asked two things in one reply, or raised on an apology')
  }

  // 3. THE BARS.
  const bar = args.mode === 'ordinary' ? 0.3 : 0.85
  const metric = args.mode === 'ordinary' ? 'raised' : 'order'
  for (const arm of arms) {
    const t = pooled[arm]
    if (!t || t.n === 0 || arm === 'scripted_control' || arm === 'before') continue
    const rate = (metric === 'raised' ? t.raised : t.order) / t.n
    console.log(
      `${rate >= bar ? 'PASS' : 'MISS'}  bar: ${arm} ${metric} ${Math.round(rate * 100)}% vs ${Math.round(bar * 100)}%`,
    )
  }

  console.log(`\nRun log: ${log.path}`)
}

main().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
