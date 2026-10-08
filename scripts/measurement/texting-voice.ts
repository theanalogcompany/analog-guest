// Texting voice (2026-10-07): do answers read like the venue's own team
// texting, or like a brochure.
//
// The pilot venue's owner read the live replies and would not go live on them:
// "what's filter coffee?" came back as 56 words of definition with a bracketed
// aside. The five questions he asked are the first five units below, verbatim;
// that guest has since been deleted, so they are fixtures and not replays. The
// next twelve are the common ones, constructed. The last three are guests who
// need a fuller answer, where the bar is the opposite: complete, not short.
//
// GENERATE-ONLY. Nothing is sent and nothing is written, with the exception
// every harness on this path reports on itself: buildRuntimeContext calls
// computeGuestState, which persists a guest_states row on a recognition-band
// change. The row count is printed before and after.
//
// EVERY UNIT IS A FIRST CONVERSATION: a guest who said hello, got a welcome,
// and now asks one thing. That is the thread the owner tested on, and the turn
// that renders `## No questions this turn`. An established guest's turn does
// not carry that block and is not measured here.
//
// TWO ARMS.
//
//   treatment  what this checkout composes from the venue as stored: the two
//              new rules, the measured voice profile, the team's real replies
//              as examples, and the length check.
//   control    main, rebuilt: the two rules cut out of the prompt, the persona
//              as it was before the profile was written (a fixture, saved
//              before the write), the voice examples main would load (the
//              switched-off ones back in, the team's real replies out), no
//              length check, the constant split coin.
//
// A control that fails to change the prompt fails the unit, so it can never
// pass as a silent copy of the treatment.
//
// THE LEAVE-ONE-OUT RUN THAT CAME FIRST is not in this file any more. It
// removed, one at a time, the "honest take, then the specifics" rule, three
// persona anti-patterns, the one long voice example, "a warm sentence or two",
// and all but one knowledge passage; none shortened the answers. Its arms
// edited a persona and a corpus that have since changed. Bodies are in the PR.
//
// THE SYSTEM PROMPT IS SPLIT WHERE PRODUCTION SPLITS IT, the stable half with
// a cache breakpoint (five minutes here, an hour in production). The run
// prints how many input tokens were read from cache.
//
// WHAT IT DOES NOT TAKE FROM PRODUCTION. It calls generateObject itself, so
// the self-talk and link regen loop is bypassed; the length check is applied
// here by calling the same functions generateMessage calls. It classifies and
// retrieves once per unit per run. Detectors only narrow the reading: every
// body is printed to be read.
//
// A FAILED UNIT IS NOT A RESULT (scripts/CLAUDE.md, convention 5).

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { generateObject } from 'ai'

import type {
  KnowledgeCorpusChunk as AiKnowledgeCorpusChunk,
  VoiceCorpusChunk as AiVoiceCorpusChunk,
  MessageCategory,
  RecentMessage,
} from '@/lib/ai/types'
import { getGenerationModel } from '@/lib/ai/client'
import { composePrompt } from '@/lib/ai/compose-prompt'
import {
  appendFurtherHelpOffer,
  decideFurtherHelpOffer,
} from '@/lib/ai/further-help-offer'
import {
  composeReplyWithIntention,
  GeneratedMessageSchema,
  MAX_OUTPUT_TOKENS,
  replaceDashes,
  stripTrailingDuplicate,
} from '@/lib/ai/generate-message'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import {
  checkReplyLength,
  countReplyWords,
  replyLengthProfileOf,
  keepsTheFacts,
  shorterReplyConstraint,
} from '@/lib/ai/reply-length'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import { offeredThisConversation } from '@/lib/agent/previous-offer'
import {
  resolveDispatchBubbles,
  resolveOutboundTail,
  bubbleStyleFor,
} from '@/lib/agent/sentence-split'
import {
  buildAiRuntime,
  classifyStage,
  retrieveKnowledgeWithContextStage,
} from '@/lib/agent/stages'
import type { RuntimeContext } from '@/lib/agent/types'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { selectVoicePack, type VoicePackRow } from '@/lib/rag/voice-pack'
import { BrandPersonaSchema, type BrandPersona } from '@/lib/schemas'
import { toParsedGuestContext } from '@/lib/schemas/guest-context'
import { createRunLog } from './run-log'

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

type ArmName = 'treatment' | 'control'

// The two rules this change adds, cut whole for the control. Matched by how
// each opens and where its line ends, so a reworded middle cannot turn the
// control into a copy of the treatment.
const CONTROL_CUTS: readonly { label: string; text: RegExp }[] = [
  {
    label: 'answer first, one point, nothing that sells',
    text: /^- Answer what the guest asked first, before anything else\..*\n/m,
  },
  {
    label: 'never point a guest to the account they are messaging',
    text: /^- Never point a guest to the account or number they are already messaging you on\..*\n/m,
  },
]

/** The persona as stored before the measured profile was written. */
function controlPersona(): BrandPersona {
  const raw: unknown = JSON.parse(
    readFileSync(
      join(
        'scripts',
        'measurement',
        'fixtures',
        'texting-voice-control-persona.json',
      ),
      'utf8',
    ),
  )
  const persona = BrandPersonaSchema.parse(raw)
  if (persona.voiceProfile !== undefined) {
    throw new Error('the control persona fixture carries a voice profile')
  }
  return persona
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

interface Unit {
  id: string
  inbound: string
  /** One of the owner's own five questions, as he typed it. */
  demo?: true
  /** A guest who needs a fuller answer: complete beats short here. */
  fuller?: true
  /** What came before this message. Default: the hello and the welcome. */
  history?: readonly Line[]
}

type Line = readonly ['in' | 'out', string]

/**
 * A hello and the welcome it got. The welcome is the one the agent sent on
 * the 2026-10-07 phone test, kept verbatim because it is worded like an offer
 * of more help: the menu link sent next went out without its offer line until
 * a welcome stopped counting as one.
 */
const GREETING: readonly Line[] = [
  ['in', 'hey'],
  ['out', 'Hey, welcome. Let us know what we can help with'],
]

/** A question answered, for the turns that react to an answer. */
const AFTER_OAT: readonly Line[] = [
  ...GREETING,
  ['in', 'do you have oat milk'],
  ['out', 'Yeah, we do'],
]
const AFTER_REC: readonly Line[] = [
  ...GREETING,
  ['in', 'any recs'],
  ['out', 'The SoFi is our house drink and a great place to start'],
]

const UNITS: readonly Unit[] = [
  { id: 'filter', inbound: 'Whats filter coffee?', demo: true },
  {
    id: 'special',
    inbound: "What's so special about Indian coffee?",
    demo: true,
  },
  { id: 'special-drink', inbound: 'why is the Pink Panther so special?' },
  {
    id: 'special-filter',
    inbound: 'what makes your filter coffee different?',
  },
  { id: 'buy-beans', inbound: 'Where can I buy their beans?', demo: true },
  { id: 'owner', inbound: 'Who owns the cafe?', demo: true },
  { id: 'pictures', inbound: 'Show me pictures of SoFi', demo: true },
  { id: 'hours', inbound: 'what time do you close today?' },
  { id: 'oat', inbound: 'do you have oat milk?' },
  { id: 'parking', inbound: 'is there parking nearby?' },
  { id: 'menu', inbound: "What's the menu here?" },
  { id: 'rec', inbound: 'what should i get?' },
  { id: 'which-beans', inbound: 'which beans should i buy?' },
  { id: 'decaf', inbound: 'do you have decaf?' },
  { id: 'wifi', inbound: 'is there wifi?' },
  { id: 'events', inbound: 'any events coming up?' },
  { id: 'catering', inbound: 'do you do catering?' },
  { id: 'pastries', inbound: 'what pastries do you have?' },
  { id: 'price', inbound: 'how much is a filter coffee?' },
  { id: 'hey', inbound: 'hey', history: [] },
  { id: 'any-recs', inbound: 'any recs' },
  { id: 'ok', inbound: 'ok', history: AFTER_OAT },
  { id: 'haha-nice', inbound: 'haha nice', history: AFTER_REC },
  { id: 'sounds-good', inbound: 'that sounds good', history: AFTER_REC },
  { id: 'excited', inbound: 'excited to try it', history: AFTER_REC },
  {
    id: 'brew',
    inbound: 'how do I brew with the brass filter?',
    fuller: true,
  },
  {
    id: 'cater-30',
    inbound: 'can you cater 30 people next Friday?',
    fuller: true,
  },
  {
    id: 'two-questions',
    inbound: 'do you have oat milk? and is there parking nearby?',
    fuller: true,
  },
]

// ---------------------------------------------------------------------------
// Detectors. Every body is printed to be read; these only count.
// ---------------------------------------------------------------------------

// The owner's list, as given. Matched on word stems.
const MARKETING =
  /\b(unique\w*|special|unesco|biodivers\w*|replicate\w*|ends up in the cup)\b/i
// Wider, reported beside it and never part of the bar: the same claim in
// other words is the displacement a banned-word list invites.
const MARKETING_WIDER =
  /\b(world heritage|one of a kind|like no(where| other)|nowhere else|anywhere else|unlike any|renowned|finest|world[- ]class|exceptional|extraordinary|truly|rich heritage|centuries)\b/i

function detect(answer: string): Record<string, boolean> {
  return {
    parenthetical: /[()]/.test(answer),
    marketing: MARKETING.test(answer),
    marketingWider: MARKETING_WIDER.test(answer),
    pointsToOwnAccount: /@\w+|\b(our|on) (instagram|insta|ig)\b/i.test(answer),
  }
}

function emojiCount(text: string): number {
  return (text.match(/\p{Extended_Pictographic}/gu) ?? []).length
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

// ---------------------------------------------------------------------------

type BaseCtx = Awaited<ReturnType<typeof buildRuntimeContext>>

function unitContext(
  base: BaseCtx,
  persona: BrandPersona,
  unit: Unit,
  now: Date,
): RuntimeContext {
  const firstContact = new Date(now.getTime() - 20 * 60_000)
  const history = unit.history ?? GREETING
  const recentMessages = history.map(([dir, body], i) => ({
    direction: dir === 'in' ? 'inbound' : 'outbound',
    body,
    createdAt: new Date(now.getTime() - (history.length - i) * 60_000),
    delivery: 'delivered',
    // The welcome is stored as small talk, as production stores it; every
    // other line of ours here answers a question.
    category: dir === 'in' ? null : i === 1 ? 'casual_chatter' : 'new_question',
  })) as RecentMessage[]
  return {
    ...base,
    // The arm's persona, so everything derived from it downstream (the emoji
    // coin, the usual reply length) is the arm's too.
    venue: { ...base.venue, brandPersona: persona },
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
      providerMessageId: `texting-voice-${unit.id}`,
      body: unit.inbound,
      receivedAt: now,
      channel: 'instagram',
      referralSource: null,
    },
    recentMessages,
    wroteBeforeHistoryWindow: false,
    // NOTHING OF THE REAL GUEST'S (the TAC-575 contamination: a leaked open
    // comp reached a ruling).
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

async function main(): Promise<void> {
  const venueSlug = process.env.MEASURE_VENUE ?? 'le-mils-coffee-test'
  const armName = (process.env.MEASURE_ARM ?? 'treatment') as ArmName
  if (armName !== 'treatment' && armName !== 'control') {
    throw new Error('MEASURE_ARM must be "treatment" or "control"')
  }
  const reps = Number(process.env.MEASURE_REPS ?? '3')
  if (!Number.isInteger(reps) || reps < 1) {
    throw new Error('MEASURE_REPS must be a positive whole number')
  }
  const unitIds = (
    process.env.MEASURE_UNITS ?? UNITS.map((x) => x.id).join(',')
  )
    .split(',')
    .map((x) => x.trim())
  const units = UNITS.filter((x) => unitIds.includes(x.id))
  if (units.length !== unitIds.length) {
    throw new Error(`MEASURE_UNITS names an unknown unit: ${unitIds.join(',')}`)
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
    .order('created_at', { ascending: true })
    .limit(1)
  const guestId = candidates?.[0]?.id
  if (!guestId) throw new Error(`need one Instagram guest at ${venueSlug}`)

  const { count: statesBefore } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  const now = new Date()
  const base = await buildRuntimeContext({
    agentRunId: randomUUID(),
    guestId,
    venueId: venue.id,
    trace: startAgentTrace({ name: 'texting-voice', agentRunId: randomUUID() }),
    currentMessage: {
      id: randomUUID(),
      providerMessageId: `texting-voice-probe-${randomUUID()}`,
      body: 'hi',
      receivedAt: now,
      channel: 'instagram' as const,
      referralSource: null,
    },
  })

  const isControl = armName === 'control'
  const persona = isControl ? controlPersona() : base.venue.brandPersona
  if (!isControl && persona.voiceProfile === undefined) {
    throw new Error(
      `${venueSlug} has no voice profile stored: the treatment arm would measure nothing new`,
    )
  }
  const lengthProfile = isControl ? null : replyLengthProfileOf(persona)
  const bubbleStyle = bubbleStyleFor(persona.voiceProfile)

  // The voice examples each arm would load. The control gets what main loads
  // from the venue as it was: the examples since switched off are back, and
  // the team's real replies, which did not exist, are out.
  const { data: voiceRows, error: voiceError } = await db
    .from('voice_corpus')
    .select('id, content, source_type, confidence_score, tags, created_at')
    .eq('venue_id', venue.id)
  if (voiceError) throw new Error(`voice_corpus: ${voiceError.message}`)
  const stored: VoicePackRow[] = voiceRows ?? []
  const corpus = selectVoicePack(
    isControl
      ? stored
          .filter((r) => r.source_type !== 'past_message')
          .map((r) => ({ ...r, tags: r.tags.filter((t) => t !== 'inactive') }))
      : stored,
  )
  const realReplies = corpus.filter((c) => c.sourceType === 'past_message')
  if (!isControl && realReplies.length === 0) {
    throw new Error(`${venueSlug} has none of the team's real replies stored`)
  }
  const ragChunks: AiVoiceCorpusChunk[] = corpus.map((ch) => ({
    id: ch.id,
    text: ch.text,
    sourceType: ch.sourceType as AiVoiceCorpusChunk['sourceType'],
    relevanceScore: ch.similarity,
  }))

  const log = createRunLog({
    name: `texting-voice-${armName}`,
    meta: {
      arm: armName,
      promptVersion: PROMPT_VERSION,
      venue: venueSlug,
      venueStatus: venue.status,
      guestId,
      units: units.map((x) => x.id),
      reps,
      lengthProfile,
      bubbleStyle,
      voiceProfile: persona.voiceProfile ?? null,
      emojiPolicy: persona.emojiPolicy,
      voiceExamples: ragChunks.length,
      realReplies: realReplies.length,
      constructed:
        'every thread is constructed: a hello, a welcome, then the question. Classified and retrieved once per unit per run.',
    },
  })
  console.log(
    `[texting-voice] arm=${armName} prompt=${PROMPT_VERSION} venue=${venueSlug} reps=${reps} examples=${ragChunks.length} (${realReplies.length} real replies) length check=${lengthProfile ? `past ${lengthProfile.maxWords} words` : 'none'} split coin=${bubbleStyle.splitProbability} message limit=${bubbleStyle.maxBubbleWords ?? 'none'}`,
  )
  console.log(`[texting-voice] run log: ${log.path}`)

  const cache = { read: 0, write: 0, uncached: 0, calls: 0 }
  const simpleWords: number[] = []
  const tallies: Record<string, number> = {}
  let emoji = 0
  let done = 0
  let failed = 0
  let lengthRetries = 0
  let fullerRetries = 0
  let fullerSplit = 0
  let fullerDone = 0
  let longMessages = 0

  for (const unit of units) {
    const ctx = unitContext(base, persona, unit, now)
    ctx.corpus = corpus
    let category: MessageCategory
    let knowledge: AiKnowledgeCorpusChunk[]
    try {
      category = (await classifyStage(ctx)).category
      knowledge = (
        await retrieveKnowledgeWithContextStage(ctx, category, unit.inbound)
      ).map((c) => ({
        id: c.id,
        text: c.text,
        sourceType: c.sourceType,
        primaryTags: c.primaryTags,
        secondaryTags: c.secondaryTags,
        relevanceScore: c.similarity,
      }))
    } catch (e) {
      failed += reps
      const error = e instanceof Error ? e.message : String(e)
      log.appendUnit({ unit: unit.id, failed: true, error })
      console.log(`\n${unit.id} FAILED before generation: ${error}`)
      continue
    }
    console.log(
      `\n${unit.id} [${category}]${unit.fuller ? ' [needs a fuller answer]' : ''} ${JSON.stringify(unit.inbound)}`,
    )

    for (let rep = 0; rep < reps; rep += 1) {
      try {
        const runtime = buildAiRuntime(ctx)
        const composed = composePrompt({
          category,
          persona,
          venueInfo: ctx.venue.venueInfo,
          ragChunks,
          knowledgeChunks: knowledge,
          runtime,
          channel: 'instagram',
        })
        let prefix = composed.cacheableSystemPrefix
        const suffix = composed.volatileSystemSuffix
        let user = composed.userPrompt
        if (process.env.MEASURE_CUT_FULL_ANSWER === '1') {
          const next = user.replace(
            /\s*Asking nothing is not the same as saying little:[^.]*\./,
            '',
          )
          if (next === user) {
            throw new Error('the full-answer sentence was not in this prompt')
          }
          user = next
        }
        // Leave-one-out: the closed venue's "Next open <day> at <time>." in
        // `## Right now`, to see whether a turn with nothing to answer is
        // reaching for it.
        if (process.env.MEASURE_CUT_NEXT_OPEN === '1') {
          const next = user.replace(/ Next open [^.]*\./, '')
          if (next === user) {
            throw new Error('no "Next open" line: is the venue open right now?')
          }
          user = next
        }
        if (isControl) {
          for (const cut of CONTROL_CUTS) {
            const next = prefix.replace(cut.text, '')
            if (next === prefix) {
              throw new Error(`cut "${cut.label}" found nothing to remove`)
            }
            prefix = next
          }
        }

        const generate = async (userPrompt: string) => {
          const { object, usage, providerMetadata } = await generateObject({
            model: getGenerationModel(),
            messages: [
              {
                role: 'system',
                content: prefix,
                providerOptions: {
                  anthropic: { cacheControl: { type: 'ephemeral' } },
                },
              },
              { role: 'system', content: suffix },
              ...composed.historyTurns,
              { role: 'user', content: userPrompt },
            ],
            schema: GeneratedMessageSchema,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          })
          cache.read += usage?.cachedInputTokens ?? 0
          cache.write +=
            (providerMetadata?.anthropic?.cacheCreationInputTokens as
              number | null | undefined) ?? 0
          cache.uncached += usage?.inputTokenDetails?.noCacheTokens ?? 0
          cache.calls += 1
          // No unit renders an intentions block, so production drops any
          // question the model emits; and none carries a review ask.
          return {
            object,
            answer: composeReplyWithIntention(object.body, '').body,
          }
        }

        let attempt = await generate(user)
        const first = checkReplyLength(
          {
            answer: attempt.answer,
            category,
            inbound: unit.inbound,
            previous: runtime.previousExchange ?? null,
            knowledgeGap: attempt.object.knowledgeGap,
          },
          lengthProfile,
        )
        let firstAnswer: string | null = null
        let retryOutcome: string | null = null
        if (first.verdict === 'too_long' && lengthProfile !== null) {
          lengthRetries += 1
          if (unit.fuller) fullerRetries += 1
          firstAnswer = attempt.answer
          const retry = await generate(
            `${user}\n\n${shorterReplyConstraint(lengthProfile)}`,
          )
          // What generateMessage does: the retry ships only if it is shorter
          // and kept every fact the first answer carried.
          const shorter =
            countReplyWords(retry.answer) < countReplyWords(attempt.answer)
          retryOutcome = !shorter
            ? 'kept_first'
            : keepsTheFacts(attempt.answer, retry.answer)
              ? 'shortened'
              : 'kept_first_content'
          if (retryOutcome === 'shortened') attempt = retry
        }
        const { object, answer } = attempt

        const offerLine = replaceDashes(object.furtherHelpOffer).trim()
        const beforeOffer =
          offerLine === '' ? answer : stripTrailingDuplicate(answer, offerLine)
        const offer = decideFurtherHelpOffer({
          body: beforeOffer,
          offer: offerLine,
          category,
          commitment: object.commitment,
          repliesToGuest: true,
          signsOff: object.closedTheConversation,
          onComplaintTurn: object.complaintIntent !== 'none',
          carriesAnAsk: false,
          knowledgeGap: object.knowledgeGap,
          correctingVisit: false,
          offeredThisConversation: offeredThisConversation(
            ctx.recentMessages,
            now,
            ctx.conversationWindowMs,
          ),
        })
        const sendsOffer = offer.append && beforeOffer.trim() !== ''
        const reply = sendsOffer
          ? appendFurtherHelpOffer(beforeOffer, offerLine)
          : answer
        // What the guest would receive: the messages dispatch makes of it,
        // with the offer peeled off as its own.
        const bubbles = resolveDispatchBubbles(
          reply,
          Math.random,
          resolveOutboundTail('', '', 0, sendsOffer ? offerLine : ''),
          bubbleStyle,
        )
        const answerBubbles = bubbles.length - (sendsOffer ? 1 : 0)
        // The answer alone is what the bars read. The offer line is a
        // separate message with its own rule and is not this change's.
        const words = countReplyWords(beforeOffer)
        const flags = detect(beforeOffer)
        const emojis = emojiCount(reply)
        if (unit.fuller) {
          fullerDone += 1
          if (answerBubbles > 1) fullerSplit += 1
        } else {
          simpleWords.push(words)
        }
        // The bar on message length: no single message of the answer runs
        // past the venue's limit. The offer line is not the answer.
        const limit = bubbleStyle.maxBubbleWords
        if (
          limit !== undefined &&
          bubbles
            .slice(0, answerBubbles)
            .some((b) => countReplyWords(b) > limit)
        ) {
          longMessages += 1
        }
        emoji += emojis
        for (const [k, v] of Object.entries(flags)) {
          if (v) tallies[k] = (tallies[k] ?? 0) + 1
        }
        if (object.knowledgeGap) {
          tallies.knowledgeGap = (tallies.knowledgeGap ?? 0) + 1
        }
        if (reply.includes('!')) {
          tallies.exclamation = (tallies.exclamation ?? 0) + 1
        }
        if (/[:;]-?\)/.test(reply)) {
          tallies.smiley = (tallies.smiley ?? 0) + 1
        }
        if (/\d, \d/.test(reply)) {
          tallies.brokenRange = (tallies.brokenRange ?? 0) + 1
        }
        if (/^\p{Ll}/u.test(beforeOffer.trim())) {
          tallies.startsLowercase = (tallies.startsLowercase ?? 0) + 1
        }
        done += 1
        log.appendUnit({
          unit: unit.id,
          demo: unit.demo === true,
          fuller: unit.fuller === true,
          rep,
          failed: false,
          category,
          inbound: unit.inbound,
          answer: beforeOffer,
          words,
          bubbles,
          answerBubbles,
          offerLine: sendsOffer ? offerLine : '',
          offerReason: offer.reason,
          knowledgeGap: object.knowledgeGap,
          emojiDirective: runtime.emojiDirective ?? null,
          exclamationDirective: runtime.exclamationDirective ?? null,
          smileyDirective: runtime.smileyDirective ?? null,
          lengthVerdict: first.verdict,
          retryOutcome,
          fullerReason: first.fuller,
          firstAnswer,
          emojis,
          flags,
          knowledge: knowledge.map((k) => k.text),
        })
        const marks = Object.entries(flags)
          .filter(([, v]) => v)
          .map(([k]) => k)
        console.log(
          `  ${String(words).padStart(3)}w ${bubbles.map((b) => JSON.stringify(b)).join(' + ')}${object.knowledgeGap ? '  [GAP: goes to an operator, not the guest]' : ''}${first.fuller ? `  [fuller: ${first.fuller}]` : ''}${marks.length > 0 ? `  {${marks.join(',')}}` : ''}${firstAnswer === null ? '' : `\n       retried for length (${retryOutcome}); first was ${countReplyWords(firstAnswer)}w: ${JSON.stringify(firstAnswer)}`}`,
        )
      } catch (e) {
        failed += 1
        const error = e instanceof Error ? e.message : String(e)
        log.appendUnit({ unit: unit.id, rep, failed: true, error })
        console.log(`  FAILED: ${error}`)
      }
    }
  }

  const { count: statesAfter } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })
  const summary = {
    done,
    failed,
    simpleMedianWords: median(simpleWords),
    simpleLongest: Math.max(0, ...simpleWords),
    emoji,
    lengthRetries,
    fullerDone,
    fullerRetries,
    fullerSplit,
    longMessages,
    tallies,
  }
  console.log(
    `\n[texting-voice] ${armName}: ${done} generated, ${failed} failed, ${cache.calls} model calls.`,
  )
  console.log(
    `  simple questions: median ${summary.simpleMedianWords} words, longest ${summary.simpleLongest}. length retries ${lengthRetries - fullerRetries}.`,
  )
  console.log(
    `  fuller answers: ${fullerDone} generated, ${fullerRetries} retried, ${fullerSplit} sent as more than one message.`,
  )
  console.log(
    `  emoji ${emoji}. ${Object.entries(tallies)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`,
  )
  // The bars, fixed before any generation and evaluated here rather than by
  // eye. Facts and "sounds like a person" are read by hand and are not here.
  if (!isControl) {
    const bars: [string, boolean][] = [
      ['0 parentheticals', (tallies.parenthetical ?? 0) === 0],
      ['0 marketing words from the list', (tallies.marketing ?? 0) === 0],
      [
        'median <= 20 words on simple questions',
        summary.simpleMedianWords <= 20,
      ],
      ['<= 1 emoji across all outputs', emoji <= 1],
      ['no length retry on a fuller answer', fullerRetries === 0],
      ['0 single messages over the message limit', longMessages === 0],
    ]
    for (const [name, pass] of bars) {
      console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`)
    }
  }
  console.log(
    '[texting-voice] counts are detector hits, not verdicts. Read the bodies.',
  )
  console.log(
    `[texting-voice] guest_states rows before/after: ${statesBefore}/${statesAfter}`,
  )
  const inputTokens = cache.read + cache.write + cache.uncached
  const hitRate = inputTokens === 0 ? 0 : cache.read / inputTokens
  console.log(
    `[texting-voice] prompt cache: ${cache.calls} calls, ${inputTokens} input tokens: ${cache.read} read, ${cache.write} written, ${cache.uncached} uncached. hit rate ${(hitRate * 100).toFixed(0)}% of input tokens`,
  )
  log.appendUnit({
    summary: true,
    ...summary,
    cache: { ...cache, inputTokens, hitRate },
  })
  if (failed > 0) {
    console.log('[texting-voice] RUN VOID: a failed unit is not a result')
    process.exit(2)
  }
  process.exit(0)
}

main().catch((e: unknown) => {
  console.error('[texting-voice] crashed:', e instanceof Error ? e.message : e)
  process.exit(2)
})
