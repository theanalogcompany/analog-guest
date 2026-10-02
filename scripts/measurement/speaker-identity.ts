// TAC-541: does a guest-facing reply still name a person as the speaker, and
// is the name ask still bare? Generate-only. NOTHING IS SENT AND NOTHING IS
// WRITTEN.
//
// ONE WRITE IS POSSIBLE and it is not this script's, stated rather than
// claimed away because "writes nothing" is the kind of sentence that stops
// being true without anyone noticing: buildRuntimeContext runs
// computeGuestState, which persists a `guest_states` row when a guest's
// recognition band actually changes. It does not fire for a guest whose band
// is stable. The run reports the row count before and after.
//
// THREE POPULATIONS, run against Le Mil's live persona and a real guest. They
// are populations and not ARMS: there is no before/after here, because the
// ticket's claim is absolute ("zero self-introductions by name") rather than
// comparative. A bar of 0 needs no control to be meaningful.
//
//   opener    the synthesised first-touch turn, which is where the defect was
//             seen. Synthesised for the reason the TAC-423 harness documents:
//             firstTouchAfterQrScan needs a guest's true first message and
//             every scanned guest at Le Mil's already has history. Creating a
//             guest row would be a write.
//   name-ask  a real guest with real history, openIntentions forced to
//             learn_name alone, which is the configuration ruling 3 shapes.
//   why-turn  the guest has just been asked and replies "why?". learn_name is
//             ABSENT from openIntentions, which is production-faithful: it
//             closes the moment it is raised, so its line does not render on
//             this turn. That is exactly why R37 is a universal rule and not
//             part of the intention, and this population is the only evidence
//             the rule does anything.
//
// BARS AND CEILINGS ARE PRE-REGISTERED, in EXPECTATION below, and EVALUATED IN
// CODE. A ceiling breach fails its population whatever the rate: a rate
// answers "did the change work", a ceiling answers "did it break something
// while working", and only the second catches a change that improves the
// number being watched by doing the thing it was meant to prevent.
//
// A FAILED CALL IS NOT A RESULT. An errored generation produces no verdict, so
// counting it in the denominator scores it as a clean one and a wholly broken
// run reports as a pass. Failures are excluded from the denominator and
// reported per population; a population with any failure cannot meet a bar
// whose form is "every rep".
//
// WHAT THIS IS NOT. It replicates generateMessage's single model call (same
// model, same system prompt plus the fidelity instruction, same schema, same
// token cap) but NOT its regeneration loop or its fidelity floor. Nothing in
// that loop fires on a name or a question, so it does not decide these
// metrics. The why-turn population additionally runs the REAL grounding
// verifier, because "so we remember you next time" is a claim about the venue
// that is in no knowledge chunk, and whether it gets held is worth knowing
// here rather than on a device.
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
} from '@/lib/ai/generate-message'
import { getGenerationModel } from '@/lib/ai/client'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { INTENTION_DEFINITION_BY_KEY } from '@/lib/agent/intentions/definitions'
import type { RecentMessage } from '@/lib/agent/types'
import { classifyIntentionPrompts } from '@/lib/ai/classify-intention-prompts'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { createRunLog } from './run-log'
import { classifySpeakerIdentity } from './speaker-identity-language'
import { classifyFirstTouchReply } from './first-touch-question-detector'

type Population = 'opener' | 'name-ask' | 'why-turn'
const POPULATIONS: readonly Population[] = ['opener', 'name-ask', 'why-turn']

/**
 * PRE-REGISTERED, and a total map so a fourth population has to state its own
 * bars rather than inherit silence.
 */
const EXPECTATION = {
  opener: {
    bars: ['namedSelfIntro must be 0 for every rep'],
    ceilings: ["no rep may ask the guest's name INSTEAD of the order"],
  },
  'name-ask': {
    bars: [
      'namedSelfIntro must be 0 for every rep',
      'bareNameAsk must be 0 among replies that raised the intention',
    ],
    ceilings: ['no rep may carry more than one question'],
  },
  'why-turn': {
    bars: [
      'namedSelfIntro must be 0 for every rep',
      'whatToCallYouReason on at least 18 of 20',
    ],
    findings: ['any rep promising recognition, the reason cut on 2026-09-26'],
    ceilings: [],
  },
} as const satisfies Record<
  Population,
  {
    bars: readonly string[]
    ceilings: readonly string[]
    findings?: readonly string[]
  }
>

const WHY_TURN_REASON_FLOOR_RATIO = 0.9

/**
 * THE CONTROL ARM for the name-ask population, added after the first run.
 *
 * The pre-registered bar was absolute ("0 bare asks"), which needs no control
 * to be meaningful. It breached at a low rate, and a low rate with nothing to
 * compare it to is close to uninterpretable: it cannot distinguish "the
 * shaping barely helped" from "the shaping did most of the work and this is
 * what is left". So the shipped promptLine is swapped for the one it replaced,
 * changing EXACTLY ONE VARIABLE, and the two are run side by side.
 *
 * Derived from the shipped line rather than transcribed, so it cannot drift:
 * the control is the shipped line's FIRST SENTENCE, which is what the line was
 * before TAC-541 added the shape to it.
 */
function preTac541NameLine(shipped: string): string {
  const first = shipped.split('. ')[0]
  if (first === undefined || !shipped.startsWith(`${first}. Asked at all,`)) {
    throw new Error(
      `learn_name's promptLine no longer has the shape this control derives from (${JSON.stringify(shipped)}). Fix the harness before trusting a run.`,
    )
  }
  return `${first}.`
}

interface Args {
  venue: string
  reps: number
  populations: Population[]
  /** name-ask only: run against the pre-TAC-541 line instead of the shipped one. */
  control: boolean
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = {
    venue: 'le-mils-coffee',
    reps: 20,
    populations: [...POPULATIONS],
    control: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--venue') out.venue = argv[++i] ?? out.venue
    else if (argv[i] === '--reps') out.reps = Number(argv[++i])
    else if (argv[i] === '--control') out.control = true
    else if (argv[i] === '--populations') {
      const picked = (argv[++i] ?? '')
        .split(',')
        .filter(Boolean) as Population[]
      if (picked.length > 0) out.populations = picked
    }
  }
  return out
}

interface Prepared {
  composed: ReturnType<typeof composePrompt>
  offeredForClassifier: { key: string; description: string }[]
  category: string
  venueInfo: unknown
  knowledgeChunks: unknown[]
  conversationChannel: 'text' | 'instagram' | null
  runtimeContext: string
}

async function finishPrepare(
  ctx: Awaited<ReturnType<typeof buildRuntimeContext>>,
  inboundBody: string,
): Promise<Prepared> {
  const classification = await classifyStage(ctx)
  ctx.classification = classification
  ctx.corpus = await retrieveCorpusStage(ctx)
  ctx.knowledgeCorpus = shouldRetrieveKnowledge(ctx)
    ? await retrieveKnowledgeStage(ctx, classification.category, inboundBody)
    : []

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

  return {
    composed,
    offeredForClassifier,
    category: classification.category,
    venueInfo: ctx.venue.venueInfo,
    knowledgeChunks: ctx.knowledgeCorpus ?? [],
    conversationChannel: ctx.conversationChannel,
    runtimeContext: composed.userPrompt,
  }
}

async function generate(prepared: Prepared): Promise<string> {
  const result = await generateObject({
    model: getGenerationModel(),
    schema: GeneratedMessageSchema,
    system: prepared.composed.systemPrompt,
    messages: [
      ...prepared.composed.historyTurns,
      { role: 'user', content: prepared.composed.userPrompt },
    ],
    temperature: 0.7,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  })
  return result.object.body
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const db = createAdminClient()

  const { data: venue, error: venueError } = await db
    .from('venues')
    .select('id, slug')
    .eq('slug', args.venue)
    .single()
  if (venueError || !venue) throw new Error(`venue ${args.venue} not found`)

  // The roster the detector matches self-introductions against, read from the
  // venue's own venue_info rather than hardcoded, so a new barista is covered.
  const { data: cfg } = await db
    .from('venue_configs')
    .select('venue_info, brand_persona')
    .eq('venue_id', venue.id)
    .single()
  const info = (cfg?.venue_info ?? {}) as { staff?: string[] }
  const persona = (cfg?.brand_persona ?? {}) as {
    speakerFraming?: string
    speakerName?: string
  }
  const personNames = [
    ...(info.staff ?? []).map(
      (line) => (line.split(/[—–-]/)[0] ?? '').trim().split(/\s+/)[0] ?? '',
    ),
    'Himanshu',
    'Milana',
  ].filter((n) => n.length > 2)
  const venueNames = ["Le Mil's", 'Le Mils', 'LeMils']

  // A guest WITH NO FIRST NAME ON RECORD, and the filter is load-bearing.
  //
  // The first smoke run picked the newest guest, who has first_name "Jaipal".
  // The prompt then carried "You don't know this guest's name yet" AND
  // "Guest name: Jaipal" at once, the model correctly declined to ask, and the
  // name-ask population measured 0 raised against a turn where asking would
  // have been absurd. The fixture could not reach the behaviour it exists to
  // measure, which is this repo's signature failure.
  //
  // It also matters for why-turn: a guest whose name is already known is not
  // one who was just asked for it.
  const { data: guests } = await db
    .from('guests')
    .select('id, phone_number, instagram_scoped_id, first_name')
    .eq('venue_id', venue.id)
    .is('first_name', null)
    .order('created_at', { ascending: false })
    .limit(20)
  const guest = (guests ?? [])[0]
  if (!guest) {
    throw new Error(
      'no guest at this venue without a first_name. Every population needs one: ' +
        'learn_name is satisfied for a named guest, so the prompt would contradict itself ' +
        'and the run would measure a turn that cannot happen.',
    )
  }
  const channel: 'text' | 'instagram' = guest.phone_number
    ? 'text'
    : 'instagram'

  const { count: statesBefore } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })
    .eq('venue_id', venue.id)

  const log = createRunLog({
    name: 'tac541-speaker-identity',
    meta: {
      arm: args.control ? 'control-pre-tac541-name-line' : 'shipped',
      ticket: 'TAC-541',
      promptVersion: PROMPT_VERSION,
      venue: args.venue,
      reps: args.reps,
      speakerFraming: persona.speakerFraming ?? null,
      speakerName: persona.speakerName ?? null,
      personNames,
      expectation: EXPECTATION,
      whyTurnReasonFloorRatio: WHY_TURN_REASON_FLOOR_RATIO,
      guestStatesRowsBefore: statesBefore ?? null,
    },
  })

  console.log(
    `[tac541] venue=${args.venue} channel=${channel} reps=${args.reps} arm=${args.control ? 'CONTROL (pre-TAC-541 name line)' : 'shipped'}`,
  )
  console.log(
    `[tac541] persona: speakerFraming=${persona.speakerFraming} speakerName=${persona.speakerName ?? '(none)'}`,
  )
  console.log(`[tac541] guest_states rows before: ${statesBefore}`)
  console.log(`[tac541] roster for the detector: ${personNames.join(', ')}`)
  console.log(`[tac541] run log: ${log.path}\n`)

  const results: Record<
    string,
    {
      n: number
      failed: number
      namedSelfIntro: number
      asksName: number
      bareNameAsk: number
      usesByTheWay: number
      raised: number
      judgeFailed: number
      whatToCallYouReason: number
      overPromisesRecognition: number
      namesVenue: number
      asksOrder: number
      twoQuestions: number
      nameInsteadOfOrder: number
    }
  > = {}

  const blank = () => ({
    n: 0,
    failed: 0,
    namedSelfIntro: 0,
    asksName: 0,
    bareNameAsk: 0,
    usesByTheWay: 0,
    raised: 0,
    judgeFailed: 0,
    whatToCallYouReason: 0,
    overPromisesRecognition: 0,
    namesVenue: 0,
    asksOrder: 0,
    twoQuestions: 0,
    nameInsteadOfOrder: 0,
  })

  for (const population of args.populations) {
    const cell = blank()
    results[population] = cell

    for (let rep = 0; rep < args.reps; rep += 1) {
      const trace = startAgentTrace({
        agentRunId: randomUUID(),
        name: 'tac541',
      } as never)
      try {
        const now = new Date()
        let inbound: string
        let prepared: Prepared

        if (population === 'opener') {
          inbound = "Hi Le Mil's!"
          const ctx = await buildRuntimeContext({
            agentRunId: randomUUID(),
            guestId: guest.id,
            venueId: venue.id,
            trace,
            currentMessage: {
              id: randomUUID(),
              providerMessageId: `tac541-opener-${rep}`,
              body: inbound,
              receivedAt: now,
              channel,
              referralSource: null,
            },
          })
          // The same four overrides the TAC-423 harness makes, for the same
          // reason: this turn cannot be found in production.
          ctx.guest.createdVia = 'qr_scan'
          ctx.guest.createdAt = now
          ctx.recentMessages = []
          ctx.recentVisits = []
          ctx.activeCommitments = []
          ctx.openIntentions = (
            ['understand_order', 'learn_name'] as const
          ).map((key) => ({
            key,
            promptLine: INTENTION_DEFINITION_BY_KEY[key].promptLine,
            eligibleAt: now,
          }))
          prepared = await finishPrepare(ctx, inbound)
        } else if (population === 'name-ask') {
          inbound = 'it was thick i ended up mixing it into the drink'
          const ctx = await buildRuntimeContext({
            agentRunId: randomUUID(),
            guestId: guest.id,
            venueId: venue.id,
            trace,
            currentMessage: {
              id: randomUUID(),
              providerMessageId: `tac541-name-${rep}`,
              body: inbound,
              receivedAt: now,
              channel,
              referralSource: null,
            },
          })
          // THE HISTORY IS NOT DECORATION. Without it the second smoke run
          // produced "sorry, we're a little lost, which drink are you talking
          // about?" twice: a bare "it was thick i ended up mixing it into the
          // drink" refers to nothing, so the turn is a confusion rather than
          // the finished exchange the restraint paragraph names as an opening.
          // A turn where the reply cannot feel finished cannot raise anything,
          // so the population would have measured 0 raised and read as a pass.
          //
          // This is the device thread of 2026-09-26, one turn before the ask.
          const nameAskHistory: RecentMessage[] = [
            {
              direction: 'inbound',
              body: 'got the blossom tonic',
              createdAt: new Date(now.getTime() - 6e5),
              delivery: 'delivered',
            },
            {
              direction: 'outbound',
              body: 'good choice. what did you think of the foam?',
              createdAt: new Date(now.getTime() - 5e5),
              delivery: 'delivered',
            },
          ]
          ctx.recentMessages = nameAskHistory
          // learn_name ALONE. That is the configuration ruling 3 shapes, and
          // forcing it is what makes the population measure the shaping rather
          // than how often the intention happens to be open.
          const shippedLine = INTENTION_DEFINITION_BY_KEY.learn_name.promptLine
          ctx.openIntentions = [
            {
              key: 'learn_name',
              promptLine: args.control
                ? preTac541NameLine(shippedLine)
                : shippedLine,
              eligibleAt: now,
            },
          ]
          prepared = await finishPrepare(ctx, inbound)
        } else {
          inbound = 'why?'
          const ctx = await buildRuntimeContext({
            agentRunId: randomUUID(),
            guestId: guest.id,
            venueId: venue.id,
            trace,
            currentMessage: {
              id: randomUUID(),
              providerMessageId: `tac541-why-${rep}`,
              body: inbound,
              receivedAt: now,
              channel,
              referralSource: null,
            },
          })
          // The agent asked on the previous turn, so the history carries the
          // ask and learn_name is CLOSED. Production-faithful, and the whole
          // reason R37 cannot live on the intention.
          const whyHistory: RecentMessage[] = [
            {
              direction: 'inbound',
              body: 'got the blossom tonic',
              createdAt: new Date(now.getTime() - 9e5),
              delivery: 'delivered',
            },
            {
              direction: 'outbound',
              body: 'good choice. what did you think of the foam?',
              createdAt: new Date(now.getTime() - 8e5),
              delivery: 'delivered',
            },
            {
              direction: 'inbound',
              body: 'it was thick i ended up mixing it into the drink',
              createdAt: new Date(now.getTime() - 7e5),
              delivery: 'delivered',
            },
            {
              direction: 'outbound',
              body: "ha, yeah that foam is basically a topping. by the way, what's your name?",
              createdAt: new Date(now.getTime() - 6e5),
              delivery: 'delivered',
            },
          ]
          ctx.recentMessages = whyHistory
          ctx.openIntentions = []
          prepared = await finishPrepare(ctx, inbound)
        }

        const body = await generate(prepared)
        const v = classifySpeakerIdentity(body, { personNames, venueNames })
        const ft = classifyFirstTouchReply(body)

        cell.n += 1
        if (v.namedSelfIntro) cell.namedSelfIntro += 1
        if (v.asksName) cell.asksName += 1
        if (v.usesByTheWay) cell.usesByTheWay += 1
        if (v.namesVenue) cell.namesVenue += 1
        if (v.whatToCallYouReason) cell.whatToCallYouReason += 1
        if (v.overPromisesRecognition) cell.overPromisesRecognition += 1
        if (ft.isOrderQuestion) cell.asksOrder += 1
        if (v.questionCount > 1) cell.twoQuestions += 1
        if (population === 'opener' && v.asksName && !ft.isOrderQuestion)
          cell.nameInsteadOfOrder += 1

        // The judge is production's own classifier, never a regex: the
        // detector-asymmetry trap has bitten this family of harness twice.
        let raised: string[] | null = null
        if (population === 'name-ask') {
          const judged = await classifyIntentionPrompts({
            sentBody: body,
            openIntentions: prepared.offeredForClassifier,
          } as Parameters<typeof classifyIntentionPrompts>[0])
          if (judged.ok) {
            raised = judged.data.raisedKeys
            if (raised.includes('learn_name')) {
              cell.raised += 1
              if (v.bareNameAsk) cell.bareNameAsk += 1
            }
          } else {
            cell.judgeFailed += 1
          }
        }

        log.appendUnit({
          population,
          rep,
          category: prepared.category,
          inbound,
          body,
          namedSelfIntro: v.namedSelfIntro,
          namedSelfIntroMatch: v.namedSelfIntroMatch,
          asksName: v.asksName,
          bareNameAsk: v.bareNameAsk,
          nameAskSentence: v.nameAskSentence,
          usesByTheWay: v.usesByTheWay,
          whatToCallYouReason: v.whatToCallYouReason,
          whatToCallYouReasonMatch: v.whatToCallYouReasonMatch,
          overPromisesRecognition: v.overPromisesRecognition,
          overPromisesRecognitionMatch: v.overPromisesRecognitionMatch,
          namesVenue: v.namesVenue,
          questionCount: v.questionCount,
          asksOrder: ft.isOrderQuestion,
          raised,
        })
        console.log(
          `  [${population} ${rep + 1}/${args.reps}] ${JSON.stringify(body)}`,
        )
      } catch (e) {
        cell.failed += 1
        log.appendUnit({ population, rep, failed: true, error: String(e) })
        console.log(
          `  [${population} ${rep + 1}/${args.reps}] FAILED: ${String(e).slice(0, 160)}`,
        )
      } finally {
        await trace.flushAsync()
      }
    }
  }

  const { count: statesAfter } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })
    .eq('venue_id', venue.id)

  console.log('\n================ RESULTS ================')
  console.log(`guest_states rows: before ${statesBefore}, after ${statesAfter}`)
  let anyBreach = false
  for (const population of args.populations) {
    const c = results[population]
    if (!c) continue
    console.log(`\n--- ${population} (n=${c.n}, failed=${c.failed}) ---`)
    console.log(`  namedSelfIntro     ${c.namedSelfIntro}/${c.n}`)
    console.log(`  namesVenue         ${c.namesVenue}/${c.n}`)
    console.log(`  asksName           ${c.asksName}/${c.n}`)
    console.log(`  asksOrder          ${c.asksOrder}/${c.n}`)
    console.log(`  questionCount>1    ${c.twoQuestions}/${c.n}`)
    if (population === 'name-ask') {
      console.log(
        `  raised (judge)     ${c.raised}/${c.n}  (judge failed ${c.judgeFailed})`,
      )
      console.log(`  bareNameAsk        ${c.bareNameAsk}/${c.raised} of raised`)
      console.log(`  usesByTheWay       ${c.usesByTheWay}/${c.n}`)
    }
    if (population === 'why-turn') {
      console.log(`  whatToCallYou      ${c.whatToCallYouReason}/${c.n}`)
      console.log(`  overPromises (cut) ${c.overPromisesRecognition}/${c.n}`)
    }

    // EVALUATED IN CODE, not left to whoever reads the output.
    const verdicts: string[] = []
    const strict = c.failed === 0 && c.n === args.reps
    if (c.namedSelfIntro > 0)
      verdicts.push(`FAIL bar: namedSelfIntro ${c.namedSelfIntro} > 0`)
    else if (!strict)
      verdicts.push('INCONCLUSIVE: a unit failed, so "every rep" cannot be met')
    else verdicts.push('PASS bar: namedSelfIntro 0')

    if (population === 'opener') {
      verdicts.push(
        c.nameInsteadOfOrder > 0
          ? `FAIL ceiling: ${c.nameInsteadOfOrder} rep(s) asked the name instead of the order`
          : 'PASS ceiling: no rep asked the name instead of the order',
      )
    }
    if (population === 'name-ask') {
      // A ZERO-RAISED POPULATION IS INCONCLUSIVE, NEVER A PASS. "0 bare asks
      // among 0 raised" is vacuously true and is exactly the shape a broken
      // fixture produces, which the second smoke run demonstrated. The bar is
      // about the SHAPE of the ask, so it needs asks to judge.
      if (c.raised === 0) {
        verdicts.push(
          'INCONCLUSIVE: nothing raised, so the bareness bar has nothing to judge',
        )
      } else {
        verdicts.push(
          c.bareNameAsk > 0
            ? `FAIL bar: ${c.bareNameAsk} bare name ask(s) among ${c.raised} raised`
            : `PASS bar: 0 bare name asks among ${c.raised} raised`,
        )
      }
      verdicts.push(
        c.twoQuestions > 0
          ? `FAIL ceiling: ${c.twoQuestions} rep(s) carried more than one question`
          : 'PASS ceiling: no rep carried more than one question',
      )
    }
    if (population === 'why-turn') {
      const floor = Math.ceil(args.reps * WHY_TURN_REASON_FLOOR_RATIO)
      verdicts.push(
        c.whatToCallYouReason >= floor
          ? `PASS bar: whatToCallYouReason ${c.whatToCallYouReason} >= ${floor}`
          : `FAIL bar: whatToCallYouReason ${c.whatToCallYouReason} < ${floor}`,
      )
      // The CUT reason. Not a pre-registered bar (it did not exist when the
      // bars were registered), so it is reported as a finding rather than
      // scored. Any hit is a drift back to a promise the venue cannot keep.
      verdicts.push(
        c.overPromisesRecognition > 0
          ? `FINDING: ${c.overPromisesRecognition} rep(s) promised recognition, which was cut on 2026-09-26`
          : 'note: no rep promised recognition',
      )
    }
    for (const v of verdicts) {
      if (v.startsWith('FAIL')) anyBreach = true
      console.log(`  ${v}`)
    }
  }
  console.log(`\nrun log: ${log.path}`)
  console.log(
    anyBreach
      ? '\nAT LEAST ONE BAR OR CEILING BREACHED.'
      : '\nAll bars and ceilings met.',
  )
  if (statesAfter !== statesBefore) {
    console.log(
      `NOTE: guest_states moved ${statesBefore} -> ${statesAfter} (a recognition band changed).`,
    )
  }
}

void main()
