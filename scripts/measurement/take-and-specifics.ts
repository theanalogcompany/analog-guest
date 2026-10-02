/**
 * TAC-548. Does R39 make replies carry the specifics the venue already holds,
 * WITHOUT making them drier?
 *
 * CONTROL FIRST, as the ticket asks. `control` is the SHIPPED prompt with R39
 * sliced out; `treatment` is the shipped prompt untouched, so the treatment arm
 * cannot drift from production. A unit whose slice did not change the prompt is
 * INVALID rather than recorded (TAC-502's lesson: a silently broken arm
 * produces exactly the "the fix works" shape).
 *
 * THE ARMS ARE BYTE-IDENTICAL APART FROM THE ONE LINE, and that is stronger
 * here than in the TAC-544 harness it is modelled on. These are SINGLE-turn
 * questions, so there is no generated history to diverge: per question the
 * classification, the voice corpus, the knowledge corpus and the user prompt
 * are computed ONCE and shared by both arms. The runner asserts per unit that
 * the two system prompts differ by exactly the R39 line and nothing else.
 *
 * GENERATE-ONLY. Nothing is sent and nothing is written. The one write
 * `buildRuntimeContext` can make is `computeGuestState` persisting a
 * `guest_states` row on a recognition-band change, so context is built ONCE for
 * the whole run and cloned per question, giving it exactly one opportunity. The
 * run reports the `guest_states` count before and after.
 *
 * THE NUMBERS INFORM, THEY DO NOT DECIDE. The ticket is explicit that Jaipal
 * reads the replies. So the runner writes a verbatim side-by-side of every
 * question next to the table, and the three headline metrics come from an LLM
 * judge handed the venue's own knowledge entry, with the deterministic
 * detectors printed beside it as a cross-check. Where they disagree the run
 * says so rather than picking one.
 *
 *   npx tsx --env-file=.env.local scripts/measurement/take-and-specifics.ts
 *
 * Env: MEASURE_ONLY=<id,id> to run a subset. Run with NEXT_PUBLIC_POSTHOG_KEY
 * and SLACK_ALERTS_WEBHOOK_URL unset so the stages' telemetry goes inert.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'

import { generateObject } from 'ai'
import { z } from 'zod'

import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import {
  buildAiRuntime,
  classifyStage,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
  shouldRetrieveKnowledge,
} from '@/lib/agent/stages'
import { getClassificationModel, getGenerationModel } from '@/lib/ai/client'
import { composePrompt } from '@/lib/ai/compose-prompt'
import {
  GeneratedMessageSchema,
  MAX_OUTPUT_TOKENS,
  VOICE_FIDELITY_INSTRUCTION,
} from '@/lib/ai/generate-message'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import type {
  KnowledgeCorpusChunk as AiKnowledgeCorpusChunk,
  VoiceCorpusChunk as AiVoiceCorpusChunk,
} from '@/lib/ai'
import { classifySpeakerIdentity } from './speaker-identity-language'
import { findThirdPersonVenue } from './guest-name-language'
import { createRunLog } from './run-log'
import {
  countSpecificHits,
  findPersonalTake,
  repeatedPhrases,
} from './take-and-specifics-language'
import { QUESTIONS, type Question } from './take-and-specifics-questions'

/**
 * The rule under test, transcribed from the ticket rather than imported from
 * SYSTEM_TEMPLATE. Importing it would make the slice agree with whatever the
 * template says, including a reworded version, so a run could silently measure
 * something other than the approved wording. A mismatch is a startup failure.
 */
const R39 =
  '- Give your honest take first, the way you would to a friend, then back it up with the specific details you have: the actual flavor if they asked how it tastes, the how if they asked how to use or brew it.'

const ARMS = ['control', 'treatment'] as const
type Arm = (typeof ARMS)[number]

const VENUE_SLUG = 'le-mils-coffee'

/**
 * The judge. Temperature 0, and handed the venue's OWN entry as ground truth
 * so "used the specifics" is a question about that text rather than about the
 * judge's opinion of coffee.
 *
 * `reasoning` is declared FIRST, the TAC-301 part 1.5 ordering: structured
 * output generates in declaration order, so a verdict declared first is
 * produced before the analysis that justifies it.
 */
const JudgeSchema = z.object({
  reasoning: z.string(),
  answersQuestionType: z.boolean(),
  answersQuestionTypeWhy: z.string(),
  usesSpecifics: z.boolean(),
  specificsUsed: z.array(z.string()),
  keepsPersonalTake: z.boolean(),
  personalTakeQuote: z.string(),
})
type Judgement = z.infer<typeof JudgeSchema>

const TYPE_ASK: Record<Question['type'], string> = {
  taste:
    'The guest asked HOW IT TASTES. Answering the question type means the reply describes the actual flavour. Saying only that it is strong, popular, good, or who likes it is NOT describing the flavour. Telling them where to buy it, or what it is made of without saying how it tastes, is answering a different question.',
  how_to:
    'The guest asked HOW TO USE, BREW OR ORDER it. Answering the question type means the reply tells them a method: a brew style, a recipe, a grind, a thing to say at the counter, a technique. Telling them where to BUY it, or describing what it tastes like, or what it is, is answering a different question.',
  what_is:
    'The guest asked WHAT IT IS. Answering the question type means the reply says what the thing is. A reply that only says it is good, or only says where to buy it, is answering a different question.',
}

async function judge(q: Question, reply: string): Promise<Judgement> {
  const { object } = await generateObject({
    model: getClassificationModel(),
    schema: JudgeSchema,
    temperature: 0,
    maxOutputTokens: 1200,
    system: [
      'You are grading one reply a cafe sent a guest. Be strict and literal. You are not judging whether the reply is nice, only the three questions asked.',
      '',
      'keepsPersonalTake: does the reply contain an opinion, a reaction, a recommendation, a warning, or an honest aside, as opposed to only stating facts? A take is the venue having a VIEW. "it is intense, honestly" is a take. "it is my favourite" is a take. "only if you handle caffeine well" is a take. "it has notes of dark chocolate" alone is NOT a take, it is a fact. Quote the take in personalTakeQuote, or leave that empty.',
      '',
      'usesSpecifics: does the reply use the concrete details from the SOURCE ENTRY below? List in specificsUsed only details that genuinely appear in the reply AND in the entry. A reply that is accurate but generic does not use the specifics.',
      '',
      'Judge the reply exactly as written. Do not reward or penalise length.',
    ].join('\n'),
    prompt: [
      `GUEST ASKED: ${q.body}`,
      '',
      `QUESTION TYPE: ${q.type}`,
      TYPE_ASK[q.type],
      '',
      "SOURCE ENTRY (the venue's own knowledge, the ground truth for specifics):",
      q.entry,
      '',
      'THE REPLY:',
      reply,
    ].join('\n'),
  })
  return object
}

interface Unit {
  questionId: string
  rep: number
  type: Question['type']
  question: string
  arm: Arm
  reply: string | null
  error: string | null
  calls: number
  category: string | null
  knowledgeChunkIds: string[]
  entryRetrieved: boolean
  judge: Judgement | null
  specificHits: number
  specificsAvailable: number
  specificLabels: string[]
  detectorTake: boolean
  detectorTakeMatches: string[]
  namedSelfIntro: boolean
  namedSelfIntroMatch: string | null
  thirdPersonVenue: string | null
}

async function main() {
  // REPS. Generation runs at temperature 0.7, so ONE draw per cell is a draw
  // and not a property of the question (TAC-520 measured two runs of
  // byte-identical code at 4/5 and 1/5 on the same metric). The rates below are
  // computed over every rep; the side-by-side shows rep 1, which is what Jaipal
  // reads. A per-question metric that is not unanimous across reps is printed
  // as a fraction so an unstable cell is visible rather than rounded away.
  const reps = Number(process.env.MEASURE_REPS ?? '3')
  if (!Number.isInteger(reps) || reps < 1)
    throw new Error('MEASURE_REPS must be a positive integer')
  const only = (process.env.MEASURE_ONLY ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const questions =
    only.length > 0 ? QUESTIONS.filter((q) => only.includes(q.id)) : QUESTIONS
  if (questions.length === 0)
    throw new Error('MEASURE_ONLY matched no question id')

  const db = createAdminClient()
  const { data: venue, error: venueError } = await db
    .from('venues')
    .select('id, slug, timezone')
    .eq('slug', VENUE_SLUG)
    .single()
  if (venueError || !venue) throw new Error(`venue ${VENUE_SLUG} not found`)

  const { data: cfg } = await db
    .from('venue_configs')
    .select('venue_info')
    .eq('venue_id', venue.id)
    .single()
  const info = (cfg?.venue_info ?? {}) as { staff?: string[] }
  const personNames = [
    ...(info.staff ?? []).map(
      (line) => (line.split(/[—–-]/)[0] ?? '').trim().split(/\s+/)[0] ?? '',
    ),
    'Himanshu',
    'Milana',
  ].filter((n) => n.length > 2)
  const venueNames = ["Le Mil's", 'Le Mils', 'LeMils'] as const

  // The guest: the non-synthetic guest with the most messages, derived rather
  // than pasted as an id, and reported so a run says which one it used. Same
  // selection the TAC-544 harness makes, for the same reason.
  const { data: candidates } = await db
    .from('guests')
    .select('id, first_name, phone_number, instagram_scoped_id')
    .eq('venue_id', venue.id)
    .not('first_name', 'is', null)
  const named = (candidates ?? []).filter(
    (g) =>
      !String(g.first_name ?? '')
        .toLowerCase()
        .startsWith('synthetic'),
  )
  let guest: (typeof named)[number] | null = null
  let guestMessageCount = 0
  for (const g of named) {
    const { count } = await db
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('guest_id', g.id)
    if ((count ?? 0) > guestMessageCount) {
      guestMessageCount = count ?? 0
      guest = g
    }
  }
  if (!guest)
    throw new Error('no non-synthetic guest with a first_name at this venue')
  const channel: 'text' | 'instagram' = guest.phone_number
    ? 'text'
    : 'instagram'

  const { count: statesBefore } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  const startedAt = new Date()
  const log = createRunLog({
    name: 'tac548-take-and-specifics',
    meta: {
      arm: 'both',
      promptVersion: PROMPT_VERSION,
      venue: VENUE_SLUG,
      channel,
      guestFirstName: String(guest.first_name),
      guestMessageCount,
      ruleUnderTest: R39,
      questions: questions.length,
      reps,
      statesBefore,
      runLocal: startedAt.toLocaleString('en-US', {
        timeZone: venue.timezone ?? 'UTC',
      }),
    },
  })

  console.log(
    `[tac548] venue ${VENUE_SLUG} | guest "${guest.first_name}" (${channel}, ${guestMessageCount} messages)`,
  )
  console.log(
    `[tac548] prompt ${PROMPT_VERSION} | venue-local ${startedAt.toLocaleString('en-US', { timeZone: venue.timezone ?? 'UTC' })}`,
  )
  console.log(`[tac548] guest_states rows before: ${statesBefore}`)
  console.log(`[tac548] run log: ${log.path}\n`)

  const trace = startAgentTrace({
    name: 'tac548-measure',
    agentRunId: randomUUID(),
  })
  const now = new Date()

  // ONE context build for the whole run, cloned per question below.
  const baseCtx = await buildRuntimeContext({
    agentRunId: randomUUID(),
    guestId: guest.id,
    venueId: venue.id,
    trace,
    currentMessage: {
      id: randomUUID(),
      providerMessageId: `tac548-probe-${randomUUID()}`,
      body: questions[0]!.body,
      receivedAt: now,
      channel,
      referralSource: null,
    },
  })

  // STARTUP GUARD. The slice must find the rule exactly once in a real composed
  // prompt, or every control unit would be byte-identical to its treatment and
  // the run would measure nothing while reporting cleanly.
  {
    const probe = composePrompt({
      category: 'reply',
      persona: baseCtx.venue.brandPersona,
      venueInfo: baseCtx.venue.venueInfo,
      ragChunks: [],
      knowledgeChunks: undefined,
      runtime: buildAiRuntime(baseCtx),
      channel: baseCtx.conversationChannel,
    })
    const hits = probe.systemPrompt.split(R39).length - 1
    if (hits !== 1) {
      console.error(
        `✗ the rule under test appears ${hits} times in a composed system prompt, expected exactly 1.\n` +
          '  Either it is not shipped (run this on a branch where it is), or its wording has drifted\n' +
          '  from the approved text transcribed at the top of this file. Refusing to run.',
      )
      process.exit(1)
    }
  }

  const units: Unit[] = []

  for (const q of questions) {
    // Per question: classify and retrieve ONCE, compose ONCE. Both arms share
    // all of it, so the only thing that can differ is the sliced line.
    const ctx = {
      ...baseCtx,
      recentMessages: [...baseCtx.recentMessages],
    } as typeof baseCtx
    ctx.currentMessage = {
      id: randomUUID(),
      providerMessageId: `tac548-${q.id}`,
      body: q.body,
      receivedAt: now,
      channel,
      referralSource: null,
    }

    let composed: ReturnType<typeof composePrompt> | null = null
    let category: string | null = null
    let knowledgeChunkIds: string[] = []
    let entryRetrieved = false
    let setupError: string | null = null

    try {
      const classification = await classifyStage(ctx)
      ctx.classification = classification
      category = classification.category
      ctx.corpus = await retrieveCorpusStage(ctx)
      ctx.knowledgeCorpus = shouldRetrieveKnowledge(ctx)
        ? await retrieveKnowledgeStage(ctx, classification.category, q.body)
        : []

      const ragChunks: AiVoiceCorpusChunk[] = (ctx.corpus ?? []).map((c) => ({
        id: c.id,
        text: c.text,
        sourceType: c.sourceType as AiVoiceCorpusChunk['sourceType'],
        relevanceScore: c.similarity,
      }))
      const knowledgeChunks: AiKnowledgeCorpusChunk[] | undefined =
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
      knowledgeChunkIds = (knowledgeChunks ?? []).map((c) => c.id)

      // Did retrieval actually surface the entry this question is about? A
      // proxy, and reported as one: it asks whether any retrieved chunk carries
      // a distinctive phrase from the transcribed entry. A miss here is a
      // RETRIEVAL result (TAC-547's subject), not a verdict on the rule, and
      // the report separates the two rather than blaming R39 for it.
      const probeTerms = q.specifics.flatMap((s) => s.variants)
      entryRetrieved = (knowledgeChunks ?? []).some((c) =>
        probeTerms.some((t) => c.text.toLowerCase().includes(t.toLowerCase())),
      )

      composed = composePrompt({
        category: classification.category,
        persona: ctx.venue.brandPersona,
        venueInfo: ctx.venue.venueInfo,
        ragChunks,
        knowledgeChunks,
        runtime: buildAiRuntime(ctx),
        channel: ctx.conversationChannel,
      })
    } catch (e) {
      setupError = e instanceof Error ? e.message : String(e)
    }

    for (let rep = 0; rep < reps; rep += 1) {
      for (const arm of ARMS) {
        let reply: string | null = null
        let error: string | null = setupError
        let calls = 0

        if (composed !== null && error === null) {
          // THE ONE DIFFERENCE BETWEEN THE ARMS.
          let systemBody = composed.systemPrompt
          if (arm === 'control') {
            const stripped = systemBody.replace(`${R39}\n`, '')
            if (stripped === systemBody) {
              error = 'control slice did not change the prompt'
            } else {
              systemBody = stripped
            }
          }

          if (error === null) {
            const system = `${systemBody}\n\n${VOICE_FIDELITY_INSTRUCTION}`
            // A BOUNDED RE-ASK on a schema failure, byte-identical prompt every
            // attempt. Not the regen loop: no feedback, no sticky constraints. It
            // absorbs the voiceFidelity-scale failure that hit 11 of the TAC-513
            // harness's first 14 generations, which has nothing to do with arm.
            for (let attempt = 0; attempt < 4; attempt += 1) {
              calls += 1
              try {
                const { object } = await generateObject({
                  model: getGenerationModel(),
                  system,
                  messages: [
                    ...composed.historyTurns,
                    { role: 'user', content: composed.userPrompt },
                  ],
                  schema: GeneratedMessageSchema,
                  temperature: 0.7,
                  maxOutputTokens: MAX_OUTPUT_TOKENS,
                })
                reply = object.body
                error = null
                break
              } catch (e) {
                error = e instanceof Error ? e.message : String(e)
              }
            }
          }
        }

        // A FAILED UNIT IS NOT A RESULT. It is recorded with its error and
        // excluded from every rate below, never counted as a negative.
        let judgement: Judgement | null = null
        if (reply !== null) {
          try {
            judgement = await judge(q, reply)
          } catch (e) {
            error = `judge failed: ${e instanceof Error ? e.message : String(e)}`
          }
        }

        const spec = reply ? countSpecificHits(reply, q.specifics) : null
        const take = reply ? findPersonalTake(reply) : null
        const identity = reply
          ? classifySpeakerIdentity(reply, {
              personNames,
              venueNames: [...venueNames],
            })
          : null
        const thirdPerson = reply
          ? findThirdPersonVenue(reply, [...venueNames])
          : null

        const unit: Unit = {
          questionId: q.id,
          rep,
          type: q.type,
          question: q.body,
          arm,
          reply,
          error,
          calls,
          category,
          knowledgeChunkIds,
          entryRetrieved,
          judge: judgement,
          specificHits: spec?.hits ?? 0,
          specificsAvailable: q.specifics.length,
          specificLabels: spec?.hitLabels ?? [],
          detectorTake: take?.hasTake ?? false,
          detectorTakeMatches: take?.matches ?? [],
          namedSelfIntro: identity?.namedSelfIntro ?? false,
          namedSelfIntroMatch: identity?.namedSelfIntroMatch ?? null,
          thirdPersonVenue: thirdPerson,
        }
        units.push(unit)
        log.appendUnit(unit as unknown as Record<string, unknown>)

        const mark = error
          ? '!'
          : judgement?.answersQuestionType
            ? '\u2713'
            : '\u2717'
        console.log(
          `  ${mark} ${q.id.padEnd(22)} r${rep + 1} ${arm.padEnd(9)} ` +
            `type=${judgement?.answersQuestionType ? 'Y' : 'n'} ` +
            `spec=${judgement?.usesSpecifics ? 'Y' : 'n'}(${unit.specificHits}/${unit.specificsAvailable}) ` +
            `take=${judgement?.keepsPersonalTake ? 'Y' : 'n'}` +
            (error ? ` ERROR ${error.slice(0, 60)}` : ''),
        )
      }
    }
  }

  const { count: statesAfter } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  report(units, {
    statesBefore: statesBefore ?? 0,
    statesAfter: statesAfter ?? 0,
    logPath: log.path,
  })
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${n}/${d} (${Math.round((n / d) * 100)}%)`
}

function report(
  units: readonly Unit[],
  meta: { statesBefore: number; statesAfter: number; logPath: string },
) {
  const lines: string[] = []
  const say = (s = '') => {
    lines.push(s)
    console.log(s)
  }

  say('')
  say('='.repeat(78))
  say('TAC-548 — keep the honest take, add the specifics')
  say('='.repeat(78))

  const failed = units.filter((u) => u.error !== null)
  say('')
  say(
    `units: ${units.length} | failed: ${failed.length} (excluded from every rate)`,
  )
  for (const f of failed) say(`  ! ${f.questionId} ${f.arm}: ${f.error}`)
  say(
    `guest_states rows: ${meta.statesBefore} before, ${meta.statesAfter} after`,
  )
  say(`run log: ${meta.logPath}`)

  const notRetrieved = units.filter(
    (u) => u.arm === 'treatment' && !u.entryRetrieved,
  )
  if (notRetrieved.length > 0) {
    say('')
    say(
      `RETRIEVAL NOTE: the entry's own terms did not appear in any retrieved chunk for ${notRetrieved.length} question(s).`,
    )
    say(
      "That is a retrieval result (TAC-547's subject), not a verdict on R39. Those questions are",
    )
    say(
      'reported in the table like any other, and are the ones to read rather than count.',
    )
    for (const u of notRetrieved) say(`  - ${u.questionId}`)
  }

  say('')
  say('-'.repeat(78))
  say(
    'HEADLINE METRICS (LLM judge, given the venue’s own entry as ground truth)',
  )
  say('-'.repeat(78))
  say('')
  say('metric                          control            change')

  for (const [label, key] of [
    ['answers the question type', 'answersQuestionType'],
    ['uses the specifics available', 'usesSpecifics'],
    ['keeps a personal take', 'keepsPersonalTake'],
  ] as const) {
    const cells = ARMS.map((arm) => {
      const scored = units.filter(
        (u) => u.arm === arm && u.error === null && u.judge !== null,
      )
      const hits = scored.filter((u) => (u.judge as Judgement)[key]).length
      return pct(hits, scored.length)
    })
    say(`${label.padEnd(32)}${cells[0]!.padEnd(19)}${cells[1]}`)
  }

  // The bars, evaluated in code rather than left to whoever reads the output
  // (TAC-519's lesson: an assertion that reports a pass without evaluating
  // anything is worse than no assertion).
  say('')
  say('-'.repeat(78))
  say('BARS')
  say('-'.repeat(78))

  const scoredOf = (arm: Arm) =>
    units.filter((u) => u.arm === arm && u.error === null && u.judge !== null)

  const treatMisses = scoredOf('treatment').filter(
    (u) => !(u.judge as Judgement).answersQuestionType,
  )
  say(
    `${treatMisses.length === 0 ? 'PASS' : 'FAIL'}  bar: the change answers the question type asked, 0 misses` +
      (treatMisses.length > 0
        ? ` — missed: ${treatMisses.map((u) => u.questionId).join(', ')}`
        : ''),
  )

  const takeRate = (arm: Arm) => {
    const s = scoredOf(arm)
    return s.length === 0
      ? 0
      : s.filter((u) => (u.judge as Judgement).keepsPersonalTake).length /
          s.length
  }
  const ctlTake = takeRate('control')
  const trtTake = takeRate('treatment')
  say(
    `${trtTake >= ctlTake ? 'PASS' : 'FAIL'}  bar: the change keeps a personal take at no lower a rate than the control ` +
      `(${Math.round(ctlTake * 100)}% → ${Math.round(trtTake * 100)}%)`,
  )

  for (const arm of ARMS) {
    const scored = units.filter((u) => u.arm === arm && u.error === null)
    const intros = scored.filter((u) => u.namedSelfIntro)
    const thirds = scored.filter((u) => u.thirdPersonVenue !== null)
    const reps = repeatedPhrases(
      scored.map((u) => u.reply ?? ''),
      { n: 5, maxShare: 0.25 },
    )
    say(
      `${intros.length === 0 ? 'PASS' : 'FAIL'}  ${arm}: 0 named self-introductions` +
        (intros.length > 0
          ? ` — ${intros.map((u) => `${u.questionId}:"${u.namedSelfIntroMatch}"`).join(', ')}`
          : ''),
    )
    say(
      `${thirds.length === 0 ? 'PASS' : 'FAIL'}  ${arm}: 0 third-person venue references` +
        (thirds.length > 0
          ? ` — ${thirds.map((u) => `${u.questionId}:"${u.thirdPersonVenue}"`).join(', ')}`
          : ''),
    )
    say(
      `${reps.length === 0 ? 'PASS' : 'FAIL'}  ${arm}: no phrasing in more than a quarter of replies` +
        (reps.length > 0
          ? ` — ${reps.map((r) => `"${r.phrase}" x${r.replies}`).join('; ')}`
          : ''),
    )
  }

  // The deterministic cross-check, printed beside the judge rather than instead
  // of it. A wide gap between the two is a reason to read the bodies.
  say('')
  say('-'.repeat(78))
  say(
    'DETERMINISTIC CROSS-CHECK (a floor, not the verdict — see the module header)',
  )
  say('-'.repeat(78))
  for (const arm of ARMS) {
    const scored = units.filter((u) => u.arm === arm && u.error === null)
    const hits = scored.reduce((n, u) => n + u.specificHits, 0)
    const avail = scored.reduce((n, u) => n + u.specificsAvailable, 0)
    const takes = scored.filter((u) => u.detectorTake).length
    say(
      `${arm.padEnd(10)} specifics matched ${hits}/${avail} tokens | take markers fired in ${pct(takes, scored.length)}`,
    )
  }

  const disagree = units.filter(
    (u) =>
      u.error === null &&
      u.judge !== null &&
      u.judge.keepsPersonalTake !== u.detectorTake,
  )
  if (disagree.length > 0) {
    say('')
    say(
      `judge and detector disagree on a take in ${disagree.length} reply/replies (read these):`,
    )
    for (const u of disagree) {
      say(
        `  ${u.questionId} ${u.arm}: judge=${u.judge!.keepsPersonalTake} detector=${u.detectorTake}` +
          (u.judge!.personalTakeQuote
            ? ` judge quote: "${u.judge!.personalTakeQuote}"`
            : ''),
      )
    }
  }

  say('')
  say('-'.repeat(78))
  say('PER QUESTION')
  say('-'.repeat(78))
  say('')
  say('YYY = all reps, ··· = none, else hits/reps')
  say('')
  say('question                type    | control             | change')
  for (const q of QUESTIONS) {
    const cell = (arm: Arm) => {
      const all = units.filter((u) => u.questionId === q.id && u.arm === arm)
      if (all.length === 0) return '-'.padEnd(20)
      const ok = all.filter((u) => u.error === null && u.judge !== null)
      if (ok.length === 0) return 'FAILED'.padEnd(20)
      const n = ok.length
      const f = (key: keyof Judgement) => {
        const hits = ok.filter((u) => (u.judge as Judgement)[key]).length
        return hits === n ? 'YYY' : hits === 0 ? '···' : `${hits}/${n}`
      }
      return `type ${f('answersQuestionType')} spec ${f('usesSpecifics')} take ${f('keepsPersonalTake')}`.padEnd(
        20,
      )
    }
    if (units.some((u) => u.questionId === q.id)) {
      say(
        `${q.id.padEnd(24)}${q.type.padEnd(8)}| ${cell('control')}| ${cell('treatment')}`,
      )
    }
  }

  mkdirSync('measurement-runs', { recursive: true })
  writeFileSync('measurement-runs/tac548-report.txt', `${lines.join('\n')}\n`)
  writeFileSync('measurement-runs/tac548-side-by-side.md', sideBySide(units))
  console.log('\nreport:        measurement-runs/tac548-report.txt')
  console.log('side-by-side:  measurement-runs/tac548-side-by-side.md')
}

/** The deliverable. Every question, both replies, verbatim. */
function sideBySide(units: readonly Unit[]): string {
  const out: string[] = []
  out.push('# TAC-548 side-by-side')
  out.push('')
  out.push(
    'Control is the shipped prompt with R39 sliced out. Change is the shipped prompt untouched.',
  )
  out.push(
    'Per question both arms share one classification, one voice corpus, one knowledge corpus and',
  )
  out.push(
    'one user prompt, so the only difference between them is that single line.',
  )
  out.push('')
  for (const q of QUESTIONS) {
    const c = units.find(
      (u) => u.questionId === q.id && u.arm === 'control' && u.rep === 0,
    )
    const t = units.find(
      (u) => u.questionId === q.id && u.arm === 'treatment' && u.rep === 0,
    )
    if (!c && !t) continue
    out.push(`### ${q.body}`)
    out.push(
      `*${q.type}* · ${q.id}${c && !c.entryRetrieved ? ' · **entry terms not in retrieved chunks**' : ''}`,
    )
    out.push('')
    out.push('**Control**')
    out.push('')
    out.push(c?.error ? `> _(failed: ${c.error})_` : blockquote(c?.reply ?? ''))
    out.push('')
    out.push('**Change**')
    out.push('')
    out.push(t?.error ? `> _(failed: ${t.error})_` : blockquote(t?.reply ?? ''))
    out.push('')
  }
  return `${out.join('\n')}\n`
}

function blockquote(s: string): string {
  return s
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
