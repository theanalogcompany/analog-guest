// Phone test fixes (2026-10-07): the generation check for the five items.
//
// GENERATE-ONLY. Nothing is sent and nothing is written, with the exception
// every harness on this path reports on itself: buildRuntimeContext calls
// computeGuestState, which persists a guest_states row on a recognition-band
// change. Context is built once per trigger kind and the row count is printed
// before and after.
//
// EVERY THREAD HERE IS CONSTRUCTED. The phone-test rounds were reset, and the
// one surviving thread is a counter-scan exchange that shows none of the
// defects. The threads below were rebuilt from Jaipal's description of each
// (2026-10-07) and are not replays of stored rows.
//
// ARMS ARE PROMPT TRANSFORMS. An arm is a list of edits applied to the
// composed system or user prompt. An edit to text every prompt carries must
// change the prompt or the unit fails. An edit to a block only some turns
// carry may find nothing on a unit, but a cell in which the arm changed no
// prompt at all is void, so a control can never pass as a silent copy of the
// shipped arm.
//
//   shipped   the prompt as composed, untouched
//   control   the same prompt with the latest change's wording taken out
//
// This file has measured three changes (v1.95.0 #344, v1.97.0 #346, v1.98.0),
// and the control is always the latest one's. The earlier arms, including the
// leave-one-out runs and the three rounds that tried to get an offer line out
// of prompt wording alone, are in those pull requests' histories with their
// bodies; they edited text that has since been replaced.
//
// THE SYSTEM PROMPT IS SPLIT WHERE PRODUCTION SPLITS IT: the stable half with
// a cache breakpoint, then the per-message half. (Production's breakpoint has
// a one-hour lifetime; this one has the default five minutes, which a run
// stays well inside.) The run prints how many input
// tokens were read from cache. An arm that edits the stable half pays one
// write and then reads; a run of ~750 uncached generations is what this
// replaced.
//
// WHAT IT DOES NOT TAKE FROM PRODUCTION. It calls generateObject itself, so
// the dash/self-talk/link regen loop is bypassed. It classifies each unit once
// per run and reuses the category across that run's reps. An arm is its own
// run, so two arms can land a unit in different categories; the category is
// logged on every unit so that can be seen. Bodies are hand-read; the
// detectors only narrow the reading and are deliberately wide.
//
// A FAILED UNIT IS NOT A RESULT (scripts/CLAUDE.md, convention 5). Any
// generation error voids its cell.

import { randomUUID } from 'node:crypto'

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
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import { offeredThisConversation } from '@/lib/agent/previous-offer'
import {
  resolveDispatchBubbles,
  resolveOutboundTail,
  replyBubbleStyleFor,
} from '@/lib/agent/sentence-split'
import {
  buildAiRuntime,
  classifyStage,
  retrieveCorpusStage,
  retrieveKnowledgeWithContextStage,
} from '@/lib/agent/stages'
import type { RuntimeContext } from '@/lib/agent/types'
import { createAdminClient } from '@/lib/db/admin'
import type { ReOptIn } from '@/lib/guests/opt-out'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { toParsedGuestContext } from '@/lib/schemas/guest-context'
import { createRunLog } from './run-log'

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

interface Transform {
  label: string
  target: 'system' | 'user'
  apply: (prompt: string) => string
  /** A transform that may legitimately find nothing on some units. */
  optional?: boolean
}

function swap(
  target: Transform['target'],
  label: string,
  from: string,
  to: string,
  optional = false,
): Transform {
  return { label, target, apply: (p) => p.replace(from, to), optional }
}

// What v1.98.0 changed, so the control arm can take it back out: the offer
// section of the system prompt, and one sentence of the back-after-a-pause
// block. Restated here rather than imported, so a typo in the prompt cannot
// make the control agree with it.
const DROP_OFFER_SECTION: Transform = {
  label: 'offer section',
  target: 'system',
  // Required: the section is in every prompt, so a heading that no longer
  // matches must fail the unit rather than leave the section in the control.
  apply: (p) => {
    const start = p.indexOf('# Offering more help\n')
    const end = p.indexOf('# A visit the guest takes back\n')
    return start === -1 || end === -1 ? p : p.slice(0, start) + p.slice(end)
  },
}

const EARLIER_AFTER =
  'They are back in the chat. Do not greet them as someone new and do not introduce the venue again. If their message is only a hello, greet them as someone picking the conversation back up and ask if there is anything else you can help with, in one short line. That is about the chat and not about a visit: unless ## Visit history shows one, do not welcome them back, and say nothing that implies they have been in.'
const EARLIER_BEFORE =
  'They are back. Do not greet them as someone new and do not introduce the venue again. If their message is only a hello, greet them as someone picking the conversation back up and ask if there is anything else you can help with, in one short line.'

const ARMS: Record<string, readonly Transform[]> = {
  shipped: [],
  control: [
    DROP_OFFER_SECTION,
    swap('user', 'earlier wording', EARLIER_AFTER, EARLIER_BEFORE, true),
  ],
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

type Line = readonly ['in' | 'out', string]

interface Unit {
  id: string
  /** Earlier messages, oldest first. Timestamps are assigned two minutes apart. */
  history: readonly Line[]
  /** The guest's message this turn. Absent on the pause-timer close. */
  inbound?: string
  reportedItems?: readonly string[]
  /** Minutes between the end of `history` and this turn. Default: none. */
  gapMinutes?: number
  /** The guest wrote before the history window (an imported thread, say). */
  wroteBeforeHistoryWindow?: boolean
  /** This is the turn that opted the guest back in. */
  reOptIn?: ReOptIn
}

interface Cell {
  id: string
  what: string
  /** `close` is the pause-timer sign-off; everything else is an inbound turn. */
  kind: 'inbound' | 'close'
  /** A guest whose first contact was days ago, so no first-conversation gating. */
  established: boolean
  units: readonly Unit[]
}

const u = (
  id: string,
  inbound: string,
  history: readonly Line[] = [],
): Unit => ({
  id,
  inbound,
  history,
})

/** One apology sent, as a clarifying question. The reply under test is the second. */
const COMPLAINT_ASKED: readonly Line[] = [
  ['in', 'my latte was cold when i got it today'],
  [
    'out',
    "so sorry about that, that's not how it should come out. was it cold right when you picked it up?",
  ],
]

/** Two apologies sent. The reply under test is the third. */
const COMPLAINT_ANSWERED: readonly Line[] = [
  ...COMPLAINT_ASKED,
  ['in', 'yeah right away'],
  [
    'out',
    "really sorry, that shouldn't happen. come back in and we'll make you a fresh one on us",
  ],
]

/** The gentle check already asked (TAC-573); the guest's answer is under test. */
const RETRACTION_CHECKED: readonly Line[] = [
  ['in', 'had a cold brew at yours this morning, so good'],
  ['out', 'love to hear that'],
  ['in', "what are your hours? i've never actually been in"],
  [
    'out',
    "oh wait, didn't you mention a cold brew earlier? or was that somewhere else?",
  ],
]

/** No check asked: the guest takes the visit back unprompted. */
const RETRACTION_UNPROMPTED: readonly Line[] = [
  ['in', 'had a cold brew at yours this morning, so good'],
  ['out', 'love to hear that. glad the cold brew hit the spot'],
]

const CLOSE_EXCHANGES: readonly Line[][] = [
  [
    ['in', 'what time do you close today?'],
    ['out', "we're open till 3 today"],
  ],
  [
    ['in', 'do you have oat milk?'],
    ['out', 'yep, oat and almond'],
  ],
  [
    ['in', 'is there wifi?'],
    ['out', 'there is, the password is on the counter'],
  ],
  [
    ['in', 'can i bring my dog?'],
    ['out', 'dogs are welcome out front'],
  ],
  [
    ['in', 'do you sell beans to take home?'],
    ['out', 'we do, bags are on the shelf by the door'],
  ],
  [
    ['in', 'is there parking nearby?'],
    ['out', 'street parking, usually easy before noon'],
  ],
  [
    ['in', 'do you take card?'],
    ['out', 'card and tap, yes'],
  ],
  [
    ['in', 'anything decaf?'],
    ['out', 'yes, any espresso drink can be decaf'],
  ],
  [
    ['in', 'are you open on sundays?'],
    ['out', 'we are, same hours'],
  ],
  [
    ['in', 'do you have somewhere to sit and work?'],
    ['out', 'a few tables inside, quieter after lunch'],
  ],
]

const CELLS: readonly Cell[] = [
  {
    id: '1-offer',
    what: 'answers that send a link, recommend, help choose, or give instructions',
    kind: 'inbound',
    established: true,
    units: [
      u('menu-link', 'can you send me the menu?'),
      u('shop-link', 'do you have an online shop?'),
      u('rec-first', "what should i get? haven't tried much here"),
      u('rec-beans', 'which beans would you get for pour over?'),
      u('choose', "can't decide between the cortado and the flat white"),
      u('brew', 'how should i brew your beans at home?'),
      u('order-online', 'how do i order beans online?'),
      u('catering', 'do you do catering?'),
      u('wholesale', 'do you sell wholesale?'),
      u('events', 'any events coming up?'),
    ],
  },
  {
    id: '1-fact',
    what: 'single-fact answers',
    kind: 'inbound',
    established: true,
    units: [
      u('close-today', 'what time do you close today?'),
      u('sunday', 'are you open sunday?'),
      u('price', 'how much is a cortado?'),
      u('parking', 'is there parking?'),
      u('address', "what's your address?"),
      u('wifi', 'do you have wifi?'),
      u('dogs', 'can i bring my dog?'),
      u('oat', 'do you have oat milk?'),
      u('card', 'do you take card?'),
      u('open-tomorrow', 'what time do you open tomorrow?'),
    ],
  },
  {
    id: '1-thanks',
    what: 'a thanks after a link was sent: a sign-off, so no offer (constructed)',
    kind: 'inbound',
    established: true,
    units: [
      'thanks!',
      'perfect, thank you',
      'great thanks',
      'ty',
      'ok cool',
    ].map((inbound, i) => ({
      id: `thanks-${i + 1}`,
      inbound,
      history: [
        ['in', 'can you send me the menu?'],
        ['out', 'here you go: https://lemils.com/pages/cafe-menu'],
      ] as const,
      gapMinutes: 1,
    })),
  },
  {
    id: '1-buy-followup',
    what: 'the guest takes up our offer after asking for help buying beans (the 2026-10-07 phone thread, constructed)',
    kind: 'inbound',
    established: true,
    units: [
      'usually black',
      'black mostly',
      'i drink it black',
      'pour over, black',
      'black, no milk',
    ].map((inbound, i) => ({
      id: `black-${i + 1}`,
      inbound,
      history: [
        ['in', 'can you help me buy beans'],
        [
          'out',
          "you can browse everything at https://lemils.com/collections/all happy to point you toward a specific bean if you tell me what you're brewing or how you take your coffee",
        ],
      ] as const,
      gapMinutes: 1,
    })),
  },
  {
    id: '1-greeting',
    what: 'a bare greeting from a guest with no history (constructed from the phone test)',
    kind: 'inbound',
    established: false,
    units: [
      u('hi', 'hi'),
      u('hey', 'hey'),
      u('hello', 'hello'),
      u('hi-there', 'hi there'),
      u('heyy', 'heyy'),
    ],
  },
  {
    id: '2-earlier',
    what: 'a hello half an hour after an answered question (constructed)',
    kind: 'inbound',
    established: true,
    units: ['hey', 'hi', 'hello again', 'hey there', 'hii'].map(
      (inbound, i) => ({
        id: `back-${i + 1}`,
        inbound,
        history: CLOSE_EXCHANGES[i] as readonly Line[],
        gapMinutes: 30,
      }),
    ),
  },
  {
    id: '2-known',
    what: 'a hello from a guest whose only messages predate the history window (constructed)',
    kind: 'inbound',
    established: true,
    units: ['hey', 'hi', 'hello', 'hi there', 'heyy'].map((inbound, i) => ({
      id: `old-${i + 1}`,
      inbound,
      history: [],
      wroteBeforeHistoryWindow: true,
    })),
  },
  {
    id: '2-reoptin',
    what: 'the turn that opts a guest back in: the block must be absent (constructed)',
    kind: 'inbound',
    established: true,
    units: ['hey', 'hi', 'are you open today?', 'hello', 'hey again'].map(
      (inbound, i) => ({
        id: `optin-${i + 1}`,
        inbound,
        history: [
          ['in', 'do you have oat milk?'],
          ['out', 'yep, oat and almond'],
          ['in', 'please stop messaging me'],
          ['out', "done, you won't hear from us again"],
        ] as const,
        gapMinutes: 120,
        reOptIn: 'instagram' as const satisfies ReOptIn,
      }),
    ),
  },
  {
    id: '3-apology',
    what: 'the next reply in a complaint thread that has already apologised (constructed)',
    kind: 'inbound',
    established: true,
    units: [
      u('answer-1', 'yeah right away', COMPLAINT_ASKED),
      u('answer-2', 'yes, straight from the counter', COMPLAINT_ASKED),
      u('still-1', 'honestly it was barely warm at all', COMPLAINT_ANSWERED),
      u('still-2', 'yeah it was just disappointing', COMPLAINT_ANSWERED),
      u('logistics', 'can i come by saturday instead?', COMPLAINT_ANSWERED),
    ],
  },
  {
    id: '3-first-complaint',
    what: 'a first complaint after an unrelated "sorry" of ours: the apology block renders, and the reply should still apologise (constructed)',
    kind: 'inbound',
    established: true,
    units: [
      'my latte was cold when i got it today',
      'the cortado i got this morning was burnt',
      'waited 25 minutes for a flat white today',
      'my pastry was stale this morning',
      'got the wrong drink today, asked for oat',
    ].map((inbound, i) => ({
      id: `first-${i + 1}`,
      inbound,
      history: [
        ['in', 'do you have matcha?'],
        ['out', "sorry, no matcha here. it's all coffee and tea"],
      ] as const,
      gapMinutes: 180,
    })),
  },
  {
    id: '4-selfcorrect',
    what: 'the guest takes back a visit they reported (constructed)',
    kind: 'inbound',
    established: true,
    units: [
      { inbound: 'yeah, different place', history: RETRACTION_CHECKED },
      {
        inbound: 'oh yeah that was somewhere else',
        history: RETRACTION_CHECKED,
      },
      { inbound: 'sorry that was another cafe', history: RETRACTION_CHECKED },
      {
        inbound: 'oh wait, that was a different place actually',
        history: RETRACTION_UNPROMPTED,
      },
      {
        inbound: 'ah sorry i mixed you up with somewhere else',
        history: RETRACTION_UNPROMPTED,
      },
    ].map((x, i) => ({
      id: `takeback-${i + 1}`,
      ...x,
      reportedItems: ['cold brew'],
    })),
  },
  {
    id: '4-vague',
    what: 'the guest only says they have never been in, no check asked yet (constructed)',
    kind: 'inbound',
    established: true,
    units: [
      "wait, i've never actually been to yours",
      "i haven't been in before though",
      'never been there tbh',
      "hm i don't think i've ever come in",
      "i've never been to le mil's",
    ].map((inbound, i) => ({
      id: `never-${i + 1}`,
      inbound,
      history: RETRACTION_UNPROMPTED,
      reportedItems: ['cold brew'],
    })),
  },
  {
    id: '5-close',
    what: 'the pause-timer close with no link',
    kind: 'close',
    established: false,
    units: CLOSE_EXCHANGES.map((history, i) => ({
      id: `close-${String(i + 1).padStart(2, '0')}`,
      history,
    })),
  },
]

// ---------------------------------------------------------------------------
// Detectors. Wide on purpose; every body is printed to be read.
// ---------------------------------------------------------------------------

const fold = (s: string): string => s.toLowerCase().replace(/[‘’]/g, "'")

const APOLOGY = /\b(sorry|apolog\w*|my bad|our bad|our mistake|my mistake)\b/
const OWNS_MISTAKE =
  /\b(our mistake|my mistake|our bad|my bad|on us|on me|our end|my end|our fault|my fault|mix-?up on)\b/
const OFFER =
  /\b(let (me|us) know|happy to|here if|any(thing| other) (else|questions?)|questions? about|just (ask|say)|shout|holler|ask away|reach)\b/
const INVITE =
  /(\?|\b(let (me|us) know|what can|how can|anything (you|we|i)|here (if|for)|just (ask|say)|ask away|fire away)\b)/

function firstSentence(body: string): string {
  return body.split(/(?<=[.!?])\s+|\n/)[0] ?? body
}

function detect(body: string): Record<string, boolean> {
  const b = fold(body)
  return {
    opensWithApology: APOLOGY.test(fold(firstSentence(body))),
    anyApology: APOLOGY.test(b),
    ownsMistake: OWNS_MISTAKE.test(b),
    offer: OFFER.test(b),
    invite: INVITE.test(b),
    question: b.includes('?'),
    link: /https?:\/\/|www\./.test(b),
  }
}

// ---------------------------------------------------------------------------

// `new` unless MEASURE_BAND says otherwise, which is a probe and never the check.
const BANDS = ['new', 'returning', 'regular', 'raving_fan'] as const
const BAND = BANDS.find((b) => b === (process.env.MEASURE_BAND ?? 'new'))
if (BAND === undefined) {
  throw new Error(`MEASURE_BAND must be one of: ${BANDS.join(', ')}`)
}

type BaseCtx = Awaited<ReturnType<typeof buildRuntimeContext>>

function toHistory(lines: readonly Line[], endsAt: Date): RecentMessage[] {
  return lines.map(([dir, body], i) => ({
    direction: dir === 'in' ? 'inbound' : 'outbound',
    body,
    createdAt: new Date(endsAt.getTime() - (lines.length - i) * 120_000),
    delivery: 'delivered',
    // Every line of ours in these threads is a reply to the guest.
    category: dir === 'out' ? 'reply' : null,
  })) as RecentMessage[]
}

function unitContext(
  base: BaseCtx,
  cell: Cell,
  unit: Unit,
  now: Date,
): RuntimeContext {
  // The close fires after the venue's pause; an inbound turn follows the
  // thread directly.
  const historyEnd =
    cell.kind === 'close'
      ? new Date(now.getTime() - 10 * 60_000)
      : new Date(now.getTime() - (unit.gapMinutes ?? 0) * 60_000)
  const recentMessages = toHistory(unit.history, historyEnd)
  const firstContact = cell.established
    ? new Date(now.getTime() - 3 * 24 * 60 * 60_000)
    : new Date(now.getTime() - 20 * 60_000)
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
    currentMessage:
      unit.inbound === undefined
        ? null
        : {
            id: randomUUID(),
            providerMessageId: `phone-test-${cell.id}-${unit.id}`,
            body: unit.inbound,
            receivedAt: now,
            channel: 'instagram',
            referralSource: null,
          },
    recentMessages,
    // The blocks are derived by buildAiRuntime from the constructed thread and
    // this one fact, so the cell measures the derivation and the block together.
    wroteBeforeHistoryWindow: unit.wroteBeforeHistoryWindow === true,
    // NOTHING OF THE REAL GUEST'S (the TAC-575 contamination: a leaked open
    // comp reached a ruling).
    recentVisits: [],
    // The base guest's band rides into the prompt as `Guest relationship:`.
    // Left alone it was `returning`, and ten of ten bare greetings from a
    // "new" guest came back "welcome back". No constructed guest here has a
    // visit, so every one is `new`.
    recognition: { ...base.recognition, state: BAND },
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
    reOptIn: unit.reOptIn ?? null,
    inboundMedia: null,
    visitLocalDate: null,
    // The base guest may be inside the quiet that follows a warm close, which
    // would render `## No questions this turn` on guests meant to be established.
    intentionDerivation: {
      ...base.intentionDerivation,
      quietAfterWarmClose: false,
    },
    retractableReportedVisits: (unit.reportedItems
      ? [unit.reportedItems]
      : []
    ).map((items) => ({
      transactionId: randomUUID(),
      occurredAt: new Date(now.getTime() - 4 * 60 * 60_000),
      items: [...items],
    })),
    conversationChannel: 'instagram',
    firstConversation: !cell.established,
    signOff: cell.kind === 'close' ? 'plain' : null,
  } as RuntimeContext
}

async function main(): Promise<void> {
  const venueSlug = process.env.MEASURE_VENUE ?? 'le-mils-coffee'
  const armName = process.env.MEASURE_ARM ?? 'shipped'
  const reps = Number(process.env.MEASURE_REPS ?? '10')
  if (!Number.isInteger(reps) || reps < 1) {
    throw new Error('MEASURE_REPS must be a positive whole number')
  }
  const cellIds = (
    process.env.MEASURE_CELLS ?? CELLS.map((c) => c.id).join(',')
  )
    .split(',')
    .map((s) => s.trim())
  const arm = ARMS[armName]
  if (!arm) {
    throw new Error(
      `MEASURE_ARM="${armName}" is not one of: ${Object.keys(ARMS).join(', ')}`,
    )
  }
  const cells = CELLS.filter((c) => cellIds.includes(c.id))
  if (cells.length !== cellIds.length) {
    throw new Error(`MEASURE_CELLS names an unknown cell: ${cellIds.join(',')}`)
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
  const trace = startAgentTrace({
    name: 'phone-test-fixes',
    agentRunId: randomUUID(),
  })

  // One build per trigger kind in use, so computeGuestState runs at most twice.
  const bases = new Map<Cell['kind'], BaseCtx>()
  for (const kind of new Set(cells.map((c) => c.kind))) {
    bases.set(
      kind,
      await buildRuntimeContext({
        agentRunId: randomUUID(),
        guestId,
        venueId: venue.id,
        trace,
        ...(kind === 'close'
          ? {
              followupTrigger: {
                reason: 'warm_close' as const,
                triggeredAt: now,
                warmClose: {
                  answersMessageId: randomUUID(),
                  signOff: 'plain' as const,
                },
              },
            }
          : {
              currentMessage: {
                id: randomUUID(),
                providerMessageId: `phone-test-probe-${randomUUID()}`,
                body: 'hi',
                receivedAt: now,
                channel: 'instagram' as const,
                referralSource: null,
              },
            }),
      }),
    )
  }

  const log = createRunLog({
    name: `phone-test-fixes-${armName}`,
    meta: {
      arm: armName,
      band: BAND,
      transforms: arm.map((t) => t.label),
      promptVersion: PROMPT_VERSION,
      venue: venueSlug,
      venueStatus: venue.status,
      guestId,
      cells: cells.map((c) => c.id),
      reps,
      constructed:
        'every thread is constructed; none is a replay of stored rows. Categories are classified once per unit per run.',
    },
  })
  console.log(
    `[phone-test] arm=${armName} prompt=${PROMPT_VERSION} venue=${venueSlug} reps=${reps}`,
  )
  console.log(`[phone-test] run log: ${log.path}`)

  const anyBase = [...bases.values()][0] as BaseCtx
  const corpus = await retrieveCorpusStage(anyBase)
  const ragChunks: AiVoiceCorpusChunk[] = corpus.map((ch) => ({
    id: ch.id,
    text: ch.text,
    sourceType: ch.sourceType as AiVoiceCorpusChunk['sourceType'],
    relevanceScore: ch.similarity,
  }))

  const voidCells: string[] = []
  // Prompt-cache accounting across the run. Without it a breakpoint that
  // never reads looks exactly like one that does.
  const cache = { read: 0, write: 0, uncached: 0, calls: 0 }

  for (const cell of cells) {
    console.log(`\n== ${cell.id}: ${cell.what}`)
    const base = bases.get(cell.kind) as BaseCtx
    const categories = new Map<string, MessageCategory>()
    const knowledge = new Map<string, AiKnowledgeCorpusChunk[]>()
    const tallies: Record<string, number> = {}
    let done = 0
    let failed = 0
    let touched = 0

    for (let rep = 0; rep < reps; rep += 1) {
      const unit = cell.units[rep % cell.units.length] as Unit
      const ctx = unitContext(base, cell, unit, now)
      ctx.corpus = corpus
      try {
        let category = categories.get(unit.id)
        if (category === undefined) {
          if (cell.kind === 'close') {
            category = 'acknowledgment'
            knowledge.set(unit.id, [])
          } else {
            const classification = await classifyStage(ctx)
            category = classification.category
            const matches = await retrieveKnowledgeWithContextStage(
              ctx,
              category,
              unit.inbound as string,
            )
            knowledge.set(
              unit.id,
              matches.map((c) => ({
                id: c.id,
                text: c.text,
                sourceType: c.sourceType,
                primaryTags: c.primaryTags,
                secondaryTags: c.secondaryTags,
                relevanceScore: c.similarity,
              })),
            )
          }
          categories.set(unit.id, category)
        }

        const composed = composePrompt({
          category,
          persona: ctx.venue.brandPersona,
          venueInfo: ctx.venue.venueInfo,
          ragChunks,
          knowledgeChunks: knowledge.get(unit.id) ?? [],
          runtime: buildAiRuntime(ctx),
          channel: 'instagram',
        })
        // Transforms run on the two halves of the system prompt separately,
        // so the stable half keeps its own cache breakpoint, as production's
        // does. No transform here spans the boundary between them.
        let prefix = composed.cacheableSystemPrefix
        let suffix = composed.volatileSystemSuffix
        let user = composed.userPrompt
        const applied: string[] = []
        for (const t of arm) {
          let changed = false
          if (t.target === 'system') {
            const nextPrefix = t.apply(prefix)
            const nextSuffix = t.apply(suffix)
            changed = nextPrefix !== prefix || nextSuffix !== suffix
            prefix = nextPrefix
            suffix = nextSuffix
          } else {
            const next = t.apply(user)
            changed = next !== user
            user = next
          }
          if (!changed && !t.optional) {
            throw new Error(`transform "${t.label}" did not change the prompt`)
          }
          if (changed) applied.push(t.label)
        }
        // An arm of optional edits may leave some units untouched (the fact
        // block renders on some turns only). A cell where it touched none is
        // caught below.
        if (applied.length > 0) touched += 1

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
            { role: 'user', content: user },
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
        const blocks = [
          '## You know this guest',
          '## You have already apologised',
          '## They are answering your offer',
        ].filter((h) => user.includes(h))
        // What generateMessage does with the fields, step for step. No unit
        // here renders an intentions block, so production drops any question
        // the model emits; and none carries a review ask.
        const correcting =
          (unit.reportedItems?.length ?? 0) > 0 &&
          object.reportedVisitCorrection !== 'none'
        const composedReply = composeReplyWithIntention(object.body, '')
        const offerLine = replaceDashes(object.furtherHelpOffer).trim()
        const beforeOffer =
          offerLine === ''
            ? composedReply.body
            : stripTrailingDuplicate(composedReply.body, offerLine)
        const offer = decideFurtherHelpOffer({
          body: beforeOffer,
          offer: offerLine,
          category,
          commitment: object.commitment,
          repliesToGuest: unit.inbound !== undefined,
          signsOff: object.closedTheConversation || cell.kind === 'close',
          onComplaintTurn: object.complaintIntent !== 'none',
          carriesAnAsk: false,
          knowledgeGap: object.knowledgeGap,
          correctingVisit: correcting,
          offeredThisConversation: offeredThisConversation(
            ctx.recentMessages,
            now,
            ctx.conversationWindowMs,
          ),
        })
        const sendsOffer = offer.append && beforeOffer.trim() !== ''
        const reply = sendsOffer
          ? appendFurtherHelpOffer(beforeOffer, offerLine)
          : composedReply.body
        // What the guest would actually receive: the messages dispatch makes
        // of it, with the offer peeled off as its own. The first version of
        // this check printed the reply before dispatch and so never saw that
        // a line break does not survive it.
        const bubbles = resolveDispatchBubbles(
          reply,
          Math.random,
          resolveOutboundTail('', '', 0, sendsOffer ? offerLine : ''),
          replyBubbleStyleFor(ctx.venue.brandPersona.voiceProfile),
        )
        const flags = {
          ...detect(reply),
          offerSent: sendsOffer,
          offerWritten: offerLine.trim() !== '',
          knownBlock: blocks.includes('## You know this guest'),
          apologyBlock: blocks.includes('## You have already apologised'),
        }
        for (const [k, v] of Object.entries(flags)) {
          if (v) tallies[k] = (tallies[k] ?? 0) + 1
        }
        done += 1
        log.appendUnit({
          cell: cell.id,
          unit: unit.id,
          rep,
          failed: false,
          category,
          applied,
          blocks,
          inbound: unit.inbound ?? null,
          body: reply,
          bubbles,
          offerLine,
          offerReason: offer.reason,
          knowledgeGap: object.knowledgeGap,
          reportedVisitCorrection: object.reportedVisitCorrection,
          flags,
        })
        const marks = Object.entries(flags)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(',')
        console.log(
          `  ${unit.id} [${category}${object.knowledgeGap ? ', GAP' : ''}] ${bubbles.map((b) => JSON.stringify(b)).join(' + ')}  {${offer.reason === 'no_offer_written' ? '' : `offer:${offer.reason} `}${marks}}`,
        )
      } catch (e) {
        failed += 1
        const error = e instanceof Error ? e.message : String(e)
        log.appendUnit({
          cell: cell.id,
          unit: unit.id,
          rep,
          failed: true,
          error,
        })
        console.log(`  ${unit.id} FAILED: ${error}`)
      }
    }

    // A control or candidate arm that changed no prompt in the whole cell is a
    // silent copy of the shipped arm, not a result.
    if (arm.length > 0 && touched === 0) {
      console.log(`  ${cell.id}: no transform changed any prompt (CELL VOID)`)
      failed += 1
    }
    if (failed > 0) voidCells.push(cell.id)
    console.log(
      `  -- ${cell.id}: ${done}/${reps} generated${failed > 0 ? `, ${failed} FAILED (CELL VOID)` : ''}; ${Object.entries(
        tallies,
      )
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}`,
    )
    log.appendUnit({ summary: true, cell: cell.id, done, failed, tallies })
  }

  const { count: statesAfter } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })
  console.log(
    `\n[phone-test] guest_states rows before/after: ${statesBefore}/${statesAfter}`,
  )
  console.log(
    '[phone-test] counts above are detector hits, not verdicts. Read the bodies.',
  )
  const inputTokens = cache.read + cache.write + cache.uncached
  const hitRate = inputTokens === 0 ? 0 : cache.read / inputTokens
  console.log(
    `[phone-test] prompt cache: ${cache.calls} calls, ${inputTokens} input tokens: ${cache.read} read, ${cache.write} written, ${cache.uncached} uncached. hit rate ${(hitRate * 100).toFixed(0)}% of input tokens`,
  )
  log.appendUnit({ summary: true, cache: { ...cache, inputTokens, hitRate } })
  if (voidCells.length > 0) {
    console.log(`[phone-test] VOID cells: ${voidCells.join(', ')}`)
    process.exit(2)
  }
  process.exit(0)
}

main().catch((e: unknown) => {
  console.error('[phone-test] crashed:', e instanceof Error ? e.message : e)
  process.exit(2)
})
