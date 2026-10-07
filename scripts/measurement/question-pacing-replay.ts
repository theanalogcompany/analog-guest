// A replay of the 2026-10-07 phone test: the name question went unanswered, and
// on the guest's fifth message ("can i see the menu") the reply carried the menu
// link AND "do you live or work nearby?".
//
// GENERATE-ONLY. Nothing is sent and nothing is written, with the one exception
// every harness that builds a real context reports on itself: buildRuntimeContext
// calls computeGuestState, which persists a guest_states row on a band change.
// Context is built ONCE and cloned per unit, and the row count is printed before
// and after.
//
// THE THREAD IS CONSTRUCTED (fixtures/question-pacing-phone-test.json). The real
// rows were deleted with the guest. The earlier turns are fixed text, including
// our name question, so every unit measures the same state; only the reply to the
// last message is generated, MEASURE_UNITS times.
//
// THE CATEGORY IS THE REAL CLASSIFIER'S, not a constant. Half of the rule under
// test is "this turn is not a relaxed one", so a hand-set category would be
// measuring the fixture's opinion of the message rather than production's.
//
// TWO ARMS, same guest, venue, thread and classifier verdict:
//
//   rules_on   the branch as it ships.
//   rules_off  the same code with the three rules switched off from outside:
//              the pacing read is handed a zero-length conversation (so the
//              unanswered name is not "in this conversation"), the category
//              filter is bypassed, and the draft drop is off. NOT origin/main,
//              but for this thread it renders what main renders, because the
//              branch changes no wording.
//
//              WHAT THE ZERO WINDOW ALSO TOUCHES: the brake reads the same
//              window, and at zero every prompt counts as unanswered. One
//              prompt is on file here and the brake needs two, so it is inert.
//              A fixture with two would need a different switch.
//
//   draft_drop_only  rules_off with the draft drop left ON. In rules_on the
//              block never renders on this turn, so the third gate (drop the
//              question from a reply that carries a link) is never reached and
//              a clean rules_on run says nothing about it. This arm renders the
//              block, lets the model ask, and counts the drops: the gate's
//              true-positive record.
//
// WHAT CAN CONTRADICT A ZERO. The bar counts a bad thing (a getting-to-know-you
// question on the menu turn), so a broken run reads clean. rules_off is the
// contrast: if it also shows none, this run has shown nothing about the rules,
// and the summary says so rather than printing a pass. The judge is production's
// classifyIntentionPrompts on the FULL ballot of intention keys, over every
// question in the reply, so a question the model invents in the body with no
// block rendered is counted too.
//
// Run with NEXT_PUBLIC_POSTHOG_KEY and SLACK_ALERTS_WEBHOOK_URL unset so the
// stages' telemetry goes inert.

import { randomUUID } from 'node:crypto'
import {
  classifyIntentionPrompts,
  classifyMessage,
  generateMessage,
} from '@/lib/ai'
import type {
  KnowledgeCorpusChunk as AiKnowledgeChunk,
  VoiceCorpusChunk as AiVoiceCorpusChunk,
} from '@/lib/ai'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { extractUrls } from '@/lib/ai/url-detector'
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
import { isConversationPaced } from '@/lib/agent/intentions/pacing'
import {
  buildAiRuntime,
  retrieveCorpusStage,
  retrieveKnowledgeWithContextStage,
} from '@/lib/agent/stages'
import type { RuntimeContext } from '@/lib/agent/types'
import { createAdminClient } from '@/lib/db/admin'
import { toParsedGuestContext } from '@/lib/schemas/guest-context'
import { INTENTION_RULES_DEFAULT } from '@/lib/schemas/intention-rules'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { splitQuestions } from './first-visit-question-budget-score'
import fixture from './fixtures/question-pacing-phone-test.json'
import { createRunLog } from './run-log'

type Arm = 'rules_on' | 'rules_off' | 'draft_drop_only'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const CONVERSATION_WINDOW_MS = 48 * 60 * 60 * 1000
/** Seconds between the fixture's messages. The whole thread is one sitting. */
const MESSAGE_GAP_S = 40

async function main(): Promise<void> {
  const arm = process.env.MEASURE_ARM as Arm | undefined
  if (arm !== 'rules_on' && arm !== 'rules_off' && arm !== 'draft_drop_only') {
    console.error(
      '✗ set MEASURE_ARM=rules_on, rules_off or draft_drop_only. A run log with no arm is unreadable afterwards.',
    )
    process.exit(2)
  }
  const venueSlug = process.env.MEASURE_VENUE ?? 'le-mils-coffee'
  const units = Number(process.env.MEASURE_UNITS ?? '10')
  if (!Number.isInteger(units) || units < 1) {
    console.error('✗ MEASURE_UNITS must be a positive integer')
    process.exit(2)
  }

  const db = createAdminClient()
  const { data: venue, error: venueError } = await db
    .from('venues')
    .select('id, slug, name, status')
    .eq('slug', venueSlug)
    .single()
  if (venueError || !venue) throw new Error(`venue ${venueSlug} not found`)

  const { count: statesBefore } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  // Any guest will do: everything guest-specific is overridden below. Nameless,
  // so a stored name cannot reach the prompt by a field this file forgot.
  const { data: candidates } = await db
    .from('guests')
    .select('id')
    .eq('venue_id', venue.id)
    .is('first_name', null)
    .is('opted_out_at', null)
    .limit(1)
  const guestId = candidates?.[0]?.id
  if (!guestId)
    throw new Error(`need one nameless, non-opted-out guest at ${venueSlug}`)

  const now = new Date()
  const history: RuntimeContext['recentMessages'] = fixture.history.map(
    (m, i) => ({
      direction: m.direction as 'inbound' | 'outbound',
      body: m.body,
      createdAt: new Date(
        now.getTime() - (fixture.history.length - i) * MESSAGE_GAP_S * 1000,
      ),
      delivery: 'delivered',
    }),
  )
  const startedAt = history[0]!.createdAt
  const nameAskIndex = fixture.history.findIndex((m) => 'asks' in m)
  const nameAskedAt = history[nameAskIndex]!.createdAt
  const inbound = history.filter((m) => m.direction === 'inbound')
  const repliedMessageCount = inbound.length + 1

  const log = createRunLog({
    name: `question-pacing-replay-${arm}`,
    meta: {
      arm,
      promptVersion: PROMPT_VERSION,
      venue: venueSlug,
      venueStatus: venue.status,
      units,
      fixture: 'fixtures/question-pacing-phone-test.json (CONSTRUCTED)',
      measuredInbound: fixture.measuredInbound,
      repliedMessageCount,
      bar: 'on the menu turn: getting-to-know-you questions 0, bare-link replies 0',
      draftDropOnlyIs:
        'rules_off with the draft drop left on, to show that gate firing on its own',
      controlIs:
        'rules_off: branch code with the pacing read handed a zero-length conversation, the category filter bypassed and the draft drop off. NOT origin/main; renders what main renders for this thread.',
    },
  })

  console.log(`[pacing] arm=${arm} prompt=${PROMPT_VERSION} units=${units}`)
  console.log(`[pacing] venue ${venueSlug} (status=${venue.status})`)
  console.log(`[pacing] guest_states rows before: ${statesBefore}`)
  console.log(`[pacing] run log: ${log.path}\n`)

  const trace = startAgentTrace({
    name: 'question-pacing-replay',
    agentRunId: randomUUID(),
  })
  const baseCtx = await buildRuntimeContext({
    agentRunId: randomUUID(),
    guestId,
    venueId: venue.id,
    trace,
    currentMessage: {
      id: randomUUID(),
      providerMessageId: `pacing-replay-${randomUUID()}`,
      body: fixture.measuredInbound,
      receivedAt: now,
      channel: 'text',
      referralSource: null,
    },
  })

  // Classified ONCE, by production's classifier, and held fixed across units and
  // across arms (the caller runs both arms; the verdict is in each log).
  const classified = await classifyMessage({
    inboundBody: fixture.measuredInbound,
    persona: baseCtx.venue.brandPersona,
    venueInfo: baseCtx.venue.venueInfo,
    recentMessages: history,
  })
  if (!classified.ok) throw new Error(`classifier: ${classified.error}`)
  const category = classified.data.category
  console.log(`[pacing] "${fixture.measuredInbound}" classified ${category}\n`)

  const derived = deriveOpenIntentions({
    now,
    responseRate: 0,
    repliedMessageCount,
    rules: INTENTION_RULES_DEFAULT,
    // No order, no name, no home base: a guest who wrote in for the first time.
    facts: buildSatisfactionFacts({
      hasQualifyingTransaction: false,
      firstName: null,
      homeBase: undefined,
      recordedVisitCount: 0,
      venueHistory: undefined,
    }),
    visitConfirmedAt: null,
    sameVisitOrderAt: null,
    checkbackDueAt: null,
    openRecommendationTimes: [],
    openRecommendationTouchedTimes: [],
    openRecommendationsUnreadable: false,
    recordedOrderTimes: [],
    rows: {
      prompted: [
        {
          intentionKey: fixture.history[nameAskIndex]!.asks!,
          promptedAt: nameAskedAt,
          eligibleAt: nameAskedAt,
          promptSource: 'classified',
          messageId: randomUUID(),
        },
      ],
      eligible: [],
    },
    inboundTimes: [...inbound.map((m) => m.createdAt), now],
    inboundMessages: [
      ...inbound.map((m) => ({ at: m.createdAt, body: m.body })),
      { at: now, body: fixture.measuredInbound },
    ],
    venueHasAnsweredBefore: true,
    conversationWindowMs: arm === 'rules_on' ? CONVERSATION_WINDOW_MS : 0,
    inboundHistoryFrom: new Date(startedAt.getTime() - 14 * MS_PER_DAY),
    isFirstConversation: true,
    quietAfterWarmClose: false,
  })

  const ctx: RuntimeContext = {
    ...baseCtx,
    // Every guest-specific field, not only the ones this turn is about: a real
    // guest's open comp once reached every unit of another harness.
    guest: {
      ...baseCtx.guest,
      firstName: null,
      context: toParsedGuestContext({}, startedAt),
      createdAt: startedAt,
      firstContactedAt: startedAt,
    },
    recentMessages: history,
    recentVisits: [],
    activeCommitments: [],
    retractableReportedVisits: [],
    mechanics: [],
    conversationChannel: 'text',
    openIntentions: derived.open,
    pendingQuestion: null,
    reviewAsk: null,
    visitCheckin: null,
    visitCheckinHold: false,
    firstConversation: true,
    classification: classified.data,
  }

  const rendered =
    arm === 'rules_on'
      ? renderableIntentions(derived.open, category, false, false, false)
      : // The category filter bypassed: a relaxed category stands in, which
        // changes nothing else because this turn is neither an opt-out nor a
        // complaint (asserted just below).
        renderableIntentions(
          derived.open,
          'casual_chatter',
          false,
          false,
          false,
        )
  if (category === 'opt_out' || category === 'comp_complaint')
    throw new Error(
      `the fixture message classified as ${category}; the rules_off arm cannot stand in for it`,
    )
  console.log(
    `[pacing] pacing verdict: ${JSON.stringify(derived.pacing)}\n[pacing] open: [${derived.open.map((o) => o.key).join(', ')}] rendered: [${rendered.map((o) => o.key).join(', ')}]\n`,
  )

  ctx.corpus = await retrieveCorpusStage(ctx)
  ctx.knowledgeCorpus = await retrieveKnowledgeWithContextStage(
    ctx,
    category,
    fixture.measuredInbound,
  )
  const ragChunks: AiVoiceCorpusChunk[] = (ctx.corpus ?? []).map((ch) => ({
    id: ch.id,
    text: ch.text,
    sourceType: ch.sourceType as AiVoiceCorpusChunk['sourceType'],
    relevanceScore: ch.similarity,
  }))
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

  const runtime =
    arm === 'rules_on'
      ? buildAiRuntime(ctx)
      : {
          ...buildAiRuntime(ctx),
          openIntentions:
            rendered.length > 0 ? rendered.map((o) => o.promptLine) : undefined,
          conversationPacedIntentionsOnly: arm === 'draft_drop_only',
        }

  let valid = 0
  let failed = 0
  let withLink = 0
  let bareLink = 0
  let withPacedQuestion = 0
  let draftDropFired = 0
  const attributed = new Map<string, number>()

  for (let u = 0; u < units; u += 1) {
    const unitId = `u${String(u + 1).padStart(2, '0')}`
    const unit: Record<string, unknown> = {
      unitId,
      arm,
      category,
      renderedKeys: rendered.map((o) => o.key),
    }
    try {
      const gen = await generateMessage({
        category,
        persona: ctx.venue.brandPersona,
        venueInfo: ctx.venue.venueInfo,
        ragChunks,
        knowledgeChunks,
        runtime,
        channel: 'text',
      })
      if (!gen.ok) throw new Error(`generation: ${gen.error}`)

      const questions = splitQuestions(gen.data.body)
      let askedKeys: string[] = []
      if (questions.length > 0) {
        const judged = await classifyIntentionPrompts({
          sentBody: questions.join(' '),
          openIntentions: INTENTION_KEYS.map((k) => ({
            key: k,
            description: INTENTION_DEFINITION_BY_KEY[k].classifierDescription,
          })),
        })
        if (!judged.ok) throw new Error(`judge: ${judged.error}`)
        askedKeys = [...judged.data.raisedKeys]
      }
      const pacedKeys = askedKeys.filter(
        (k) =>
          (INTENTION_KEYS as readonly string[]).includes(k) &&
          isConversationPaced(k as (typeof INTENTION_KEYS)[number]),
      )
      const urls = extractUrls(gen.data.body)
      const hasLink = urls.length > 0
      // A reply that is nothing but its link: no letter or digit is left once
      // the links are taken out. Ruled 2026-10-07 as not acceptable.
      const isBareLink =
        hasLink &&
        !/[\p{L}\p{N}]/u.test(
          urls.reduce((rest, url) => rest.split(url).join(''), gen.data.body),
        )

      valid += 1
      if (hasLink) withLink += 1
      if (isBareLink) bareLink += 1
      if (pacedKeys.length > 0) withPacedQuestion += 1
      if (gen.data.intentionQuestionDroppedForTaskDraft) draftDropFired += 1
      for (const k of askedKeys) attributed.set(k, (attributed.get(k) ?? 0) + 1)

      Object.assign(unit, {
        body: gen.data.body,
        intentionQuestion: gen.data.intentionQuestion,
        hasLink,
        isBareLink,
        questions,
        askedKeys,
        pacedKeys,
        droppedForTaskDraft: gen.data.intentionQuestionDroppedForTaskDraft,
        droppedForBodyQuestion:
          gen.data.intentionQuestionDroppedForBodyQuestion,
        error: null,
      })
      console.log(
        `[${unitId}] link=${hasLink ? 'yes' : 'NO'} bare=${isBareLink ? 'YES' : 'no'} paced=[${pacedKeys.join(',')}]\n    -> ${gen.data.body}`,
      )
    } catch (e) {
      // A failed unit is not a result: it is counted apart and never as clean.
      failed += 1
      unit.error = e instanceof Error ? e.message : String(e)
      console.log(`[${unitId}] FAILED ${unit.error}`)
    }
    log.appendUnit(unit)
  }

  const { count: statesAfter } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  console.log(`\n[pacing] guest_states rows after: ${statesAfter}`)
  console.log(
    `[pacing] ==== arm=${arm} prompt=${PROMPT_VERSION} category=${category} units=${units} valid=${valid} failed=${failed}`,
  )
  console.log(
    `[pacing] rendered getting-to-know-you lines : [${rendered
      .filter((o) => isConversationPaced(o.key))
      .map((o) => o.key)
      .join(', ')}]`,
  )
  console.log(
    `[pacing] replies with a getting-to-know-you question : ${withPacedQuestion}/${valid}${arm === 'rules_on' ? ' (bar 0)' : ' (contrast: 0 here means this run shows nothing about the rules)'}`,
  )
  console.log(`[pacing] replies carrying a link : ${withLink}/${valid}`)
  console.log(
    `[pacing] replies that are a bare link : ${bareLink}/${valid}${arm === 'rules_on' ? ' (bar 0)' : ''}`,
  )
  console.log(`[pacing] draft drop fired : ${draftDropFired}/${valid}`)
  for (const [k, n] of [...attributed.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`[pacing]   asked ${k}: ${n}`)
  console.log(`[pacing] run log: ${log.path}`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
