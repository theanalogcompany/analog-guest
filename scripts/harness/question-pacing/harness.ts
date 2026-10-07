// Behavioural checks for WHEN a getting-to-know-you question may be asked
// (ruled 2026-10-07): one open question at a time, only on a relaxed turn, and
// a ceiling per conversation.
//
// Run by hand (see README.md). Pure: it drives the real derivation, the real
// render filter and the real draft check with constructed inputs. No database,
// no model, no network, so it needs no credentials and refuses none.
//
// Every scenario has a CONTROL beside it that renders the question, so a check
// expecting "nothing renders" cannot pass because the scenario was never able
// to render anything. The README lists which rules were removed to confirm the
// checks fail.

import type { MessageCategory } from '@/lib/ai'
import {
  buildSatisfactionFacts,
  deriveOpenIntentions,
  renderableIntentions,
  rendersOnlyConversationPaced,
  type DeriveOpenIntentionsInput,
  type OpenIntention,
} from '@/lib/agent/intentions/derive'
import {
  INTENTION_DEFINITION_BY_KEY,
  type IntentionKey,
} from '@/lib/agent/intentions/definitions'
import type { PromptedIntentionRow } from '@/lib/agent/intentions/load'
import {
  isConversationPaced,
  isRelaxedCategory,
} from '@/lib/agent/intentions/pacing'
import { isTaskDraft } from '@/lib/ai/task-draft'
import { INTENTION_RULES_DEFAULT } from '@/lib/schemas/intention-rules'

const NOW = new Date('2026-10-07T20:00:00Z')
const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000)
const HOUR = 3600
const DAY = 24 * HOUR
const WINDOW_MS = 48 * HOUR * 1000

let failures = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`ok    ${name}`)
    return
  }
  failures++
  console.log(`FAIL  ${name}\n        expected ${e}\n        actual   ${a}`)
}

interface Known {
  name?: string
  homeBase?: string
  history?: string
}
const facts = (known: Known = {}) =>
  buildSatisfactionFacts({
    hasQualifyingTransaction: true,
    firstName: known.name ?? null,
    homeBase: known.homeBase,
    recordedVisitCount: 1,
    venueHistory: known.history,
  })

/** A question that reached the guest, as the post-send classifier records it. */
function asked(
  key: IntentionKey,
  secondsAgo: number,
  messageId: string,
  promptSource = 'classified',
): PromptedIntentionRow {
  return {
    intentionKey: key,
    promptedAt: at(-secondsAgo),
    eligibleAt: at(-secondsAgo - 60),
    promptSource,
    messageId,
  }
}

/** The guest's messages, newest last; the final one is the current message. */
function said(...bodies: string[]): { at: Date; body: string }[] {
  return bodies.map((body, i) => ({
    at: at(-(bodies.length - 1 - i) * 30),
    body,
  }))
}

interface Turn {
  replies: number
  prompted?: PromptedIntentionRow[]
  known?: Known
  messages?: { at: Date; body: string }[]
  over?: Partial<DeriveOpenIntentionsInput>
}

function derive(turn: Turn) {
  const messages = turn.messages ?? said('hi')
  return deriveOpenIntentions({
    now: NOW,
    responseRate: 0,
    repliedMessageCount: turn.replies,
    rules: INTENTION_RULES_DEFAULT,
    facts: facts(turn.known),
    visitConfirmedAt: null,
    openRecommendationTimes: [],
    openRecommendationTouchedTimes: [],
    openRecommendationsUnreadable: false,
    recordedOrderTimes: [],
    sameVisitOrderAt: null,
    checkbackDueAt: null,
    rows: { prompted: turn.prompted ?? [], eligible: [] },
    inboundTimes: messages.map((m) => m.at),
    inboundMessages: messages,
    conversationWindowMs: WINDOW_MS,
    inboundHistoryFrom: at(-14 * DAY),
    isFirstConversation: true,
    quietAfterWarmClose: false,
    venueHasAnsweredBefore: true,
    ...turn.over,
  })
}

/** The getting-to-know-you questions this turn renders, once it is classified. */
function pacedRendered(
  turn: Turn,
  category: MessageCategory | null,
): IntentionKey[] {
  return renderableIntentions(derive(turn).open, category, false, false, false)
    .map((o) => o.key)
    .filter(isConversationPaced)
}

const line = (key: IntentionKey): OpenIntention => ({
  key,
  promptLine: INTENTION_DEFINITION_BY_KEY[key].promptLine,
  eligibleAt: NOW,
})

// ---------------------------------------------------------------------------
// The phone test, 2026-10-07 (constructed: the rows were deleted with the
// guest). "hi", "do you have oat milk?", "can i get a flat white"; our reply
// asks their name and gets no answer; then "can i see the menu".
// ---------------------------------------------------------------------------

const phoneTest: Turn = {
  replies: 5,
  prompted: [asked('learn_name', 120, 'm-name')],
  messages: said(
    'hi',
    'do you have oat milk?',
    'can i get a flat white',
    'ok',
    'can i see the menu',
  ),
}

check(
  'CONTROL the menu turn, with the name never asked and on a relaxed turn, can ask',
  pacedRendered({ ...phoneTest, prompted: [] }, 'casual_chatter'),
  ['learn_name', 'are_they_local'],
)
check(
  'phone test: the menu turn renders no getting-to-know-you question',
  pacedRendered(phoneTest, 'new_question'),
  [],
)
check(
  'phone test, rule 1 alone: the unanswered name holds them even on a relaxed turn',
  pacedRendered(phoneTest, 'casual_chatter'),
  [],
)
check(
  'phone test, rule 1 alone: the hold says why',
  derive(phoneTest).pacing.hold,
  'open_question',
)
check(
  'phone test, rule 2 alone: with the name never asked, a menu request still renders none',
  pacedRendered({ ...phoneTest, prompted: [] }, 'new_question'),
  [],
)

// ---------------------------------------------------------------------------
// Rule 1: one open question at a time.
// ---------------------------------------------------------------------------

const nameAnswered: Turn = {
  replies: 5,
  prompted: [asked('learn_name', 120, 'm-name')],
  known: { name: 'Sam' },
  messages: said('hi', 'sam', 'haha yes'),
}

check(
  'name asked and answered: a relaxed turn later may ask the next one',
  pacedRendered(nameAnswered, 'reply'),
  ['are_they_local'],
)
check(
  'the turn that carries the answer asks nothing (the name is not on file yet)',
  pacedRendered({ ...nameAnswered, known: {} }, 'reply'),
  [],
)
check(
  'name asked and answered, but the guest is asking for something: none',
  pacedRendered(nameAnswered, 'new_question'),
  [],
)
check(
  'an ignored question from an earlier conversation does not hold the next one',
  pacedRendered(
    {
      replies: 5,
      prompted: [asked('learn_name', 49 * HOUR, 'm-name')],
      over: { isFirstConversation: false },
    },
    'casual_chatter',
  ),
  ['are_they_local'],
)
check(
  'CONTROL the same ignored question inside the window does hold it',
  pacedRendered(
    {
      replies: 5,
      prompted: [asked('learn_name', 47 * HOUR, 'm-name')],
      over: { isFirstConversation: false },
    },
    'casual_chatter',
  ),
  [],
)
check(
  'a pessimistic closure asked nothing, so it holds nothing',
  pacedRendered(
    {
      replies: 5,
      prompted: [asked('learn_name', 120, 'm-name', 'pessimistic')],
    },
    'casual_chatter',
  ),
  ['are_they_local'],
)
check(
  'a question with no stored answer (their_rhythm) ends the asking for the conversation',
  pacedRendered(
    {
      replies: 11,
      prompted: [asked('their_rhythm', 300, 'm-rhythm')],
      known: { name: 'Sam', homeBase: 'Polk Street' },
      messages: said('mornings mostly, before work around eight', 'you?'),
    },
    'casual_chatter',
  ),
  [],
)

// ---------------------------------------------------------------------------
// Rule 3: two per conversation, three for an engaged guest.
// ---------------------------------------------------------------------------

const twoAnswered = (messages: { at: Date; body: string }[]): Turn => ({
  replies: 8,
  prompted: [
    asked('learn_name', 600, 'm-name'),
    asked('are_they_local', 300, 'm-local'),
  ],
  known: { name: 'Sam', homeBase: 'Polk Street' },
  messages,
})
const terse = said('sam', 'yeah', 'ok cool')
const asksBack = said('sam', 'yeah', 'how long have you been open?')
const writesAtLength = said(
  'sam, nice to meet you too',
  'yeah i live just around the corner on polk',
  'honestly this is my favourite spot on the whole street',
)

check(
  'two asked and answered, guest not engaged: no third',
  pacedRendered(twoAnswered(terse), 'casual_chatter'),
  [],
)
check(
  'two asked and answered, not engaged: the hold is the cap',
  derive(twoAnswered(terse)).pacing.hold,
  'conversation_cap',
)
check(
  'two asked and answered, guest asks us something: a third may render',
  pacedRendered(twoAnswered(asksBack), 'casual_chatter'),
  ['their_rhythm'],
)
check(
  'two asked and answered, guest writes at length: a third may render',
  pacedRendered(twoAnswered(writesAtLength), 'casual_chatter'),
  ['their_rhythm'],
)
check(
  'the engaged verdict and its signals are reported for the log',
  derive(twoAnswered(asksBack)).pacing,
  {
    hold: 'none',
    askedThisConversation: 2,
    lastAskedKeys: ['are_they_local'],
    lastAskedAnswered: true,
    engaged: true,
    engagedSignals: {
      allAnswered: true,
      askedUsSomething: true,
      medianWords: 1,
    },
  },
)
check(
  'a guest who writes at length, with the last question unanswered: rule 1 still holds',
  derive({ ...twoAnswered(writesAtLength), known: { name: 'Sam' } }).pacing
    .hold,
  'open_question',
)
check(
  'an earlier question never answered: not engaged, however much they write',
  derive({ ...twoAnswered(writesAtLength), known: { homeBase: 'Polk Street' } })
    .pacing.hold,
  'conversation_cap',
)
check(
  'three asked and answered, engaged: no fourth',
  pacedRendered(
    {
      replies: 11,
      prompted: [
        asked('learn_name', 900, 'm-name'),
        asked('are_they_new_here', 600, 'm-new'),
        asked('are_they_local', 300, 'm-local'),
      ],
      known: { name: 'Sam', homeBase: 'Polk Street', history: 'first time' },
      messages: writesAtLength,
    },
    'casual_chatter',
  ),
  [],
)
check(
  'one message that raised two questions counts once',
  derive({
    replies: 8,
    prompted: [
      asked('learn_name', 300, 'm-both'),
      asked('are_they_local', 300, 'm-both'),
    ],
    known: { name: 'Sam', homeBase: 'Polk Street' },
    messages: terse,
  }).pacing.askedThisConversation,
  1,
)
check(
  'nothing asked in this conversation: no hold, and engaged is not judged',
  [derive({ replies: 5 }).pacing.hold, derive({ replies: 5 }).pacing.engaged],
  ['none', null],
)

// ---------------------------------------------------------------------------
// Rule 2: only on a relaxed turn.
// ---------------------------------------------------------------------------

check(
  'relaxed categories are small talk, thanks and a reply; nothing else',
  (
    [
      'casual_chatter',
      'acknowledgment',
      'reply',
      'new_question',
      'recommendation_request',
      'mechanic_request',
      'personal_history_question',
      'perk_inquiry',
      'event_question',
      'manual',
      'unknown',
    ] as const
  ).filter(isRelaxedCategory),
  ['casual_chatter', 'acknowledgment', 'reply'],
)
check(
  'a turn nobody classified renders no getting-to-know-you question',
  pacedRendered({ replies: 5 }, null),
  [],
)
check(
  'a draft carrying a link is doing a job',
  isTaskDraft('here you go https://lemils.com/menu', {}),
  true,
)
check(
  'a draft making a recommendation is doing a job',
  isTaskDraft('the cardamom bun is the one', {
    type: 'recommendation',
    description: 'cardamom bun',
  }),
  true,
)
check(
  'CONTROL a plain draft is not',
  isTaskDraft('haha glad you liked it', {}),
  false,
)
check(
  'the draft check applies when every rendered line is a getting-to-know-you one',
  rendersOnlyConversationPaced([line('learn_name'), line('are_they_local')]),
  true,
)
check(
  'and not when a visit question is among them, or nothing rendered',
  [
    rendersOnlyConversationPaced([
      line('understand_order'),
      line('learn_name'),
    ]),
    rendersOnlyConversationPaced([]),
  ],
  [false, false],
)

// ---------------------------------------------------------------------------
// The visit-tied intentions are not touched by any of it.
// ---------------------------------------------------------------------------

const visitTurn: Turn = {
  ...phoneTest,
  known: {},
  over: { visitConfirmedAt: at(-600) },
}
const visitFacts = buildSatisfactionFacts({
  hasQualifyingTransaction: false,
  firstName: null,
  homeBase: undefined,
  recordedVisitCount: 0,
  venueHistory: undefined,
})
check(
  'an unanswered name and a non-relaxed turn still render the visit question',
  renderableIntentions(
    derive({ ...visitTurn, over: { ...visitTurn.over, facts: visitFacts } })
      .open,
    'new_question',
    false,
    false,
    false,
  ).map((o) => o.key),
  ['understand_order'],
)
check(
  'every intention declares its pacing, and the five paced ones are the ruled five',
  Object.values(INTENTION_DEFINITION_BY_KEY)
    .filter((d) => d.pacing === 'conversation')
    .map((d) => d.key)
    .sort(),
  [
    'are_they_local',
    'are_they_new_here',
    'learn_name',
    'their_rhythm',
    'why_theyre_here',
  ],
)

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall checks passed')
