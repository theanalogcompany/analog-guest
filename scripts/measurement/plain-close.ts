// TAC-578: the once-ever close, for a hand-read.
//
// Ruled 2026-10-07 from two live phone tests: ten generations, read by Jaipal
// before the branch merges. THERE IS NO MECHANICAL VERDICT. The counts printed
// are what code can see of the rules for what the close says, as an aid to the
// read and not a substitute for it:
//
//   a warm line tied to the conversation, plus at most one short open-door
//     clause, two short sentences at most
//   never "message us anytime" verbatim
//   never a list of examples of what they can ask about
//
// WHEN the close is sent is not exercised here: only after the guest signalled
// they were done, and never once an offer of more help has gone out. Both are
// decided in the pause timer before any prompt is composed
// (lib/agent/warm-close-timeout.ts). Every guest here HAS signalled it: each
// thread ends with a thanks, a bye or an emoji from the guest and our short
// reply to it, which is the state the timer sends from.
//
// An earlier version of this file ran two arms of ten (with and without an
// earlier offer) against wording that has since been replaced; its outputs
// are in the run log of 2026-10-07T22-05.
//
// GENERATE-ONLY, one call at a time through generateMessage so each reads the
// cached system prefix. Counted against the ticket's cap, which these ten take
// past 450: they were asked for after the cap was set.

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

const MAX_MODEL_CALLS = 463

/** What ten guests asked, what we said, how they signed off and our reply. */
const EXCHANGES: readonly {
  asked: string
  answered: string
  done: string
  ack: string
}[] = [
  {
    asked: 'what time do you close today?',
    answered: "we're open till 3 today",
    done: 'perfect thanks',
    ack: 'of course',
  },
  {
    asked: 'do you have oat milk?',
    answered: 'yep, oat and almond',
    done: '🙌',
    ack: '🙂',
  },
  {
    asked: 'is there wifi?',
    answered: 'there is, the password is on the counter',
    done: 'great, thank you!',
    ack: 'anytime',
  },
  {
    asked: 'can i bring my dog?',
    answered: 'dogs are welcome out front',
    done: 'amazing, thanks',
    ack: 'you got it',
  },
  {
    asked: 'which beans would you get for a moka pot at home?',
    answered: 'the darker house blend, ground a little coarser than espresso',
    done: 'ok perfect, ordering it now. thanks!',
    ack: 'good choice',
  },
  {
    asked: 'is there parking nearby?',
    answered: 'street parking, usually easy before noon',
    done: 'cool thanks',
    ack: 'sure thing',
  },
  {
    asked: 'do you take card?',
    answered: 'card and tap, yes',
    done: '👍',
    ack: '👍',
  },
  {
    asked: 'anything decaf?',
    answered: 'yes, any espresso drink can be decaf',
    done: 'oh nice, thank you',
    ack: 'of course',
  },
  {
    asked: 'are you open on sundays?',
    answered: 'we are, same hours',
    done: 'ok bye for now!',
    ack: 'bye!',
  },
  {
    asked: 'do you have somewhere to sit and work?',
    answered: 'a few tables inside, quieter after lunch',
    done: 'thanks so much',
    ack: 'no problem',
  },
]

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

  const planned = EXCHANGES.length
  const log = createRunLog({
    name: 'tac578-plain-close',
    meta: {
      arm: 'hand-read',
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

  const outputs: { id: string; body: string }[] = []
  const failed: string[] = []
  const cache = { calls: 0, hits: 0 }

  {
    for (const [i, x] of EXCHANGES.entries()) {
      const id = `close-${String(i + 1).padStart(2, '0')}`
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
          turn('inbound', x.asked, at(15)),
          turn('outbound', x.answered, at(14)),
          turn('inbound', x.done, at(12)),
          turn('outbound', x.ack, at(11)),
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
        log.appendUnit({ id, failed: true, error: gen.error })
        console.log(`  ${id}  FAILED: ${gen.error}`)
        continue
      }
      if (gen.data.attempts > 1) spend(gen.data.attempts - 1)
      cache.calls += 1
      if (gen.data.cacheReadTokens > 0) cache.hits += 1
      const out = { id, body: gen.data.body }
      outputs.push(out)
      log.appendUnit({ ...out, asked: x.asked, attempts: gen.data.attempts })
      console.log(
        `  ${id}  asked ${JSON.stringify(x.asked)}, then ${JSON.stringify(x.done)}\n      ${JSON.stringify(gen.data.body)}`,
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
  const summary = {
    n: outputs.length,
    messageUsAnytimeVerbatim: outputs
      .filter((o) => /message (us|here|me)?\s*any ?time/i.test(o.body))
      .map((o) => o.id),
    withOpenDoorWording: outputs
      .filter((o) => OPEN_DOOR.test(o.body))
      .map((o) => o.id),
    overTwoSentences: outputs
      .filter((o) => sentenceCount(o.body) > 2)
      .map((o) => o.id),
    withLink: outputs
      .filter((o) => extractUrls(o.body).length > 0)
      .map((o) => o.id),
    withQuestion: outputs.filter((o) => o.body.includes('?')).map((o) => o.id),
  }
  log.appendUnit({ summary: true, ...summary })
  console.log(
    `[tac578] "message us anytime" or a near copy ${summary.messageUsAnytimeVerbatim.length}/${summary.n}; some open-door wording ${summary.withOpenDoorWording.length}/${summary.n}; over two sentences ${summary.overTwoSentences.length}/${summary.n}; link ${summary.withLink.length}; question ${summary.withQuestion.length}`,
  )
  console.log(`[tac578] HAND-READ. No verdict. Log: ${log.path}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
