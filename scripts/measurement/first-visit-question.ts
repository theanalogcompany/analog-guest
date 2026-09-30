// TAC-558: once the order is captured, does the agent ask whether the guest is
// new here - and only then?
//
// GENERATE-ONLY. Nothing is sent and nothing is written, with one exception this
// run reports on itself: buildRuntimeContext calls computeGuestState, which
// persists a guest_states row on a recognition-band change. Context is therefore
// built ONCE and cloned per conversation, so that write has one opportunity
// rather than eighty, and the row count is printed before and after (the TAC-544
// precedent).
//
// MULTI-TURN, four guest turns per conversation: the scan, the order named, an
// ordinary reply, and the guest's answer. The ticket's three turns measure the
// ASK; storing the answer needs a turn where the guest actually answers, which
// is why there is a fourth. Each generated reply is appended to
// ctx.recentMessages in memory and the next turn is generated against it, the
// TAC-544 shape.
//
// THE ARMS CANNOT BE BYTE-IDENTICAL PAST TURN 3, and that is not a flaw to
// engineer away. The metric is a property of a SEQUENCE - a question asked on one
// turn and answered on the next - so a matched-prompt comparison would be
// measuring a different question. What IS matched: the guest, the venue, the
// scan body, the order body, the turn-3 body, and the derivation.
//
// THE CONTROL IS IN-PROCESS, AND HERE IS THE CAVEAT PRECISELY. It runs the real
// derivation and then FILTERS are_they_new_here out of the open set before
// buildAiRuntime. So the control is "branch schema, this intention suppressed",
// never a measurement of origin/main: the extra optional field
// (guest_details.history_here) exists in both arms. That is the same caveat
// channel-self-reference-replay.ts carries, and it is chosen over TAC-554's
// two-runs-of-the-file because it makes turns 1 and 2 byte-identical between
// arms and removes model-version drift between two separate invocations.
//
// WHY THE DERIVATION IS RUN FOR REAL rather than hand-set, which is the opposite
// of what intention-bubble.ts rightly does for its own question. The acceptance
// criteria here ARE claims about the derivation - raised after the order and
// never before it, never for a guest with visits on record - so overriding
// openIntentions would make the measurement circular. The facts each turn sees
// are constructed (no order on turns 1-2, one order from turn 3), which is the
// production sequence: TAC-323's extractor runs post-send under waitUntil, so the
// transaction exists from the next turn.
//
// THE JUDGE IS PRODUCTION'S OWN classifyIntentionPrompts, never a regex. TAC-423
// spent two rounds on a phrase-list detector that under-counted whichever arm was
// not echoing a script, and the error always flattered the control. There is no
// phrase list here that could go stale against a paraphrase.
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
  type OpenIntention,
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
  retrieveCorpusStage,
  retrieveKnowledgeWithContextStage,
} from '@/lib/agent/stages'
import type { RuntimeContext } from '@/lib/agent/types'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { hasContent } from './intention-bubble-score'
import {
  scoreConversation,
  scoreVariety,
  TARGET_KEY,
  type TurnRecord,
  type TurnStage,
} from './first-visit-question-score'
import { createRunLog } from './run-log'
import { seededFlip } from './seeded-flip'

type Arm = 'control' | 'after'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const MAX_BUBBLES_CEILING = 3

/**
 * The turn-3 shapes: an ordinary message that leaves the reply finished, which is
 * one of the openings the restraint paragraph names positively.
 *
 * ROTATED across conversations rather than repeated, the TAC-544 lesson: a design
 * that always used the same shape would measure one door twenty times and say
 * nothing about the others.
 */
const REPLY_SHAPES: readonly {
  body: string
  category: MessageCategory
  shape: string
}[] = [
  {
    body: 'are you open on sundays?',
    category: 'new_question',
    shape: 'answerable_question',
  },
  {
    body: 'that was really good actually',
    category: 'reply',
    shape: 'chatting_nothing_needed',
  },
  {
    body: 'do you have oat milk?',
    category: 'new_question',
    shape: 'answerable_question',
  },
  {
    body: 'just moved to the area so im trying places out',
    category: 'reply',
    shape: 'said_something_about_self',
  },
  {
    body: 'whats good here besides that',
    category: 'recommendation_request',
    shape: 'recommendation',
  },
]

/**
 * How the guest answers, when the question was asked. Both directions, rotated,
 * because the ticket wants the answer stored "either way" - a run that only ever
 * said "first time" would leave the regular case unmeasured, which is the half
 * that has to inform later turns.
 */
const ANSWERS: readonly { body: string; kind: 'new' | 'regular' }[] = [
  { body: 'yeah first time in today', kind: 'new' },
  { body: 'been coming for about a year now', kind: 'regular' },
  { body: 'first time, someone at work told me about you', kind: 'new' },
  { body: 'oh ive been coming since you opened', kind: 'regular' },
]

/** What the guest says when nothing was asked. Keeps the fourth turn comparable. */
const NEUTRAL_CONTINUATION = 'cool, thanks'

async function main(): Promise<void> {
  const arm = process.env.MEASURE_ARM as Arm | undefined
  if (arm !== 'control' && arm !== 'after') {
    console.error(
      '✗ set MEASURE_ARM=control or MEASURE_ARM=after. A run log with no arm is unreadable afterwards.',
    )
    process.exit(2)
  }
  const venueSlug = process.env.MEASURE_VENUE ?? 'le-mils-coffee'
  const conversations = Number(process.env.MEASURE_CONVERSATIONS ?? '20')
  if (!Number.isInteger(conversations) || conversations < 1) {
    console.error('✗ MEASURE_CONVERSATIONS must be a positive integer')
    process.exit(2)
  }

  // ARM-INTEGRITY GUARD, before a call is spent. The control arm's whole claim is
  // that it suppresses something the treatment renders, so a run where the filter
  // removed nothing is INVALID rather than a clean zero - which is exactly the
  // shape of "the change works". Checked per conversation below and asserted here
  // at the definition level so a rename cannot make it vacuous.
  if (INTENTION_DEFINITION_BY_KEY[TARGET_KEY] === undefined) {
    console.error(
      `✗ no definition for ${TARGET_KEY}; this tree cannot run either arm`,
    )
    process.exit(1)
  }

  const db = createAdminClient()
  const { data: venue, error: venueError } = await db
    .from('venues')
    .select('id, slug, timezone, status')
    .eq('slug', venueSlug)
    .single()
  if (venueError || !venue) throw new Error(`venue ${venueSlug} not found`)

  const { count: statesBefore } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  // DERIVE the guest rather than pasting an id, and require NO first name: with a
  // name on record learn_name is closed by its own proxy, and learn_name sharing
  // rung 3 is precisely what "first in line" has to beat. A named guest would
  // remove the competition this run exists to measure.
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
    name: `tac558-first-visit-question-${arm}`,
    meta: {
      arm,
      promptVersion: PROMPT_VERSION,
      venue: venueSlug,
      venueStatus: venue.status,
      guest,
      conversations,
      target: TARGET_KEY,
      promptLine: INTENTION_DEFINITION_BY_KEY[TARGET_KEY].promptLine,
      statesBefore,
      // What the arms hold fixed, frozen into the file so a reader need not
      // trust the prose above.
      heldFixed: [
        'guest',
        'venue',
        'scanBody',
        'orderBody',
        'replyBody',
        'derivation(real)',
        'coin(seeded from conversationId+turn)',
      ],
      controlIs:
        'branch schema with are_they_new_here filtered out of the derived open set, NOT origin/main',
    },
  })

  console.log(`[tac558] arm=${arm} prompt=${PROMPT_VERSION}`)
  console.log(`[tac558] venue ${venueSlug} (status=${venue.status})`)
  console.log(
    `[tac558] guest ${guest.id.slice(0, 8)} (${guest.messages} msgs, no first name)`,
  )
  console.log(`[tac558] guest_states rows before: ${statesBefore}`)
  console.log(`[tac558] conversations: ${conversations}`)
  console.log(`[tac558] run log: ${log.path}\n`)

  const trace = startAgentTrace({
    name: 'tac558-measure',
    agentRunId: randomUUID(),
  })

  // ONE context build for the whole run; cloned per conversation.
  const scanBody = "Hi Le Mil's!"
  const baseCtx = await buildRuntimeContext({
    agentRunId: randomUUID(),
    guestId: guest.id,
    venueId: venue.id,
    trace,
    currentMessage: {
      id: randomUUID(),
      providerMessageId: `tac558-probe-${randomUUID()}`,
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

  type ConversationRow = {
    conversationId: string
    arm: Arm
    replyShape: string
    orderItem: string
    answerKind: 'new' | 'regular' | 'none'
    turns: {
      stage: TurnStage
      inbound: string
      orderOnRecord: boolean
      repliedMessageCount: number
      derivedOpenKeys: string[]
      renderedKeys: string[]
      filteredOutByControl: boolean
      body: string
      intentionQuestion: string
      bubbles: string[]
      raisedKeys: string[]
      storedHistory: string | undefined
      /** The full-ballot judge's attribution; see the on-target read. */
      attributedTo: string[]
      offTarget: string[]
      breaches: string[]
      calls: number
      error: string | null
    }[]
    verdict: ReturnType<typeof scoreConversation>
    invalidReason: string | null
  }

  const rows: ConversationRow[] = []

  for (let c = 0; c < conversations; c += 1) {
    const conversationId = `c${String(c + 1).padStart(2, '0')}`
    const replyShape = REPLY_SHAPES[c % REPLY_SHAPES.length]!
    const orderItem = menuNames[c % menuNames.length]!
    const answer = ANSWERS[c % ANSWERS.length]!

    const row: ConversationRow = {
      conversationId,
      arm,
      replyShape: replyShape.shape,
      orderItem,
      answerKind: 'none',
      turns: [],
      verdict: {
        raised: false,
        raisedBeforeOrder: false,
        ownLastBubble: false,
        answerStored: false,
        invalid: false,
        question: '',
        onTarget: false,
        offTarget: [],
      },
      invalidReason: null,
    }

    // Per-conversation mutable state: the history the next turn is generated
    // against, and the intention rows prompted-once reads.
    //
    // HISTORY STARTS EMPTY, which is the one place this departs from TAC-544's
    // multi-turn harness. That run KEPT the guest's real history deliberately,
    // because a loaded first name was the cause it was measuring. Here the
    // population is a FIRST-VISIT counter conversation, and the derived guest has
    // 20-odd real messages: loading them makes turn 1 not a first touch at all,
    // and the smoke run duly produced "Hey, welcome back!" on it. The guest's
    // recognition signals stay real; the conversation is the constructed one.
    const history: typeof baseCtx.recentMessages = []
    const prompted: PromptedIntentionRow[] = []
    const turnRecords: TurnRecord[] = []
    let controlEverFiltered = false

    const plan: {
      stage: TurnStage
      body: string
      category: MessageCategory
    }[] = [
      { stage: 'scan', body: scanBody, category: 'welcome' },
      {
        stage: 'order',
        body: `got a ${orderItem.toLowerCase()}`,
        category: 'reply',
      },
      {
        stage: 'reply',
        body: replyShape.body,
        category: replyShape.category,
      },
      // Turn 4's body is decided AFTER turn 3, from whether the question was
      // actually asked. Placeholder here; replaced below.
      { stage: 'answer', body: NEUTRAL_CONTINUATION, category: 'reply' },
    ]

    for (let t = 0; t < plan.length; t += 1) {
      const step = plan[t]!
      const receivedAt = new Date(startedAt.getTime() + t * 60_000)
      // The order is on record from turn 3 on: TAC-323's extractor runs post-send
      // under waitUntil, so the transaction the guest's turn-2 message produces
      // exists from the following turn.
      const orderOnRecord = t >= 2
      const orderAt = new Date(startedAt.getTime() + 60_000)
      // ## Visit history must agree with the facts this turn was derived from.
      // Left as the real guest's visits, the prompt would show a history of
      // earlier visits while the derivation was told there are none - a
      // contradiction the model has to resolve, and on exactly the axis this run
      // measures.
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
          firstName: null,
          homeBase: undefined,
          // One visit once the order lands: the population the ticket is about.
          recordedVisitCount: orderOnRecord ? 1 : 0,
          venueHistory: turnRecords.find(
            (r) =>
              r.storedHistory !== undefined && r.storedHistory.trim() !== '',
          )?.storedHistory,
        }),
        // The scan confirms the visit, which is what arms understand_order.
        visitConfirmedAt: startedAt,
        openRecommendationTimes: [],
        openRecommendationTouchedTimes: [],
        openRecommendationsUnreadable: false,
        recordedOrderTimes: orderOnRecord ? [orderAt] : [],
        rows: { prompted, eligible: [] },
        inboundTimes: [receivedAt],
        conversationWindowMs: 48 * 60 * 60 * 1000,
        inboundHistoryFrom: new Date(startedAt.getTime() - 14 * MS_PER_DAY),
        // TAC-567: true, because every conversation this harness generates IS a
        // first one (a fresh qr_scan guest, four turns inside one sitting). That
        // is the production value, and it now suppresses the five intentions the
        // 2026-09-30 ruling holds back on a first visit. are_they_new_here, this
        // harness's target, is one of the three still allowed, so the metric it
        // measures is unchanged - but the off-target denominator is, because
        // are_they_local and their_rhythm can no longer appear in it. A re-run
        // after this ticket is not comparable to the runs recorded on TAC-558.
        isFirstConversation: true,
      })

      const derivedOpenKeys = derived.open.map((o) => o.key)
      // THE CONTROL ARM'S ONE EDIT.
      const openForArm: OpenIntention[] =
        arm === 'control'
          ? derived.open.filter((o) => o.key !== TARGET_KEY)
          : derived.open
      const filteredOutByControl =
        arm === 'control' && derivedOpenKeys.includes(TARGET_KEY)
      if (filteredOutByControl) controlEverFiltered = true

      const ctx: RuntimeContext = {
        ...baseCtx,
        recentMessages: [...history],
        recentVisits,
        conversationChannel: 'text',
        openIntentions: openForArm,
        pendingQuestion: null,
        // firstTouchAfterQrScan is NOT set here: buildAiRuntime derives it from
        // created_via, the history length and the freshness window
        // (computeFirstTouchAfterQrScan). Overriding it would make the opener a
        // harness decision rather than production's.
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
          reasoning: 'tac558 measurement: category held fixed across arms',
          crisisSafety: false,
          correctsPendingReply: false,
          followUpWorthy: false,
        },
      }

      const turnRow: ConversationRow['turns'][number] = {
        stage: step.stage,
        inbound: step.body,
        orderOnRecord,
        repliedMessageCount,
        derivedOpenKeys,
        renderedKeys: [],
        filteredOutByControl,
        body: '',
        intentionQuestion: '',
        bubbles: [],
        raisedKeys: [],
        storedHistory: undefined,
        attributedTo: [] as string[],
        offTarget: [] as string[],
        breaches: [],
        calls: 0,
        error: null,
      }

      const record: TurnRecord = {
        stage: step.stage,
        renderedKeys: [],
        raisedKeys: [],
        orderOnRecord,
        intentionQuestion: '',
        bubbles: [],
        storedHistory: undefined,
        attributedTo: [],
        failed: false,
      }

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
        )
        turnRow.renderedKeys = rendered.map((r) => r.key)
        record.renderedKeys = turnRow.renderedKeys

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
          record.failed = true
        } else {
          turnRow.calls = gen.data.attempts
          turnRow.body = gen.data.body
          turnRow.intentionQuestion = gen.data.intentionQuestion
          record.intentionQuestion = gen.data.intentionQuestion
          turnRow.storedHistory =
            gen.data.contextUpdate?.structured?.guest_details?.history_here
          record.storedHistory = turnRow.storedHistory

          // The tail only reaches dispatch when the block rendered, via
          // production's own gate. Seeded per turn so a conversation sees the
          // same coin in both arms.
          const tail = rendered.length > 0 ? gen.data.intentionQuestion : ''
          const bubbles = resolveDispatchBubbles(
            gen.data.body,
            () => seededFlip(`${conversationId}-t${t}`),
            tail,
          )
          turnRow.bubbles = bubbles
          record.bubbles = bubbles

          if (bubbles.length > MAX_BUBBLES_CEILING)
            turnRow.breaches.push('too_many_bubbles')
          if (bubbles.some((b) => b.trim() === ''))
            turnRow.breaches.push('empty_bubble')
          if (bubbles.some((b) => !hasContent(b)))
            turnRow.breaches.push('contentless_bubble')
          if (tail !== '' && bubbles[bubbles.length - 1] !== tail)
            turnRow.breaches.push('tail_not_last_bubble')

          // WHAT WAS ACTUALLY RAISED, by production's judge over the SENT text.
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
              record.raisedKeys = turnRow.raisedKeys

              // THE ON-TARGET READ. Production's gate asks the judge a
              // forced-choice question - its z.enum is built from the OPEN keys
              // only, so with one intention rendered the options are "raised it"
              // or "nothing" and an are_they_local question lands in the one
              // available bucket. Asking again with EVERY intention on the ballot
              // is the same instrument with a fair choice, and it is what says
              // whether the question was about the right thing.
              //
              // DIAGNOSTIC ONLY. Nothing in production makes this call, and its
              // answer never feeds the prompted-once state below - that follows
              // the gate, as it does in production.
              if (turnRow.raisedKeys.includes(TARGET_KEY)) {
                const fullBallot = await classifyIntentionPrompts({
                  sentBody: gen.data.body,
                  openIntentions: INTENTION_KEYS.map((k) => ({
                    key: k,
                    description:
                      INTENTION_DEFINITION_BY_KEY[k].classifierDescription,
                  })),
                })
                if (fullBallot.ok) {
                  turnRow.attributedTo = [...fullBallot.data.raisedKeys]
                  record.attributedTo = turnRow.attributedTo
                  turnRow.offTarget = turnRow.attributedTo.filter(
                    (k) => k !== TARGET_KEY,
                  )
                } else {
                  turnRow.error = `full-ballot judge: ${fullBallot.error}`
                  record.failed = true
                }
              }
            } else {
              // A judge failure is a failed unit, not "raised nothing".
              turnRow.error = `judge: ${judged.error}`
              record.failed = true
            }
          }

          // Feed the reply into the history the next turn sees.
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

          // TURN 4'S BODY IS DECIDED HERE, from whether the question was asked.
          if (step.stage === 'reply') {
            if (turnRow.raisedKeys.includes(TARGET_KEY)) {
              plan[3] = {
                stage: 'answer',
                body: answer.body,
                category: 'reply',
              }
              row.answerKind = answer.kind
            } else {
              plan[3] = {
                stage: 'answer',
                body: NEUTRAL_CONTINUATION,
                category: 'reply',
              }
              row.answerKind = 'none'
            }
          }
        }
      } catch (e) {
        turnRow.error = `threw: ${e instanceof Error ? e.message : String(e)}`
        record.failed = true
      }

      row.turns.push(turnRow)
      turnRecords.push(record)
      if (record.failed) break
    }

    row.verdict = scoreConversation(turnRecords)
    if (row.verdict.invalid) row.invalidReason = 'failed model call'
    // The control arm's integrity check, per conversation: if the filter never
    // removed anything, this conversation did not differ from the treatment and
    // says nothing about the change.
    if (arm === 'control' && !controlEverFiltered) {
      row.verdict = { ...row.verdict, invalid: true }
      row.invalidReason = 'control filter removed nothing'
    }

    rows.push(row)
    log.appendUnit(row)
    const v = row.verdict
    console.log(
      `[${conversationId}] ${arm} raised=${v.raised} beforeOrder=${v.raisedBeforeOrder} ownBubble=${v.ownLastBubble} stored=${v.answerStored}${v.invalid ? ` INVALID(${row.invalidReason})` : ''}${v.question ? `\n    q: ${v.question}` : ''}`,
    )
  }

  const { count: statesAfter } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  const valid = rows.filter((r) => !r.verdict.invalid)
  const invalid = rows.length - valid.length
  const raised = valid.filter((r) => r.verdict.raised)
  // THE NUMBER TO READ. `raised` is what production's gate would attribute, which
  // on a one-intention turn is a forced choice; onTarget is what was actually
  // asked. The first run of this harness reported 12/20 raised where 6 of the 12
  // questions were about somewhere the guest lives or their name.
  const onTarget = raised.filter((r) => r.verdict.onTarget)
  const offTarget = raised.filter((r) => !r.verdict.onTarget)
  const beforeOrder = valid.filter((r) => r.verdict.raisedBeforeOrder)
  const ownBubble = raised.filter((r) => r.verdict.ownLastBubble)
  const stored = raised.filter((r) => r.verdict.answerStored)
  const orderTurnsWithQuestion = rows.flatMap((r) =>
    r.turns.filter(
      (t) => !t.orderOnRecord && t.raisedKeys.includes(TARGET_KEY),
    ),
  )
  // SCOPED TO THE RAISED TURN. The smoke run breached `contentless_bubble` on a
  // turn-1 welcome reply that isolated a lone emoji into its own bubble - a
  // pre-existing resolveDispatchBubbles artifact with nothing to do with this
  // change, which would have failed the arm for someone else's defect. Other
  // turns' breaches are reported as informational and listed under Follow-ups.
  const breaches = rows.flatMap((r) =>
    r.turns
      .filter((t) => t.raisedKeys.includes(TARGET_KEY))
      .flatMap((t) => t.breaches),
  )
  const otherBreaches = rows.flatMap((r) =>
    r.turns
      .filter((t) => !t.raisedKeys.includes(TARGET_KEY))
      .flatMap((t) => t.breaches.map((b) => `${t.stage}:${b}`)),
  )
  // CONVENTION 9: state up front where the arms CANNOT differ, and verify it
  // rather than inferring it from the rate. The filter can only fire once an
  // order is on record, so the order question's own turns are identical in both
  // arms by construction - which is AC 4 (order capture unchanged).
  const preOrderFiltered = rows.flatMap((r) =>
    r.turns.filter((t) => !t.orderOnRecord && t.filteredOutByControl),
  )
  const learnNameWon = valid.filter(
    (r) =>
      !r.verdict.raised &&
      r.turns.some((t) => t.raisedKeys.includes('learn_name')),
  )
  // Scored over the ON-TARGET questions only. An are_they_local question in the
  // denominator measures a different question's phrasing, and including the
  // off-target ones would both inflate n and dilute a real template.
  const variety = scoreVariety(onTarget.map((r) => r.verdict.question))

  console.log(`\n${'='.repeat(72)}`)
  console.log(`TAC-558 ${arm}  prompt=${PROMPT_VERSION}`)
  console.log(`${'='.repeat(72)}`)
  console.log(
    `conversations      ${rows.length} (${invalid} invalid, excluded)`,
  )
  console.log(`raised (gate)      ${raised.length}/${valid.length}`)
  console.log(
    `ON TARGET          ${onTarget.length}/${valid.length}  <- the number to read`,
  )
  console.log(`off target         ${offTarget.length}`)
  console.log(
    `BEFORE the order   ${beforeOrder.length}  (bar: 0)  [turns: ${orderTurnsWithQuestion.length}]`,
  )
  console.log(`own last bubble    ${ownBubble.length}/${raised.length}`)
  console.log(`answer stored      ${stored.length}/${raised.length}`)
  console.log(`learn_name instead ${learnNameWon.length}`)
  console.log(
    `ceiling breaches   ${breaches.length} (on raised turns) ${breaches.length > 0 ? `(${[...new Set(breaches)].join(', ')})` : ''}`,
  )
  console.log(
    `other-turn breaches ${otherBreaches.length} (informational, pre-existing splitter) ${otherBreaches.length > 0 ? `(${[...new Set(otherBreaches)].join(', ')})` : ''}`,
  )
  console.log(
    `pre-order arms differ ${preOrderFiltered.length}  (must be 0: the arms cannot differ before the order, so AC 4 holds by construction)`,
  )
  console.log(`guest_states rows  ${statesBefore} -> ${statesAfter}`)

  console.log(`\nverbatim questions (${raised.length}):`)
  for (const r of raised) {
    const tag = r.verdict.onTarget
      ? 'ON TARGET '
      : `OFF TARGET${r.verdict.offTarget.length > 0 ? ` -> ${r.verdict.offTarget.join(',')}` : ' -> nothing'}`
    console.log(
      `  [${r.conversationId}] ${tag}  ${r.verdict.question || '(empty)'}`,
    )
  }

  console.log(`\nphrasing variety (bar: no wording in >25% of raised):`)
  if (variety.findings.length === 0) {
    console.log('  no repeated phrase over threshold at n=2, 3 or 5')
  } else {
    for (const f of variety.findings) {
      console.log(
        `  n=${f.n} x${f.replies}/${variety.raisedCount} ${f.subjectOnly ? '[subject-only, informational]' : '[SCORED]'} "${f.phrase}"`,
      )
    }
  }

  // CEILINGS EVALUATED HERE, not left to whoever reads the output.
  const ceilingFailures: string[] = []
  if (beforeOrder.length > 0)
    ceilingFailures.push(
      `${beforeOrder.length} raised before the order (bar: 0)`,
    )
  if (breaches.length > 0)
    ceilingFailures.push(
      `${breaches.length} bubble ceiling breaches on raised turns`,
    )
  if (preOrderFiltered.length > 0)
    ceilingFailures.push(
      `${preOrderFiltered.length} pre-order turns where the arms differed; AC 4's by-construction claim is false`,
    )
  if (!variety.pass)
    ceilingFailures.push(
      `phrasing: ${variety.scored.map((f) => `n=${f.n} "${f.phrase}" x${f.replies}`).join('; ')}`,
    )
  if (raised.length > 0 && ownBubble.length < raised.length)
    ceilingFailures.push(
      `${raised.length - ownBubble.length} raised questions were not their own last bubble`,
    )
  // A NEW CEILING, from the first run's finding. An off-target question closes
  // are_they_new_here prompted-once having learned nothing, so it is worse than a
  // repeated phrase and must fail the arm rather than sit in the raise rate.
  if (offTarget.length > 0)
    ceilingFailures.push(
      `${offTarget.length} raised questions were off target (${offTarget.map((r) => `${r.conversationId}->${r.verdict.offTarget.join(',') || 'nothing'}`).join('; ')})`,
    )

  console.log()
  if (ceilingFailures.length === 0) {
    console.log('PASS  no ceiling breached')
  } else {
    for (const f of ceilingFailures) console.log(`FAIL  ceiling: ${f}`)
  }
  console.log(`\nrun log: ${log.path}`)

  await trace.flushAsync()
}

void main()
