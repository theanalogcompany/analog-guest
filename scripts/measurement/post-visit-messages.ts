// TAC-578: do the first-visit thank-you and the later-visit check-in say what
// they were ruled to say?
//
// THE BARS WERE PRE-REGISTERED on TAC-578 (comment "Pre-registered generation
// check", 2026-10-07) before any generation and before this file existed. They
// are restated in BARS below and evaluated in code where code can; three of
// them are hand-reads and this prints every body verbatim for that. A re-run
// after a miss is informational and does not replace the first run.
//
// GENERATE-ONLY. Nothing is sent and nothing is written, with the one
// exception every harness on this path reports on itself: buildRuntimeContext
// calls computeGuestState, which persists a guest_states row on a band change.
// Context is built ONCE and the row count is printed before and after.
//
// THE BUDGET IS A HARD STOP, not a hope: every model call this makes
// (generation attempts and freshness-judge calls alike) is counted against
// MAX_MODEL_CALLS, and the run aborts before the call that would pass it.
//
// PROMPT CACHING. generateMessage already puts a one-hour cache breakpoint on
// the composed system prompt's stable prefix (template, persona, venue info;
// lib/ai/generate-message.ts), and every unit here goes through it, one at a
// time so each call can read what the one before wrote. The second system
// block (voice pack and category instructions) is deliberately uncached in
// production and is left that way here: a harness that cached differently
// from production would be measuring a different call. The hit rate is
// printed and logged: calls that read the cache over calls made, and cached
// input tokens over all input tokens. The judge's prompt is under the
// classification model's cacheable minimum and is not cached.
//
// WHAT IS CONSTRUCTED. The venue, its persona, voice pack, menu and review
// link are real. Each guest's history, orders and earlier check-ins are
// written here, and everything the base guest carries (commitments, stored
// context, mechanics) is cleared, because a real guest's open comp has ridden
// into a constructed prompt before and reached a ruling (TAC-575).
//
// WHAT IT CANNOT SHOW. Whether a review ask reads as pushy and whether a
// compliment is specific are hand-reads. Bar 8's "repeats none of the five
// earlier angles" is enforced in code for anything sent (the floor), so that
// bar cannot fail mechanically; what can fail is the judge misnaming an angle,
// which only reading the bodies shows. The timing, the claims and the
// one-message rule are not exercised here at all
// (scripts/harness/post-visit-timing).
//
// A FAILED UNIT IS NOT A RESULT (scripts/CLAUDE.md, convention 5). Any
// generation error voids the run, whatever the counts read.

import { randomUUID } from 'node:crypto'

import type {
  VoiceCorpusChunk as AiVoiceCorpusChunk,
  RecentMessage,
  Visit,
} from '@/lib/ai/types'
import { generateMessage } from '@/lib/ai'
import { PROMPT_VERSION } from '@/lib/ai/prompts/system-template'
import { VERIFY_VISIT_CHECKIN_PROMPT_VERSION } from '@/lib/ai/verify-visit-checkin'
import { buildRuntimeContext } from '@/lib/agent/build-runtime-context'
import { judgeCheckin } from '@/lib/agent/post-visit-timeout'
import { bodyContainsReviewLink } from '@/lib/agent/review-ask'
import { buildAiRuntime, retrieveCorpusStage } from '@/lib/agent/stages'
import type { PostVisitTrigger, RuntimeContext } from '@/lib/agent/types'
import {
  comparableWords,
  decodeAngle,
  encodeAngle,
  thanksForVisiting,
  type CheckinAngle,
} from '@/lib/agent/visit-messages'
import { createAdminClient } from '@/lib/db/admin'
import { startAgentTrace } from '@/lib/observability/langfuse'
import { findReviewLink, parseVenueLinks } from '@/lib/schemas'
import { toParsedGuestContext } from '@/lib/schemas/guest-context'
import { createRunLog } from './run-log'

/**
 * Ruled 2026-10-07: cap model calls at 300 across all arms; raised to 320 the
 * same day and then to 450, on the worst-case count of the first run, with
 * judge calls counted exactly from then on.
 */
const MAX_MODEL_CALLS = 450

/** The pre-registered bars, as posted on TAC-578. */
const BARS = {
  1: 'thank-you names something specific from the visit: 20/20 by token match, confirmed by hand',
  2: 'the review ask is not pushy: 0/20 on hand-read',
  3: 'the ask carries the link exactly: 20/20',
  4: 'today or yesterday matches the slot: 20/20',
  5: 'after a resolved complaint: 0/10 mention it, 0/10 apologise, 10/10 carry the ask',
  6: 'check-ins never thank for visiting: 0/20 pattern hits, confirmed by hand',
  7: 'every sent check-in is a specific compliment on hand-read; a skip passes',
  8: 'five earlier check-ins: 10/10 are a skip, or specific and repeating none of the five angles',
  9: 'second visit, one earlier order: 0/10 sent that are not specific; skip rate reported',
  10: '0 duplicates across guests; no opening four words shared by more than 2 guests within an arm (scored across guests only, ruled 2026-10-07)',
  C1: 'judge on hand-written candidates: catches 5/5 repeats, passes at least 4/5 fresh',
  C2: 'same order every visit, every angle used: at least 8/10 skip',
  C3: 'thanks-for-visiting pattern: 5/5 seeded, 0/5 clean (run in scripts/harness/post-visit-timing)',
} as const

type Arm =
  | 'thanks'
  | 'thanks_resolved'
  | 'checkin'
  | 'checkin_five_prior'
  | 'checkin_second_visit'
  | 'control_all_angles_used'

interface Unit {
  id: string
  /**
   * Which constructed guest this is. Several units share one on purpose (the
   * same guest's inputs run five or ten times), and bar 10 is scored ACROSS
   * guests only: ruled 2026-10-07, because one guest only ever receives one of
   * those drafts, so two of them sharing an opening is not two guests getting
   * the same line.
   */
  guest: string
  arm: Arm
  postVisit: Omit<PostVisitTrigger, 'answersMessageId'>
  history: RecentMessage[]
  visits: Visit[]
  /** Arm 1: any one of these in the body counts as naming the visit. */
  tokens?: string[]
  /** Check-in arms: the earlier check-ins with their angles, newest first. */
  prior?: { body: string; angle: CheckinAngle | null }[]
}

interface Output {
  id: string
  arm: Arm
  body: string
  reviewAsk: string
  /** Check-in arms: null when it would be sent, else why it would not. */
  rejection: string | null
  angle: string | null
}

const turn = (
  direction: 'inbound' | 'outbound',
  body: string,
  createdAt: Date,
): RecentMessage =>
  ({ direction, body, createdAt, delivery: 'delivered' }) as RecentMessage

const pad = (n: number): string => String(n).padStart(2, '0')

/** What a first-time guest told us besides the order, with a word to find it by. */
const TOLD: readonly { said: string; token: string }[] = [
  {
    said: 'first time here, my sister keeps talking about you',
    token: 'sister',
  },
  { said: 'just moved in around the corner', token: 'moved' },
  { said: 'stopped in before my flight', token: 'flight' },
  { said: 'my dog dragged me in honestly', token: 'dog' },
  { said: 'finally made it after walking past for months', token: 'walking' },
]

/** How the complaint arm's visits went wrong. The body must hint at none. */
const WRONG: readonly { said: string; words: string[] }[] = [
  {
    said: 'it came out lukewarm',
    words: ['lukewarm', 'warm', 'cold', 'temperature'],
  },
  { said: 'i asked for oat and got regular milk', words: ['oat', 'milk'] },
  {
    said: 'waited almost twenty minutes for it',
    words: ['wait', 'twenty', 'minutes'],
  },
  { said: 'there was a hair in it', words: ['hair'] },
  { said: 'you charged me twice', words: ['charge', 'twice', 'refund'] },
]

/** Anything that reads as going back over a complaint. */
const COMPLAINT_ECHO =
  /\b(sorry|apolog\w*|went wrong|mix[- ]?up|mishap|hiccup|issue|trouble|problem|complain\w*|make it right|made it right|remake|remade|sorted|fixed|bumpy|rough start|despite)\b/i

async function main(): Promise<void> {
  const venueSlug = process.env.MEASURE_VENUE ?? 'le-mils-coffee'
  const db = createAdminClient()

  const { data: venue, error: venueError } = await db
    .from('venues')
    .select('id, slug, name, status')
    .eq('slug', venueSlug)
    .single()
  if (venueError || !venue) throw new Error(`venue ${venueSlug} not found`)

  // Any real, non-opted-out Instagram guest. Only its id is used: everything a
  // message reads about the guest is overridden per unit below.
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
    name: 'tac578-post-visit-messages',
    agentRunId: randomUUID(),
  })
  const at = (minutesAgo: number): Date =>
    new Date(startedAt.getTime() - minutesAgo * 60_000)
  const daysAgo = (d: number): Date => at(d * 24 * 60)

  // Built ONCE, as the post-visit processor's own trigger would build it.
  const baseCtx = await buildRuntimeContext({
    agentRunId: randomUUID(),
    guestId,
    venueId: venue.id,
    trace,
    followupTrigger: {
      reason: 'post_visit',
      triggeredAt: startedAt,
      postVisit: {
        kind: 'first_visit_thanks',
        when: 'yesterday',
        answersMessageId: randomUUID(),
        afterResolvedComplaint: false,
        order: '',
        priorCheckins: [],
      },
    },
  })
  const reviewLink = findReviewLink(
    parseVenueLinks(baseCtx.venue.venueInfo.links),
  )
  if (reviewLink === null) {
    throw new Error(
      `${venueSlug} has no review link (kind: 'review' in venue_info.links); the thank-you arms cannot run`,
    )
  }
  const menu = baseCtx.venue.venueInfo.menu.items
    .map((i) => i.name.trim().toLowerCase())
    .filter((n) => n.length > 0)
  if (menu.length < 8) {
    throw new Error(`venue has ${menu.length} named menu items; need 8`)
  }
  // Spread across the menu, so the fixtures are not eight neighbours.
  const pick = (i: number): string =>
    menu[Math.floor((i * menu.length) / 8) % menu.length]
  const [A, B, C, D] = [pick(0), pick(1), pick(2), pick(3)]

  // ---- Units ----
  const visitThread = (
    order: string,
    extra: RecentMessage[],
  ): RecentMessage[] => [
    turn('outbound', 'hey, welcome in. what did you get?', at(26 * 60)),
    turn('inbound', `the ${order}`, at(26 * 60 - 1)),
    turn('outbound', `nice, the ${order}. how is it so far?`, at(26 * 60 - 2)),
    ...extra,
  ]

  const units: Unit[] = []
  // Arms 1-4: five first-time guests, four visits each, half in each slot.
  for (let g = 0; g < 5; g += 1) {
    for (let v = 0; v < 4; v += 1) {
      const order = pick(g + v)
      const morning = v % 2 === 0
      units.push({
        id: `thanks-${pad(g * 4 + v + 1)}`,
        guest: `first-timer-${g}`,
        arm: 'thanks',
        postVisit: {
          kind: 'first_visit_thanks',
          when: morning ? 'yesterday' : 'earlier today',
          afterResolvedComplaint: false,
          reviewAsk: { url: reviewLink.url, label: reviewLink.label },
          order: '',
          priorCheckins: [],
        },
        history: visitThread(order, [
          turn('inbound', `really good. ${TOLD[g].said}`, at(26 * 60 - 6)),
          turn('outbound', 'love that. enjoy it', at(26 * 60 - 7)),
        ]),
        visits: [{ items: [order], visitedAt: at(26 * 60) }],
        tokens: [
          order,
          ...order.split(/\s+/).filter((w) => w.length >= 5),
          TOLD[g].token,
        ],
      })
    }
  }
  // Arm 5: a first visit where something went wrong and staff put it right.
  for (let i = 0; i < 10; i += 1) {
    const order = pick(i)
    const wrong = WRONG[i % WRONG.length]
    units.push({
      id: `resolved-${pad(i + 1)}`,
      guest: `resolved-${i}`,
      arm: 'thanks_resolved',
      postVisit: {
        kind: 'first_visit_thanks',
        when: i % 2 === 0 ? 'yesterday' : 'earlier today',
        afterResolvedComplaint: true,
        reviewAsk: { url: reviewLink.url, label: reviewLink.label },
        order: '',
        priorCheckins: [],
      },
      history: visitThread(order, [
        turn('inbound', `honestly not great, ${wrong.said}`, at(26 * 60 - 5)),
        turn(
          'outbound',
          "that's on us, come up to the counter and we'll sort it right now",
          at(26 * 60 - 9),
        ),
        turn('inbound', 'ok thanks, all good now', at(26 * 60 - 20)),
      ]),
      visits: [{ items: [order], visitedAt: at(26 * 60) }],
      tokens: wrong.words,
    })
  }
  // Arms 6-7: four guests with a history, five runs each on identical inputs,
  // which is the pressure toward repetition.
  const regulars: { today: string[]; before: string[][] }[] = [
    { today: [A], before: [[A], [A], [A], [A], [B]] },
    { today: [C], before: [[A], [A], [A], [A]] },
    { today: [A, D], before: [[A], [A, D], [A]] },
    { today: [B], before: [[B], [C], [B], [D], [B]] },
  ]
  const history = (today: string[], before: string[][]): Visit[] => [
    { items: today, visitedAt: at(26 * 60) },
    ...before.map((items, i) => ({ items, visitedAt: daysAgo(3 + i * 4) })),
  ]
  regulars.forEach((r, g) => {
    for (let i = 0; i < 5; i += 1) {
      units.push({
        id: `checkin-${pad(g * 5 + i + 1)}`,
        guest: `regular-${g}`,
        arm: 'checkin',
        postVisit: {
          kind: 'visit_checkin',
          when: i % 2 === 0 ? 'yesterday' : 'earlier today',
          afterResolvedComplaint: false,
          order: r.today.join(', '),
          priorCheckins: [],
        },
        history: visitThread(r.today[0], [
          turn('inbound', 'good as always', at(26 * 60 - 6)),
        ]),
        visits: history(r.today, r.before),
        prior: [],
      })
    }
  })
  // Arm 8: one guest who has already had five check-ins, each a different
  // angle. Newest first.
  const fivePrior: { body: string; angle: CheckinAngle }[] = [
    {
      body: `the ${A} again. you know exactly what you like`,
      angle: { kind: 'the_usual', item: A },
    },
    {
      body: `${B} this time, after all those ${A}s. keeping us on our toes`,
      angle: { kind: 'a_departure', item: B },
    },
    {
      body: `the ${A} with the ${C} is what half our staff orders on break`,
      angle: { kind: 'the_pairing', item: A },
    },
    {
      body: 'in before nine three days running. the morning crew has noticed',
      angle: { kind: 'the_timing', item: '' },
    },
    {
      body: 'you always go for the one with the least sugar in it. good instincts',
      angle: { kind: 'their_taste', item: '' },
    },
  ]
  const fivePriorVisits = history([A, D], [[A], [B], [A, C], [A], [A], [A]])
  for (let i = 0; i < 10; i += 1) {
    units.push({
      id: `five-prior-${pad(i + 1)}`,
      guest: 'five-prior',
      arm: 'checkin_five_prior',
      postVisit: {
        kind: 'visit_checkin',
        when: i % 2 === 0 ? 'yesterday' : 'earlier today',
        afterResolvedComplaint: false,
        order: [A, D].join(', '),
        priorCheckins: fivePrior.map((p) => p.body),
      },
      history: visitThread(A, [turn('inbound', 'perfect', at(26 * 60 - 6))]),
      visits: fivePriorVisits,
      prior: fivePrior,
    })
  }
  // Arm 9: a second visit, with one order behind it.
  for (let i = 0; i < 10; i += 1) {
    const today = i < 5 ? A : B
    units.push({
      id: `second-visit-${pad(i + 1)}`,
      guest: `second-visit-${today}`,
      arm: 'checkin_second_visit',
      postVisit: {
        kind: 'visit_checkin',
        when: i % 2 === 0 ? 'yesterday' : 'earlier today',
        afterResolvedComplaint: false,
        order: today,
        priorCheckins: [],
      },
      history: visitThread(today, [
        turn('inbound', 'so good', at(26 * 60 - 6)),
      ]),
      visits: history([today], [[A]]),
      prior: [],
    })
  }
  // Control C2: the same order every visit, and every angle already used on
  // it. There is nothing left to say; the right output is nothing.
  const allUsed: { body: string; angle: CheckinAngle }[] = [
    {
      body: `nobody orders the ${A} with more conviction than you`,
      angle: { kind: 'the_choice', item: A },
    },
    {
      body: `the ${A}, same as every time. we start it when you walk in`,
      angle: { kind: 'the_usual', item: A },
    },
    {
      body: `you and the ${A}, same time every week. we could set a clock by it`,
      angle: { kind: 'the_timing', item: A },
    },
    {
      body: `anyone who sticks with the ${A} this long knows what good tastes like`,
      angle: { kind: 'their_taste', item: A },
    },
    {
      body: `still not tempted away from the ${A}? respect for holding the line`,
      angle: { kind: 'a_departure', item: A },
    },
    {
      body: `the ${A} on its own, nothing with it. it does not need company`,
      angle: { kind: 'the_pairing', item: A },
    },
  ]
  for (let i = 0; i < 10; i += 1) {
    units.push({
      id: `all-used-${pad(i + 1)}`,
      guest: 'all-used',
      arm: 'control_all_angles_used',
      postVisit: {
        kind: 'visit_checkin',
        when: i % 2 === 0 ? 'yesterday' : 'earlier today',
        afterResolvedComplaint: false,
        order: A,
        priorCheckins: allUsed.map((p) => p.body),
      },
      history: visitThread(A, [turn('inbound', 'yep', at(26 * 60 - 6))]),
      visits: history([A], [[A], [A], [A], [A], [A], [A], [A]]),
      prior: allUsed,
    })
  }

  // Control C1: the judge and the floor on drafts nobody generated, against
  // the arm-8 guest. Five restate an earlier observation; five do not.
  const c1Repeats = [
    `${A} again, of course. you really do know what you like`,
    `always the ${A}. you know your own mind`,
    `back for the ${A} like clockwork, nothing else gets a look in`,
    'another early one. you beat most of the staff in this week',
    `you never pick the sweet one, do you. the ${A} is the grown-up choice`,
  ]
  const c1Fresh = [
    `adding the ${D} to your ${A} is new for you, and it is the right one to add`,
    `the ${D}. we wondered how long you would hold out`,
    `first time we have seen you with a ${D}. it was made about ten minutes before you walked in`,
    `the ${D} is the thing on the menu we are proudest of, glad it finally got you`,
    `a ${D} on the side this time. that one sells out by ten most days, good catch`,
  ]
  // Added on the ruling of 2026-10-07, and scored apart from the five above so
  // the original bar still reads on the original five. It is exactly the shape
  // ruled fresh: "you tried something new" about a DIFFERENT item on a
  // different day from the earlier message that said it about another one.
  const c1FreshAdded = [
    `${D} today, after ${B} the other week. trying new things suits you`,
  ]

  // MEASURE_ONLY=c1 runs the judge control alone: ten judge calls, no
  // generation. INFORMATIONAL, never the pre-registered verdict, and it prints
  // no PASS or FAIL for the other bars because it has not run them.
  const controlOnly = process.env.MEASURE_ONLY === 'c1'
  if (controlOnly) units.length = 0
  // MEASURE_ONLY=rerun regenerates the two thank-you arms and the judge
  // control, the ones behind the bars the first run failed (1, 10, C1) and
  // the one whose pass did not survive a hand-read (5). INFORMATIONAL too: the
  // first run is the verdict on the wording it measured, and this is a first
  // look at different wording.
  //
  // MEASURE_ONLY=checkins does the same for the four check-in arms (bars 6
  // to 9 and C2) with C1, against whichever judge is in the tree.
  const only = process.env.MEASURE_ONLY
  const rerun = only === 'rerun' || only === 'checkins'
  if (rerun) {
    const kept = units.filter((u) =>
      only === 'rerun'
        ? u.arm === 'thanks' || u.arm === 'thanks_resolved'
        : u.arm !== 'thanks' && u.arm !== 'thanks_resolved',
    )
    units.length = 0
    units.push(...kept)
  }
  const totalGenerations = units.length
  const log = createRunLog({
    name: 'tac578-post-visit-messages',
    meta: {
      arm: controlOnly
        ? 'informational-c1-only'
        : rerun
          ? `informational-${only}-and-c1`
          : 'treatment-with-controls',
      promptVersion: PROMPT_VERSION,
      judgePromptVersion: VERIFY_VISIT_CHECKIN_PROMPT_VERSION,
      venue: venueSlug,
      venueName: venue.name,
      venueStatus: venue.status,
      guestId,
      units: totalGenerations,
      maxModelCalls: MAX_MODEL_CALLS,
      bars: BARS,
      controls:
        'C1 scores the judge on hand-written drafts; C2 is a guest with nothing left to say; C3 is the no-model pattern check in scripts/harness/post-visit-timing.',
      constructed:
        "each unit's history, orders and earlier check-ins; the base guest's commitments, context and mechanics are cleared",
      menuItemsUsed: { A, B, C, D },
    },
  })
  console.log(
    `[tac578] prompt=${PROMPT_VERSION} judge=${VERIFY_VISIT_CHECKIN_PROMPT_VERSION} venue=${venueSlug} units=${totalGenerations} cap=${MAX_MODEL_CALLS}`,
  )

  // Calls made by earlier runs of this harness, carried in by hand so the cap
  // is over the whole ticket and not over one invocation.
  const alreadySpent = Number(process.env.MEASURE_SPENT ?? '0')
  if (!Number.isInteger(alreadySpent) || alreadySpent < 0) {
    throw new Error('MEASURE_SPENT must be a whole number of model calls')
  }
  let modelCalls = alreadySpent
  /** Refuse to start something that could pass the cap, without counting it. */
  const reserve = (n: number, what: string): void => {
    if (modelCalls + n > MAX_MODEL_CALLS) {
      log.appendUnit({
        summary: true,
        void: true,
        reason: 'budget',
        modelCalls,
      })
      throw new Error(
        `budget: ${what} could take the run past ${MAX_MODEL_CALLS} model calls (at ${modelCalls})`,
      )
    }
  }
  const spend = (n: number, what: string): void => {
    if (modelCalls + n > MAX_MODEL_CALLS) {
      log.appendUnit({
        summary: true,
        void: true,
        reason: 'budget',
        modelCalls,
      })
      throw new Error(
        `budget: ${what} would take the run past ${MAX_MODEL_CALLS} model calls (at ${modelCalls})`,
      )
    }
    modelCalls += n
  }

  // The voice pack is static per venue, so one load serves every unit.
  const corpus = await retrieveCorpusStage(baseCtx)
  const ragChunks: AiVoiceCorpusChunk[] = corpus.map((ch) => ({
    id: ch.id,
    text: ch.text,
    sourceType: ch.sourceType as AiVoiceCorpusChunk['sourceType'],
    relevanceScore: ch.similarity,
  }))

  const outputs: Output[] = []
  const failed: { id: string; error: string }[] = []
  const cache = { calls: 0, hits: 0, read: 0, written: 0, uncached: 0 }

  // ONE AT A TIME, on purpose: a call can only read the cache entry the call
  // before it finished writing.
  for (const unit of units) {
    const postVisit: PostVisitTrigger = {
      ...unit.postVisit,
      answersMessageId: randomUUID(),
    }
    const ctx: RuntimeContext = {
      ...baseCtx,
      guest: {
        ...baseCtx.guest,
        firstName: null,
        context: toParsedGuestContext({}, startedAt),
        reviewAskedAt: null,
      },
      recentMessages: unit.history,
      recentVisits: unit.visits,
      // NOTHING OF THE REAL GUEST'S (TAC-575's contaminated run).
      activeCommitments: [],
      retractableReportedVisits: [],
      mechanics: [],
      conversationChannel: 'instagram',
      firstConversation: false,
      openIntentions: [],
      pendingQuestion: null,
      corpus,
      knowledgeCorpus: [],
      signOff: null,
      postVisit,
      reviewAsk: postVisit.reviewAsk ?? null,
      followupTrigger: {
        reason: 'post_visit',
        triggeredAt: startedAt,
        postVisit,
      },
      // What handleFollowup synthesises for a post_visit trigger.
      classification: {
        category: 'follow_up',
        classifierConfidence: 1,
        reasoning: 'Followup trigger: post_visit',
        crisisSafety: false,
        correctsPendingReply: false,
        followUpWorthy: false,
        praisedExperience: false,
      },
    }

    // One attempt is certain; a regeneration is counted after the fact.
    spend(1, `generating ${unit.id}`)
    const gen = await generateMessage({
      category: 'follow_up',
      persona: ctx.venue.brandPersona,
      venueInfo: ctx.venue.venueInfo,
      ragChunks,
      knowledgeChunks: [],
      runtime: buildAiRuntime(ctx),
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
    if (gen.data.attempts > 1)
      spend(gen.data.attempts - 1, `regenerating ${unit.id}`)
    cache.calls += 1
    if (gen.data.cacheReadTokens > 0) cache.hits += 1
    cache.read += gen.data.cacheReadTokens
    cache.written += gen.data.cacheWriteTokens
    // `usage.inputTokens` is the SDK's TOTAL (uncached + read + written).
    cache.uncached += Math.max(
      0,
      (gen.data.usage?.inputTokens ?? 0) -
        gen.data.cacheReadTokens -
        gen.data.cacheWriteTokens,
    )

    let rejection: string | null = null
    let angle: string | null = null
    if (unit.postVisit.kind === 'visit_checkin') {
      // The production check, the production function. Up to two judge calls.
      reserve(2, `judging ${unit.id}`)
      const verdict = await judgeCheckin({
        draft: gen.data.body,
        order: unit.postVisit.order,
        earlierOrders: unit.visits.slice(1).map((v) => v.items.join(', ')),
        earlier: unit.prior ?? [],
        signOffBody: null,
      })
      spend(verdict.judgeCalls, `judging ${unit.id}`)
      rejection = verdict.rejection
      angle = verdict.angle === null ? null : encodeAngle(verdict.angle)
    }
    const out: Output = {
      id: unit.id,
      arm: unit.arm,
      body: gen.data.body,
      reviewAsk: gen.data.reviewAsk,
      rejection,
      angle,
    }
    outputs.push(out)
    log.appendUnit({
      ...out,
      when: unit.postVisit.when,
      attempts: gen.data.attempts,
      cacheReadTokens: gen.data.cacheReadTokens,
      cacheWriteTokens: gen.data.cacheWriteTokens,
    })
    console.log(
      `  ${unit.id}  [${unit.postVisit.when}]${rejection === null ? '' : `  NOT SENT (${rejection})`}${angle === null ? '' : `  angle=${angle}`}\n      ${JSON.stringify(gen.data.body)}`,
    )
  }

  // ---- Control C1: no generation, judge only. ----
  const c1: {
    draft: string
    expected: 'repeat' | 'fresh' | 'fresh_added'
    rejection: string | null
  }[] = []
  for (const [expected, drafts] of [
    ['repeat', c1Repeats],
    ['fresh', c1Fresh],
    ['fresh_added', c1FreshAdded],
  ] as const) {
    for (const draft of drafts) {
      reserve(2, 'control C1')
      const verdict = await judgeCheckin({
        draft,
        order: [A, D].join(', '),
        earlierOrders: fivePriorVisits.slice(1).map((v) => v.items.join(', ')),
        earlier: fivePrior,
        signOffBody: null,
      })
      spend(verdict.judgeCalls, 'control C1')
      c1.push({ draft, expected, rejection: verdict.rejection })
      log.appendUnit({
        control: 'C1',
        draft,
        expected,
        rejection: verdict.rejection,
        angle: verdict.angle === null ? null : encodeAngle(verdict.angle),
      })
      console.log(
        `  C1 ${expected.padEnd(11)} ${verdict.rejection === null ? 'would send' : `not sent (${verdict.rejection})`}  ${JSON.stringify(draft)}`,
      )
    }
  }

  const { count: statesAfter } = await db
    .from('guest_states')
    .select('*', { count: 'exact', head: true })
  await trace.flushAsync()

  if (controlOnly) {
    const caught = c1.filter(
      (c) => c.expected === 'repeat' && c.rejection !== null,
    ).length
    const passed = c1.filter(
      (c) => c.expected === 'fresh' && c.rejection === null,
    ).length
    log.appendUnit({ summary: true, informational: true, caught, passed })
    console.log(
      `\n[tac578] INFORMATIONAL (C1 only, judge ${VERIFY_VISIT_CHECKIN_PROMPT_VERSION}): caught ${caught}/5 repeats, passed ${passed}/5 fresh. Model calls counted: ${modelCalls}. No verdict against the pre-registered bars.`,
    )
    process.exit(0)
  }

  // ---- Cache, first, whatever the verdict. ----
  const inputTokens = cache.read + cache.written + cache.uncached
  const cacheReport = {
    generationCalls: cache.calls,
    callsThatReadTheCache: cache.hits,
    callHitRate: cache.calls === 0 ? 0 : cache.hits / cache.calls,
    cachedInputTokens: cache.read,
    cacheWriteTokens: cache.written,
    uncachedInputTokens: cache.uncached,
    cachedShareOfInput: inputTokens === 0 ? 0 : cache.read / inputTokens,
  }
  console.log(
    `\n[tac578] prompt cache: ${cache.hits}/${cache.calls} generation calls read it (${(cacheReport.callHitRate * 100).toFixed(1)}%); ${cache.read} of ${inputTokens} input tokens were cached (${(cacheReport.cachedShareOfInput * 100).toFixed(1)}%); ${cache.written} written`,
  )
  console.log(
    `[tac578] model calls counted against the cap: ${modelCalls}/${MAX_MODEL_CALLS}`,
  )
  console.log(
    `[tac578] guest_states rows before/after: ${statesBefore}/${statesAfter}`,
  )

  if (failed.length > 0 || outputs.length !== units.length) {
    console.log(
      `\n[tac578] RUN VOID: ${failed.length} unit(s) failed (${failed.map((f) => f.id).join(', ')}). A failed unit is not a result; no verdict.`,
    )
    log.appendUnit({
      summary: true,
      void: true,
      failed,
      cache: cacheReport,
      modelCalls,
    })
    process.exit(2)
  }

  // ---- Scoring: what code can decide. ----
  const of = (arm: Arm): Output[] => outputs.filter((o) => o.arm === arm)
  const unitOf = new Map(units.map((u) => [u.id, u]))
  const lower = (o: Output): string => o.body.toLowerCase()
  const sent = (list: Output[]): Output[] =>
    list.filter((o) => o.rejection === null)

  const thanks = of('thanks')
  // Compared with punctuation folded away. The first run scored two bodies as
  // misses because a menu name carries a dash the reply correctly drops
  // ("sofi – mj" against "SoFi MJ"); that was the scorer, not the reply.
  const folded = (text: string): string => comparableWords(text).join(' ')
  const b1 = thanks.filter((o) =>
    (unitOf.get(o.id)?.tokens ?? []).some((t) =>
      folded(o.body).includes(folded(t)),
    ),
  )
  const b3 = thanks.filter((o) =>
    bodyContainsReviewLink(o.body, reviewLink.url),
  )
  const wrongDay = (o: Output): boolean => {
    const when = unitOf.get(o.id)?.postVisit.when
    return when === 'yesterday'
      ? /\b(today|this morning|this afternoon|tonight|earlier)\b/i.test(o.body)
      : /\b(yesterday|last night)\b/i.test(o.body)
  }
  const b4 = thanks.filter((o) => !wrongDay(o))

  const resolved = of('thanks_resolved')
  const b5Echo = resolved.filter(
    (o) =>
      COMPLAINT_ECHO.test(o.body) ||
      (unitOf.get(o.id)?.tokens ?? []).some((t) => lower(o).includes(t)),
  )
  const b5Link = resolved.filter((o) =>
    bodyContainsReviewLink(o.body, reviewLink.url),
  )

  const checkins = of('checkin')
  const b6 = checkins.filter((o) => thanksForVisiting(o.body))

  const five = of('checkin_five_prior')
  const priorAngles = new Set(fivePrior.map((p) => encodeAngle(p.angle)))
  const b8Bad = sent(five).filter((o) => {
    const a = decodeAngle(o.angle)
    return a === null || priorAngles.has(encodeAngle(a))
  })

  const second = of('checkin_second_visit')
  const c2 = of('control_all_angles_used')
  const c2Skips = c2.length - sent(c2).length

  // Bar 10, ACROSS GUESTS ONLY (see Unit.guest). A duplicate is the same body
  // going to two different guests; an overused opening is one that more than
  // two different guests in an arm would receive.
  const norm = (o: Output): string => comparableWords(o.body).join(' ')
  const guestOf = (o: Output): string => unitOf.get(o.id)?.guest ?? o.id
  const seen = new Map<string, Output[]>()
  for (const o of outputs) seen.set(norm(o), [...(seen.get(norm(o)) ?? []), o])
  const duplicates = [...seen.values()]
    .filter((group) => new Set(group.map(guestOf)).size > 1)
    .map((group) => group.map((o) => o.id))
  const overusedOpenings: { arm: Arm; opening: string; ids: string[] }[] = []
  for (const arm of new Set(outputs.map((o) => o.arm))) {
    const byOpening = new Map<string, Output[]>()
    for (const o of of(arm)) {
      const opening = comparableWords(o.body).slice(0, 4).join(' ')
      byOpening.set(opening, [...(byOpening.get(opening) ?? []), o])
    }
    for (const [opening, group] of byOpening) {
      if (new Set(group.map(guestOf)).size > 2) {
        overusedOpenings.push({ arm, opening, ids: group.map((o) => o.id) })
      }
    }
  }

  const c1Caught = c1.filter(
    (c) => c.expected === 'repeat' && c.rejection !== null,
  )
  const c1Passed = c1.filter(
    (c) => c.expected === 'fresh' && c.rejection === null,
  )

  const verdicts: Record<string, { pass: boolean | null; detail: string }> = {
    1: {
      pass: b1.length === thanks.length,
      detail: `${b1.length}/${thanks.length} name something from the visit (token match; confirm by hand)`,
    },
    2: {
      pass: null,
      detail: 'HAND-READ: the review ask, in the thanks-* bodies above',
    },
    3: {
      pass: b3.length === thanks.length,
      detail: `${b3.length}/${thanks.length} carry the link exactly`,
    },
    4: {
      pass: b4.length === thanks.length,
      detail: `${b4.length}/${thanks.length} name no day that contradicts the slot`,
    },
    5: {
      pass: b5Echo.length === 0 && b5Link.length === resolved.length,
      detail: `${b5Echo.length}/${resolved.length} echo the complaint or apologise${b5Echo.length > 0 ? ` (${b5Echo.map((o) => o.id).join(', ')})` : ''}; ${b5Link.length}/${resolved.length} carry the ask`,
    },
    6: {
      pass: b6.length === 0,
      detail: `${b6.length}/${checkins.length} thank for visiting (pattern; confirm by hand)`,
    },
    7: {
      pass: null,
      detail: `HAND-READ: ${sent(checkins).length}/${checkins.length} would be sent, ${checkins.length - sent(checkins).length} skipped`,
    },
    8: {
      pass: b8Bad.length === 0,
      detail: `${five.length - sent(five).length}/${five.length} skipped; ${sent(five).length} would be sent, ${b8Bad.length} of those on an earlier angle (the floor makes this 0 by construction; specificity is a HAND-READ)`,
    },
    9: {
      pass: null,
      detail: `HAND-READ: ${sent(second).length}/${second.length} would be sent; skip rate ${second.length - sent(second).length}/${second.length}`,
    },
    10: {
      pass: duplicates.length === 0 && overusedOpenings.length === 0,
      detail: `${duplicates.length} duplicate group(s); ${overusedOpenings.length} opening(s) shared by more than 2 guests in an arm${overusedOpenings.map((x) => ` [${x.arm}: "${x.opening}" x${x.ids.length}]`).join('')}`,
    },
    C1: {
      pass: c1Caught.length === 5 && c1Passed.length >= 4,
      detail: `caught ${c1Caught.length}/5 repeats; passed ${c1Passed.length}/5 fresh; the added different-item case ${c1.some((c) => c.expected === 'fresh_added' && c.rejection === null) ? 'passed' : 'was NOT passed'} (reported, outside the original bar)`,
    },
    C2: {
      pass: c2Skips >= 8,
      detail: `${c2Skips}/${c2.length} skipped`,
    },
  }

  console.log('\n[tac578] against the pre-registered bars:')
  for (const [bar, v] of Object.entries(verdicts)) {
    const mark = v.pass === null ? 'READ' : v.pass ? 'PASS' : 'FAIL'
    console.log(`  ${bar.padEnd(3)} ${mark}  ${v.detail}`)
  }
  const reasons = new Map<string, number>()
  for (const o of outputs) {
    if (o.rejection !== null) {
      reasons.set(
        `${o.arm}:${o.rejection}`,
        (reasons.get(`${o.arm}:${o.rejection}`) ?? 0) + 1,
      )
    }
  }
  console.log(
    `[tac578] why check-ins were not sent: ${[...reasons].map(([k, n]) => `${k} x${n}`).join(', ') || 'none were skipped'}`,
  )

  if (rerun) {
    log.appendUnit({
      summary: true,
      informational: true,
      verdicts,
      overusedOpenings,
      cache: cacheReport,
      modelCalls,
    })
    console.log(
      `\n[tac578] INFORMATIONAL RE-RUN (${only}, with C1). Lines for arms that did not run read 0/0 and mean nothing. No verdict against the pre-registered bars. Model calls so far: ${modelCalls}/${MAX_MODEL_CALLS}. Log: ${log.path}`,
    )
    process.exit(0)
  }

  const mechanicalFail = Object.values(verdicts).some((v) => v.pass === false)
  log.appendUnit({
    summary: true,
    void: false,
    verdicts,
    duplicates,
    overusedOpenings,
    skipReasons: Object.fromEntries(reasons),
    cache: cacheReport,
    modelCalls,
    statesBefore,
    statesAfter,
  })
  console.log(
    `\n[tac578] MECHANICAL BARS: ${mechanicalFail ? 'FAIL' : 'PASS'}. Bars 2, 7 and 9, and the hand half of 1, 6 and 8, are Jaipal's to read. Log: ${log.path}`,
  )
  process.exit(mechanicalFail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
