// TAC-513 defect 2: after a complaint, does a plain report of a second item
// still get comped? Generate-only. NOTHING IS SENT and nothing is written to
// the database.
//
// THE BAR IS PRE-REGISTERED on the ticket, posted before this was ever run:
//   - defect population: the item-B comp rate must fall, and the `on` arm must
//     land at 5/50 or below.
//   - control population: the `on` arm must stay at 20/25 or above, and within
//     20% of the `off` arm. A fix that also stops the agent making it right on
//     a real second complaint has not fixed anything.
// A miss is reported as it came out, not re-cut.
//
// THE TWO ARMS DIFFER IN EXACTLY ONE STRING: the TAC-513 paragraph in
// COMP_COMPLAINT_INSTRUCTIONS. The context is built ONCE per rep and reused
// across both arms, so retrieval, history, recognition state and the current
// message are identical and any difference is attributable to the paragraph.
//
// WHY IT COMPOSES THE PROMPT AND CALLS generateObject DIRECTLY, rather than
// going through generateStage. Two reasons, and the first is that there is no
// other way: the category instructions are selected inside composePrompt from
// the category, so there is no parameter, context field or option that can
// vary them per arm. Removing the paragraph from the composed system prompt is
// the only injection point that leaves everything else byte-identical.
//
// The second reason is that it REMOVES A CONFOUND. generateMessage runs a
// regen loop (dash, self-talk, unverified URL, fidelity floor), returns the
// LAST attempt rather than the best, and carries sticky constraints between
// attempts. A rate measured through that loop mixes the paragraph's effect
// with the loop's. One attempt per rep, N reps, is the cleaner measurement of
// the question being asked.
//
// WHAT THAT COSTS, stated rather than left to be discovered: this measures
// GENERATION, not what ships. In production a reply carrying an obligation
// queues for an operator (commitment_type_gated), so an item-B comp counted
// here is a draft an operator would see, not a message a guest receives. The
// defect being measured is upstream of that gate and is what the ticket is
// about: the agent deciding, unprompted, that the venue owes something.
//
// SYNTHETIC HISTORY. The turn-1 complaint and its comp are injected into
// ctx.recentMessages and ctx.activeCommitments in memory. They are not written
// anywhere. Building them from real rows would need a seeded guest per
// scenario and would vary the guest alongside the variable under test.
//
// TELEMETRY: run with NEXT_PUBLIC_POSTHOG_KEY and SLACK_ALERTS_WEBHOOK_URL
// unset so the stages' events go inert.

import { randomUUID } from 'node:crypto'
import { generateObject } from 'ai'

import {
  classifyStage,
  buildAiRuntime,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
  shouldRetrieveKnowledge,
} from '@/lib/agent/stages'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import { createAdminClient } from '@/lib/db/admin'
import { getGenerationModel } from '@/lib/ai/client'
import { composePrompt } from '@/lib/ai/compose-prompt'
import {
  GeneratedMessageSchema,
  MAX_OUTPUT_TOKENS,
  VOICE_FIDELITY_INSTRUCTION,
} from '@/lib/ai/generate-message'
import { COMP_COMPLAINT_INSTRUCTIONS } from '@/lib/ai/prompts/categories/comp-complaint'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { startAgentTrace } from '@/lib/observability/langfuse'
import type {
  KnowledgeCorpusChunk as AiKnowledgeCorpusChunk,
  VoiceCorpusChunk as AiVoiceCorpusChunk,
} from '@/lib/ai'
import { createRunLog } from './run-log'

/**
 * The anchor the arms inject after. It is the block's opening assertion, and
 * the paragraph under test qualifies it, so it has to sit immediately next to
 * it: three paragraphs later the model has already been told to say sorry and
 * make it up to them.
 */
const ANCHOR = 'The guest is telling you something went wrong.'

/**
 * TAC-513's paragraph, which was tried in comp-complaint.ts and REVERTED
 * (ruled 2026-09-22). It lives here now rather than being sliced out of the
 * live constant, which is the inversion that keeps this harness runnable: with
 * the paragraph unshipped, the `off` arm is simply the prompt as it composes
 * today, and the other arms inject.
 *
 * Measured over two runs, 325 generations: defect population item-B comp
 * 29/100 to 0/100, control population 26/50 to 7/50. It closes the defect and
 * takes AC 5 with it.
 */
const TAC_513_PARAGRAPH =
  'If their message names another item but does not say anything was wrong with it, you do not know that anything was. Ask how it was. Do not apologise for it and do not offer anything on it until they tell you.'

/**
 * The second wording, which added an explicit hand-back for the genuine case.
 * It scored IDENTICALLY to the first on the control metric (3/25 both), which
 * is the result that moved TAC-514 away from category-instruction wording
 * altogether.
 */
const CANDIDATE_PARAGRAPH =
  'If their message names another item but does not say anything was wrong with it, you do not know that anything was. Ask how it was, and do not apologise for it or offer anything on it until they answer. If they do say something was wrong with it, that is a second complaint: treat it exactly like the first.'

/**
 * `off` is the SHIPPED prompt, untouched. The other two inject their paragraph
 * after the anchor.
 *
 * This is the inverse of how the harness ran during TAC-513, when the paragraph
 * was briefly committed and `off` was "shipped minus the paragraph". The arms
 * mean the same thing either way; what changed is which side needs surgery, and
 * doing it this way means the harness keeps working with nothing unshipped
 * sitting in comp-complaint.ts.
 */
const PARAGRAPH_BY_ARM: Record<string, string | null> = {
  off: null,
  on: TAC_513_PARAGRAPH,
  candidate: CANDIDATE_PARAGRAPH,
}

const ARMS = ['off', 'on', 'candidate'] as const

interface Scenario {
  id: string
  /** Defect population, or the AC-5 control. */
  population: 'report' | 'complaint'
  /** What the guest complained about on turn 1, and what we comped. */
  itemA: string
  /** The item named on turn 2. The metric asks whether THIS got comped. */
  itemB: string
  /** Distinctive lowercase words that identify item B in a description. */
  itemBWords: string[]
  /** Turn 1, the guest's complaint. */
  complaint: string
  /** Turn 2, the message under test. */
  report: string
}

/**
 * Ten in the defect population, five controls.
 *
 * The phrasings VARY deliberately. "i also got the X" is the exact incident
 * wording and would be the easiest thing in the world to fix narrowly; a
 * paragraph that only works on that one sentence has not fixed the class. The
 * set includes a bare "and the X", a question-shaped one, and one where item B
 * arrives with a neutral adjective ("the big one"), which is the case most
 * likely to read as a complaint to a model looking for one.
 *
 * The controls are genuine second complaints and are the AC-5 half: they must
 * keep getting a remedy. One of them ("same with the X") is deliberately terse,
 * because a terse real complaint is what a too-broad fix would break first.
 *
 * EVERY ITEM IS ON LE MIL'S REAL MENU, and the first validation run is why. An
 * earlier set used generic cafe items (matcha, almond croissant, scone) and the
 * model correctly replied "we don't actually have a matcha on the menu" and
 * asked what they meant. That is a question, so it would have scored as the
 * desired behaviour while measuring item existence rather than the paragraph.
 * Re-point these if the run moves to another venue.
 */
const SCENARIOS: Scenario[] = [
  { id: 'incident-verbatim', population: 'report', itemA: 'Cortado', itemB: 'Blossom Tonic', itemBWords: ['blossom', 'tonic'],
    complaint: 'came by earlier today and got the cortado, but it was cold',
    report: 'i also got the blossom tonic' },
  { id: 'got-one-too', population: 'report', itemA: 'Flat White', itemB: 'Gulab Jamun Cake', itemBWords: ['gulab', 'jamun'],
    complaint: 'the flat white I picked up this morning was really bitter',
    report: 'got a gulab jamun cake too' },
  { id: 'bare-and', population: 'report', itemA: 'Latte', itemB: 'Pink Panther', itemBWords: ['pink', 'panther'],
    complaint: 'my latte was lukewarm when I got it today',
    report: 'and the pink panther' },
  { id: 'oh-and', population: 'report', itemA: 'Spiced Cold Brew', itemB: 'Mango Lassi', itemBWords: ['mango lassi', 'lassi'],
    complaint: 'the spiced cold brew tasted off today, kind of sour',
    report: 'oh and I had a mango lassi' },
  { id: 'we-also-had', population: 'report', itemA: 'Cappuccino', itemB: 'Rose Pistachio Barfi', itemBWords: ['rose', 'pistachio'],
    complaint: 'cappuccino this morning was pretty much cold by the time I sat down',
    report: 'we also had a rose pistachio barfi' },
  { id: 'neutral-adjective', population: 'report', itemA: 'Espresso', itemB: 'Mango Cardamom Barfi', itemBWords: ['cardamom', 'mango cardamom'],
    complaint: 'the espresso I got was burnt tasting',
    report: 'I got one of the big mango cardamom barfis as well' },
  { id: 'question-shaped', population: 'report', itemA: 'Americano', itemB: 'SoFi', itemBWords: ['sofi'],
    complaint: 'americano was watery today, not what I usually get',
    report: 'do you still do the SoFi? I got one of those today' },
  { id: 'my-friend-had', population: 'report', itemA: 'Almost Latte', itemB: 'Pour Over', itemBWords: ['pour over', 'pour-over'],
    complaint: 'almost latte was cold when I got to the office',
    report: 'my friend had a pour over' },
  { id: 'plus-the', population: 'report', itemA: 'Latte', itemB: 'Blossom Tonic', itemBWords: ['blossom', 'tonic'],
    complaint: 'the latte was way too sweet and kind of gritty',
    report: 'plus the blossom tonic' },
  { id: 'ordered-both', population: 'report', itemA: 'Flat White', itemB: 'Pink Panther', itemBWords: ['pink', 'panther'],
    complaint: 'flat white came out wrong, it was basically a cappuccino',
    report: 'ordered a pink panther with it' },

  { id: 'control-was-bad-too', population: 'complaint', itemA: 'Cortado', itemB: 'Blossom Tonic', itemBWords: ['blossom', 'tonic'],
    complaint: 'came by earlier today and got the cortado, but it was cold',
    report: 'the blossom tonic was bad too' },
  { id: 'control-same-with', population: 'complaint', itemA: 'Flat White', itemB: 'Gulab Jamun Cake', itemBWords: ['gulab', 'jamun'],
    complaint: 'the flat white I picked up this morning was really bitter',
    report: 'same with the gulab jamun cake' },
  { id: 'control-as-well', population: 'complaint', itemA: 'Latte', itemB: 'Pink Panther', itemBWords: ['pink', 'panther'],
    complaint: 'my latte was lukewarm when I got it today',
    report: 'the pink panther was flat and warm as well' },
  { id: 'control-couldnt-drink', population: 'complaint', itemA: 'Spiced Cold Brew', itemB: 'Mango Lassi', itemBWords: ['mango lassi', 'lassi'],
    complaint: 'the spiced cold brew tasted off today, kind of sour',
    report: 'the mango lassi was undrinkable honestly, threw it out' },
  { id: 'control-both-wrong', population: 'complaint', itemA: 'Cappuccino', itemB: 'Rose Pistachio Barfi', itemBWords: ['rose', 'pistachio'],
    complaint: 'cappuccino this morning was pretty much cold by the time I sat down',
    report: 'the rose pistachio barfi was stale too, both were off' },
]

const OBLIGATION_TYPES = new Set(['comp', 'hold', 'discount'])

/**
 * THE PRIMARY METRIC, deterministic and computed from the structured emission
 * rather than the prose.
 *
 * An obligation carrier whose description names item B is exactly what created
 * comp GWPZ in the incident, and it is what becomes a `guest_commitments` row
 * on approval. Matching on the item's distinctive words rather than the whole
 * name, because the model writes "replacement blossom tonic" and "the tonic"
 * for the same thing.
 */
function compsItemB(
  commitment: { type?: string; description?: string },
  itemBWords: string[],
): boolean {
  if (commitment.type === undefined || !OBLIGATION_TYPES.has(commitment.type)) return false
  const description = (commitment.description ?? '').toLowerCase()
  return itemBWords.some((w) => description.includes(w))
}

function parseArgs() {
  const argv = process.argv.slice(2)
  const get = (flag: string) => {
    const i = argv.indexOf(flag)
    return i === -1 ? undefined : argv[i + 1]
  }
  const venue = get('--venue')
  const guest = get('--guest')
  if (venue === undefined || guest === undefined) {
    console.error(
      'usage: tsx scripts/measurement/complaint-then-report.ts --venue <slug> --guest <uuid> [--reps 5] [--out <path>] [--force]',
    )
    process.exit(2)
  }
  return {
    venue,
    guest,
    reps: Number(get('--reps') ?? 5),
    out: get('--out'),
    force: argv.includes('--force'),
  }
}

async function main() {
  const args = parseArgs()

  // Two guards, both of which have caught something.
  //
  // The anchor must still be in the block, or every injecting arm silently
  // composes identically to `off` and the run measures nothing.
  if (!COMP_COMPLAINT_INSTRUCTIONS.includes(ANCHOR)) {
    console.error(
      `\u2717 the anchor is no longer in COMP_COMPLAINT_INSTRUCTIONS: ${ANCHOR}\n  Every injecting arm would compose identically to off; refusing to run.`,
    )
    process.exit(1)
  }
  // And the paragraph must NOT already be shipped, or `off` is not a baseline.
  if (COMP_COMPLAINT_INSTRUCTIONS.includes(TAC_513_PARAGRAPH)) {
    console.error(
      '\u2717 the TAC-513 paragraph is already in COMP_COMPLAINT_INSTRUCTIONS, so the off arm is not a baseline. Refusing to run.',
    )
    process.exit(1)
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

  const log = createRunLog({
    name: 'tac513-complaint-then-report',
    outputPath: args.out,
    force: args.force,
    meta: {
      arm: 'both',
      promptVersion: PROMPT_VERSION,
      venue: venue.slug,
      guestId: args.guest,
      reps: args.reps,
      scenarios: SCENARIOS.map((s) => `${s.population}:${s.id}`),
      paragraphs: PARAGRAPH_BY_ARM,
      note: 'generate-only; nothing sent, nothing written to the database; one attempt per rep, no regen loop',
    },
  })
  console.log(`run log: ${log.path}`)
  console.log(`${SCENARIOS.length} scenarios x ${ARMS.length} arms x ${args.reps} reps\n`)

  const trace = startAgentTrace({
    name: 'measurement.complaint-then-report',
    agentRunId: randomUUID(),
    metadata: { venueId: venue.id, guestId: args.guest },
  })

  for (const scenario of SCENARIOS) {
    for (let rep = 0; rep < args.reps; rep += 1) {
      const ctx = await buildRuntimeContext({
        agentRunId: randomUUID(),
        guestId: args.guest,
        venueId: venue.id,
        trace,
        currentMessage: {
          id: randomUUID(),
          providerMessageId: `measurement-${scenario.id}-${rep}`,
          body: scenario.report,
          receivedAt: new Date(),
          // The incident guest reached the venue on Instagram and has no phone
          // number. Saying 'text' here makes resolveConversationChannel warn
          // and fall back, which is a confound worth removing.
          channel: 'instagram',
        },
      })

      // The synthetic turn-1 exchange, in memory only. This is what makes the
      // turn a SECOND turn: without it the model has no complaint to read the
      // report against, which is the whole situation under test.
      const now = Date.now()
      ctx.recentMessages = [
        {
          direction: 'inbound',
          body: scenario.complaint,
          createdAt: new Date(now - 120_000),
          delivery: 'delivered',
        },
        {
          direction: 'outbound',
          body: `really sorry about that. come back and I'll have another ${scenario.itemA} made for you on us. give me a heads up when you're heading over`,
          createdAt: new Date(now - 90_000),
          delivery: 'delivered',
        },
      ]
      // EVERYTHING ELSE THE GUEST CARRIES IS NEUTRALISED, and the probe that
      // found the schema bug is why. This is the INCIDENT guest, so their real
      // history contains the very exchange under test, and the model quoted it
      // back: "Last time they said this, it turned out the blossom tonic was
      // fine and only the cortado was the complaint." A model that remembers
      // the answer is not being asked the question.
      //
      // It would not BIAS the arm comparison, since it is identical on both
      // sides, but it can suppress the defect on BOTH arms, and an `off` arm
      // that does not reproduce proves nothing either way (the TAC-409 lesson
      // about control arms). So the only history any scenario sees is the
      // synthetic turn-1 above.
      ctx.recentVisits = []
      ctx.guest.context = { observations: [], life_context: [] }
      ctx.openIntentions = []
      ctx.pendingQuestion = null
      ctx.activeCommitments = [
        {
          id: randomUUID(),
          type: 'comp',
          description: `replacement ${scenario.itemA}`,
          code: 'AB12',
          status: 'open',
          expected_arrival: null,
          arrival_signal: null,
          created_at: new Date(now - 90_000).toISOString(),
        },
      ]

      // THE CATEGORY IS FORCED, and the first validation run is why.
      //
      // The classifier returned `reply` for the incident's own wording in this
      // setup, so COMP_COMPLAINT_INSTRUCTIONS never rendered and both arms were
      // byte-identical. The guard below caught it and refused to record the
      // pair, which is the only reason this is a design note rather than a
      // silent 0-vs-0 result.
      //
      // Forcing it is the right call, not a workaround. The incident turn WAS
      // classified comp_complaint (the outbound row's category records it), and
      // the fix under test is scoped to what comp_complaint generation does. So
      // the question this run answers is precisely: given that label, does the
      // paragraph change what the model emits? The classification half of
      // defect 2 is evidenced by the production rows on the ticket and is not
      // what this measures.
      //
      // The classifier still RUNS and its verdict is logged, because how often
      // each phrasing routes to comp_complaint is worth knowing on its own and
      // this is the only place it gets measured.
      const classification = await classifyStage(ctx)
      const category = 'comp_complaint' as const
      ctx.classification = { ...classification, category }
      ctx.corpus = await retrieveCorpusStage(ctx)
      ctx.knowledgeCorpus = shouldRetrieveKnowledge(ctx)
        ? await retrieveKnowledgeStage(ctx, category, scenario.report)
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

      const { systemPrompt, userPrompt } = composePrompt({
        category,
        persona: ctx.venue.brandPersona,
        venueInfo: ctx.venue.venueInfo,
        ragChunks,
        knowledgeChunks,
        runtime: buildAiRuntime(ctx),
        channel: ctx.conversationChannel,
      })

      for (const arm of ARMS) {
        // The one difference. `off` is the shipped prompt minus the paragraph,
        // so nothing else about the composition can vary between arms.
        // The one difference between arms: which paragraph, if any, is
        // injected after the anchor.
        const paragraph = PARAGRAPH_BY_ARM[arm] ?? null
        const composed =
          paragraph === null
            ? systemPrompt
            : systemPrompt.replace(ANCHOR, `${ANCHOR}\n\n${paragraph}`)
        if (paragraph !== null && composed === systemPrompt) {
          console.error(
            `\u2717 ${scenario.id} rep${rep} ${arm}: injection did not change the prompt (category ${category}); refusing to record a meaningless pair.`,
          )
          process.exit(1)
        }

        // VOICE_FIDELITY_INSTRUCTION is appended exactly as generateMessage
        // appends it. composePrompt does NOT include it, and without it the
        // model returns voiceFidelity on a 1-to-10 scale, which the schema's
        // [0,1] refine rejects and generateObject reports as
        // "response did not match schema". That is what 11 of 14 first-run
        // generations hit, and four byte-identical re-asks could not fix it,
        // because it was systematic rather than intermittent. The constant's
        // own comment in generate-message.ts documents the failure; the
        // harness simply was not sending it.
        const system = `${composed}\n\n${VOICE_FIDELITY_INSTRUCTION}`

        let body: string | null = null
        let commitment: { type?: string; description?: string } = {}
        let cancels = ''
        let error: string | null = null
        let calls = 0
        // A BOUNDED RE-ASK ON A SCHEMA FAILURE, and the first validation run is
        // why this exists: 11 of 14 generations threw "response did not match
        // schema", and the raw output showed the cause is the model emitting
        // `voiceFidelity: 9` on a 1-to-10 scale where the schema refines to
        // 0-to-1. That is PRE-EXISTING behaviour, not anything this ticket
        // added (cancelsCommitmentId came back as "" every time), and
        // production never sees it because generateMessage's regen loop
        // re-asks. Dropping that loop to remove a confound removed the retry
        // with it.
        //
        // This is NOT the regen loop. The prompt is byte-identical on every
        // attempt: no feedback, no sticky constraints, no accumulated
        // instructions. It re-asks the same question until the answer parses,
        // which keeps "one attempt's worth of prompt" true while absorbing a
        // failure that has nothing to do with either arm.
        for (let attempt = 0; attempt < 4; attempt += 1) {
          calls += 1
          try {
            const { object } = await generateObject({
              model: getGenerationModel(),
              system,
              prompt: userPrompt,
              schema: GeneratedMessageSchema,
              maxOutputTokens: MAX_OUTPUT_TOKENS,
            })
            body = object.body
            commitment = object.commitment
            cancels = object.cancelsCommitmentId
            error = null
            break
          } catch (e) {
            error = e instanceof Error ? e.message : String(e)
          }
        }

        const compedB = compsItemB(commitment, scenario.itemBWords)
        const lowered = (body ?? '').toLowerCase()
        log.appendUnit({
          scenarioId: scenario.id,
          population: scenario.population,
          rep,
          arm,
          category,
          // What the classifier would have said, left of the forcing. Reported
          // as its own number; it is not the metric.
          classifierCategory: classification.category,
          classifierConfidence: classification.classifierConfidence,
          inbound: scenario.report,
          itemB: scenario.itemB,
          body,
          error,
          // How many times the model had to be asked before the object parsed.
          // >1 is the voiceFidelity scale confusion, not a property of the arm.
          calls,
          commitmentType: commitment.type ?? null,
          commitmentDescription: commitment.description ?? null,
          // The pre-registered primary metric.
          compedItemB: compedB,
          // Secondary, reported not gating.
          asksAQuestion: lowered.includes('?'),
          mentionsItemB: scenario.itemBWords.some((w) => lowered.includes(w)),
          apologyPhrase:
            ['sorry', 'apolog', 'that is on us', "that's on us", 'on us'].find((phrase) =>
              lowered.includes(phrase),
            ) ?? null,
          // TAC-513's own carrier, recorded because this population is exactly
          // where a spurious cancellation would show up if one ever did.
          cancelsCommitmentId: cancels,
        })

        const mark = error !== null ? '·' : compedB ? '✗' : '✓'
        console.log(
          `${mark} ${scenario.population.padEnd(9)} ${scenario.id.padEnd(22)} rep${rep} ${arm.padEnd(3)} ${
            error !== null ? `(error: ${error})` : compedB ? `COMPED ${commitment.description}` : ''
          }`,
        )
      }
    }
  }

  await trace.flushAsync()
  console.log(`\nDone. ${log.path}`)
  console.log('Count compedItemB by arm AND by population. Never pool them.')
}

main().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
