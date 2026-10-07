// TAC-575 PR 5: the wording check for the follow-up after a complaint.
//
// THE BAR WAS POSTED ON THE TICKET BEFORE ANY GENERATION (the [PLAN] comment of
// 2026-10-06) and is evaluated in code below:
//
//   One run, twenty generations on constructed guests, nothing sent: ten
//   follow-up greetings and ten after-complaint sign-offs.
//
//   Greetings pass when 0 of 10 apologise ("sorry", "apolog"), 0 offer
//   anything, 0 name what went wrong, and 10 of 10 ask what they got.
//
//   Sign-offs pass when 10 of 10 carry the review link, 0 ask for a rating or
//   stars, 0 mention what went wrong, and 0 offer anything.
//
//   A generation that fails to produce a body voids the run. Any re-run is
//   informational.
//
// THERE IS NO CONTROL ARM. The comparison is against that bar, not against
// another prompt: before this PR neither message existed.
//
// WHAT THE DETECTORS ARE, AND WHERE THEY ARE WEAK. All four are string tests,
// so each UNDER-detects, and the bodies are printed and logged to be read:
//
//   apologises       "sorry" or "apolog" anywhere. The ticket's own definition.
//   offers           a fixed list of comp words (OFFER_WORDS). An offer phrased
//                    any other way gets past it.
//   names the fault  each unit carries the words its own complaint used
//                    ("cold", "burnt"), plus phrases that point back at it
//                    (FAULT_PHRASES). "Hope today's is better" is NOT counted:
//                    the instruction asks for "glad they came back", and a
//                    hope about today names nothing that went wrong. Flagged
//                    separately as `alludes` so the count is visible.
//   asks what        a question mark, and "what" with a getting verb.
//   asks for rating  "star", "rating", "rate us", a digit before "star".
//
// NOTHING IS SENT AND NOTHING IS WRITTEN. It builds a runtime context for one
// real guest (read-only), overrides everything a turn reads about them, and
// calls the generator. `guest_states` is counted before and after, because the
// context build is the one step that could persist anything.
//
//   npx tsx --env-file=.env.local scripts/measurement/complaint-followup.ts
//
// TWO INFORMATIONAL MODES, added after the pre-registered run (its greetings
// FAILED: eight of ten answered the old complaint instead of greeting). Either
// one prints no PASS or FAIL and says so in its log:
//
//   MEASURE_ARMS=greeting          one arm only (or sign_off).
//   MEASURE_GREETING=returning     the greeting arm with the ORDINARY
//                                  returning-guest instruction on the same
//                                  histories. First run as the control for
//                                  "is answering the old complaint something
//                                  the new wording causes, or what any
//                                  greeting does when the thread ends on a
//                                  complaint" (it was the second), and since
//                                  the follow-up PR the check that the
//                                  ordinary greeting no longer does it.
//   MEASURE_PRIORS=1               THE PRIOR-GREETINGS CHECK, which has a bar
//                                  of its own (posted on the ticket
//                                  2026-10-06) and prints a verdict: the
//                                  ordinary returning greeting on the ten
//                                  complaint threads, each guest with one
//                                  prior greeting on file, plus five regulars
//                                  with three each. Passes when the complaint
//                                  bar is still met on the ten AND no greeting
//                                  repeats one of its own priors word for
//                                  word (normalizeForRepeat).
//   MEASURE_OPEN_COMP=1            every unit's guest holds an OPEN COMP for
//                                  the item they complained about, which is
//                                  what the complaint path leaves behind when
//                                  an operator approves one. Production
//                                  renders it under `## Active commitments` on
//                                  the greeting, beside "do not offer
//                                  anything". Without this mode the offer bar
//                                  has almost nothing to fail on.

import { randomUUID } from 'node:crypto'

import type {
  VoiceCorpusChunk as AiVoiceCorpusChunk,
  RecentMessage,
} from '@/lib/ai/types'
import { generateMessage } from '@/lib/ai'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import { bodyContainsReviewLink } from '@/lib/agent/review-ask'
import { buildAiRuntime, retrieveCorpusStage } from '@/lib/agent/stages'
import type { RuntimeContext } from '@/lib/agent/types'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { findReviewLink, parseVenueLinks } from '@/lib/schemas'
import { toParsedGuestContext } from '@/lib/schemas/guest-context'
import { createRunLog } from './run-log'

const PER_ARM = 10
const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Ten complaints, how long ago, and the words each one used for the fault. */
const COMPLAINTS: readonly {
  daysAgo: number
  said: string
  apology: string
  faultWords: readonly string[]
}[] = [
  {
    daysAgo: 2,
    said: 'honestly it came out cold',
    apology: "so sorry about that, that's not how it should be",
    faultWords: ['cold'],
  },
  {
    daysAgo: 5,
    said: 'the milk tasted burnt',
    apology: "ugh, sorry. that's on us",
    faultWords: ['burnt', 'burned'],
  },
  {
    daysAgo: 1,
    said: 'this is not what i ordered, i asked for oat',
    apology: 'sorry, we got that wrong',
    faultWords: ['oat', 'wrong order', 'mix-up', 'mix up', 'mixup'],
  },
  {
    daysAgo: 9,
    said: 'way too sweet, could barely drink it',
    apology: 'sorry to hear that, thank you for telling us',
    faultWords: ['too sweet', 'sweetness'],
  },
  {
    daysAgo: 3,
    said: 'waited 20 minutes for it',
    apology: "that's too long, sorry about the wait",
    faultWords: ['waited', 'the wait', '20 min', 'slow'],
  },
  {
    daysAgo: 14,
    said: 'it was kind of watery',
    apology: "sorry, that's not right",
    faultWords: ['watery', 'weak'],
  },
  {
    daysAgo: 21,
    said: 'the pastry was stale',
    apology: 'sorry about that one',
    faultWords: ['stale'],
  },
  {
    daysAgo: 4,
    said: 'there was a hair in it',
    apology: "oh no, we're really sorry",
    faultWords: ['hair'],
  },
  {
    daysAgo: 7,
    said: 'lukewarm and bitter',
    apology: "sorry, that shouldn't happen",
    faultWords: ['lukewarm', 'bitter'],
  },
  {
    daysAgo: 27,
    said: 'the lid leaked all over my bag',
    apology: 'so sorry about your bag',
    faultWords: ['lid', 'leak', 'your bag', 'spill'],
  },
]

/** What ten returning guests said today after naming their order. None is praise. */
const TODAY_REPLIES: readonly string[] = [
  "haven't tried it yet",
  'just got it',
  "it's fine",
  'ok so far',
  'still too hot to drink',
  'about to find out',
  'waiting for it to cool down',
  'not bad',
  'taking it to go',
  'ask me in ten',
]

const OFFER_WORDS = [
  'on us',
  'on the house',
  'free',
  'complimentary',
  'comp ',
  'discount',
  '% off',
  'our treat',
  'my treat',
  'make it up',
  'refund',
  'voucher',
  'credit',
]
/** Phrases that point back at the complaint without using its own words. */
const FAULT_PHRASES = [
  'last time',
  'last visit',
  'went wrong',
  'what happened',
  'the issue',
  'the problem',
  'the mix',
  'mishap',
  'complain',
]
/** A hope about today. Counted and reported, not part of the bar. */
const ALLUSION_PHRASES = ['this time', 'better today', "today's", 'hits right']

const has = (body: string, words: readonly string[]): string[] => {
  const b = body.toLowerCase()
  return words.filter((w) => b.includes(w))
}
const apologises = (body: string): boolean => /sorry|apolog/i.test(body)
const asksWhatTheyGot = (body: string): boolean =>
  body.includes('?') &&
  /what\b[^?]*\b(get|got|getting|having|have|order|ordered|grab|grabbed|drinking|pick|picked|is it|did you)\b/i.test(
    body,
  )
const asksForRating = (body: string): boolean =>
  /\bstars?\b|\brating\b|\brate us\b|\d\s*-?\s*star/i.test(body)

interface Unit {
  id: string
  arm: 'greeting' | 'sign_off'
  faultWords: readonly string[]
  history: RecentMessage[]
  /** The greetings on file for this guest, newest first. Priors mode only. */
  priors?: readonly string[]
  /** A regular with a friendly thread, not a complaint. Priors mode only. */
  regular?: boolean
}

/** The greeting each complaint thread's earlier visit opened with. */
const FIRST_GREETING = 'hey, welcome in! what did you get?'

/**
 * Five regulars and the last three greetings each has had, newest first.
 * Taken from what the greeting actually produced in the #334 runs, so they
 * are the lines it is most likely to write again.
 */
const REGULARS: readonly (readonly string[])[] = [
  [
    'hey, good to see you again! what did you get? ☕',
    'hey, good to see you back 👋 what did you get?',
    'hey, good to see you! what did you get? ☕',
  ],
  [
    'hey, you made it in! what did you end up getting?',
    'hey, good to see you again. what did you end up getting?',
    'hey, welcome back! what did you get today?',
  ],
  [
    'morning! what did you get? ☕',
    'hey, good to see you back 😊 what did you get?',
    'hey, good to see you again 👋 what did you get?',
  ],
  [
    'hey, good to see you in! what did you get? ☕',
    'hey, good to see you back. what did you get?',
    "hey, you're back. what did you get today?",
  ],
  [
    'hey, good to see you! what did you get? ☕',
    'hey, good to see you again! what did you get? ☕',
    'hey, good to see you back 👋 what did you get?',
  ],
]

/**
 * "Word for word", made strict: lowercased, with emoji, punctuation and extra
 * spaces removed, so a greeting that only swaps an emoji or a full stop still
 * counts as a repeat.
 */
export function normalizeForRepeat(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function turn(
  direction: 'inbound' | 'outbound',
  body: string,
  createdAt: Date,
): RecentMessage {
  return { direction, body, createdAt, delivery: 'delivered' } as RecentMessage
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

  // Any real, non-opted-out Instagram guest. Only its id is used: everything
  // either message reads about the guest is overridden per unit below.
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

  const { count: statesBefore } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  const startedAt = new Date()
  const trace = startAgentTrace({
    name: 'tac575-complaint-followup',
    agentRunId: randomUUID(),
  })

  // Built ONCE per arm, as each processor's own trigger would build it.
  const greetingBase = await buildRuntimeContext({
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
        afterComplaint: true,
      },
    },
  })
  const reviewLink = findReviewLink(
    parseVenueLinks(greetingBase.venue.venueInfo.links),
  )
  if (reviewLink === null) {
    throw new Error(
      `${venueSlug} has no review link (kind: 'review' in venue_info.links); the sign-off arm cannot run`,
    )
  }
  const signOffBase = await buildRuntimeContext({
    agentRunId: randomUUID(),
    guestId,
    venueId: venue.id,
    trace,
    followupTrigger: {
      reason: 'warm_close',
      triggeredAt: startedAt,
      warmClose: { answersMessageId: randomUUID(), signOff: 'visit' },
    },
  })
  if (greetingBase.scanArrival?.afterComplaint !== true) {
    throw new Error('the greeting context did not carry afterComplaint')
  }
  if (signOffBase.signOff !== 'visit') {
    throw new Error('the sign-off context did not carry its kind')
  }

  const menuNames = greetingBase.venue.venueInfo.menu.items
    .map((i) => i.name)
    .filter((n) => n.trim().length > 0)
  if (menuNames.length === 0) throw new Error('venue has no menu items to name')

  const minutesAgo = (m: number): Date =>
    new Date(startedAt.getTime() - m * 60_000)
  /** The earlier visit: greeted, ordered, asked, complained, apologised to. */
  const earlierVisit = (i: number): RecentMessage[] => {
    const c = COMPLAINTS[i]
    const item = menuNames[i % menuNames.length].toLowerCase()
    const base = startedAt.getTime() - c.daysAgo * MS_PER_DAY
    const t = (m: number): Date => new Date(base + m * 60_000)
    return [
      turn('outbound', 'hey, welcome in! what did you get?', t(0)),
      turn('inbound', `the ${item}`, t(1)),
      turn('outbound', `nice, the ${item}. how is it so far?`, t(2)),
      turn('inbound', c.said, t(4)),
      turn('outbound', c.apology, t(9)),
    ]
  }

  const armsEnv = process.env.MEASURE_ARMS
  const priorsMode = process.env.MEASURE_PRIORS === '1'
  // The priors check is about the ordinary returning greeting.
  const controlGreeting =
    priorsMode || process.env.MEASURE_GREETING === 'returning'
  const openComp = process.env.MEASURE_OPEN_COMP === '1'
  const informational =
    !priorsMode && (armsEnv !== undefined || controlGreeting || openComp)
  const allUnits: Unit[] = [
    ...COMPLAINTS.slice(0, PER_ARM).map((c, i) => ({
      id: `greeting-${String(i + 1).padStart(2, '0')}`,
      arm: 'greeting' as const,
      faultWords: c.faultWords,
      // What production loads for this guest: the earlier visit, when it is
      // within fourteen days. THE MODEL DOES NOT SEE IT, on either greeting:
      // buildAiRuntime drops everything before this visit for every scan
      // greeting, which is the thing under test. `historySeenByModel` in the
      // run log is what generation was actually handed.
      history: c.daysAgo <= 14 ? earlierVisit(i) : [],
    })),
    ...COMPLAINTS.slice(0, PER_ARM).map((c, i) => {
      const item = menuNames[(i + 3) % menuNames.length].toLowerCase()
      return {
        id: `sign-off-${String(i + 1).padStart(2, '0')}`,
        arm: 'sign_off' as const,
        faultWords: c.faultWords,
        history: [
          ...(c.daysAgo <= 14 ? earlierVisit(i) : []),
          turn(
            'outbound',
            'good to see you back! what did you get today?',
            minutesAgo(16),
          ),
          turn('inbound', `the ${item}`, minutesAgo(15)),
          turn(
            'outbound',
            `the ${item}, nice. how is it so far?`,
            minutesAgo(14),
          ),
          turn('inbound', TODAY_REPLIES[i], minutesAgo(12)),
          turn('outbound', 'no rush at all', minutesAgo(11)),
        ],
      }
    }),
  ]

  const priorsUnits: Unit[] = [
    ...allUnits
      .filter((u) => u.arm === 'greeting')
      .map((u) => ({ ...u, priors: [FIRST_GREETING] })),
    ...REGULARS.map((priors, i) => ({
      id: `regular-${String(i + 1).padStart(2, '0')}`,
      arm: 'greeting' as const,
      faultWords: [],
      regular: true,
      priors,
      // A friendly earlier visit. The model does not see it; it is here so
      // the unit is the shape production loads.
      history: [
        turn(
          'outbound',
          priors[0],
          new Date(startedAt.getTime() - 2 * MS_PER_DAY),
        ),
        turn(
          'inbound',
          'a flat white',
          new Date(startedAt.getTime() - 2 * MS_PER_DAY + 60_000),
        ),
        turn(
          'outbound',
          'good choice',
          new Date(startedAt.getTime() - 2 * MS_PER_DAY + 120_000),
        ),
      ],
    })),
  ]
  // TAC-578 RETIRED WHAT THE SIGN-OFF ARM MEASURED. It scored the review
  // invitation on the sign-off of a guest whose complaint had been followed
  // up. Ruled 2026-10-07, no sign-off carries an invitation: it rides the
  // first-visit thank-you (scripts/measurement/post-visit-messages.ts measures
  // that). The arm's units and scoring are left for the greeting arm's
  // history fixtures, which they share, but it refuses to run rather than
  // print a FAIL for a link that is no longer supposed to be there.
  if (
    !priorsMode &&
    (armsEnv === undefined ||
      armsEnv
        .split(',')
        .map((a) => a.trim())
        .includes('sign_off'))
  ) {
    throw new Error(
      'the sign_off arm is retired (TAC-578): run with MEASURE_ARMS=greeting',
    )
  }
  const units = priorsMode
    ? priorsUnits
    : allUnits.filter(
        (u) =>
          armsEnv === undefined ||
          armsEnv
            .split(',')
            .map((a) => a.trim())
            .includes(u.arm),
      )
  if (units.length === 0) {
    throw new Error(
      `MEASURE_ARMS="${armsEnv}" names no arm (greeting, sign_off)`,
    )
  }

  const log = createRunLog({
    name: 'tac575-complaint-followup',
    meta: {
      openComp,
      priorsMode,
      arm: priorsMode
        ? 'prior-greetings'
        : controlGreeting
          ? 'informational-control-returning-greeting'
          : informational
            ? `informational-${armsEnv}`
            : 'treatment-only',
      promptVersion: PROMPT_VERSION,
      venue: venueSlug,
      venueName: venue.name,
      venueStatus: venue.status,
      guestId,
      units: units.length,
      perArm: PER_ARM,
      bars: {
        greetings: {
          apologise: 0,
          offer: 0,
          nameTheFault: 0,
          askWhatTheyGot: PER_ARM,
        },
        signOffs: {
          carryTheLink: PER_ARM,
          askForRating: 0,
          nameTheFault: 0,
          offer: 0,
        },
      },
      noControlArm:
        'There is no control: the comparison is against a bar fixed in advance. Neither message existed before this PR.',
      constructed:
        "each unit's history is hand-written: an earlier visit ending in a complaint and an apology, and for sign-offs a return visit today",
    },
  })

  console.log(`[tac575] prompt=${PROMPT_VERSION}`)
  console.log(
    `[tac575] venue ${venueSlug} "${venue.name}" (status=${venue.status})`,
  )
  console.log(`[tac575] guest_states rows before: ${statesBefore}`)
  console.log(`[tac575] run log: ${log.path}\n`)

  const corpus = await retrieveCorpusStage(greetingBase)
  const ragChunks: AiVoiceCorpusChunk[] = corpus.map((ch) => ({
    id: ch.id,
    text: ch.text,
    sourceType: ch.sourceType as AiVoiceCorpusChunk['sourceType'],
    relevanceScore: ch.similarity,
  }))

  // The comp an approved complaint leaves open, in the stored shape.
  const openCompFor = (
    unitId: string,
  ): RuntimeContext['activeCommitments'][number] => {
    const i = Number(unitId.slice(-2)) - 1
    const item = menuNames[i % menuNames.length]
    return {
      id: randomUUID(),
      type: 'comp',
      description: `${item} replacement`,
      code: 'TEST',
      status: 'open',
      expected_arrival: null,
      arrival_signal: null,
      created_at: new Date(
        startedAt.getTime() - COMPLAINTS[i].daysAgo * MS_PER_DAY,
      ).toISOString(),
    } as RuntimeContext['activeCommitments'][number]
  }

  const repeats: { id: string; body: string }[] = []
  const priorsBodies: { id: string; body: string }[] = []
  const regulars = { total: 0, asks: 0 }
  const failed: { id: string; error: string }[] = []
  const counts = {
    greetings: {
      total: 0,
      apologise: 0,
      offer: 0,
      fault: 0,
      asks: 0,
      alludes: 0,
    },
    signOffs: {
      total: 0,
      link: 0,
      rating: 0,
      fault: 0,
      offer: 0,
      apologise: 0,
    },
  }

  for (const unit of units) {
    const isGreeting = unit.arm === 'greeting'
    const base = isGreeting ? greetingBase : signOffBase
    const category = isGreeting ? 'guest_arrived' : 'acknowledgment'
    const ctx: RuntimeContext = {
      ...base,
      // A returning guest with nothing else on file, so no unit is told a name
      // or a history the others are not.
      guest: {
        ...base.guest,
        firstName: null,
        context: toParsedGuestContext({}, startedAt),
        createdAt: new Date(startedAt.getTime() - 40 * MS_PER_DAY),
        firstContactedAt: new Date(startedAt.getTime() - 40 * MS_PER_DAY),
        reviewAskedAt: null,
      },
      recentMessages: unit.history,
      recentVisits: [],
      // NOTHING OF THE REAL GUEST'S. The base context is built for a real
      // guest, and until 2026-10-06 their open commitments and stored notes
      // rode into every unit: that guest holds an open comp for a Blossom
      // Tonic, and closes and greetings offered constructed guests "the
      // Blossom Tonic we owe you". Found by the control arm of
      // complaint-followup.ts. Every run before this line was contaminated.
      activeCommitments: openComp ? [openCompFor(unit.id)] : [],
      retractableReportedVisits: [],
      mechanics: [],
      conversationChannel: 'instagram',
      firstConversation: false,
      openIntentions: [],
      pendingQuestion: null,
      corpus,
      knowledgeCorpus: [],
      scanArrival: isGreeting
        ? {
            hadPriorConversation: true,
            hasRecordedVisit: true,
            afterComplaint: !controlGreeting,
            priorGreetings: [...(unit.priors ?? [])],
          }
        : null,
      signOff: isGreeting ? null : 'visit',
      reviewAsk: null,
      // What handleFollowup synthesises for each trigger.
      classification: {
        category,
        classifierConfidence: 1,
        reasoning: `Followup trigger: ${isGreeting ? 'instagram_scan_arrival' : 'warm_close'}`,
        crisisSafety: false,
        correctsPendingReply: false,
        followUpWorthy: false,
        praisedExperience: false,
      },
    }

    const runtime = buildAiRuntime(ctx)
    const gen = await generateMessage({
      category,
      persona: ctx.venue.brandPersona,
      venueInfo: ctx.venue.venueInfo,
      ragChunks,
      // What handleFollowup sets on both turns: an empty list.
      knowledgeChunks: [],
      runtime,
      channel: 'instagram',
    })

    if (!gen.ok) {
      failed.push({ id: unit.id, error: gen.error })
      log.appendUnit({
        id: unit.id,
        arm: unit.arm,
        failed: true,
        error: gen.error,
      })
      console.log(`  ${unit.id}  FAILED: ${gen.error}`)
      continue
    }

    const body = gen.data.body
    const offers = has(body, OFFER_WORDS)
    const fault = [...has(body, unit.faultWords), ...has(body, FAULT_PHRASES)]
    const alludes = has(body, ALLUSION_PHRASES)
    const flags = {
      apologises: apologises(body),
      offers,
      namesTheFault: fault,
      alludes,
      asksWhatTheyGot: isGreeting ? asksWhatTheyGot(body) : null,
      carriesTheLink: isGreeting
        ? null
        : bodyContainsReviewLink(body, reviewLink.url),
      asksForRating: isGreeting ? null : asksForRating(body),
    }
    const repeated = (unit.priors ?? []).filter(
      (prior) => normalizeForRepeat(prior) === normalizeForRepeat(body),
    )
    if (repeated.length > 0) repeats.push({ id: unit.id, body })
    priorsBodies.push({ id: unit.id, body })
    if (unit.regular) {
      regulars.total += 1
      if (flags.asksWhatTheyGot) regulars.asks += 1
    } else if (isGreeting) {
      const c = counts.greetings
      c.total += 1
      if (flags.apologises) c.apologise += 1
      if (offers.length > 0) c.offer += 1
      if (fault.length > 0) c.fault += 1
      if (flags.asksWhatTheyGot) c.asks += 1
      if (alludes.length > 0) c.alludes += 1
    } else {
      const c = counts.signOffs
      c.total += 1
      if (flags.carriesTheLink) c.link += 1
      if (flags.asksForRating) c.rating += 1
      if (fault.length > 0) c.fault += 1
      if (offers.length > 0) c.offer += 1
      if (flags.apologises) c.apologise += 1
    }
    log.appendUnit({
      id: unit.id,
      arm: unit.arm,
      failed: false,
      body,
      reviewAsk: gen.data.reviewAsk,
      flags,
      priors: unit.priors ?? null,
      repeatsAPrior: repeated.length > 0,
      attempts: gen.data.attempts,
      // Loaded, and what generation was handed after buildAiRuntime's filter.
      historyLoaded: unit.history.length,
      historySeenByModel: runtime.recentMessages?.length ?? 0,
    })
    console.log(`  ${unit.id}  ${JSON.stringify(body)}`)
  }

  const { count: statesAfter } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })

  const g = counts.greetings
  const s = counts.signOffs
  console.log(`\n[tac575] greetings: ${g.total}`)
  console.log(`  apologise: ${g.apologise} (bar 0)`)
  console.log(`  offer anything: ${g.offer} (bar 0)`)
  console.log(`  name what went wrong: ${g.fault} (bar 0)`)
  console.log(`  ask what they got: ${g.asks} (bar ${PER_ARM})`)
  console.log(
    `  allude to it with a hope about today: ${g.alludes} (reported, not in the bar)`,
  )
  console.log(`[tac575] sign-offs: ${s.total}`)
  console.log(`  carry the review link: ${s.link} (bar ${PER_ARM})`)
  console.log(`  ask for a rating or stars: ${s.rating} (bar 0)`)
  console.log(`  mention what went wrong: ${s.fault} (bar 0)`)
  console.log(`  offer anything: ${s.offer} (bar 0)`)
  console.log(`  apologise: ${s.apologise} (reported, not in the bar)`)
  console.log(
    `[tac575] guest_states rows before/after: ${statesBefore}/${statesAfter}`,
  )

  // Validity before verdict.
  if (
    failed.length > 0 ||
    g.total + s.total + regulars.total !== units.length
  ) {
    console.log(
      `\n[tac575] RUN VOID: ${failed.length} unit(s) failed (${failed.map((f) => f.id).join(', ')}). A failed unit is not a result; no verdict.`,
    )
    log.appendUnit({ summary: true, void: true, failed })
    process.exit(2)
  }
  if (statesBefore !== statesAfter) {
    console.log('\n[tac575] RUN VOID: guest_states changed during the run.')
    log.appendUnit({ summary: true, void: true, statesBefore, statesAfter })
    process.exit(2)
  }

  if (priorsMode) {
    // Reported, not part of the bar: how alike the fifteen are to each other.
    const groups = new Map<string, string[]>()
    for (const b of priorsBodies) {
      const key = normalizeForRepeat(b.body)
      groups.set(key, [...(groups.get(key) ?? []), b.id])
    }
    const identical = [...groups.values()].filter((ids) => ids.length > 1)
    const complaintBarMet =
      g.apologise === 0 && g.offer === 0 && g.fault === 0 && g.asks === PER_ARM
    const pass = complaintBarMet && repeats.length === 0
    console.log(
      `\n[tac575] greetings repeating one of their own priors: ${repeats.length} of ${priorsBodies.length} (bar 0)${repeats.map((r) => ` [${r.id}]`).join('')}`,
    )
    console.log(
      `[tac575] regulars asking what they got: ${regulars.asks}/${regulars.total} (reported, not in the bar)`,
    )
    console.log(
      `[tac575] groups identical to each other: ${identical.length}${identical.map((ids) => ` [${ids.join(', ')}]`).join('')} (reported, not in the bar)`,
    )
    log.appendUnit({
      summary: true,
      void: false,
      priorsMode: true,
      counts,
      regulars,
      repeats,
      identical,
      complaintBarMet,
      pass,
      statesBefore,
      statesAfter,
    })
    console.log(
      `\n[tac575] complaint bar: ${complaintBarMet ? 'MET' : 'NOT MET'}; repeats: ${repeats.length}; ${pass ? 'PASS' : 'FAIL'}`,
    )
    process.exit(pass ? 0 : 1)
  }

  if (informational) {
    log.appendUnit({
      summary: true,
      void: false,
      informational: true,
      controlGreeting,
      counts,
      statesBefore,
      statesAfter,
    })
    console.log(
      '\n[tac575] INFORMATIONAL RUN: no verdict against the pre-registered bar.',
    )
    process.exit(0)
  }

  const greetingsPass =
    g.apologise === 0 && g.offer === 0 && g.fault === 0 && g.asks === PER_ARM
  const signOffsPass =
    s.link === PER_ARM && s.rating === 0 && s.fault === 0 && s.offer === 0
  log.appendUnit({
    summary: true,
    void: false,
    counts,
    greetingsPass,
    signOffsPass,
    statesBefore,
    statesAfter,
  })
  console.log(
    `\n[tac575] greetings: ${greetingsPass ? 'PASS' : 'FAIL'}; sign-offs: ${signOffsPass ? 'PASS' : 'FAIL'}`,
  )
  process.exit(greetingsPass && signOffsPass ? 0 : 1)
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(2)
})
