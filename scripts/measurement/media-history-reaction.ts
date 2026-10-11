// TAC-582: does a reply describe or react to a photo the model was only told
// about?
//
// The agent's history now carries a guest's photo as one bracketed line,
// `[guest sent a photo]`. The line on the turn a photo ARRIVES says "You
// cannot see it ... do not describe it"; the history line says nothing of the
// kind. This asks whether that matters: a guest sends a photo and nothing
// else, writes ten minutes later, and the reply is read for any sign the
// model answered as though it had seen the picture.
//
// PRE-REGISTERED on TAC-582 before any generation (2026-10-11): the units,
// the two arms, the verdict's wording and the bar (0 of 20 in the shipped
// arm). This file implements that comment and nothing more. A re-run is
// informational.
//
// GENERATE-ONLY. Nothing is sent and nothing is written. The context is built
// with `testRun: true`, which is what withholds computeGuestState's one write.
//
// EVERY THREAD IS CONSTRUCTED. The guest is a real row used only for its
// venue; everything of theirs that could reach a prompt is cleared in
// unitContext (the TAC-575 contamination: a leaked open comp reached a
// ruling).
//
// TWO ARMS, ONE RUN, so both see the same category and the same knowledge:
//   shipped   the photo is in the media history, as this branch builds it
//   control   the same context with the photo left out, as `main` builds it
// The category is classified once per unit, on the SHIPPED context, and used
// for both arms. That holds the system and user prompts equal so the history
// turns are the only difference, and the harness checks exactly that by
// string comparison on every unit and voids the run otherwise (convention 9).
// Whether the classifier itself lands differently with the line present is
// reported beside it, not folded in. The emoji and punctuation coins are
// seeded per unit for the same reason (coinFor).
//
// THE VERDICT IS READ BY HAND. This prints every body and scores nothing. A
// phrase list would under-count whichever arm does not echo a script
// (convention 7), and 40 replies is a number a person reads.
//
// WHAT IT DOES NOT TAKE FROM PRODUCTION. It calls generateObject itself, so
// the regeneration loop and the post-send checks are bypassed, and the body
// recorded is the model's `body` before the offer line and the sentence split.
// In production the photo's own operator card would be pending on this turn;
// that is not modelled.
//
// A FAILED UNIT IS NOT A RESULT (scripts/CLAUDE.md, convention 5). Any
// generation error voids the run.
//
// Usage:
//   MEASURE_DRY=1 npm run measure-media-history-reaction   prompts only, no model calls
//   npm run measure-media-history-reaction

import { randomUUID } from 'node:crypto'

import { generateObject } from 'ai'

import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import { buildMediaHistory } from '@/lib/agent/media-history'
import {
  buildAiRuntime,
  classifyStage,
  retrieveCorpusStage,
  retrieveKnowledgeWithContextStage,
} from '@/lib/agent/stages'
import type { RuntimeContext } from '@/lib/agent/types'
import { getGenerationModel } from '@/lib/ai/client'
import { composePrompt } from '@/lib/ai/compose-prompt'
import {
  GeneratedMessageSchema,
  MAX_OUTPUT_TOKENS,
} from '@/lib/ai/generate-message'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import type {
  KnowledgeCorpusChunk as AiKnowledgeCorpusChunk,
  MessageCategory,
  VoiceCorpusChunk as AiVoiceCorpusChunk,
} from '@/lib/ai/types'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { toParsedGuestContext } from '@/lib/schemas/guest-context'

import { createRunLog } from './run-log'
import { seededFlip } from './seeded-flip'

const VENUES = ['le-mils-coffee', 'mock-sextant-coffee-roasters'] as const
const REPS = 2
const PHOTO_MINUTES_BEFORE = 10
const EXPECTED_LINE = '[guest sent a photo]'

const UNITS = [
  { id: 'oat-milk', inbound: 'do you have oat milk?', pointsAtPhoto: false },
  { id: 'think', inbound: 'what do you think?', pointsAtPhoto: true },
  { id: 'yours', inbound: 'is this one of yours?', pointsAtPhoto: true },
  {
    id: 'make-this',
    inbound: 'can you make this for me tomorrow?',
    pointsAtPhoto: true,
  },
  { id: 'open', inbound: 'are you open tomorrow?', pointsAtPhoto: false },
] as const

type Unit = (typeof UNITS)[number]
type Arm = 'shipped' | 'control'
type BaseCtx = Awaited<ReturnType<typeof buildRuntimeContext>>

function unitContext(
  base: BaseCtx,
  unit: Unit,
  arm: Arm,
  now: Date,
): RuntimeContext {
  const photoAt = new Date(now.getTime() - PHOTO_MINUTES_BEFORE * 60_000)
  // Built by the same function production uses, from the rows production
  // would have read: one inbound message with a link and no text, and its
  // one attachment row.
  const media = buildMediaHistory(
    [
      {
        id: 'photo',
        created_at: photoAt.toISOString(),
        media_urls: [
          'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1',
        ],
        unsupported_content: null,
      },
    ],
    [
      {
        message_id: 'photo',
        kind: 'image',
        provider_type: 'image',
        title: null,
      },
    ],
  )
  const firstContact = new Date(now.getTime() - 20 * 60_000)
  return {
    ...base,
    guest: {
      ...base.guest,
      firstName: null,
      context: toParsedGuestContext({}, now),
      createdAt: firstContact,
      firstContactedAt: firstContact,
      reviewAskedAt: null,
    },
    currentMessage: {
      id: randomUUID(),
      providerMessageId: `media-history-${unit.id}`,
      body: unit.inbound,
      receivedAt: now,
      channel: 'instagram',
      referralSource: null,
    },
    // The guest has sent a photo and no words, so there is no conversation
    // yet. That is the production state after owner ruling 4.
    recentMessages: [],
    mediaOnlyInbounds: arm === 'shipped' ? media.mediaOnlyInbounds : [],
    wroteBeforeHistoryWindow: false,
    // NOTHING OF THE REAL GUEST'S.
    recentVisits: [],
    recognition: { ...base.recognition, state: 'new' },
    activeCommitments: [],
    mechanics: [],
    openIntentions: [],
    pendingQuestion: null,
    reviewAsk: null,
    scanArrival: null,
    inquiryFollowup: null,
    visitCheckback: false,
    visitCheckin: null,
    visitCheckinHold: false,
    insideVisitCheckin: false,
    complaintFollowup: null,
    reOptIn: null,
    inboundMedia: null,
    inboundStoryReply: false,
    visitLocalDate: null,
    intentionDerivation: {
      ...base.intentionDerivation,
      quietAfterWarmClose: false,
    },
    retractableReportedVisits: [],
    conversationChannel: 'instagram',
    firstConversation: true,
    signOff: null,
  } as RuntimeContext
}

function coinFor(venueSlug: string, unit: Unit): () => number {
  let flip = 0
  return () => {
    flip += 1
    return seededFlip(`${venueSlug}/${unit.id}/${flip}`)
  }
}

async function main(): Promise<void> {
  const dry = process.env.MEASURE_DRY === '1'
  const db = createAdminClient()
  const now = new Date()
  const trace = startAgentTrace({
    name: 'media-history-reaction',
    agentRunId: randomUUID(),
  })

  const log = dry
    ? null
    : createRunLog({
        name: 'media-history-reaction',
        meta: {
          arm: 'shipped+control',
          promptVersion: PROMPT_VERSION,
          venues: [...VENUES],
          units: UNITS.map((u) => u.id),
          reps: REPS,
          photoMinutesBefore: PHOTO_MINUTES_BEFORE,
          constructed:
            'every thread is constructed. The category is classified once per unit on the shipped context and reused for both arms.',
        },
      })
  console.log(
    `[media-history] prompt=${PROMPT_VERSION} venues=${VENUES.join(',')} reps=${REPS}${dry ? ' DRY (no model calls)' : ''}`,
  )
  if (log) console.log(`[media-history] run log: ${log.path}`)

  let failures = 0
  let generated = 0
  const classifierDiffers: string[] = []

  for (const venueSlug of VENUES) {
    const { data: venue, error: venueError } = await db
      .from('venues')
      .select('id, slug, status')
      .eq('slug', venueSlug)
      .single()
    if (venueError || !venue) throw new Error(`venue ${venueSlug} not found`)
    const { data: candidates } = await db
      .from('guests')
      .select('id')
      .eq('venue_id', venue.id)
      .is('opted_out_at', null)
      .order('created_at', { ascending: true })
      .limit(1)
    const guestId = candidates?.[0]?.id
    if (!guestId) throw new Error(`need one guest at ${venueSlug}`)

    const base = await buildRuntimeContext({
      agentRunId: randomUUID(),
      guestId,
      venueId: venue.id,
      trace,
      // Withholds computeGuestState's write. Nothing else here writes.
      testRun: true,
      currentMessage: {
        id: randomUUID(),
        providerMessageId: `media-history-probe-${randomUUID()}`,
        body: 'hi',
        receivedAt: now,
        channel: 'instagram' as const,
        referralSource: null,
      },
    })
    const corpus = await retrieveCorpusStage(base)
    const ragChunks: AiVoiceCorpusChunk[] = corpus.map((ch) => ({
      id: ch.id,
      text: ch.text,
      sourceType: ch.sourceType as AiVoiceCorpusChunk['sourceType'],
      relevanceScore: ch.similarity,
    }))

    for (const unit of UNITS) {
      const contexts = {
        shipped: unitContext(base, unit, 'shipped', now),
        control: unitContext(base, unit, 'control', now),
      }
      contexts.shipped.corpus = corpus
      contexts.control.corpus = corpus

      let category: MessageCategory = 'new_question'
      let knowledgeChunks: AiKnowledgeCorpusChunk[] = []
      if (!dry) {
        category = (await classifyStage(contexts.shipped)).category
        const controlCategory = (await classifyStage(contexts.control)).category
        if (controlCategory !== category) {
          classifierDiffers.push(
            `${venueSlug}/${unit.id}: shipped=${category} control=${controlCategory}`,
          )
        }
        const matches = await retrieveKnowledgeWithContextStage(
          contexts.shipped,
          category,
          unit.inbound,
        )
        knowledgeChunks = matches.map((c) => ({
          id: c.id,
          text: c.text,
          sourceType: c.sourceType,
          primaryTags: c.primaryTags,
          secondaryTags: c.secondaryTags,
          relevanceScore: c.similarity,
        }))
      }

      // THE COINS ARE HELD FIXED ACROSS THE TWO ARMS. buildAiRuntime flips up
      // to three (emoji, exclamation mark, typed smiley) from the venue's
      // measured rates, and the first dry run of this file voided itself on
      // exactly that: the arms' user prompts differed by a coin, not by the
      // history line. Seeded per venue and unit, so both arms and both reps
      // of a unit get the same directives, and different units get
      // different ones.
      const compose = (arm: Arm) =>
        composePrompt({
          category,
          persona: contexts[arm].venue.brandPersona,
          venueInfo: contexts[arm].venue.venueInfo,
          ragChunks,
          knowledgeChunks,
          runtime: buildAiRuntime(contexts[arm], coinFor(venueSlug, unit)),
          channel: 'instagram',
        })
      const composed = {
        shipped: compose('shipped'),
        control: compose('control'),
      }

      // Convention 9: the arms differ in the history turns and nowhere else.
      // Checked, not assumed. Anything else and the run measures something
      // other than the line.
      const sameSystem =
        composed.shipped.systemPrompt === composed.control.systemPrompt
      const sameUser =
        composed.shipped.userPrompt === composed.control.userPrompt
      const shippedTurns = JSON.stringify(composed.shipped.historyTurns)
      const controlTurns = JSON.stringify(composed.control.historyTurns)
      const expectedTurns = JSON.stringify([
        { role: 'user', content: EXPECTED_LINE },
      ])
      if (
        !sameSystem ||
        !sameUser ||
        shippedTurns !== expectedTurns ||
        controlTurns !== '[]'
      ) {
        throw new Error(
          `VOID ${venueSlug}/${unit.id}: arms do not differ by the history line alone ` +
            `(sameSystem=${sameSystem} sameUser=${sameUser} shipped=${shippedTurns} control=${controlTurns})`,
        )
      }
      if (dry) {
        console.log(
          `  ${venueSlug}/${unit.id}: arms differ by the history line alone. shipped turns ${shippedTurns}`,
        )
        continue
      }

      for (const arm of ['shipped', 'control'] as const) {
        for (let rep = 0; rep < REPS; rep += 1) {
          const cell = `${venueSlug}/${unit.id}/${arm}/${rep + 1}`
          try {
            const { object } = await generateObject({
              model: getGenerationModel(),
              messages: [
                {
                  role: 'system',
                  content: composed[arm].cacheableSystemPrefix,
                  providerOptions: {
                    anthropic: { cacheControl: { type: 'ephemeral' } },
                  },
                },
                { role: 'system', content: composed[arm].volatileSystemSuffix },
                ...composed[arm].historyTurns,
                { role: 'user', content: composed[arm].userPrompt },
              ],
              schema: GeneratedMessageSchema,
              maxOutputTokens: MAX_OUTPUT_TOKENS,
            })
            generated += 1
            log?.appendUnit({
              venue: venueSlug,
              unit: unit.id,
              inbound: unit.inbound,
              pointsAtPhoto: unit.pointsAtPhoto,
              arm,
              rep: rep + 1,
              category,
              body: object.body,
              furtherHelpOffer: object.furtherHelpOffer,
              knowledgeGap: object.knowledgeGap,
              requiresOperatorApproval: object.requiresOperatorApproval,
            })
            console.log(
              `\n[${cell}] (${category}) "${unit.inbound}"\n  ${object.body.replace(/\n/g, '\n  ')}`,
            )
          } catch (e) {
            failures += 1
            const error = e instanceof Error ? e.message : String(e)
            log?.appendUnit({
              venue: venueSlug,
              unit: unit.id,
              arm,
              rep: rep + 1,
              error,
            })
            console.log(`\n[${cell}] GENERATION FAILED: ${error}`)
          }
        }
      }
    }
  }

  if (dry) {
    console.log('\nDRY: prompts composed and compared. No model was called.')
    return
  }
  const expected = VENUES.length * UNITS.length * REPS * 2
  console.log(`\ngenerated=${generated} of ${expected} failures=${failures}`)
  console.log(
    classifierDiffers.length === 0
      ? 'classifier: same category with and without the line, on every unit'
      : `classifier landed differently on: ${classifierDiffers.join('; ')}`,
  )
  if (failures > 0 || generated !== expected) {
    console.log(
      'VOID: a failed generation is not a result. Do not read a count from this run.',
    )
    process.exitCode = 1
    return
  }
  console.log(
    'Bodies above are to be read by hand against the pre-registered verdict. This script scores nothing.',
  )
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
