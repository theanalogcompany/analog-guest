// TAC-578, rule 3 as re-ruled 2026-10-07: is the reply to "it's good" a
// sign-off?
//
// THE BARS WERE PRE-REGISTERED on TAC-578 (the [PLAN] comment of 2026-10-07)
// before any generation and before this file existed:
//
//   S1  0/20 contain a question
//   S2  0/20 contain a link or mention a review
//   S3  0/20 thank the guest for coming in or visiting
//   S4  20/20 mention what they got or what they said about it (token match,
//       confirmed by hand)
//   S5  0 duplicates; no opening four words shared by more than 2 of the 20
//
// S4 and S5 were DROPPED for this arm on 2026-10-07 after two runs failed them
// (see the verdicts below), and a hand-read bar was added: 0/20 invented facts.
//
// AND A CONTROL WITH NO BAR: the same twenty guests with the sign-off block
// removed and nothing else changed. If the control already passes S1 to S3,
// the block is not what produces the result, and a pass on the treatment
// would be a pass the block had not earned.
//
// Twenty guests in two groups of ten. `straight`: asked how it is, answers
// that it is good. `after_not_yet`: said they had not tried it, then says it
// is good. The first group is in a first conversation and the second is not,
// because the "ask nothing" restraint a first conversation already renders is
// the likeliest reason for the control to pass, and one group without it shows
// what the block does alone.
//
// THE BASE VARIANT ONLY. No question is open and no review link is handed
// over, so neither of the two allowed additions (the name ask on a first
// visit, the invitation on a later one) is exercised here. Those are wording
// that was not yet approved when this was written.
//
// GENERATE-ONLY, one call at a time through generateMessage, so each call
// reads the cached system prefix the one before wrote; the hit rate is
// printed. Every model call counts against the ticket's cap of 450, carried
// across runs by hand in MEASURE_SPENT.
//
// A FAILED UNIT IS NOT A RESULT (scripts/CLAUDE.md, convention 5).

import { randomUUID } from 'node:crypto'

import type {
  VoiceCorpusChunk as AiVoiceCorpusChunk,
  RecentMessage,
} from '@/lib/ai/types'
import { generateMessage } from '@/lib/ai'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { extractUrls } from '@/lib/ai/url-detector'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import { buildAiRuntime, retrieveCorpusStage } from '@/lib/agent/stages'
import type { RuntimeContext } from '@/lib/agent/types'
import { comparableWords, thanksForVisiting } from '@/lib/agent/visit-messages'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { toParsedGuestContext } from '@/lib/schemas/guest-context'
import { createRunLog } from './run-log'

const MAX_MODEL_CALLS = 450
const PER_GROUP = 10

/**
 * Ten ways of saying it is good, each with a word to find it by.
 *
 * EVERY LINE FITS ANY ITEM, a drink or a pastry, and that is a correction. The
 * first run paired lines about foam, strength and temperature with whatever
 * the menu index landed on, so a guest praised "the foam" on a khari and found
 * a brownie "strong", and one reply duly said "that foam hits different on the
 * khari". That invention was the fixture's. The "not yet" line was "too hot"
 * for four pastries, for the same reason.
 */
const GOOD: readonly { said: string; token: string }[] = [
  { said: 'so good', token: 'good' },
  { said: 'honestly perfect', token: 'perfect' },
  { said: 'love it, exactly what i was hoping for', token: 'hoping' },
  { said: "it's great, exactly what i needed this morning", token: 'morning' },
  { said: 'amazing, not too sweet', token: 'sweet' },
  { said: 'really nice actually, better than i expected', token: 'expect' },
  { said: 'delicious 😍', token: 'delicious' },
  { said: "best one i've had in a while", token: 'best' },
  { said: 'yeah it is great, glad i went with it', token: 'went with' },
  { said: 'so so good, worth the walk over', token: 'walk' },
]

type Arm = 'treatment' | 'control'
type Group = 'straight' | 'after_not_yet'

interface Unit {
  id: string
  group: Group
  order: string
  inbound: string
  history: RecentMessage[]
  tokens: string[]
}

const turn = (
  direction: 'inbound' | 'outbound',
  body: string,
  createdAt: Date,
): RecentMessage =>
  ({ direction, body, createdAt, delivery: 'delivered' }) as RecentMessage

const folded = (text: string): string => comparableWords(text).join(' ')

async function main(): Promise<void> {
  const venueSlug = process.env.MEASURE_VENUE ?? 'le-mils-coffee'
  const alreadySpent = Number(process.env.MEASURE_SPENT ?? '0')
  if (!Number.isInteger(alreadySpent) || alreadySpent < 0) {
    throw new Error('MEASURE_SPENT must be a whole number of model calls')
  }
  const db = createAdminClient()
  const { data: venue, error: venueError } = await db
    .from('venues')
    .select('id, slug, name, status')
    .eq('slug', venueSlug)
    .single()
  if (venueError || !venue) throw new Error(`venue ${venueSlug} not found`)
  const { data: candidates } = await db
    .from('guests')
    .select('id')
    .eq('venue_id', venue.id)
    .is('opted_out_at', null)
    .not('instagram_scoped_id', 'is', null)
    .limit(1)
  const guestId = candidates?.[0]?.id
  if (!guestId) {
    throw new Error(`need one non-opted-out Instagram guest at ${venueSlug}`)
  }
  const { count: statesBefore } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  const startedAt = new Date()
  const trace = startAgentTrace({
    name: 'tac578-sign-off-reply',
    agentRunId: randomUUID(),
  })
  const at = (minutesAgo: number): Date =>
    new Date(startedAt.getTime() - minutesAgo * 60_000)

  // Built ONCE, as an inbound turn's context is.
  const baseCtx = await buildRuntimeContext({
    agentRunId: randomUUID(),
    guestId,
    venueId: venue.id,
    trace,
    currentMessage: {
      id: randomUUID(),
      providerMessageId: `tac578-probe-${randomUUID()}`,
      body: 'so good',
      receivedAt: startedAt,
      channel: 'instagram',
      referralSource: null,
    },
  })
  const menu = baseCtx.venue.venueInfo.menu.items
    .map((i) => i.name.trim().toLowerCase())
    .filter((n) => n.length > 0)
  if (menu.length < PER_GROUP) {
    throw new Error(
      `venue has ${menu.length} named menu items; need ${PER_GROUP}`,
    )
  }
  const pick = (i: number): string =>
    menu[Math.floor((i * menu.length) / PER_GROUP) % menu.length]

  const units: Unit[] = []
  for (let i = 0; i < PER_GROUP; i += 1) {
    const order = pick(i)
    const good = GOOD[i]
    const opening = [
      turn('outbound', 'hey, welcome in. what did you get?', at(9)),
      turn('inbound', `the ${order}`, at(8)),
      turn('outbound', `nice, the ${order}. how is it so far?`, at(7)),
    ]
    const tokens = [
      order,
      ...order.split(/\s+/).filter((w) => w.length >= 5),
      good.token,
    ]
    units.push({
      id: `straight-${String(i + 1).padStart(2, '0')}`,
      group: 'straight',
      order,
      inbound: good.said,
      history: opening,
      tokens,
    })
    units.push({
      id: `after-not-yet-${String(i + 1).padStart(2, '0')}`,
      group: 'after_not_yet',
      order,
      inbound: `ok tried it. ${good.said}`,
      history: [
        ...opening,
        turn('inbound', "haven't tried it yet, just sat down", at(6)),
        turn('outbound', 'no rush at all', at(5)),
      ],
      tokens,
    })
  }

  // MEASURE_ARMS=treatment runs the treatment alone (a re-run of the arm; the
  // control was run once and its result does not depend on the block).
  const arms: readonly Arm[] =
    process.env.MEASURE_ARMS === 'treatment'
      ? ['treatment']
      : ['treatment', 'control']
  const planned = units.length * arms.length
  const log = createRunLog({
    name: 'tac578-sign-off-reply',
    meta: {
      arm: 'treatment-and-control',
      promptVersion: PROMPT_VERSION,
      venue: venueSlug,
      venueName: venue.name,
      venueStatus: venue.status,
      guestId,
      units: planned,
      maxModelCalls: MAX_MODEL_CALLS,
      alreadySpent,
      control:
        'the same guests with ctx.signOff left null, so the `## Sign off` block does not render; nothing else differs',
      constructed:
        "each unit's history; the base guest's commitments, context and mechanics are cleared",
    },
  })
  console.log(
    `[tac578] prompt=${PROMPT_VERSION} venue=${venueSlug} generations=${planned} spent-before=${alreadySpent} cap=${MAX_MODEL_CALLS}`,
  )
  let modelCalls = alreadySpent
  const spend = (n: number, what: string): void => {
    if (modelCalls + n > MAX_MODEL_CALLS) {
      log.appendUnit({
        summary: true,
        void: true,
        reason: 'budget',
        modelCalls,
      })
      throw new Error(
        `budget: ${what} would take the ticket past ${MAX_MODEL_CALLS} model calls (at ${modelCalls})`,
      )
    }
    modelCalls += n
  }

  const corpus = await retrieveCorpusStage(baseCtx)
  const ragChunks: AiVoiceCorpusChunk[] = corpus.map((ch) => ({
    id: ch.id,
    text: ch.text,
    sourceType: ch.sourceType as AiVoiceCorpusChunk['sourceType'],
    relevanceScore: ch.similarity,
  }))

  const outputs: { id: string; arm: Arm; group: Group; body: string }[] = []
  const failed: { id: string; error: string }[] = []
  const cache = { calls: 0, hits: 0, read: 0, input: 0 }

  for (const arm of arms) {
    for (const unit of units) {
      const firstConversation = unit.group === 'straight'
      const ctx: RuntimeContext = {
        ...baseCtx,
        guest: {
          ...baseCtx.guest,
          firstName: null,
          context: toParsedGuestContext({}, startedAt),
          reviewAskedAt: null,
        },
        recentMessages: unit.history,
        recentVisits: [{ items: [unit.order], visitedAt: at(8) }],
        // NOTHING OF THE REAL GUEST'S (TAC-575's contaminated run).
        activeCommitments: [],
        retractableReportedVisits: [],
        mechanics: [],
        conversationChannel: 'instagram',
        firstConversation,
        // The base variant: no question open, no link handed over.
        openIntentions: [],
        pendingQuestion: null,
        reviewAsk: null,
        visitCheckinHold: false,
        insideVisitCheckin: true,
        corpus,
        knowledgeCorpus: [],
        // THE ONE DIFFERENCE BETWEEN THE ARMS.
        signOff: arm === 'treatment' ? 'answer' : null,
        currentMessage: {
          ...baseCtx.currentMessage!,
          id: randomUUID(),
          body: unit.inbound,
          receivedAt: at(1),
        },
        classification: {
          category: 'reply',
          classifierConfidence: 1,
          reasoning: 'tac578 measurement: category held fixed across arms',
          crisisSafety: false,
          correctsPendingReply: false,
          followUpWorthy: false,
          praisedExperience: true,
        },
      }
      spend(1, `generating ${arm} ${unit.id}`)
      const gen = await generateMessage({
        category: 'reply',
        persona: ctx.venue.brandPersona,
        venueInfo: ctx.venue.venueInfo,
        ragChunks,
        knowledgeChunks: [],
        runtime: buildAiRuntime(ctx),
        channel: 'instagram',
      })
      if (!gen.ok) {
        failed.push({ id: `${arm}:${unit.id}`, error: gen.error })
        log.appendUnit({ id: unit.id, arm, failed: true, error: gen.error })
        console.log(`  ${arm} ${unit.id}  FAILED: ${gen.error}`)
        continue
      }
      if (gen.data.attempts > 1) {
        spend(gen.data.attempts - 1, `regenerating ${unit.id}`)
      }
      cache.calls += 1
      if (gen.data.cacheReadTokens > 0) cache.hits += 1
      cache.read += gen.data.cacheReadTokens
      cache.input += gen.data.usage?.inputTokens ?? 0
      outputs.push({ id: unit.id, arm, group: unit.group, body: gen.data.body })
      log.appendUnit({
        id: unit.id,
        arm,
        group: unit.group,
        inbound: unit.inbound,
        body: gen.data.body,
        attempts: gen.data.attempts,
        cacheReadTokens: gen.data.cacheReadTokens,
      })
      console.log(
        `  ${arm.padEnd(9)} ${unit.id}  <- ${JSON.stringify(unit.inbound)}\n      ${JSON.stringify(gen.data.body)}`,
      )
    }
  }

  const { count: statesAfter } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })
  await trace.flushAsync()

  console.log(
    `\n[tac578] prompt cache: ${cache.hits}/${cache.calls} calls read it; ${cache.read} of ${cache.input} input tokens cached (${cache.input === 0 ? '0.0' : ((cache.read / cache.input) * 100).toFixed(1)}%)`,
  )
  console.log(
    `[tac578] model calls, ticket total: ${modelCalls}/${MAX_MODEL_CALLS}`,
  )
  console.log(
    `[tac578] guest_states rows before/after: ${statesBefore}/${statesAfter}`,
  )

  if (failed.length > 0 || outputs.length !== planned) {
    console.log(
      `\n[tac578] RUN VOID: ${failed.length} unit(s) failed (${failed.map((f) => f.id).join(', ')}). A failed unit is not a result; no verdict.`,
    )
    log.appendUnit({ summary: true, void: true, failed, modelCalls })
    process.exit(2)
  }

  const unitOf = new Map(units.map((u) => [u.id, u]))
  const score = (list: typeof outputs) => {
    const question = list.filter((o) => o.body.includes('?'))
    const link = list.filter(
      (o) => extractUrls(o.body).length > 0 || /\breviews?\b/i.test(o.body),
    )
    const thanks = list.filter((o) => thanksForVisiting(o.body))
    const names = list.filter((o) =>
      (unitOf.get(o.id)?.tokens ?? []).some((t) =>
        folded(o.body).includes(folded(t)),
      ),
    )
    const seen = new Map<string, string[]>()
    const openings = new Map<string, string[]>()
    for (const o of list) {
      seen.set(folded(o.body), [...(seen.get(folded(o.body)) ?? []), o.id])
      const opening = comparableWords(o.body).slice(0, 4).join(' ')
      openings.set(opening, [...(openings.get(opening) ?? []), o.id])
    }
    return {
      n: list.length,
      withQuestion: question.map((o) => o.id),
      withLinkOrReview: link.map((o) => o.id),
      thanksForVisiting: thanks.map((o) => o.id),
      namesTheVisit: names.length,
      duplicateGroups: [...seen.values()].filter((ids) => ids.length > 1),
      overusedOpenings: [...openings]
        .filter(([, ids]) => ids.length > 2)
        .map(([opening, ids]) => ({ opening, count: ids.length })),
    }
  }
  const treatment = score(outputs.filter((o) => o.arm === 'treatment'))
  const control = score(outputs.filter((o) => o.arm === 'control'))
  const controlByGroup = {
    straight: score(
      outputs.filter((o) => o.arm === 'control' && o.group === 'straight'),
    ),
    after_not_yet: score(
      outputs.filter((o) => o.arm === 'control' && o.group === 'after_not_yet'),
    ),
  }
  // S4 AND S5 WERE DROPPED FOR THIS ARM on 2026-10-07, after two runs failed
  // them: with added facts barred, the replies are short and alike, and that
  // was ruled acceptable for a one-line sign-off ("accept the safe, short
  // replies"). They are still printed above, as information. A sixth bar,
  // 0/20 invented facts, is a hand-read and has no line here.
  const verdicts = {
    S1: treatment.withQuestion.length === 0,
    S2: treatment.withLinkOrReview.length === 0,
    S3: treatment.thanksForVisiting.length === 0,
  }
  const line = (label: string, s: ReturnType<typeof score>): string =>
    `${label}: question ${s.withQuestion.length}/${s.n}, link or review ${s.withLinkOrReview.length}/${s.n}, thanks for visiting ${s.thanksForVisiting.length}/${s.n}, names the visit ${s.namesTheVisit}/${s.n}, duplicates ${s.duplicateGroups.length}, overused openings ${s.overusedOpenings.length}${s.overusedOpenings.map((x) => ` ["${x.opening}" x${x.count}]`).join('')}`
  console.log('\n[tac578] against the pre-registered bars:')
  console.log(`  ${line('TREATMENT', treatment)}`)
  for (const [bar, pass] of Object.entries(verdicts)) {
    console.log(`  ${bar} ${pass ? 'PASS' : 'FAIL'}`)
  }
  console.log(`  ${line('CONTROL (no bar)', control)}`)
  console.log(
    `  ${line('  control, first conversation', controlByGroup.straight)}`,
  )
  console.log(
    `  ${line('  control, returning guest', controlByGroup.after_not_yet)}`,
  )
  const controlAlreadyPasses =
    control.withQuestion.length === 0 &&
    control.withLinkOrReview.length === 0 &&
    control.thanksForVisiting.length === 0
  if (controlAlreadyPasses) {
    console.log(
      '  NOTE: the control passes S1 to S3 with the block removed, so a pass on those three is not evidence the block does anything.',
    )
  }
  const pass = Object.values(verdicts).every(Boolean)
  log.appendUnit({
    summary: true,
    void: false,
    verdicts,
    treatment,
    control,
    controlByGroup,
    controlAlreadyPasses,
    modelCalls,
    statesBefore,
    statesAfter,
  })
  console.log(
    `\n[tac578] MECHANICAL BARS (S1 to S3): ${pass ? 'PASS' : 'FAIL'}. Invented facts are a hand-read. Log: ${log.path}`,
  )
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
