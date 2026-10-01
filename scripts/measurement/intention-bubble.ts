// TAC-554: does a getting-to-know-you question actually go out as its own
// message bubble, sent last?
//
// GENERATE-ONLY. Nothing is sent to a guest and nothing is written, with one
// exception this run reports on itself: buildRuntimeContext calls
// computeGuestState, which persists a guest_states row on a recognition-band
// change. Context is therefore built ONCE PER CHANNEL and cloned per scenario,
// so that write has one opportunity rather than thirty, and the row count is
// printed before and after (the TAC-544 precedent).
//
// TWO RUNS OF THIS FILE, NOT TWO PASSES INSIDE ONE. The change under test
// alters the output SCHEMA as well as the prompt, so an in-process control arm
// is impossible: there is no way to ask one process's GeneratedMessageSchema to
// be two shapes. So the control runs this file on a tree at origin/main and the
// treatment runs it on the branch, compared by scenarioId, exactly as TAC-520
// had to. createRunLog stamps the prompt version and the git sha into each
// file's header, which is what tells the two apart afterwards.
//
// WHY IT CALLS THE REAL generateMessage rather than composePrompt +
// generateObject, which is what most harnesses in this folder do: the
// composition of body + intentionQuestion happens INSIDE generateMessage, at
// the replaceDashes seam, and that composition is the thing under test. A
// harness that composed its own prompt and called generateObject directly
// would measure the model's field population and never touch the mechanism.
// The cost is that the regen loop runs, so a unit can spend up to MAX_ATTEMPTS
// generations; `calls` is reported per unit.
//
// WHAT IS HELD FIXED, and why each is an override rather than live state:
//
//   openIntentions — SET PER SCENARIO, never derived. Two reasons. The arms run
//     minutes apart, and nothing guarantees the same intentions are open in
//     both, which would be a straight confound on the one variable that decides
//     whether the block renders at all. And the ticket's denominator is "20
//     turns that raise learn_name or are_they_local", so the intention has to
//     be the controlled variable. Precedent: ordinary-turn-selection.ts takes
//     openIntentions from a turn's own stored set rather than re-deriving, for
//     the same reason.
//   category — SET PER SCENARIO. Running the real classifier would let the
//     category differ between arms on identical input, and the category decides
//     whether the intentions block renders (renderableIntentions excludes
//     opt_out and comp_complaint).
//   the coin — SEEDED FROM THE scenarioId, so a scenario sees the SAME flip in
//     both arms. resolveDispatchBubbles' 50/50 is what decided the ticket's
//     first failure, so leaving it to Math.random would put arm-sized noise on
//     the exact axis under test. Seeding makes it a controlled variable instead
//     of a source of difference.
//
// The guest is DERIVED per channel rather than pasted as an id, and reported:
// the non-synthetic, non-opted-out guest with NO first_name and the most
// messages. The no-name condition is load-bearing rather than tidy — learn_name
// renders "You don't know this guest's name yet", and against a guest block
// carrying a first name that is a contradiction the model has to resolve, which
// would corrupt every learn_name unit.

import { randomUUID } from 'node:crypto'
import { classifyIntentionPrompts, generateMessage } from '@/lib/ai'
import { MAX_ATTEMPTS } from '@/lib/ai/generate-message'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import type {
  KnowledgeCorpusChunk as AiKnowledgeChunk,
  VoiceCorpusChunk as AiVoiceCorpusChunk,
  MessageCategory,
} from '@/lib/ai'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import { renderableIntentions } from '@/lib/agent/intentions/derive'
import type { OpenIntention } from '@/lib/agent/intentions/derive'
import { INTENTION_DEFINITION_BY_KEY } from '@/lib/agent/intentions/definitions'
import type { IntentionKey } from '@/lib/agent/intentions/definitions'
import {
  resolveDispatchBubbles,
  splitIntoSentences,
} from '@/lib/agent/sentence-split'
import {
  buildAiRuntime,
  retrieveCorpusStage,
  retrieveKnowledgeWithContextStage,
} from '@/lib/agent/stages'
import type { RuntimeContext } from '@/lib/agent/types'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { GeneratedMessageSchema } from '@/lib/ai/generate-message'
import {
  answerRepeatsQuestion,
  scoreUnit,
  type CeilingBreach,
} from './intention-bubble-score'
import { createRunLog } from './run-log'
// TAC-558 extracted this; see seeded-flip.ts for the distribution hazard.
import { seededFlip } from './seeded-flip'

type Arm = 'control' | 'after'
type Channel = 'text' | 'instagram'

const TARGETS = [
  'learn_name',
  'are_they_local',
] as const satisfies readonly IntentionKey[]

/**
 * The guest turns. Each is an ordinary message that leaves the reply finished
 * and so opens one of the doors the restraint paragraph names positively: a
 * question the venue can answer, something the guest said about themselves, or
 * chatting with nothing needed.
 *
 * `intention` rotates so each target lands on a spread of shapes rather than
 * clustering on one — the TAC-544 rotation lesson, where always opening with
 * small talk measured the permitted case five times more often than the others.
 *
 * `none` scenarios carry NO open intention. They are the "turns without an
 * intention are unchanged" criterion, and they are in the same run rather than
 * a separate one so they ride the identical code path.
 */
const SCENARIOS: readonly {
  id: string
  body: string
  category: MessageCategory
  intention: IntentionKey | 'none'
  shape: string
}[] = [
  {
    id: 's01',
    body: 'are you open on sundays?',
    category: 'new_question',
    intention: 'learn_name',
    shape: 'answerable_question',
  },
  {
    id: 's02',
    body: 'what time do you close today',
    category: 'new_question',
    intention: 'are_they_local',
    shape: 'answerable_question',
  },
  {
    id: 's03',
    body: 'just moved to the neighborhood and trying coffee places',
    category: 'reply',
    intention: 'learn_name',
    shape: 'said_something_about_self',
  },
  {
    id: 's04',
    body: 'that cortado was so good',
    category: 'reply',
    intention: 'are_they_local',
    shape: 'chatting_nothing_needed',
  },
  {
    id: 's05',
    body: 'do you have oat milk?',
    category: 'new_question',
    intention: 'learn_name',
    shape: 'answerable_question',
  },
  {
    id: 's06',
    body: 'i work from home so im always looking for somewhere to sit',
    category: 'reply',
    intention: 'are_they_local',
    shape: 'said_something_about_self',
  },
  {
    id: 's07',
    body: 'whats good here',
    category: 'recommendation_request',
    intention: 'learn_name',
    shape: 'recommendation',
  },
  {
    id: 's08',
    body: 'saw your sign outside, cool space',
    category: 'casual_chatter',
    intention: 'are_they_local',
    shape: 'chatting_nothing_needed',
  },
  {
    id: 's09',
    body: 'do you do decaf',
    category: 'new_question',
    intention: 'learn_name',
    shape: 'answerable_question',
  },
  {
    id: 's10',
    body: 'been meaning to come in for weeks',
    category: 'casual_chatter',
    intention: 'are_they_local',
    shape: 'said_something_about_self',
  },
  {
    id: 's11',
    body: 'is there wifi',
    category: 'new_question',
    intention: 'learn_name',
    shape: 'answerable_question',
  },
  {
    id: 's12',
    body: 'my friend told me to try the blossom tonic',
    category: 'reply',
    intention: 'are_they_local',
    shape: 'said_something_about_self',
  },
  {
    id: 's13',
    body: 'what are your hours during the week',
    category: 'new_question',
    intention: 'learn_name',
    shape: 'answerable_question',
  },
  {
    id: 's14',
    body: 'coffee was great today thanks',
    category: 'casual_chatter',
    intention: 'are_they_local',
    shape: 'chatting_nothing_needed',
  },
  {
    id: 's15',
    body: 'do you have any pastries left',
    category: 'new_question',
    intention: 'learn_name',
    shape: 'answerable_question',
  },
  // s16-s21 were added after a first run yielded 17 raising turns against a
  // pre-registered denominator of 20. They deliberately repeat the SAME shape
  // mix as s01-s15 (two answerable questions, two self-disclosures, two
  // chatting turns) rather than the shapes that raised most often in that run.
  // Picking the reliable raisers would grow the denominator by making the
  // fixture easier, which is fitting the evidence to the answer; this grows it
  // by spending more attempts at the same difficulty.
  {
    id: 's16',
    body: 'do you have soy milk too',
    category: 'new_question',
    intention: 'are_they_local',
    shape: 'answerable_question',
  },
  {
    id: 's17',
    body: 'are you open early on weekdays',
    category: 'new_question',
    intention: 'learn_name',
    shape: 'answerable_question',
  },
  {
    id: 's18',
    body: 'i come past here on my way to work every day',
    category: 'reply',
    intention: 'learn_name',
    shape: 'said_something_about_self',
  },
  {
    id: 's19',
    body: 'im new to the city and dont know anywhere yet',
    category: 'reply',
    intention: 'are_they_local',
    shape: 'said_something_about_self',
  },
  {
    id: 's20',
    body: 'this place smells incredible',
    category: 'casual_chatter',
    intention: 'learn_name',
    shape: 'chatting_nothing_needed',
  },
  {
    id: 's21',
    body: 'love the music youre playing',
    category: 'casual_chatter',
    intention: 'are_they_local',
    shape: 'chatting_nothing_needed',
  },
  {
    id: 'n01',
    body: 'what time do you open tomorrow?',
    category: 'new_question',
    intention: 'none',
    shape: 'no_intention_control',
  },
  {
    id: 'n02',
    body: 'do you take card',
    category: 'new_question',
    intention: 'none',
    shape: 'no_intention_control',
  },
  {
    id: 'n03',
    body: 'thanks!',
    category: 'acknowledgment',
    intention: 'none',
    shape: 'no_intention_control',
  },
]

/** Read intentionQuestion without assuming the field exists on this tree. */
function readIntentionQuestion(data: unknown): string {
  const q = (data as { intentionQuestion?: unknown }).intentionQuestion
  return typeof q === 'string' ? q : ''
}

/** Call resolveDispatchBubbles with the tail, on a tree that may ignore it. */
function splitWithTail(body: string, flip: number, tail: string): string[] {
  const fn = resolveDispatchBubbles as unknown as (
    b: string,
    rng: () => number,
    tail?: string,
  ) => string[]
  return fn(body, () => flip, tail)
}

async function judge(
  sentBody: string,
  key: IntentionKey,
): Promise<{ keys: string[]; error: string | null }> {
  if (sentBody.trim() === '') return { keys: [], error: null }
  const res = await classifyIntentionPrompts({
    sentBody,
    openIntentions: [
      {
        key,
        description: INTENTION_DEFINITION_BY_KEY[key].classifierDescription,
      },
    ],
  })
  if (!res.ok) return { keys: [], error: res.error }
  return { keys: [...res.data.raisedKeys], error: null }
}

async function main(): Promise<void> {
  const arm = process.env.MEASURE_ARM as Arm | undefined
  if (arm !== 'control' && arm !== 'after') {
    console.error(
      '✗ set MEASURE_ARM=control or MEASURE_ARM=after. A run log with no arm is unreadable afterwards.',
    )
    process.exit(2)
  }
  const venueSlug = process.env.MEASURE_VENUE ?? 'le-mils-coffee'
  const only = process.env.MEASURE_ONLY ?? ''

  // ARM-INTEGRITY GUARD, before a single call is spent.
  //
  // A mislabelled run is the failure mode that produces exactly the shape of a
  // clean result: TAC-502's replay scored 60 failed calls as "as expected"
  // because nothing checked that the arm was what it claimed. Here the schema
  // itself says which tree this is, so the two can never be confused.
  const schemaKeys = Object.keys(GeneratedMessageSchema.shape)
  const hasField = schemaKeys.includes('intentionQuestion')
  if (arm === 'after' && !hasField) {
    console.error(
      '✗ MEASURE_ARM=after but GeneratedMessageSchema has no `intentionQuestion` field.\n' +
        '  This tree does not carry the change. Run the after arm on the branch.',
    )
    process.exit(1)
  }
  if (arm === 'control' && hasField) {
    console.error(
      '✗ MEASURE_ARM=control but GeneratedMessageSchema HAS `intentionQuestion`.\n' +
        '  This tree carries the change, so it cannot produce a control. Run the control on a tree at origin/main.',
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

  // DERIVE one guest per channel. See the header for why first_name must be null.
  const { data: candidates } = await db
    .from('guests')
    .select('id, first_name, phone_number, instagram_scoped_id, opted_out_at')
    .eq('venue_id', venue.id)
    .is('first_name', null)
    .is('opted_out_at', null)

  const guestFor: Record<Channel, { id: string; messages: number } | null> = {
    text: null,
    instagram: null,
  }
  for (const g of candidates ?? []) {
    const ch: Channel = g.phone_number ? 'text' : 'instagram'
    const { count } = await db
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('guest_id', g.id)
    const n = count ?? 0
    if ((guestFor[ch]?.messages ?? -1) < n)
      guestFor[ch] = { id: g.id, messages: n }
  }
  if (!guestFor.text || !guestFor.instagram) {
    throw new Error(
      `need one nameless, non-opted-out guest per channel at ${venueSlug}; got text=${guestFor.text?.id ?? 'none'} instagram=${guestFor.instagram?.id ?? 'none'}`,
    )
  }

  const startedAt = new Date()
  const log = createRunLog({
    name: `tac554-intention-bubble-${arm}`,
    meta: {
      arm,
      promptVersion: PROMPT_VERSION,
      schemaHasIntentionQuestion: hasField,
      venue: venueSlug,
      venueStatus: venue.status,
      guests: {
        text: guestFor.text,
        instagram: guestFor.instagram,
      },
      scenarios: SCENARIOS.length,
      targets: TARGETS,
      statesBefore,
      maxAttempts: MAX_ATTEMPTS,
      // Everything the arms hold fixed, frozen into the file so a reader does
      // not have to trust the prose above.
      heldFixed: ['openIntentions', 'category', 'coin(seeded from scenarioId)'],
    },
  })

  console.log(
    `[tac554] arm=${arm} schemaHasField=${hasField} prompt=${PROMPT_VERSION}`,
  )
  console.log(`[tac554] venue ${venueSlug} (status=${venue.status})`)
  console.log(
    `[tac554] guest text=${guestFor.text.id.slice(0, 8)} (${guestFor.text.messages} msgs), instagram=${guestFor.instagram.id.slice(0, 8)} (${guestFor.instagram.messages} msgs)`,
  )
  console.log(`[tac554] guest_states rows before: ${statesBefore}`)
  console.log(`[tac554] run log: ${log.path}\n`)

  const trace = startAgentTrace({
    name: 'tac554-measure',
    agentRunId: randomUUID(),
  })

  type Row = {
    scenarioId: string
    channel: Channel
    intention: IntentionKey | 'none'
    shape: string
    category: MessageCategory
    inbound: string
    flip: number
    body: string
    intentionQuestion: string
    bubbles: string[]
    bubbleCount: number
    /**
     * Sentences splitIntoSentences finds in the ANSWER portion. Recorded
     * because it is the structural fact behind a control failure: TAC-319 only
     * ever splits a body of 2 to MAX_BUBBLES_PER_RESPONSE sentences, so a
     * control unit outside that range could not have separated the question at
     * any coin value, and one inside it merely lost a coin. Free — no extra
     * model call — and it is what stops a reader treating the two as the same
     * kind of failure.
     */
    answerSentences: number
    renderedBlock: boolean
    raised: boolean
    separateLastBubble: boolean
    breaches: CeilingBreach[]
    pass: boolean
    judgeWhole: string[]
    judgeLast: string[]
    judgeEarlier: string[]
    /** A duplicate SURVIVED the guard. Should always be false. */
    duplicateInAnswer: boolean
    /** The guard FIRED and edited the answer. Reported, not silent. */
    duplicateGuardFired: boolean
    calls: number
    /** Non-null makes this unit INVALID: it can meet no expectation. */
    error: string | null
  }

  const rows: Row[] = []

  for (const channel of ['text', 'instagram'] as const) {
    const guestId = guestFor[channel]!.id
    // ONE context build per channel; cloned per scenario below.
    const baseCtx = await buildRuntimeContext({
      agentRunId: randomUUID(),
      guestId,
      venueId: venue.id,
      trace,
      currentMessage: {
        id: randomUUID(),
        providerMessageId: `tac554-probe-${randomUUID()}`,
        body: SCENARIOS[0]!.body,
        receivedAt: startedAt,
        channel,
        referralSource: null,
      },
    })

    for (const scenario of SCENARIOS) {
      if (only !== '' && scenario.id !== only) continue

      const open: OpenIntention[] =
        scenario.intention === 'none'
          ? []
          : [
              {
                key: scenario.intention,
                promptLine:
                  INTENTION_DEFINITION_BY_KEY[scenario.intention].promptLine,
                eligibleAt: new Date(
                  startedAt.getTime() - 7 * 24 * 60 * 60 * 1000,
                ),
              },
            ]

      const ctx: RuntimeContext = {
        ...baseCtx,
        recentMessages: [...baseCtx.recentMessages],
        conversationChannel: channel,
        openIntentions: open,
        pendingQuestion: null,
        currentMessage: {
          ...baseCtx.currentMessage!,
          id: randomUUID(),
          body: scenario.body,
          channel,
        },
        classification: {
          category: scenario.category,
          classifierConfidence: 1,
          reasoning: 'tac554 measurement: category held fixed across arms',
          crisisSafety: false,
          correctsPendingReply: false,
          followUpWorthy: false,
        },
      }

      const row: Row = {
        scenarioId: scenario.id,
        channel,
        intention: scenario.intention,
        shape: scenario.shape,
        category: scenario.category,
        inbound: scenario.body,
        flip: seededFlip(scenario.id),
        body: '',
        intentionQuestion: '',
        bubbles: [],
        bubbleCount: 0,
        answerSentences: 0,
        renderedBlock: false,
        raised: false,
        separateLastBubble: false,
        breaches: [],
        pass: false,
        judgeWhole: [],
        judgeLast: [],
        judgeEarlier: [],
        duplicateInAnswer: false,
        duplicateGuardFired: false,
        calls: 0,
        error: null,
      }

      try {
        ctx.corpus = await retrieveCorpusStage(ctx)
        ctx.knowledgeCorpus = await retrieveKnowledgeWithContextStage(
          ctx,
          scenario.category,
          scenario.body,
        )

        const ragChunks: AiVoiceCorpusChunk[] = (ctx.corpus ?? []).map((c) => ({
          id: c.id,
          text: c.text,
          sourceType: c.sourceType as AiVoiceCorpusChunk['sourceType'],
          relevanceScore: c.similarity,
        }))
        const knowledgeChunks: AiKnowledgeChunk[] | undefined =
          ctx.knowledgeCorpus === null
            ? undefined
            : ctx.knowledgeCorpus.map((c) => ({
                id: c.id,
                text: c.text,
                sourceType: c.sourceType,
                primaryTags: c.primaryTags,
                secondaryTags: c.secondaryTags,
                relevanceScore: c.similarity,
              }))

        // The rendered set, from production's own predicate — this is exactly
        // what handle-inbound passes to dispatch as renderedIntentions, so the
        // gate under test is the real one.
        const rendered = renderableIntentions(
          ctx.openIntentions,
          ctx.classification?.category ?? null,
          ctx.pendingQuestion !== null,
        )
        row.renderedBlock = rendered.length > 0

        const gen = await generateMessage({
          category: scenario.category,
          persona: ctx.venue.brandPersona,
          venueInfo: ctx.venue.venueInfo,
          ragChunks,
          knowledgeChunks,
          runtime: buildAiRuntime(ctx),
          channel,
        })
        if (!gen.ok) {
          row.error = `generation: ${gen.error}`
        } else {
          row.calls = gen.data.attempts
          row.body = gen.data.body
          // The tail only ever reaches dispatch when the block rendered — the
          // same gate handle-inbound applies. A question emitted on a turn
          // where nothing rendered is folded into the body, never bubbled.
          const tail = row.renderedBlock ? readIntentionQuestion(gen.data) : ''
          row.intentionQuestion = tail
          row.bubbles = splitWithTail(row.body, row.flip, tail)
          row.bubbleCount = row.bubbles.length

          const answer =
            tail === ''
              ? row.body
              : row.body.slice(0, row.body.length - tail.length)
          row.answerSentences = splitIntoSentences(answer).length
          // An INDEPENDENT second opinion on the duplicate guard. The guard
          // itself reports that it fired (duplicateGuardFired, read off the
          // result); this asks whether a duplicate SURVIVED it. The two can
          // disagree, which is the point — a guard checked only by itself is
          // the shape this repo keeps paying for.
          row.duplicateInAnswer = answerRepeatsQuestion(answer, tail)
          row.duplicateGuardFired =
            (gen.data as { intentionQuestionDuplicateStripped?: boolean })
              .intentionQuestionDuplicateStripped === true

          const key: IntentionKey =
            scenario.intention === 'none' ? 'learn_name' : scenario.intention
          const last = row.bubbles[row.bubbles.length - 1] ?? ''
          const earlier = row.bubbles.slice(0, -1).join(' ')

          const [jWhole, jLast, jEarlier] = await Promise.all([
            judge(row.body, key),
            judge(last, key),
            judge(earlier, key),
          ])
          const judgeError = jWhole.error ?? jLast.error ?? jEarlier.error
          if (judgeError !== null) {
            row.error = `judge: ${judgeError}`
          } else {
            row.judgeWhole = jWhole.keys
            row.judgeLast = jLast.keys
            row.judgeEarlier = jEarlier.keys
            const verdict = scoreUnit({
              bubbles: row.bubbles,
              intentionQuestion: tail,
              judge: {
                whole: jWhole.keys,
                last: jLast.keys,
                earlier: jEarlier.keys,
              },
            })
            row.raised = verdict.raised
            row.separateLastBubble = verdict.separateLastBubble
            row.breaches = verdict.breaches
            row.pass = verdict.pass
          }
        }
      } catch (e) {
        row.error = e instanceof Error ? e.message : String(e)
      }

      rows.push(row)
      log.appendUnit(row)
      const mark =
        row.error !== null
          ? 'INVALID'
          : row.pass
            ? 'pass'
            : row.raised
              ? 'FAIL'
              : 'not-raised'
      console.log(
        `  ${channel.padEnd(9)} ${row.scenarioId} ${String(row.intention).padEnd(15)} bubbles=${row.bubbleCount} ${mark}${row.breaches.length > 0 ? ` breach=${row.breaches.join(',')}` : ''}${row.error ? ` (${row.error})` : ''}`,
      )
    }
  }

  const { count: statesAfter } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  const invalid = rows.filter((r) => r.error !== null)
  const valid = rows.filter((r) => r.error === null)
  const targeted = valid.filter((r) => r.intention !== 'none')
  const raised = targeted.filter((r) => r.raised)
  const passed = raised.filter((r) => r.pass)
  const noIntention = valid.filter((r) => r.intention === 'none')

  console.log(`\n${'='.repeat(72)}`)
  console.log(
    `ARM: ${arm}   prompt ${PROMPT_VERSION}   schema field: ${hasField}`,
  )
  console.log(`${'='.repeat(72)}`)
  console.log(
    `units: ${rows.length}   INVALID (errored, meet no expectation): ${invalid.length}`,
  )
  console.log(
    `targeted units: ${targeted.length}   of which raised an intention: ${raised.length}`,
  )
  console.log(
    `\nBAR — the question is its own bubble, sent last: ${passed.length}/${raised.length}`,
  )

  // Why a failure failed. On the control arm these are different kinds of
  // thing and collapsing them would overstate what a coin could ever fix.
  const failures = raised.filter((r) => !r.pass)
  const couldNeverSplit = failures.filter(
    (r) => r.answerSentences < 2 || r.answerSentences > 3,
  )
  console.log(
    `  of ${failures.length} failures: ${couldNeverSplit.length} had an answer outside the 2-3 sentence range,\n` +
      `  so TAC-319 could not have split them at ANY coin value; the other ${failures.length - couldNeverSplit.length} lost the coin.`,
  )

  const breached = valid.filter((r) => r.breaches.length > 0)
  const dupes = valid.filter((r) => r.duplicateInAnswer)
  const bubbledWithoutBlock = noIntention.filter(
    (r) => r.bubbleCount > 1 && r.intentionQuestion !== '',
  )

  console.log(`\nCEILINGS`)
  console.log(
    `  bubbles over the cap / empty / contentless / tail-not-last: ${breached.length}`,
  )
  for (const r of breached)
    console.log(`    ${r.channel} ${r.scenarioId}: ${r.breaches.join(', ')}`)
  console.log(`  a duplicate SURVIVED the guard (must be 0): ${dupes.length}`)
  for (const r of dupes) console.log(`    ${r.channel} ${r.scenarioId}`)
  const guardFired = valid.filter((r) => r.duplicateGuardFired)
  console.log(
    `  duplicate guard FIRED and edited the answer: ${guardFired.length}`,
  )
  for (const r of guardFired) console.log(`    ${r.channel} ${r.scenarioId}`)
  console.log(
    `  separate bubble on a turn with no rendered intention: ${bubbledWithoutBlock.length}`,
  )

  console.log(`\nno-intention control units: ${noIntention.length}`)
  for (const r of noIntention) {
    console.log(
      `  ${r.channel.padEnd(9)} ${r.scenarioId} bubbles=${r.bubbleCount} field="${r.intentionQuestion}"`,
    )
  }

  console.log(
    `\nguest_states rows: ${statesBefore} before, ${statesAfter} after`,
  )
  if (statesBefore !== statesAfter) {
    console.log(
      `  NOTE: the count moved. buildRuntimeContext runs computeGuestState, which persists a row on a band change.`,
    )
  }

  console.log(`\n${'='.repeat(72)}`)
  console.log(
    'VERBATIM BODIES — read these. A rate cannot tell a clean split from',
  )
  console.log(
    'one that cut the answer short, and "the answer bubble still reads',
  )
  console.log('complete" is a judgement, not a count.')
  console.log(`${'='.repeat(72)}`)
  for (const r of valid) {
    console.log(
      `\n--- ${r.channel} ${r.scenarioId} [${r.intention}] flip=${r.flip.toFixed(3)}`,
    )
    console.log(`    guest: ${r.inbound}`)
    r.bubbles.forEach((b, i) =>
      console.log(`    bubble ${i + 1}: ${JSON.stringify(b)}`),
    )
    if (r.intentionQuestion !== '')
      console.log(`    field:    ${JSON.stringify(r.intentionQuestion)}`)
    console.log(
      `    judge: whole=[${r.judgeWhole}] last=[${r.judgeLast}] earlier=[${r.judgeEarlier}]`,
    )
  }

  console.log(`\nrun log: ${log.path}`)
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
