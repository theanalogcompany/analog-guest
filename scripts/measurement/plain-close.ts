// TAC-578: the once-ever close, in its two shapes, for a hand-read.
//
// Ruled 2026-10-07 from a live phone test: ten generations of each shape,
// read by Jaipal before the branch merges. THERE IS NO MECHANICAL VERDICT. The
// counts printed are what code can see of the three rules, as an aid to the
// read and not a substitute for it:
//
//   never a list of examples of what they can ask about
//   after an offer of more help already went out in the conversation, the
//     warm line only, with no open door
//   otherwise the warm line plus one short open-door clause, two short
//     sentences at most
//
// The two arms share ten guests. In `after_offer` our answer ends with an
// offer of more help, which is what production's own detector reads
// (lib/agent/previous-offer.ts); the harness does not set the flag, so a
// detector that missed the offer would show up as an open door in that arm.
//
// GENERATE-ONLY, one call at a time through generateMessage so each reads the
// cached system prefix. Counted against the ticket's cap, which these twenty
// take three past 450: they were asked for after the cap was set.

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
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { toParsedGuestContext } from '@/lib/schemas/guest-context'
import { createRunLog } from './run-log'

const MAX_MODEL_CALLS = 453

/** What ten guests asked, what we said, and the offer the second arm adds. */
const EXCHANGES: readonly { asked: string; answered: string; offer: string }[] =
  [
    {
      asked: 'what time do you close today?',
      answered: "we're open till 3 today",
      offer: 'let us know if you need anything else',
    },
    {
      asked: 'do you have oat milk?',
      answered: 'yep, oat and almond',
      offer: 'happy to help with anything else',
    },
    {
      asked: 'is there wifi?',
      answered: 'there is, the password is on the counter',
      offer: 'just ask if you need a hand with anything',
    },
    {
      asked: 'can i bring my dog?',
      answered: 'dogs are welcome out front',
      offer: 'let us know if you have any other questions',
    },
    {
      asked: 'which beans would you get for a moka pot at home?',
      answered: 'the darker house blend, ground a little coarser than espresso',
      offer: 'happy to walk you through brewing it if you want',
    },
    {
      asked: 'is there parking nearby?',
      answered: 'street parking, usually easy before noon',
      offer: 'let us know if you need anything else',
    },
    {
      asked: 'do you take card?',
      answered: 'card and tap, yes',
      offer: 'anything else, just ask',
    },
    {
      asked: 'anything decaf?',
      answered: 'yes, any espresso drink can be decaf',
      offer: 'happy to suggest one if you want',
    },
    {
      asked: 'are you open on sundays?',
      answered: 'we are, same hours',
      offer: 'let us know if you need anything else',
    },
    {
      asked: 'do you have somewhere to sit and work?',
      answered: 'a few tables inside, quieter after lunch',
      offer: 'happy to help if you have other questions',
    },
  ]

type Arm = 'no_offer_yet' | 'after_offer'

const turn = (
  direction: 'inbound' | 'outbound',
  body: string,
  createdAt: Date,
): RecentMessage =>
  ({ direction, body, createdAt, delivery: 'delivered' }) as RecentMessage

/** Sentences as a guest would count them: an emoji alone is not one. */
const sentenceCount = (body: string): number =>
  body
    .split(/[.!?\n]+/)
    .map((p) => p.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((p) => p.length > 0).length

/** Wording that tells the guest they can write to us. Wide on purpose. */
const OPEN_DOOR =
  /\b(message|text|write|reach|dm|ping|here (?:if|when|anytime|whenever)|anytime|any time|whenever|always here|just ask|let us know|let me know|holler|shout)\b/i

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

  const startedAt = new Date()
  const trace = startAgentTrace({
    name: 'tac578-plain-close',
    agentRunId: randomUUID(),
  })
  const at = (minutesAgo: number): Date =>
    new Date(startedAt.getTime() - minutesAgo * 60_000)

  // Built ONCE, as the pause timer's own trigger would build it.
  const baseCtx = await buildRuntimeContext({
    agentRunId: randomUUID(),
    guestId,
    venueId: venue.id,
    trace,
    followupTrigger: {
      reason: 'warm_close',
      triggeredAt: startedAt,
      warmClose: { answersMessageId: randomUUID(), signOff: 'plain' },
    },
  })
  const corpus = await retrieveCorpusStage(baseCtx)
  const ragChunks: AiVoiceCorpusChunk[] = corpus.map((ch) => ({
    id: ch.id,
    text: ch.text,
    sourceType: ch.sourceType as AiVoiceCorpusChunk['sourceType'],
    relevanceScore: ch.similarity,
  }))

  const arms: readonly Arm[] = ['no_offer_yet', 'after_offer']
  const planned = EXCHANGES.length * arms.length
  const log = createRunLog({
    name: 'tac578-plain-close',
    meta: {
      arm: 'hand-read-two-shapes',
      promptVersion: PROMPT_VERSION,
      venue: venueSlug,
      venueName: venue.name,
      venueStatus: venue.status,
      guestId,
      units: planned,
      maxModelCalls: MAX_MODEL_CALLS,
      alreadySpent,
      noVerdict:
        'A hand-read. The counts are what code can see of the three rules and are not a bar.',
    },
  })
  console.log(
    `[tac578] prompt=${PROMPT_VERSION} venue=${venueSlug} generations=${planned} spent-before=${alreadySpent} cap=${MAX_MODEL_CALLS}`,
  )
  let modelCalls = alreadySpent
  const spend = (n: number): void => {
    if (modelCalls + n > MAX_MODEL_CALLS) {
      throw new Error(
        `budget: would take the ticket past ${MAX_MODEL_CALLS} model calls (at ${modelCalls})`,
      )
    }
    modelCalls += n
  }

  const outputs: {
    id: string
    arm: Arm
    body: string
    blockSaidAfterOffer: boolean
  }[] = []
  const failed: string[] = []
  const cache = { calls: 0, hits: 0 }

  for (const arm of arms) {
    for (const [i, x] of EXCHANGES.entries()) {
      const id = `${arm}-${String(i + 1).padStart(2, '0')}`
      const ctx: RuntimeContext = {
        ...baseCtx,
        guest: {
          ...baseCtx.guest,
          firstName: null,
          context: toParsedGuestContext({}, startedAt),
          createdAt: at(20),
          firstContactedAt: at(20),
          reviewAskedAt: null,
        },
        recentMessages: [
          turn('inbound', x.asked, at(14)),
          turn(
            'outbound',
            arm === 'after_offer' ? `${x.answered}. ${x.offer}` : x.answered,
            at(13),
          ),
        ],
        recentVisits: [],
        // NOTHING OF THE REAL GUEST'S (TAC-575's contaminated run).
        activeCommitments: [],
        retractableReportedVisits: [],
        mechanics: [],
        conversationChannel: 'instagram',
        firstConversation: true,
        openIntentions: [],
        pendingQuestion: null,
        corpus,
        knowledgeCorpus: [],
        signOff: 'plain',
        reviewAsk: null,
        classification: {
          category: 'acknowledgment',
          classifierConfidence: 1,
          reasoning: 'Followup trigger: warm_close',
          crisisSafety: false,
          correctsPendingReply: false,
          followUpWorthy: false,
          praisedExperience: false,
        },
      }
      const runtime = buildAiRuntime(ctx)
      spend(1)
      const gen = await generateMessage({
        category: 'acknowledgment',
        persona: ctx.venue.brandPersona,
        venueInfo: ctx.venue.venueInfo,
        ragChunks,
        knowledgeChunks: [],
        runtime,
        channel: 'instagram',
      })
      if (!gen.ok) {
        failed.push(id)
        log.appendUnit({ id, arm, failed: true, error: gen.error })
        console.log(`  ${id}  FAILED: ${gen.error}`)
        continue
      }
      if (gen.data.attempts > 1) spend(gen.data.attempts - 1)
      cache.calls += 1
      if (gen.data.cacheReadTokens > 0) cache.hits += 1
      const out = {
        id,
        arm,
        body: gen.data.body,
        blockSaidAfterOffer: runtime.closeAfterOffer === true,
      }
      outputs.push(out)
      log.appendUnit({ ...out, asked: x.asked, attempts: gen.data.attempts })
      console.log(
        `  ${id}  <- ${JSON.stringify(x.asked)}${arm === 'after_offer' ? `  [our answer ended: ${JSON.stringify(x.offer)}]` : ''}\n      ${JSON.stringify(gen.data.body)}`,
      )
    }
  }
  await trace.flushAsync()

  console.log(
    `\n[tac578] prompt cache: ${cache.hits}/${cache.calls} calls read it. Model calls, ticket total: ${modelCalls}/${MAX_MODEL_CALLS}`,
  )
  if (failed.length > 0) {
    console.log(`[tac578] RUN VOID: failed ${failed.join(', ')}`)
    log.appendUnit({ summary: true, void: true, failed })
    process.exit(2)
  }
  for (const arm of arms) {
    const list = outputs.filter((o) => o.arm === arm)
    const summary = {
      n: list.length,
      detectorSawTheOffer: list.filter((o) => o.blockSaidAfterOffer).length,
      withOpenDoorWording: list
        .filter((o) => OPEN_DOOR.test(o.body))
        .map((o) => o.id),
      overTwoSentences: list
        .filter((o) => sentenceCount(o.body) > 2)
        .map((o) => o.id),
      withLink: list
        .filter((o) => extractUrls(o.body).length > 0)
        .map((o) => o.id),
      withQuestion: list.filter((o) => o.body.includes('?')).map((o) => o.id),
    }
    log.appendUnit({ summary: true, arm, ...summary })
    console.log(
      `[tac578] ${arm}: block rendered as after-offer ${summary.detectorSawTheOffer}/${summary.n}; open-door wording ${summary.withOpenDoorWording.length}/${summary.n}; over two sentences ${summary.overTwoSentences.length}/${summary.n}${summary.overTwoSentences.length > 0 ? ` (${summary.overTwoSentences.join(', ')})` : ''}; link ${summary.withLink.length}; question ${summary.withQuestion.length}`,
    )
  }
  console.log(`[tac578] HAND-READ. No verdict. Log: ${log.path}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
