// TAC-386 arm B: fifteen generated follow-ups, across inquiry types.
//
//   npm run measure-inquiry-followup -- [venue-slug] [--arm <label>]
//   npm run measure-inquiry-followup -- --rescore <run-log.jsonl>
//   npm run measure-inquiry-followup -- --extra 2x5
//
// `--extra <case>x<n>` generates one case n more times AFTER the fifteen, to
// put a rate on something one body did. The extras are printed and logged and
// never enter the three bars, which stay fifteen bodies of fifteen inputs.
//
// `--arm` only labels the run log (control, treatment). `--rescore` generates
// nothing: it re-reads the bodies of an earlier run through today's detectors,
// which is how a detector change is checked against a run that was hand-read.
//
// READ-ONLY apart from the one write buildRuntimeContext makes on its own
// (a guest_states row), same as TAC-560's harness. Nothing here sends a message.
//
// THE THREE BARS, pre-registered on TAC-386 before this generated:
//
//   1. references what was asked AND what we suggested   15/15
//   2. never asks whether they came in, never presumes
//      that they did, never pushes them to come in        15/15
//   3. no wording in more than a quarter of the set       <= 3 of 15
//
// ALL THREE ARE HAND-READ. The detectors in inquiry-followup-language.ts narrow
// the reading; they are not the verdict, and a disagreement between a detector
// and the hand-read is the finding.
//
// THE SET SPANS INQUIRY TYPES on purpose (parking or directions, beans, brewing,
// dogs, what to try). Fifteen runs of ONE question would make bar 3 meaningless:
// the same question should produce similar wording, so repetition would prove
// nothing about whether the voice is templated.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { generateObject } from 'ai'

import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import {
  buildAiRuntime,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
} from '@/lib/agent/stages'
import { getGenerationModel } from '@/lib/ai/client'
import { composePrompt } from '@/lib/ai/compose-prompt'
import {
  GeneratedMessageSchema,
  MAX_OUTPUT_TOKENS,
  replaceDashes,
} from '@/lib/ai/generate-message'
import { INQUIRY_FOLLOWUP_INSTRUCTIONS } from '@/lib/ai/prompts/categories/inquiry-followup'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import type { VoiceCorpusChunk as AiVoiceCorpusChunk } from '@/lib/ai'
import { createRunLog } from './run-log'
import {
  checkDetectors,
  findsReference,
  findsRepetition,
  findsUnsaidNames,
  findsVisitClaim,
  findsVoiceProblems,
} from './inquiry-followup-language'

const BLOCK_HEADER = '## Following up on what they asked'

/**
 * The fifteen cases: five inquiry shapes, three each.
 *
 * Each pairs a guest question with a plausible answer of ours, because the
 * prompt renders BOTH and bar 1 is about referencing both. The answers are
 * written as this venue would answer, not as a template.
 */
const CASES: { kind: string; question: string; answer: string }[] = [
  {
    kind: 'parking',
    question: 'where do I park around there',
    answer:
      'Street parking on Polk is usually fine before 9. The lot behind the building is permit only.',
  },
  {
    kind: 'parking',
    question: 'is there parking there',
    answer:
      'There is metered street parking right out front, and a garage a block up on Clay if that is full.',
  },
  {
    kind: 'directions',
    question: 'whats the easiest way to get to you from the mission',
    answer:
      'The 49 drops you two blocks away, or BART to Civic Center and a short walk up.',
  },
  {
    kind: 'directions',
    question: 'are you the one on the corner or further down the block',
    answer: 'Further down, past the flower shop, the green awning is us.',
  },
  {
    kind: 'beans',
    question: 'which bag should I buy if I like something chocolatey',
    answer:
      'The Colombia is the one, it leans cocoa and brown sugar. The Ethiopia is the bright one, so probably not that.',
  },
  {
    kind: 'beans',
    question: 'do you sell coffee beans too',
    answer:
      'We do, whole bean or ground on the shelf by the register, and we roast the Colombia weekly.',
  },
  {
    kind: 'beans',
    question: 'whats a good bag for a filter coffee drinker',
    answer:
      'The washed Ethiopia is the one most filter drinkers go for. It is delicate, so a little coarser than you might expect.',
  },
  {
    kind: 'brewing',
    question: 'how should I brew the beans I got from you',
    answer:
      'A 1 to 16 ratio, water just off the boil, and give it a good stir after the bloom.',
  },
  {
    kind: 'brewing',
    question: 'my pour over keeps coming out bitter, any ideas',
    answer:
      'Usually the grind is too fine or the water is too hot. Go a notch coarser first and let the kettle sit a minute.',
  },
  {
    kind: 'brewing',
    question: 'whats the ratio you use for the aeropress',
    answer: 'We go 17 grams to 250, about two minutes, and a slow press.',
  },
  {
    kind: 'dogs',
    question: 'can I bring my dog',
    answer:
      'Of course, the patio is dog friendly and there is a water bowl by the door.',
  },
  {
    kind: 'dogs',
    question: 'is the patio ok for a big dog',
    answer:
      'Plenty of room on the patio, the corner table by the planter is the roomiest.',
  },
  {
    kind: 'what-to-try',
    question: 'whats something I should try when I get there',
    answer:
      'The Pink Panther if you want something interesting, or the cortado if you would rather taste the coffee.',
  },
  {
    kind: 'what-to-try',
    question: 'what do you recommend, I like coffee but not too sweet',
    answer:
      'The cortado then, or a straight filter. The Blossom Tonic is the sweet one so I would skip it.',
  },
  {
    kind: 'what-to-try',
    question: 'whats underrated here',
    answer:
      'The cardamom bun. It sells out by ten and nobody asks about it until it is gone.',
  },
]

interface Args {
  venueSlug: string
  arm: string
  rescorePath: string | null
  /** 1-based case number and how many extra generations of it. */
  extra: { caseNumber: number; times: number } | null
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    venueSlug: 'le-mils-coffee',
    arm: 'shipped',
    rescorePath: null,
    extra: null,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!
    if (flag === '--arm') args.arm = argv[++i] ?? args.arm
    else if (flag === '--rescore') args.rescorePath = argv[++i] ?? null
    else if (flag === '--extra') {
      const match = /^(\d+)x(\d+)$/.exec(argv[++i] ?? '')
      const caseNumber = Number(match?.[1])
      const times = Number(match?.[2])
      if (!match || caseNumber < 1 || caseNumber > CASES.length || times < 1) {
        throw new Error('--extra takes <case>x<n>, e.g. 2x5')
      }
      args.extra = { caseNumber, times }
    } else if (flag.startsWith('--')) throw new Error(`unknown flag: ${flag}`)
    else args.venueSlug = flag
  }
  return args
}

function describeVisit(visit: ReturnType<typeof findsVisitClaim>): string {
  return visit.clean
    ? 'yes'
    : `NO asks=${visit.asks.join('|')} presumed=${visit.presumed.join('|')} pushes=${visit.pushes.join('|')}`
}

/** Re-read an earlier run's bodies through today's detectors. No model call. */
function rescore(path: string): void {
  const units = readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          index?: number
          question?: string
          answer?: string
          body?: string | null
          extra?: boolean
        },
    )
    .filter(
      (u) =>
        // Extras put a rate on one case and never enter the bars.
        u.extra !== true &&
        typeof u.index === 'number' &&
        typeof u.body === 'string' &&
        typeof u.question === 'string' &&
        typeof u.answer === 'string',
    )
  if (units.length === 0) throw new Error(`no scored units in ${path}`)

  let bar1 = 0
  let suggestion = 0
  let bar2 = 0
  for (const u of units) {
    const reference = findsReference(u.body!, u.question!, u.answer!)
    const visit = findsVisitClaim(u.body!)
    if (reference.referencesBoth) bar1 += 1
    if (reference.namesSuggestion) suggestion += 1
    if (visit.clean) bar2 += 1
    console.log(`#${u.index} ${u.body}`)
    console.log(
      `  bar1 references both: ${reference.referencesBoth ? 'yes' : 'NO'}  names our suggestion: ${reference.namesSuggestion ? 'yes' : 'NO'}  q=[${reference.sharedWithQuestion.join(' ')}] a=[${reference.sharedWithAnswerOnly.join(' ')}]`,
    )
    console.log(`  bar2 clean: ${describeVisit(visit)}`)
  }
  console.log(`\n=== rescore of ${path} ===`)
  console.log(`  bar 1 detector: ${bar1}/${units.length}`)
  console.log(`  names our suggestion: ${suggestion}/${units.length}`)
  console.log(`  bar 2 detector: ${bar2}/${units.length}`)
  console.log(
    '  Compare with the hand-read recorded for that run. The difference is the finding.',
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  // Before anything is spent or read: do the detectors agree with sentences
  // whose verdict is already known?
  const detectorProblems = checkDetectors()
  if (detectorProblems.length > 0) {
    console.error('refusing to run: the detectors disagree with their labels')
    for (const p of detectorProblems) console.error(`  - ${p}`)
    process.exit(1)
  }
  if (args.rescorePath !== null) {
    rescore(args.rescorePath)
    return
  }

  const venueSlug = args.venueSlug
  const db = createAdminClient()

  const { data: venue, error: venueError } = await db
    .from('venues')
    .select('id, slug')
    .eq('slug', venueSlug)
    .maybeSingle()
  if (venueError || !venue) {
    throw new Error(
      `could not find venue "${venueSlug}": ${venueError?.message}`,
    )
  }

  const { data: guests } = await db
    .from('guests')
    .select('id, first_name, created_via, instagram_scoped_id')
    .eq('venue_id', venue.id)
    .not('instagram_scoped_id', 'is', null)
  const guest = (guests ?? []).find(
    (g) =>
      !String(g.first_name ?? '')
        .toLowerCase()
        .startsWith('synthetic'),
  )
  if (!guest) throw new Error(`no Instagram guest at ${venueSlug}`)

  // Narrowed into consts so the closure below does not re-widen them: TS cannot
  // see that a `let`-scoped `venue` stays non-null inside a nested function.
  const venueId = venue.id
  const guestId = guest.id

  const trace = startAgentTrace({
    name: 'tac386-measure',
    agentRunId: randomUUID(),
  })
  const now = new Date()

  // ONE context build per case, because the block's contents differ per case.
  // `currentMessage: null` is what the followup path passes, which is what makes
  // this the real turn rather than an approximation of it.
  async function composeFor(c: (typeof CASES)[number]) {
    const ctx = await buildRuntimeContext({
      agentRunId: randomUUID(),
      guestId,
      venueId,
      trace,
      followupTrigger: {
        reason: 'inquiry_followup',
        triggeredAt: now,
        inquiryFollowup: {
          question: c.question,
          answer: c.answer,
          answerMessageId: randomUUID(),
        },
      },
    })
    ctx.corpus = await retrieveCorpusStage(ctx)
    ctx.knowledgeCorpus = await retrieveKnowledgeStage(
      ctx,
      'follow_up',
      c.question,
    )
    const ragChunks: AiVoiceCorpusChunk[] = (ctx.corpus ?? []).map((k) => ({
      id: k.id,
      text: k.text,
      sourceType: k.sourceType as AiVoiceCorpusChunk['sourceType'],
      relevanceScore: k.similarity,
    }))
    return {
      ctx,
      composed: composePrompt({
        category: 'follow_up',
        persona: ctx.venue.brandPersona,
        venueInfo: ctx.venue.venueInfo,
        ragChunks,
        knowledgeChunks: ctx.knowledgeCorpus ?? undefined,
        runtime: buildAiRuntime(ctx),
        channel: ctx.conversationChannel,
      }),
    }
  }

  // STARTUP GUARDS, before a single call is spent. Each is a way this run could
  // report cleanly while measuring nothing.
  const first = await composeFor(CASES[0])
  const problems: string[] = []
  if (!first.composed.userPrompt.includes(BLOCK_HEADER)) {
    problems.push(`the ${BLOCK_HEADER} block did not render`)
  }
  if (!first.composed.userPrompt.includes(CASES[0].question)) {
    problems.push('the guest question did not render into the block')
  }
  if (!first.composed.userPrompt.includes(CASES[0].answer)) {
    problems.push(
      'OUR ANSWER did not render into the block, so bar 1 is untestable',
    )
  }
  if (!first.composed.systemPrompt.includes(INQUIRY_FOLLOWUP_INSTRUCTIONS)) {
    problems.push(
      'the inquiry-follow-up category instructions did not replace the follow_up ones',
    )
  }
  if (first.composed.userPrompt.includes('## Follow-up context')) {
    problems.push(
      'the shared follow-up-context block rendered, and its framing is "you visited N days ago"',
    )
  }
  if (first.ctx.conversationChannel !== 'instagram') {
    problems.push(
      `channel resolved to ${String(first.ctx.conversationChannel)}, not instagram`,
    )
  }
  if (problems.length > 0) {
    console.error('refusing to run:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }

  const log = createRunLog({
    name: 'tac386-inquiry-followup',
    meta: {
      arm: args.arm,
      // The harness builds context at the moment it runs. Recorded so a reader
      // can tell whether the prompt told the model the venue was shut.
      openStatusLine:
        /^- Status: .*$/m.exec(first.composed.userPrompt)?.[0] ??
        /^- Status: .*$/m.exec(first.composed.systemPrompt)?.[0] ??
        null,
      promptVersion: PROMPT_VERSION,
      venueSlug: venue.slug,
      guestId: guest.id,
      cases: CASES.length,
      bars: {
        one: 'references what was asked AND what we suggested, 15/15',
        two: 'never asks whether they came in, never presumes it, never pushes, 15/15',
        three: 'no wording in more than a quarter of the set',
      },
    },
  })
  console.log(`run log: ${log.path}`)
  console.log(
    `[tac386] venue=${venue.slug} guest=${guest.id} channel=${first.ctx.conversationChannel} prompt=${PROMPT_VERSION}\n`,
  )

  const bodies: string[] = []
  let rewrittenCount = 0
  const extras = args.extra
    ? Array.from({ length: args.extra.times }, () => ({
        c: CASES[args.extra!.caseNumber - 1]!,
        caseNumber: args.extra!.caseNumber,
      }))
    : []
  const runs = [
    ...CASES.map((c, i) => ({ c, caseNumber: i + 1, extra: false })),
    ...extras.map((e) => ({ ...e, extra: true })),
  ]
  const extraBodies: string[] = []
  for (const [index, run] of runs.entries()) {
    const c = run.c
    const { composed } = index === 0 ? first : await composeFor(c)
    const system = composed.systemPrompt

    let body: string | null = null
    /**
     * The model's body BEFORE replaceDashes.
     *
     * Recorded because the first fixed run could not answer its own question:
     * it applied the rewrite and stored only the result, so "voice checks:
     * clean" could not distinguish "no dash was emitted" from "a dash was
     * emitted and rewritten". Those are different facts about the prompt.
     */
    let rawBody: string | null = null
    let error: string | null = null
    // A bounded re-ask on a schema failure, byte-identical prompt each attempt.
    // Not the regen loop: no feedback, no sticky constraints.
    for (let attempt = 0; attempt < 4; attempt += 1) {
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
        // THROUGH THE SHIPPED DASH SUBSTITUTION, which this harness bypassed
        // on its first run and so reported three em dashes as an R3 failure.
        // `generateMessage` is not called here (it runs a regen loop this
        // measurement deliberately does not want), but `replaceDashes` is a
        // DETERMINISTIC rewrite applied to every body on the real path, so
        // omitting it measured a body production would never send. Confirmed
        // 2026-09-30: em dash and en dash become ", " before the send.
        rawBody = object.body
        body = replaceDashes(object.body)
        error = null
        break
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
    }

    const reference =
      body === null ? null : findsReference(body, c.question, c.answer)
    const visit = body === null ? null : findsVisitClaim(body)
    const voice = body === null ? null : findsVoiceProblems(body)
    const unsaidNames =
      body === null ? [] : findsUnsaidNames(body, c.question, c.answer)

    log.appendUnit({
      index: index + 1,
      caseNumber: run.caseNumber,
      extra: run.extra,
      unsaidNames,
      kind: c.kind,
      question: c.question,
      answer: c.answer,
      body,
      rawBody,
      dashRewritten: rawBody !== null && rawBody !== body,
      error,
      reference,
      visit,
      voice,
    })
    if (body !== null) (run.extra ? extraBodies : bodies).push(body)
    if (!run.extra && rawBody !== null && rawBody !== body) rewrittenCount += 1

    console.log(
      run.extra
        ? `--- EXTRA of case ${run.caseNumber} (${c.kind}), not in the bars ---`
        : `--- ${index + 1}/${CASES.length} (${c.kind}) ---`,
    )
    console.log(`  asked:  ${c.question}`)
    console.log(`  we said: ${c.answer}`)
    console.log(`  BODY:   ${body ?? `(failed: ${error})`}`)
    if (reference) {
      console.log(
        `  bar1 references both: ${reference.referencesBoth ? 'yes' : 'NO'}  names our suggestion: ${reference.namesSuggestion ? 'yes' : 'NO'}  q=[${reference.sharedWithQuestion.join(' ')}] a=[${reference.sharedWithAnswerOnly.join(' ')}]`,
      )
    }
    if (visit) {
      console.log(`  bar2 clean: ${describeVisit(visit)}`)
    }
    if (unsaidNames.length > 0) {
      console.log(
        `  names in neither the question nor our answer: ${unsaidNames.join(', ')}`,
      )
    }
    if (
      voice &&
      (voice.emDash || voice.namedSpeaker.length || voice.loyalty.length)
    ) {
      console.log(
        `  voice: emDash=${voice.emDash} named=${voice.namedSpeaker.join(',')} loyalty=${voice.loyalty.join(',')}`,
      )
    }
    console.log('')
  }

  // ---- Report ----
  const units = bodies.length
  const bar1 = CASES.filter((c, i) =>
    bodies[i] === undefined
      ? false
      : findsReference(bodies[i], c.question, c.answer).referencesBoth,
  ).length
  const suggestion = CASES.filter((c, i) =>
    bodies[i] === undefined
      ? false
      : findsReference(bodies[i], c.question, c.answer).namesSuggestion,
  ).length
  const bar2 = bodies.filter((b) => findsVisitClaim(b).clean).length
  const repetition = findsRepetition(bodies)

  console.log('=== TAC-386 arm B ===')
  console.log(`generated ${units} of ${CASES.length}`)
  console.log(
    `  bar 1 references both halves: ${bar1}/${units} ${bar1 === units ? 'PASS' : 'FAIL'}`,
  )
  console.log(
    `  names our suggestion (candidate only, see ReferenceVerdict): ${suggestion}/${units}`,
  )
  console.log(
    `  bar 2 never asks about, presumes or pushes the visit: ${bar2}/${units} ${bar2 === units ? 'PASS' : 'FAIL'}`,
  )
  console.log(
    `  bar 3 worst shared phrase in ${repetition.worst} of ${units} (limit ${repetition.limit}): ${repetition.withinBar ? 'PASS' : 'FAIL'}`,
  )
  if (repetition.phrases.length > 0) {
    console.log('  most repeated phrases:')
    for (const p of repetition.phrases.slice(0, 8)) {
      console.log(`    ${p.count}x  ${JSON.stringify(p.phrase)}`)
    }
  }
  if (extraBodies.length > 0) {
    console.log(
      `  extras generated (not in any bar above): ${extraBodies.length}. Hand-read each for a fact we did not say.`,
    )
  }
  const dashRewrites = rewrittenCount
  console.log(
    `  dash rewrites applied by the shipped path: ${dashRewrites} of ${units}`,
  )
  const voiceProblems = bodies
    .map((b, i) => ({ i: i + 1, v: findsVoiceProblems(b) }))
    .filter(
      ({ v }) => v.emDash || v.namedSpeaker.length > 0 || v.loyalty.length > 0,
    )
  console.log(
    `  voice checks: ${voiceProblems.length === 0 ? 'clean' : `${voiceProblems.length} with problems`}`,
  )
  console.log(
    '\nDETECTORS ARE NOT THE VERDICT. Hand-read every body above against the three bars.',
  )
  console.log(`run log: ${log.path}`)

  const allPassed =
    units === CASES.length &&
    bar1 === units &&
    bar2 === units &&
    repetition.withinBar &&
    voiceProblems.length === 0
  if (!allPassed) process.exitCode = 1
}

void main()
