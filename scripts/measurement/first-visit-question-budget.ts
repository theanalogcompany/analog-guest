// TAC-567: on a guest's FIRST conversation, how many questions do they get asked,
// and which ones?
//
// GENERATE-ONLY. Nothing is sent and nothing is written, with one exception this
// run reports on itself: buildRuntimeContext calls computeGuestState, which
// persists a guest_states row on a recognition-band change. Context is therefore
// built ONCE and cloned per conversation, so that write has one opportunity rather
// than seventy-five, and the row count is printed before and after (the TAC-544
// precedent, followed by TAC-558).
//
// MULTI-TURN, FIVE GUEST TURNS: the scan, the order named, then three turns where
// the guest ANSWERS WHATEVER WAS ASKED. That is the ticket's own scenario. The
// guest never asks anything of their own, deliberately: a guest question changes
// what the reply is about and the metric here is what the VENUE asks unprompted.
// Five turns rather than the ruled two so there is room for a further question to
// appear if it is going to.
//
// THE THREE BARS, all absolute zeros, in first-visit-question-budget-score.ts:
//   1. questions asked: only the ones the TAC-575 ruling allows on a first
//      conversation (ALLOWED_KEYS in the scorer). NOT RE-RUN since that ruling
//      widened the set, so the figures recorded on TAC-567 are a different bar.
//   2. turns carrying two questions (body question plus bubble): 0
//   3. "you've reached" or equivalent in the opener: 0
//
// WHAT CAN CONTRADICT A ZERO, because a number nobody can contradict is not
// evidence, and every bar here counts a BAD thing so a broken run reads clean:
//
//   - THE DETECTORS are where the real risk sits: a detector that cannot fire
//     turns all three bars into decoration.
//   - MEASURE_ARM=control runs the real derivation with isFirstConversation FALSE,
//     which restores the pre-ticket eligibility AND drops the first-conversation
//     restraint, on the same guest, venue and turn bodies. It produces off-target
//     questions (14 of 15 against 0 of 15) and is the contrast for bars 1 and 2.
//
//     BUT IT VARIES TWO THINGS AT ONCE, AND THE RESTRAINT IS DOING MOST OF THE
//     WORK. Read what this five-turn fixture can actually express before reading
//     the delta as a test of the eligibility suppression:
//       their_rhythm needs 8 replies and why_theyre_here 11, and
//         repliedMessageCount maxes at GUEST_TURNS (5), so neither is ever gated
//         open, in either arm;
//       got_the_recommendation is handed no open recommendations, so it never arms;
//       did_they_like_it arms off the NEWEST order, which newestEventArming HELDs
//         while it is inside conversationWindowMs, and the only order here is 60s
//         old, so it never arms either;
//       are_they_local is the ONE suppressed intention that can differ, and only
//         on turn 5, and only once all three allowed intentions have closed.
//     So the control's off-target questions are mostly the model INVENTING them
//     with no restraint to stop it, not suppressed intentions rendering. The
//     eligibility half is not covered here and this run must not be read as if
//     it were.
//   - BAR 3 HAS NO IN-PROCESS CONTROL and this file says so rather than implying
//     one: the opener is a compiled string constant, so an arm cannot restore it
//     without editing the source, so this run gives it no contrast.
//
// THE CONTROL IS NOT origin/main, precisely: both arms carry the new opener text
// and the new two-question gate, because neither can be varied per turn. The
// control varies exactly what a boolean can reach. Stated here, in the run log's
// meta, and in the summary, so no reader has to infer it.
//
// THE JUDGE IS PRODUCTION'S OWN classifyIntentionPrompts, asked with the FULL
// BALLOT of every intention key rather than the open ones. Production's gate asks
// a forced-choice question built from the open keys alone, so with one intention
// rendered an off-target question lands in the one available bucket and reads as
// on-target - TAC-558 measured 12 raised of which 6 were about something else. No
// phrase list, so nothing here goes stale against a paraphrase (convention 7).
//
// Run with NEXT_PUBLIC_POSTHOG_KEY and SLACK_ALERTS_WEBHOOK_URL unset so the
// stages' telemetry goes inert. MEASURE_CONVERSATIONS=2 is the smoke size.

import { randomUUID } from 'node:crypto'
import { classifyIntentionPrompts, generateMessage } from '@/lib/ai'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import type {
  KnowledgeCorpusChunk as AiKnowledgeChunk,
  VoiceCorpusChunk as AiVoiceCorpusChunk,
  MessageCategory,
} from '@/lib/ai'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import {
  buildSatisfactionFacts,
  deriveOpenIntentions,
  renderableIntentions,
} from '@/lib/agent/intentions/derive'
import {
  INTENTION_DEFINITION_BY_KEY,
  INTENTION_KEYS,
} from '@/lib/agent/intentions/definitions'
import type { PromptedIntentionRow } from '@/lib/agent/intentions/load'
import { INTENTION_RULES_DEFAULT } from '@/lib/schemas/intention-rules'
import { resolveDispatchBubbles } from '@/lib/agent/sentence-split'
import {
  buildAiRuntime,
  computeFirstTouchAfterQrScan,
  retrieveCorpusStage,
  retrieveKnowledgeWithContextStage,
} from '@/lib/agent/stages'
import type { RuntimeContext } from '@/lib/agent/types'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import {
  answerPartOf,
  scoreConversation,
  splitQuestions,
  summarize,
  type ConversationVerdict,
  type TurnInput,
} from './first-visit-question-budget-score'
import { createRunLog } from './run-log'
import { seededFlip } from './seeded-flip'

type Arm = 'control' | 'after'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const CONVERSATION_WINDOW_MS = 48 * 60 * 60 * 1000
const GUEST_TURNS = 5

/**
 * Names the guest offers, rotated so no run measures one name five times.
 *
 * NONE OF THESE MAY APPEAR IN THE VENUE'S OWN CONTENT, and the guard below
 * enforces it against the live config rather than trusting this comment. The
 * first 15-conversation run used "milana", which is a Le Mil's co-founder: the
 * reply came back "Milana, of all names 🙂 co-founder Milana is part of why this
 * place exists. small world, or is it?" and that invented question was the run's
 * only breach. A variable held fixed is an instrument too (convention 10), and
 * this one was feeding the model a coincidence to remark on.
 */
const NAMES: readonly string[] = ['jaipal', 'priya', 'sam', 'andre', 'nadia']

/**
 * How the guest answers the first-visit question. Both directions, rotated: a run
 * that only ever said "first time" would leave the returner case unmeasured, and
 * that is the answer that informs every later turn.
 */
const HISTORY_ANSWERS: readonly string[] = [
  'yeah first time in today',
  'been coming for about a year now',
  'first time, someone at work told me about you',
  'oh ive been coming since you opened',
]

/** An answer to a question that was neither the name nor the first-visit one. */
const GENERIC_ANSWER = 'yeah, it was really good'

/** What the guest says when nothing was asked. Keeps the turn comparable. */
const NEUTRAL_CONTINUATION = 'cool, thanks'

// TAC-568: which intentions can actually differ between the arms in this
// fixture, named once and printed from here rather than spelled into the NOTE.
//
// The NOTE used to say "only are_they_local", which was true until
// are_they_new_here became first-conversation-suppressed: the fixture gives it a
// recorded order and clears its replies_only gate by turn 3, so it is open in
// the control arm and suppressed in `after`. That line is printed run output
// that gets pasted onto a ticket, which is the one place a stale count does the
// most damage.
const ARMS_CAN_DIFFER_ON = ['are_they_local', 'are_they_new_here'] as const

async function main(): Promise<void> {
  const arm = process.env.MEASURE_ARM as Arm | undefined
  if (arm !== 'control' && arm !== 'after') {
    console.error(
      '✗ set MEASURE_ARM=control or MEASURE_ARM=after. A run log with no arm is unreadable afterwards.',
    )
    process.exit(2)
  }
  const venueSlug = process.env.MEASURE_VENUE ?? 'le-mils-coffee'
  const conversations = Number(process.env.MEASURE_CONVERSATIONS ?? '15')
  if (!Number.isInteger(conversations) || conversations < 1) {
    console.error('✗ MEASURE_CONVERSATIONS must be a positive integer')
    process.exit(2)
  }

  const db = createAdminClient()
  const { data: venue, error: venueError } = await db
    .from('venues')
    .select('id, slug, name, timezone, status')
    .eq('slug', venueSlug)
    .single()
  if (venueError || !venue) throw new Error(`venue ${venueSlug} not found`)

  const { count: statesBefore } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  // DERIVE the guest rather than pasting an id, and require NO first name: with a
  // name on record learn_name is closed by its own proxy and one of the three
  // questions under test could never be asked.
  const { data: candidates } = await db
    .from('guests')
    .select('id, first_name, phone_number, opted_out_at')
    .eq('venue_id', venue.id)
    .is('first_name', null)
    .is('opted_out_at', null)
    .not('phone_number', 'is', null)

  let guest: { id: string; messages: number } | null = null
  for (const g of candidates ?? []) {
    const { count } = await db
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('guest_id', g.id)
    const n = count ?? 0
    if ((guest?.messages ?? -1) < n) guest = { id: g.id, messages: n }
  }
  if (!guest) {
    throw new Error(
      `need one nameless, non-opted-out guest with a phone number at ${venueSlug}`,
    )
  }

  const startedAt = new Date()
  const log = createRunLog({
    name: `tac567-first-visit-question-budget-${arm}`,
    meta: {
      arm,
      promptVersion: PROMPT_VERSION,
      venue: venueSlug,
      venueName: venue.name,
      venueStatus: venue.status,
      guest,
      conversations,
      guestTurns: GUEST_TURNS,
      allowedIntentions: [
        'understand_order',
        'learn_name',
        'are_they_new_here',
      ],
      bars: {
        offTargetQuestions: 0,
        twoQuestionTurns: 0,
        openerIdentityClaims: 0,
      },
      heldFixed: [
        'guest',
        'venue',
        'scanBody',
        'orderBody',
        'derivation(real)',
        'coin(seeded from conversationId+turn)',
        'judge(full ballot, production classifier)',
      ],
      controlIs:
        'branch code with isFirstConversation=false in the derivation, so pre-ticket eligibility and no first-conversation restraint. NOT origin/main: both arms carry the new opener text and the new two-question gate, neither of which a boolean can vary.',
      bar3HasNoInProcessControl:
        'the opener is a compiled constant, so this run has no in-process contrast for it',
    },
  })

  console.log(`[tac567] arm=${arm} prompt=${PROMPT_VERSION}`)
  console.log(
    `[tac567] venue ${venueSlug} "${venue.name}" (status=${venue.status})`,
  )
  console.log(
    `[tac567] guest ${guest.id.slice(0, 8)} (${guest.messages} msgs, no first name)`,
  )
  console.log(`[tac567] guest_states rows before: ${statesBefore}`)
  console.log(`[tac567] conversations: ${conversations} x ${GUEST_TURNS} turns`)
  console.log(`[tac567] run log: ${log.path}\n`)

  const trace = startAgentTrace({
    name: 'tac567-measure',
    agentRunId: randomUUID(),
  })

  const scanBody = "Hi Le Mil's!"
  const baseCtx = await buildRuntimeContext({
    agentRunId: randomUUID(),
    guestId: guest.id,
    venueId: venue.id,
    trace,
    currentMessage: {
      id: randomUUID(),
      providerMessageId: `tac567-probe-${randomUUID()}`,
      body: scanBody,
      receivedAt: startedAt,
      channel: 'text',
      referralSource: null,
    },
  })

  // Real menu items, deterministically chosen. A generic item would let the model
  // correctly answer "we don't have that", which scores like a dodge while
  // measuring item existence instead (the TAC-513 lesson).
  const menuNames = baseCtx.venue.venueInfo.menu.items
    .map((i) => i.name)
    .filter((n) => n.trim().length > 0)
  if (menuNames.length === 0) throw new Error('venue has no menu items to name')

  // THE FIXTURE-NAME GUARD, before a single call is spent. A guest name that also
  // appears in the venue's own persona or spec hands the model a coincidence to
  // remark on, and remarking on it is how the first run produced its only
  // breach. Checked against the live config so it cannot go stale, and against
  // this venue rather than a hardcoded list, because the next venue's people have
  // different names.
  const venueContent = JSON.stringify({
    persona: baseCtx.venue.brandPersona,
    info: baseCtx.venue.venueInfo,
  }).toLowerCase()
  const colliding = NAMES.filter((n) => venueContent.includes(n.toLowerCase()))
  if (colliding.length > 0) {
    console.error(
      `✗ guest name(s) ${colliding.join(', ')} appear in ${venueSlug}'s own persona or spec. Pick names this venue never mentions: the model will remark on the coincidence and the remark scores as an invented question.`,
    )
    process.exit(2)
  }

  // TurnRow IS the scorer's TurnInput plus everything worth keeping in the log.
  // Intersecting rather than duplicating means a scorer field added later cannot
  // be quietly left unset here.
  type TurnRow = TurnInput & {
    inbound: string
    repliedMessageCount: number
    orderOnRecord: boolean
    derivedOpenKeys: string[]
    renderedKeys: string[]
    raisedKeys: string[]
    intentionQuestion: string
    droppedForBodyQuestion: boolean
    bubbles: string[]
    capturedName: string | undefined
    capturedHistory: string | undefined
    /** computeFirstTouchAfterQrScan over this turn's facts. Turn 1 must be true. */
    openerRendered: boolean
    calls: number
    error: string | null
  }

  type ConversationRow = {
    conversationId: string
    arm: Arm
    orderItem: string
    turns: TurnRow[]
    verdict: ConversationVerdict
    invalidReason: string | null
  }

  const rows: ConversationRow[] = []

  for (let c = 0; c < conversations; c += 1) {
    const conversationId = `c${String(c + 1).padStart(2, '0')}`
    const orderItem = menuNames[c % menuNames.length]!
    const guestName = NAMES[c % NAMES.length]!
    const historyAnswer = HISTORY_ANSWERS[c % HISTORY_ANSWERS.length]!

    const row: ConversationRow = {
      conversationId,
      arm,
      orderItem,
      turns: [],
      verdict: scoreConversation([], venue.name ?? ''),
      invalidReason: null,
    }

    // HISTORY STARTS EMPTY. The derived guest has real messages on file, and
    // loading them makes turn 1 not a first touch at all - TAC-558's smoke run duly
    // produced "Hey, welcome back!" on it. The guest's recognition signals stay
    // real; the conversation is the constructed one.
    const history: typeof baseCtx.recentMessages = []
    const prompted: PromptedIntentionRow[] = []
    let capturedName: string | undefined
    let capturedHistory: string | undefined

    // Turn 1 and 2 are fixed. Each later turn's body is decided from what the
    // previous reply actually asked, which is the ticket's "answering whatever is
    // asked".
    let nextInbound: { body: string; category: MessageCategory } = {
      body: scanBody,
      category: 'welcome',
    }

    for (let t = 0; t < GUEST_TURNS; t += 1) {
      const step = nextInbound
      const stage = t === 0 ? 'opener' : t === 1 ? 'order' : `followup-${t - 1}`
      const receivedAt = new Date(startedAt.getTime() + t * 60_000)
      // The order is on record from turn 3 on: TAC-323's extractor runs post-send
      // under waitUntil, so the transaction the guest's turn-2 message produces
      // exists from the following turn.
      const orderOnRecord = t >= 2
      const orderAt = new Date(startedAt.getTime() + 60_000)
      // ## Visit history must agree with the facts this turn was derived from, or
      // the prompt shows earlier visits while the derivation is told there are
      // none - a contradiction on exactly the axis this run measures.
      const recentVisits = orderOnRecord
        ? [
            {
              items: [orderItem],
              amountCents: null,
              visitedAt: orderAt,
              precision: 'pinned' as const,
            },
          ]
        : []
      const repliedMessageCount = t + 1

      const derived = deriveOpenIntentions({
        now: receivedAt,
        responseRate: baseCtx.recognition.signals.responseRate,
        repliedMessageCount,
        rules: INTENTION_RULES_DEFAULT,
        facts: buildSatisfactionFacts({
          hasQualifyingTransaction: orderOnRecord,
          firstName: capturedName ?? null,
          homeBase: undefined,
          recordedVisitCount: orderOnRecord ? 1 : 0,
          venueHistory: capturedHistory,
        }),
        // The scan confirms the visit, which is what arms understand_order.
        visitConfirmedAt: startedAt,
        openRecommendationTimes: [],
        openRecommendationTouchedTimes: [],
        openRecommendationsUnreadable: false,
        recordedOrderTimes: orderOnRecord ? [orderAt] : [],
        rows: { prompted, eligible: [] },
        inboundTimes: [receivedAt],
        conversationWindowMs: CONVERSATION_WINDOW_MS,
        inboundHistoryFrom: new Date(startedAt.getTime() - 14 * MS_PER_DAY),
        // THE ONE THING THE ARMS VARY. `after` is production for this population:
        // a fresh scan, five turns inside one sitting. `control` restores
        // pre-ticket eligibility and drops the restraint paragraph.
        isFirstConversation: arm === 'after',
        // Both arms model the first-visit flow before any close, so this does
        // not vary by arm. Holding it false keeps the arms differing in exactly
        // one variable, which is what the control is for.
        quietAfterWarmClose: false,
      })

      const ctx: RuntimeContext = {
        ...baseCtx,
        // THE GUEST IS MADE A FRESH SCAN, and without this the whole of bar 3 is
        // vacuous. computeFirstTouchAfterQrScan requires created_via = 'qr_scan'
        // AND a createdAt inside the freshness window; the derived guest is a real
        // one with months of history, so the smoke run opened "hey, welcome back!"
        // and FIRST_TOUCH_OPENER never entered the prompt at all. A zero for "the
        // opener says who they have reached" measured against a prompt with no
        // opener in it is the "can the fixture reach the code" failure that
        // scripts/CLAUDE.md warns about.
        //
        // This CONSTRUCTS THE POPULATION rather than overriding the flag:
        // firstTouchAfterQrScan is still derived by production's own predicate from
        // these facts, exactly as buildAiRuntime does on a live scan. The guard
        // below refuses the conversation if it comes out false anyway.
        guest: {
          ...baseCtx.guest,
          createdVia: 'qr_scan',
          createdAt: startedAt,
          firstName: capturedName ?? null,
        },
        recentMessages: [...history],
        recentVisits,
        conversationChannel: 'text',
        openIntentions: derived.open,
        pendingQuestion: null,
        // Carried the same way production does, from the same boolean the
        // derivation read, so the prompt and the derivation cannot disagree.
        firstConversation: arm === 'after',
        // firstTouchAfterQrScan is NOT set here: buildAiRuntime derives it from
        // created_via, the history length and the freshness window. Overriding it
        // would make the opener a harness decision rather than production's.
        currentMessage: {
          ...baseCtx.currentMessage!,
          id: randomUUID(),
          body: step.body,
          receivedAt,
          channel: 'text',
        },
        classification: {
          category: step.category,
          classifierConfidence: 1,
          reasoning: 'tac567 measurement: category held fixed across arms',
          crisisSafety: false,
          correctsPendingReply: false,
          // TAC-386 added this after this harness was written. False here: the
          // follow-up block it gates is a different turn shape from a first-visit
          // counter conversation, and rendering it would put a second authority on
          // what to ask into a run measuring exactly that.
          followUpWorthy: false,
          praisedExperience: false,
        },
      }

      const turnRow: TurnRow = {
        stage,
        inbound: step.body,
        repliedMessageCount,
        orderOnRecord,
        derivedOpenKeys: derived.open.map((o) => o.key),
        renderedKeys: [],
        raisedKeys: [],
        body: '',
        tail: '',
        intentionQuestion: '',
        droppedForBodyQuestion: false,
        bubbles: [],
        attributedTo: [],
        capturedName: undefined,
        capturedHistory: undefined,
        openerRendered: false,
        calls: 0,
        error: null,
        failed: false,
      }

      // Production's own predicate over the constructed facts. On turn 1 this MUST
      // be true or bar 3 has nothing to measure; the conversation is invalidated
      // below rather than reporting a zero against an absent opener.
      turnRow.openerRendered = computeFirstTouchAfterQrScan(ctx, receivedAt)

      try {
        ctx.corpus = await retrieveCorpusStage(ctx)
        ctx.knowledgeCorpus = await retrieveKnowledgeWithContextStage(
          ctx,
          step.category,
          step.body,
        )

        const ragChunks: AiVoiceCorpusChunk[] = (ctx.corpus ?? []).map(
          (ch) => ({
            id: ch.id,
            text: ch.text,
            sourceType: ch.sourceType as AiVoiceCorpusChunk['sourceType'],
            relevanceScore: ch.similarity,
          }),
        )
        const knowledgeChunks: AiKnowledgeChunk[] | undefined =
          ctx.knowledgeCorpus === null
            ? undefined
            : ctx.knowledgeCorpus.map((ch) => ({
                id: ch.id,
                text: ch.text,
                sourceType: ch.sourceType,
                primaryTags: ch.primaryTags,
                secondaryTags: ch.secondaryTags,
                relevanceScore: ch.similarity,
              }))

        // Production's own predicate, so the gate under test is the real one.
        const rendered = renderableIntentions(
          ctx.openIntentions,
          ctx.classification?.category ?? null,
          ctx.pendingQuestion !== null,
          ctx.reviewAsk !== null,
        )
        turnRow.renderedKeys = rendered.map((r) => r.key)

        const gen = await generateMessage({
          category: step.category,
          persona: ctx.venue.brandPersona,
          venueInfo: ctx.venue.venueInfo,
          ragChunks,
          knowledgeChunks,
          runtime: buildAiRuntime(ctx),
          channel: 'text',
        })

        if (!gen.ok) {
          turnRow.error = `generation: ${gen.error}`
          turnRow.failed = true
        } else {
          turnRow.calls = gen.data.attempts
          // THE SENT TEXT. generation.body is the complete reply including the
          // question bubble as its exact tail, so counting questions here counts
          // what the guest actually reads across both messages.
          turnRow.body = gen.data.body
          turnRow.intentionQuestion = gen.data.intentionQuestion
          turnRow.droppedForBodyQuestion =
            gen.data.intentionQuestionDroppedForBodyQuestion
          turnRow.capturedName =
            gen.data.contextUpdate?.structured?.guest_details?.first_name
          turnRow.capturedHistory =
            gen.data.contextUpdate?.structured?.guest_details?.history_here
          if (turnRow.capturedName !== undefined)
            capturedName = turnRow.capturedName
          if (turnRow.capturedHistory !== undefined)
            capturedHistory = turnRow.capturedHistory

          const tail = rendered.length > 0 ? gen.data.intentionQuestion : ''
          // The scorer reads this structurally rather than guessing where the
          // question starts. See TurnInput.tail.
          turnRow.tail = tail
          turnRow.bubbles = resolveDispatchBubbles(
            gen.data.body,
            () => seededFlip(`${conversationId}-t${t}`),
            tail,
            // TAC-568: this harness measures the question bubble, not the warm
            // close, and no turn here closes a first conversation.
            '',
          )

          // Production's gate, over the rendered set: what it would record as
          // raised, which drives prompted-once below exactly as it does in
          // production.
          if (rendered.length > 0) {
            const judged = await classifyIntentionPrompts({
              sentBody: gen.data.body,
              openIntentions: rendered.map((r) => ({
                key: r.key,
                description:
                  INTENTION_DEFINITION_BY_KEY[r.key].classifierDescription,
              })),
            })
            if (judged.ok) {
              turnRow.raisedKeys = [...judged.data.raisedKeys]
            } else {
              turnRow.error = `judge: ${judged.error}`
              turnRow.failed = true
            }
          }

          // THE FULL BALLOT, which is what bar 1 reads. Asked whenever the reply
          // asked ANYTHING, including when nothing rendered - an invented question
          // on a turn with no open intention is exactly the case the gate's own
          // forced choice cannot see.
          //
          // IT READS THE QUESTIONS, NOT THE WHOLE BODY, and that correction came
          // out of the smoke run. Handed the whole reply, the judge attributed
          // their_rhythm to "one of those drinks that rewards the quiet of a
          // weekday" and did_they_like_it to "hope it hits right" - statements, not
          // questions. The bar is about QUESTIONS ASKED, so attributing a
          // non-question to an intention fails the arm for something no guest was
          // asked to answer. Convention 7's asymmetry check, found by reading
          // bodies rather than by trusting the rate.
          // The tail is excluded: production's own gate judged it above, and the
          // two questions in a turn must not share one forced choice.
          const questions = splitQuestions(answerPartOf(gen.data.body, tail))
          if (!turnRow.failed && questions.length > 0) {
            const fullBallot = await classifyIntentionPrompts({
              sentBody: questions.join(' '),
              openIntentions: INTENTION_KEYS.map((k) => ({
                key: k,
                description:
                  INTENTION_DEFINITION_BY_KEY[k].classifierDescription,
              })),
            })
            if (fullBallot.ok) {
              turnRow.attributedTo = [...fullBallot.data.raisedKeys]
            } else {
              turnRow.error = `full-ballot judge: ${fullBallot.error}`
              turnRow.failed = true
            }
          }

          history.push({
            direction: 'inbound',
            body: step.body,
            createdAt: receivedAt,
            delivery: 'delivered',
          })
          history.push({
            direction: 'outbound',
            body: gen.data.body,
            createdAt: new Date(receivedAt.getTime() + 30_000),
            delivery: 'delivered',
          })

          // Prompted-once: a raised intention closes for the rest of the run.
          for (const key of turnRow.raisedKeys) {
            prompted.push({
              intentionKey: key,
              promptedAt: new Date(receivedAt.getTime() + 30_000),
              eligibleAt:
                derived.open.find((o) => o.key === key)?.eligibleAt ?? null,
              messageId: randomUUID(),
              promptSource: 'classified',
            })
          }

          // THE NEXT GUEST TURN IS DECIDED HERE, from what was actually asked.
          // Turn 2 is fixed (the order), because that is the scenario's premise.
          if (t === 0) {
            nextInbound = {
              body: `got a ${orderItem.toLowerCase()}`,
              category: 'reply',
            }
          } else if (turnRow.raisedKeys.includes('learn_name')) {
            nextInbound = { body: `it's ${guestName}`, category: 'reply' }
          } else if (turnRow.raisedKeys.includes('are_they_new_here')) {
            nextInbound = { body: historyAnswer, category: 'reply' }
          } else if (gen.data.body.includes('?')) {
            // A question was asked that was neither of those. The guest still
            // answers it, which is the scenario, and the off-target key is already
            // recorded against bar 1.
            nextInbound = { body: GENERIC_ANSWER, category: 'reply' }
          } else {
            nextInbound = { body: NEUTRAL_CONTINUATION, category: 'reply' }
          }
        }
      } catch (e) {
        turnRow.error = `threw: ${e instanceof Error ? e.message : String(e)}`
        turnRow.failed = true
      }

      row.turns.push(turnRow)
      if (turnRow.failed) break
    }

    row.verdict = scoreConversation(row.turns, venue.name ?? '')
    if (row.verdict.invalid) row.invalidReason = 'failed model call'
    // THE FIXTURE-REACH GUARD. Bar 3 reads the opener, so a conversation whose
    // turn 1 did not render FIRST_TOUCH_OPENER cannot contribute a zero to it. A
    // vacuous zero is worse than a missing one: it reads as evidence.
    if (!row.verdict.invalid && row.turns[0]?.openerRendered !== true) {
      row.verdict = { ...row.verdict, invalid: true, clean: false }
      row.invalidReason = 'first-touch opener did not render'
    }

    rows.push(row)
    log.appendUnit(row)
    const v = row.verdict
    console.log(
      `[${conversationId}] ${arm} questions=${v.questionCount} twoQ=${v.twoQuestionTurns} offTarget=[${v.offTargetKeys.join(',')}] unattributed=${v.unattributedTurns} openerClaims=[${v.openerIdentityClaims.map((c) => c.label).join(',')}]${v.invalid ? ` INVALID(${row.invalidReason})` : v.clean ? ' CLEAN' : ''}`,
    )
    for (const t of row.turns) {
      console.log(`    <- ${t.inbound}`)
      console.log(`    -> ${t.body || `(none: ${t.error ?? 'no body'})`}`)
      if (t.tail !== '') console.log(`       [bubble] ${t.tail}`)
    }
    if (v.questions.length > 0)
      console.log(
        `    questions: ${v.questions.map((q) => `"${q}"`).join(' | ')}`,
      )
  }

  const { count: statesAfter } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  const summary = summarize(rows.map((r) => r.verdict))

  // Every question asked, with its attribution, so bar 1 can be READ rather than
  // trusted. Convention 7: read bodies before believing a rate.
  const askedByKey = new Map<string, number>()
  for (const r of rows) {
    if (r.verdict.invalid) continue
    for (const t of r.turns) {
      // BOTH JUDGES. attributedTo covers the body's own questions and raisedKeys
      // covers the bubble, and a breakdown showing only one of them reads as if
      // half the questions were never asked.
      for (const k of [...t.attributedTo, ...t.raisedKeys])
        askedByKey.set(k, (askedByKey.get(k) ?? 0) + 1)
    }
  }

  const droppedTurns = rows.flatMap((r) =>
    r.turns.filter((t) => t.droppedForBodyQuestion),
  )

  console.log(`\n[tac567] guest_states rows after: ${statesAfter}`)
  console.log(
    `[tac567] ==== arm=${arm} prompt=${PROMPT_VERSION} n=${summary.conversations} valid=${summary.valid} invalid=${summary.invalid}`,
  )
  console.log(
    `[tac567] bar 1  off-target conversations : ${summary.offTargetConversations}/${summary.valid} (bar 0)`,
  )
  console.log(
    `[tac567] bar 1b unattributed-question    : ${summary.unattributedConversations}/${summary.valid} (bar 0)`,
  )
  console.log(
    `[tac567] bar 2  turns with two questions : ${summary.twoQuestionTurns} (bar 0)`,
  )
  console.log(
    `[tac567] bar 3  opener "you've reached"  : ${summary.strictIdentityConversations}/${summary.valid} (bar 0)`,
  )
  console.log(
    `[tac567] bar 3b opener equivalent        : ${summary.equivalentIdentityConversations}/${summary.valid} (bar 0)`,
  )
  console.log(
    `[tac567] clean conversations            : ${summary.cleanConversations}/${summary.valid}`,
  )
  // CONVENTION 8: the floor is evaluated here, not tallied. Every bar above counts
  // a bad thing, so a run that asked nothing would sweep them.
  console.log(
    `[tac567] FLOOR  order question asked    : ${summary.orderAskedConversations}/${summary.valid} (floor ${summary.orderAskedRequired}) ${summary.floorMet ? 'MET' : 'BREACHED'}`,
  )
  console.log(`[tac567] questions attributed by intention:`)
  for (const [k, n] of [...askedByKey.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`[tac567]   ${k}: ${n}`)
  console.log(
    `[tac567] two-question gate fired on ${droppedTurns.length} turn(s)`,
  )
  console.log(
    `[tac567] openers that rendered FIRST_TOUCH_OPENER: ${rows.filter((r) => r.turns[0]?.openerRendered === true).length}/${rows.length} (bar 3 is only measurable on these)`,
  )
  if (arm === 'control') {
    console.log(
      `[tac567] NOTE control = isFirstConversation:false. Both arms carry the new opener text and the two-question gate, so bar 3 cannot differ by arm and bar 2 is partly floored by the gate in both.`,
    )
    console.log(
      `[tac567] NOTE this arm does NOT test the eligibility suppression. In a ${GUEST_TURNS}-turn fixture ${ARMS_CAN_DIFFER_ON.join(' and ')} can differ by arm; the rest never arm or never gate open. The off-target questions here are mostly invented with no restraint to stop them. derive.test.ts covers eligibility.`,
    )
  }
  // The harness's own divergences from production, printed rather than left in a
  // comment, because a reader of the output is the one who needs them.
  console.log(
    `[tac567] DIVERGENCE applyCurrentTurnSuppression is NOT applied, so turn 2 renders "you haven't heard what this guest ordered yet" on the turn that names the order. Production suppresses it for that turn. Inherited from first-visit-question.ts; against absolute-zero bars it can only cost the arm, never flatter it.`,
  )

  // The summary as a final unit, because RunLog is append-only by design: the
  // checkpoint IS the append, and a harness that held results to write at the end
  // is the failure the convention exists to prevent.
  log.appendUnit({
    kind: 'summary',
    summary,
    statesBefore,
    statesAfter,
    askedByKey: Object.fromEntries(askedByKey),
    twoQuestionGateFired: droppedTurns.length,
  })

  // CONVENTION 8: the harness prints its own verdict, and a run with no valid
  // conversation is a FAILURE rather than a clean sweep of zeros.
  console.log(
    `[tac567] ${summary.pass ? 'PASS' : 'FAIL'} (run log: ${log.path})`,
  )
  process.exit(summary.pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
