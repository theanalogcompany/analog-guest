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
// what to try). Fifteen runs of ONE question would make bar 3 meaningless:
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
 * The fifteen cases.
 *
 * REDRAWN 2026-10-06 FROM THE VENUE'S OWN KNOWLEDGE (ruled that day). The first
 * set paired each question with an answer written to sound plausible, and the
 * harness retrieves the venue's real knowledge alongside it. Where the two
 * disagreed the model followed retrieval: a body named two beans the venue
 * sells in place of the "Colombia" the fixture said we recommended, and another
 * named a lot at a venue that has none. Those read as copy failures and were
 * partly the fixture's. So every answer below is what Le Mil's knowledge
 * actually says, and where it says nothing (how to find the door, what to do
 * about a bitter cup) the answer is a plain one that contradicts none of it.
 *
 * THIS MAKES THE SET VENUE-SPECIFIC. Run it against another venue and the
 * answers are fiction again; the startup guard does not check that.
 *
 * `outOfScope` cases are still generated and printed, and are left out of bars
 * 1 and 2. Ruled 2026-10-06: a question whose only outcome is a visit (may I
 * bring a dog, which door is yours) has nothing to follow up on, so the fix is
 * the classifier not arming one, not better copy. They stay in the set so the
 * bodies are on record when that classifier change is made.
 */
const CASES: {
  kind: string
  question: string
  answer: string
  outOfScope?: string
}[] = [
  {
    kind: 'parking',
    question: 'where do I park around there',
    answer:
      'Street parking on Polk can be tough, so give yourself a few extra minutes. Muni is a short walk if you would rather skip the car.',
  },
  {
    kind: 'parking',
    question: 'is there parking there',
    answer:
      'Just street parking on Polk, and it can be challenging. Polk is well connected by transit if that is easier.',
  },
  {
    kind: 'directions',
    question: 'whats the easiest way to get to you from the mission',
    answer:
      'Transit is easiest. Polk Street is well connected and we are a short walk from the Muni stops.',
  },
  {
    kind: 'directions',
    question: 'are you the one on the corner or further down the block',
    answer: "We are right on Polk Street, the storefront says Le Mil's.",
    outOfScope: 'finding us: the only outcome is a visit',
  },
  {
    kind: 'beans',
    question: 'which bag should I buy if I like something chocolatey',
    answer:
      'Chikka if you want it dark, it is dark chocolate and roasted malt and made for espresso. Budan is the lighter one, more toffee and hazelnut.',
  },
  {
    kind: 'beans',
    question: 'do you sell coffee beans too',
    answer:
      'We do. Budan, Malenad and Chikka come whole bean or ground, in 10 oz, 1 lb and 5 lb bags on lemils.com.',
  },
  {
    kind: 'beans',
    question: 'whats a good bag for a filter coffee drinker',
    answer:
      'Estate Secret. It is our chicory blend for South Indian filter coffee, 80% Arabica and 20% chicory, and it is what goes into the SoFi.',
  },
  {
    kind: 'brewing',
    question: 'how should I brew the beans I got from you',
    answer:
      'For pour over, 21 grams to about 300ml of water, medium-fine grind, water around 200F. Bloom for 30 seconds, then three pours of about 100ml.',
  },
  {
    kind: 'brewing',
    question: 'my pour over keeps coming out bitter, any ideas',
    answer:
      'Check it against our recipe: 21 grams to about 300ml, a medium-fine grind, water around 200F, and finish in under three minutes.',
  },
  {
    kind: 'brewing',
    question: 'whats the ratio you use for the aeropress',
    answer:
      'We do not have a set Aeropress recipe. Our pour over ratio is 1:14, 21 grams to about 300ml, and we grind medium-fine for Aeropress.',
  },
  {
    kind: 'dogs',
    question: 'can I bring my dog',
    answer: 'Yes, dogs are welcome at the cafe.',
    outOfScope: 'dog policy: the only outcome is a visit',
  },
  {
    kind: 'brewing',
    question: 'how do I make filter coffee at home',
    answer:
      'Two to three tablespoons of Estate Secret in the top of a South Indian filter, press it down lightly, pour a cup of boiling water over and let it drip 10 to 15 minutes. Then half decoction, half hot milk, and sweeten to taste.',
  },
  {
    kind: 'what-to-try',
    question: 'whats something I should try when I get there',
    answer:
      'The SoFi, our South Indian filter coffee. It outsells everything else six to one. The Pink Panther if you want something cold and different.',
  },
  {
    kind: 'what-to-try',
    question: 'what do you recommend, I like coffee but not too sweet',
    answer:
      'Our drinks are not too sweet to begin with. Try the SoFi Classic, or a cortado if you would rather skip sweet altogether.',
  },
  {
    kind: 'what-to-try',
    question: 'whats underrated here',
    answer:
      'The Blossom Tonic. It is the most work to make and somehow the least ordered. It is floral, with a thick foam on top.',
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
  /** Scored bodies only: `outOfScope` cases are generated and left out. */
  const scored: { body: string; c: (typeof CASES)[number] }[] = []
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
    if (body !== null && !run.extra && c.outOfScope === undefined) {
      scored.push({ body, c })
    }
    if (!run.extra && rawBody !== null && rawBody !== body) rewrittenCount += 1

    console.log(
      run.extra
        ? `--- EXTRA of case ${run.caseNumber} (${c.kind}), not in the bars ---`
        : `--- ${index + 1}/${CASES.length} (${c.kind})${c.outOfScope ? ` OUT OF SCOPE for bars 1 and 2, ${c.outOfScope}` : ''} ---`,
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
  const inScope = scored.length
  const bar1 = scored.filter(
    ({ body, c }) => findsReference(body, c.question, c.answer).referencesBoth,
  ).length
  const suggestion = scored.filter(
    ({ body, c }) => findsReference(body, c.question, c.answer).namesSuggestion,
  ).length
  const bar2 = scored.filter(({ body }) => findsVisitClaim(body).clean).length
  const repetition = findsRepetition(bodies)

  console.log('=== TAC-386 arm B ===')
  console.log(`generated ${units} of ${CASES.length}`)
  console.log(
    `  bar 1 references both halves: ${bar1}/${inScope} ${bar1 === inScope ? 'PASS' : 'FAIL'}`,
  )
  console.log(
    `  names our suggestion (candidate only, see ReferenceVerdict): ${suggestion}/${inScope}`,
  )
  console.log(
    `  bar 2 never asks about, presumes or pushes the visit: ${bar2}/${inScope} ${bar2 === inScope ? 'PASS' : 'FAIL'}`,
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
    bar1 === inScope &&
    bar2 === inScope &&
    repetition.withinBar &&
    voiceProblems.length === 0
  if (!allPassed) process.exitCode = 1
}

void main()
