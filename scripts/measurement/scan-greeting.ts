// TAC-588: the wording check for the receipt-scan hello.
//
// THE BAR IS POSTED ON THE TICKET BEFORE ANY GENERATION, and evaluated in code
// below. Nothing has been generated against it when it is posted; a re-run
// after the first is informational.
//
//   One run, sixty generations on constructed guests, nothing sent: the three
//   receipt-scan wordings (new, returning, after a complaint), each with and
//   without a first name on file, ten of each. Items rotate through the
//   venue's own menu, half of them marked new to the guest (DISCOVERED).
//
//   Passes when, of the 60:
//     asks a question, BEFORE the code backstop (withoutQuestions)   <= 3
//     asks a question, AFTER it                                      0
//     says they are in the shop ("welcome in", "enjoy your",
//       "while you're here", "see you at the counter")               0
//     mentions a passport or a stamp                                 0
//     names the item it was given                                    >= 57
//   and, of the 30 with no name, 0 ask for one; of the 30 with a name,
//   >= 27 use it; of the 20 after a complaint, 0 apologise and 0 offer
//   anything.
//
//   A generation that fails to produce a body voids the run.
//
// THERE IS NO CONTROL ARM: the comparison is against that bar. The counter
// greeting it replaces asks a question by design, so it is not a control for
// "asks nothing".
//
// THE DETECTORS ARE STRING TESTS and under-detect; every body is printed and
// logged to be read. "Names the item" is the item's name, case-folded, or its
// last word ("cortado" for "Oat Cortado").
//
// NOTHING IS SENT AND NOTHING IS WRITTEN. It builds a runtime context for one
// real guest (read-only), overrides everything a turn reads about them (the
// base guest's commitments, notes, mechanics and visits are cleared: a leaked
// open comp once reached a ruling), and calls the generator. `guest_states`
// is counted before and after, because the context build is the one step that
// could persist anything.
//
//   npm run measure-scan-greeting
//
// MEASURE_VENUE picks the venue (default le-mils-coffee).

import { randomUUID } from 'node:crypto'

import type { VoiceCorpusChunk as AiVoiceCorpusChunk } from '@/lib/ai/types'
import { generateMessage } from '@/lib/ai'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import { withoutQuestions } from '@/lib/agent/scan-arrival'
import {
  buildAiRuntime,
  retrieveCorpusStage,
  retrieveKnowledgeStage,
} from '@/lib/agent/stages'
import type { RuntimeContext } from '@/lib/agent/types'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { toParsedGuestContext } from '@/lib/schemas/guest-context'
import { createRunLog } from './run-log'

const PER_CELL = 10
const MS_PER_DAY = 24 * 60 * 60 * 1000

const VARIANTS = ['new', 'returning', 'after_complaint'] as const

const PRESENCE_PHRASES = [
  'welcome in',
  'enjoy your',
  "while you're here",
  'while you’re here',
  'see you at the counter',
]
const OFFER_WORDS = [
  'on us',
  'on the house',
  'free',
  'complimentary',
  'discount',
  'our treat',
  'make it up',
  'refund',
]
const asksForName = (body: string): boolean =>
  /\b(your name|what should i call|who('?s| is) this)\b/i.test(body)
const mentionsPassport = (body: string): boolean => /passport|stamp/i.test(body)
const apologises = (body: string): boolean => /sorry|apolog/i.test(body)
const has = (body: string, words: readonly string[]): string[] => {
  const b = body.toLowerCase()
  return words.filter((w) => b.includes(w))
}
const namesItem = (body: string, item: string): boolean => {
  const b = body.toLowerCase()
  const name = item.toLowerCase().trim()
  const last = name.split(/\s+/).at(-1) ?? name
  return b.includes(name) || b.includes(last)
}

async function main(): Promise<void> {
  const venueSlug = process.env.MEASURE_VENUE ?? 'le-mils-coffee'
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
  if (!guestId)
    throw new Error(`need one non-opted-out Instagram guest at ${venueSlug}`)

  const { count: statesBefore } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  const startedAt = new Date()
  const trace = startAgentTrace({
    name: 'tac588-scan-greeting',
    agentRunId: randomUUID(),
  })

  const base = await buildRuntimeContext({
    agentRunId: randomUUID(),
    guestId,
    venueId: venue.id,
    trace,
    followupTrigger: {
      reason: 'instagram_scan_arrival',
      triggeredAt: startedAt,
      instagramScanArrival: {
        scanMessageId: null,
        hadPriorConversation: true,
      },
    },
  })
  const menu = base.venue.venueInfo.menu.items.filter(
    (i) => i.name.trim().length > 0,
  )
  if (menu.length === 0) throw new Error('venue has no menu items to name')

  const corpus = await retrieveCorpusStage(base)
  const ragChunks: AiVoiceCorpusChunk[] = corpus.map((ch) => ({
    id: ch.id,
    text: ch.text,
    sourceType: ch.sourceType as AiVoiceCorpusChunk['sourceType'],
    relevanceScore: ch.similarity,
  }))

  const log = createRunLog({
    name: 'tac588-scan-greeting',
    meta: {
      arm: 'treatment-only',
      promptVersion: PROMPT_VERSION,
      venue: venueSlug,
      venueName: venue.name,
      venueStatus: venue.status,
      guestId,
      units: VARIANTS.length * 2 * PER_CELL,
      bars: {
        questionBeforeBackstop: '<= 3',
        questionAfterBackstop: 0,
        presence: 0,
        passport: 0,
        namesItem: '>= 57',
        noNameAsksForName: 0,
        nameUsed: '>= 27',
        afterComplaintApologise: 0,
        afterComplaintOffer: 0,
      },
      noControlArm:
        'The comparison is against a bar fixed in advance. The counter greeting asks by design.',
    },
  })

  console.log(`[tac588] prompt=${PROMPT_VERSION}`)
  console.log(`[tac588] venue ${venueSlug} "${venue.name}"`)
  console.log(`[tac588] run log: ${log.path}\n`)

  const counts = {
    total: 0,
    questionBefore: 0,
    questionAfter: 0,
    presence: 0,
    passport: 0,
    namesItem: 0,
    noName: { total: 0, asksForName: 0 },
    withName: { total: 0, usesName: 0 },
    afterComplaint: { total: 0, apologise: 0, offer: 0 },
  }
  const failed: { id: string; error: string }[] = []

  let n = 0
  for (const variant of VARIANTS) {
    for (const named of [false, true]) {
      for (let i = 0; i < PER_CELL; i++) {
        const id = `${variant}-${named ? 'name' : 'noname'}-${String(i + 1).padStart(2, '0')}`
        const menuItem = menu[n % menu.length]
        const firstTime = n % 2 === 0
        n += 1
        const order = {
          item: menuItem.name,
          firstTime,
          menuDescription: menuItem.description?.trim() || null,
        }
        const ctx: RuntimeContext = {
          ...base,
          guest: {
            ...base.guest,
            firstName: named ? 'Maya' : null,
            context: toParsedGuestContext({}, startedAt),
            createdAt: new Date(startedAt.getTime() - 40 * MS_PER_DAY),
            firstContactedAt: new Date(startedAt.getTime() - 40 * MS_PER_DAY),
            reviewAskedAt: null,
          },
          recentMessages: [],
          recentVisits: [],
          activeCommitments: [],
          retractableReportedVisits: [],
          mechanics: [],
          conversationChannel: 'instagram',
          firstConversation: variant === 'new',
          openIntentions: [],
          pendingQuestion: null,
          corpus,
          knowledgeCorpus: [],
          scanArrival: {
            hadPriorConversation: variant !== 'new',
            hasRecordedVisit: variant !== 'new',
            afterComplaint: variant === 'after_complaint',
            priorGreetings: [],
            order,
            helloOnly: false,
          },
          classification: {
            category: 'guest_arrived',
            classifierConfidence: 1,
            reasoning: 'Followup trigger: instagram_scan_arrival',
            crisisSafety: false,
            correctsPendingReply: false,
            followUpWorthy: false,
            praisedExperience: false,
          },
        }
        // What handleFollowup retrieves for a receipt-scan hello.
        ctx.knowledgeCorpus = await retrieveKnowledgeStage(
          ctx,
          'guest_arrived',
          order.item,
        )
        const runtime = buildAiRuntime(ctx)
        const gen = await generateMessage({
          category: 'guest_arrived',
          persona: ctx.venue.brandPersona,
          venueInfo: ctx.venue.venueInfo,
          ragChunks,
          // The same mapping generateStage makes.
          knowledgeChunks: ctx.knowledgeCorpus.map((k) => ({
            id: k.id,
            text: k.text,
            sourceType: k.sourceType,
            primaryTags: k.primaryTags,
            secondaryTags: k.secondaryTags,
            relevanceScore: k.similarity,
          })),
          runtime,
          channel: 'instagram',
        })
        if (!gen.ok) {
          failed.push({ id, error: gen.error })
          log.appendUnit({ id, failed: true, error: gen.error })
          console.log(`  ${id}  FAILED: ${gen.error}`)
          continue
        }

        const raw = gen.data.body
        const after = withoutQuestions(raw).body
        const flags = {
          questionBefore: raw.includes('?'),
          questionAfter: after.includes('?'),
          presence: has(after, PRESENCE_PHRASES),
          passport: mentionsPassport(after),
          namesItem: namesItem(after, order.item),
          asksForName: asksForName(raw),
          usesName: /\bmaya\b/i.test(after),
          apologises: apologises(after),
          offers: has(after, OFFER_WORDS),
        }
        counts.total += 1
        if (flags.questionBefore) counts.questionBefore += 1
        if (flags.questionAfter) counts.questionAfter += 1
        if (flags.presence.length > 0) counts.presence += 1
        if (flags.passport) counts.passport += 1
        if (flags.namesItem) counts.namesItem += 1
        if (named) {
          counts.withName.total += 1
          if (flags.usesName) counts.withName.usesName += 1
        } else {
          counts.noName.total += 1
          if (flags.asksForName) counts.noName.asksForName += 1
        }
        if (variant === 'after_complaint') {
          counts.afterComplaint.total += 1
          if (flags.apologises) counts.afterComplaint.apologise += 1
          if (flags.offers.length > 0) counts.afterComplaint.offer += 1
        }
        log.appendUnit({ id, variant, named, order, raw, after, flags })
        console.log(`  ${id}  ${JSON.stringify(after)}`)
      }
    }
  }

  const { count: statesAfter } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  const c = counts
  console.log(`\n[tac588] greetings: ${c.total}`)
  console.log(`  asks before the backstop: ${c.questionBefore} (bar <= 3)`)
  console.log(`  asks after the backstop: ${c.questionAfter} (bar 0)`)
  console.log(`  says they are in the shop: ${c.presence} (bar 0)`)
  console.log(`  mentions a passport or stamp: ${c.passport} (bar 0)`)
  console.log(`  names the item: ${c.namesItem} (bar >= 57)`)
  console.log(
    `  no name, asks for one: ${c.noName.asksForName}/${c.noName.total} (bar 0)`,
  )
  console.log(
    `  with a name, uses it: ${c.withName.usesName}/${c.withName.total} (bar >= 27)`,
  )
  console.log(
    `  after a complaint, apologises / offers: ${c.afterComplaint.apologise} / ${c.afterComplaint.offer} (bar 0 / 0)`,
  )

  if (failed.length > 0 || c.total !== VARIANTS.length * 2 * PER_CELL) {
    console.log(`\n[tac588] RUN VOID: ${failed.length} unit(s) failed.`)
    log.appendUnit({ summary: true, void: true, failed })
    process.exit(2)
  }
  if (statesBefore !== statesAfter) {
    console.log('\n[tac588] RUN VOID: guest_states changed during the run.')
    log.appendUnit({ summary: true, void: true, statesBefore, statesAfter })
    process.exit(2)
  }

  const pass =
    c.questionBefore <= 3 &&
    c.questionAfter === 0 &&
    c.presence === 0 &&
    c.passport === 0 &&
    c.namesItem >= 57 &&
    c.noName.asksForName === 0 &&
    c.withName.usesName >= 27 &&
    c.afterComplaint.apologise === 0 &&
    c.afterComplaint.offer === 0
  log.appendUnit({ summary: true, void: false, counts, pass })
  console.log(`\n[tac588] ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}

void main()
