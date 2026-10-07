// TAC-575: behavioural checks for which question a first-visit turn carries.
//
// Run by hand (see README.md). Pure: it drives the real derivation, the real
// check-in rules and the real user-prompt renderer with constructed inputs. No
// database, no model, no network, so it needs no credentials and refuses none.
//
// WHAT IT IS FOR. The rules here are mostly "X never happens on turn Y", and a
// rule like that reads correct in review whether or not anything enforces it.
// Each check names the input that would make it fail, and the mutation notes
// in the README say which were confirmed to fail when the rule was removed.

import {
  applyCurrentTurnSuppression,
  buildSatisfactionFacts,
  deriveOpenIntentions,
  renderableIntentions,
  type DeriveOpenIntentionsInput,
} from '@/lib/agent/intentions/derive'
import { INTENTION_DEFINITION_BY_KEY } from '@/lib/agent/intentions/definitions'
import type { PromptedIntentionRow } from '@/lib/agent/intentions/load'
import { hasAnsweredGuestBefore } from '@/lib/agent/retrieval-context'
import {
  classifyCheckinAnswer,
  isAwaitingCheckinAnswer,
  nextCheckinAnswer,
  resolveSameVisitOrderAt,
  type VisitCheckin,
} from '@/lib/agent/visit-checkin'
import { isQuietAfterWarmClose } from '@/lib/agent/warm-close'
import { runtimeToProse } from '@/lib/ai/prompts/serializers'
import type { RecentMessage, RuntimeContext } from '@/lib/ai/types'
import { INTENTION_RULES_DEFAULT } from '@/lib/schemas/intention-rules'

const NOW = new Date('2026-10-06T20:00:00Z')
const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000)
const HOUR = 3600
const DAY = 24 * HOUR

let failures = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`ok    ${name}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${name}\n        expected ${e}\n        actual   ${a}`)
}

const noOrder = buildSatisfactionFacts({
  hasQualifyingTransaction: false,
  firstName: null,
  homeBase: undefined,
  recordedVisitCount: 0,
  venueHistory: undefined,
})
const oneOrder = buildSatisfactionFacts({
  hasQualifyingTransaction: true,
  firstName: null,
  homeBase: undefined,
  recordedVisitCount: 1,
  venueHistory: undefined,
})

function openKeys(over: Partial<DeriveOpenIntentionsInput>): string[] {
  return deriveOpenIntentions({
    now: NOW,
    responseRate: 0,
    repliedMessageCount: 1,
    rules: INTENTION_RULES_DEFAULT,
    facts: noOrder,
    visitConfirmedAt: null,
    openRecommendationTimes: [],
    openRecommendationTouchedTimes: [],
    openRecommendationsUnreadable: false,
    recordedOrderTimes: [],
    sameVisitOrderAt: null,
    rows: { prompted: [], eligible: [] },
    inboundTimes: [NOW],
    conversationWindowMs: 48 * HOUR * 1000,
    inboundHistoryFrom: at(-14 * DAY),
    isFirstConversation: true,
    quietAfterWarmClose: false,
    venueHasAnsweredBefore: true,
    ...over,
  }).open.map((o) => o.key)
}

function row(
  key: string,
  eligibleAt: Date,
  promptedAt: Date,
): PromptedIntentionRow {
  return {
    intentionKey: key,
    eligibleAt,
    promptedAt,
    promptSource: 'classifier',
    messageId: 'm-1',
  } as PromptedIntentionRow
}

function message(
  direction: 'inbound' | 'outbound',
  seconds: number,
  delivery: RecentMessage['delivery'] = 'delivered',
): RecentMessage {
  return {
    direction,
    createdAt: at(seconds),
    delivery,
    body: 'x',
  } as RecentMessage
}

// ---------------------------------------------------------------------------
// 1. Nothing about the guest is asked in a first reply.
// ---------------------------------------------------------------------------

check(
  'cold DM, first message: nothing open',
  openKeys({ venueHasAnsweredBefore: false }),
  [],
)
check(
  'three messages before any reply: still nothing open',
  openKeys({ repliedMessageCount: 3, venueHasAnsweredBefore: false }),
  [],
)
check(
  'a venue setting min_replies.learn_name to 0 cannot open a first reply',
  openKeys({
    venueHasAnsweredBefore: false,
    rules: { ...INTENTION_RULES_DEFAULT, min_replies: { learn_name: 0 } },
  }),
  [],
)
check(
  'cold DM, second message: nothing open',
  openKeys({ repliedMessageCount: 2 }),
  [],
)
check(
  'cold DM, third message: the name',
  openKeys({ repliedMessageCount: 3 }),
  ['learn_name'],
)
check(
  'a scan greeting alone is not an answer',
  hasAnsweredGuestBefore([message('outbound', -60)]),
  false,
)
check(
  'a held draft is not an answer',
  hasAnsweredGuestBefore([
    message('inbound', -90),
    message('outbound', -60, 'awaiting_review'),
  ]),
  false,
)
check(
  'a delivered reply after a guest message is an answer',
  hasAnsweredGuestBefore([message('inbound', -90), message('outbound', -60)]),
  true,
)

// ---------------------------------------------------------------------------
// 2. The order turn asks how it is, and only that.
// ---------------------------------------------------------------------------

const orderTurn = deriveOpenIntentions({
  now: NOW,
  responseRate: 0,
  repliedMessageCount: 2,
  rules: INTENTION_RULES_DEFAULT,
  facts: noOrder,
  visitConfirmedAt: at(-60),
  openRecommendationTimes: [],
  openRecommendationTouchedTimes: [],
  openRecommendationsUnreadable: false,
  recordedOrderTimes: [],
  sameVisitOrderAt: NOW,
  rows: { prompted: [], eligible: [] },
  inboundTimes: [NOW],
  conversationWindowMs: 48 * HOUR * 1000,
  inboundHistoryFrom: at(-14 * DAY),
  isFirstConversation: true,
  quietAfterWarmClose: false,
  venueHasAnsweredBefore: false,
})
check(
  'order turn: the required question renders alone, ahead of the order question',
  applyCurrentTurnSuppression(orderTurn.open, 'the iced sofi', [
    { name: 'Iced SoFi' },
  ]).map((o) => o.key),
  ['hows_it_so_far'],
)
check(
  'with the name and three more already open, it still renders alone',
  openKeys({
    repliedMessageCount: 6,
    facts: oneOrder,
    recordedOrderTimes: [at(-600)],
    sameVisitOrderAt: NOW,
  }),
  ['hows_it_so_far'],
)
check(
  'it is the one required intention',
  INTENTION_DEFINITION_BY_KEY.hows_it_so_far.raise,
  'always',
)
check(
  'every other intention is left to judgement',
  Object.values(INTENTION_DEFINITION_BY_KEY)
    .filter((d) => d.raise === 'always')
    .map((d) => d.key),
  ['hows_it_so_far'],
)
check(
  'no order named: the order question, not this one',
  openKeys({ repliedMessageCount: 2, visitConfirmedAt: at(-60) }),
  ['understand_order'],
)
check(
  'a complaint on the order turn renders nothing',
  renderableIntentions(orderTurn.open, 'comp_complaint', false, false, false)
    .length,
  0,
)
check(
  'the quiet after a warm close beats the required question',
  openKeys({ sameVisitOrderAt: NOW, quietAfterWarmClose: true }),
  [],
)
check(
  'asked once, it is closed for the rest of the visit',
  openKeys({
    repliedMessageCount: 3,
    facts: oneOrder,
    rows: {
      prompted: [row('hows_it_so_far', at(-300), at(-290))],
      eligible: [],
    },
    inboundTimes: [at(-200), NOW],
  }).includes('hows_it_so_far'),
  false,
)
check(
  'not asked within two hours, it is not asked late',
  deriveOpenIntentions({
    now: at(3 * HOUR),
    responseRate: 0,
    repliedMessageCount: 3,
    rules: INTENTION_RULES_DEFAULT,
    facts: oneOrder,
    visitConfirmedAt: at(-60),
    openRecommendationTimes: [],
    openRecommendationTouchedTimes: [],
    openRecommendationsUnreadable: false,
    recordedOrderTimes: [],
    sameVisitOrderAt: null,
    rows: {
      prompted: [],
      eligible: [{ intentionKey: 'hows_it_so_far', eligibleAt: at(-120) }],
    },
    inboundTimes: [at(3 * HOUR)],
    conversationWindowMs: 48 * HOUR * 1000,
    inboundHistoryFrom: at(-14 * DAY),
    isFirstConversation: true,
    quietAfterWarmClose: false,
    venueHasAnsweredBefore: true,
  } as DeriveOpenIntentionsInput)
    .open.map((o) => o.key)
    .includes('hows_it_so_far'),
  false,
)
check(
  'a later visit asks again',
  openKeys({
    now: at(3 * DAY),
    sameVisitOrderAt: at(3 * DAY),
    isFirstConversation: false,
    repliedMessageCount: 9,
    facts: oneOrder,
    rows: {
      prompted: [row('hows_it_so_far', at(-300), at(-290))],
      eligible: [],
    },
    inboundTimes: [at(-200), at(3 * DAY)],
  }),
  ['hows_it_so_far'],
)

// ---------------------------------------------------------------------------
// 3. When "the guest named their order on this visit" is true.
// ---------------------------------------------------------------------------

const named = {
  scanAt: at(-30),
  guestCreatedVia: 'instagram_dm',
  guestCreatedAt: at(-90 * DAY),
  inboundAt: NOW,
  mentionsMenuItem: true,
  alreadyAskedThisVisit: false,
}
check(
  'a returning guest who scanned and names an item',
  resolveSameVisitOrderAt(named),
  NOW,
)
check(
  'no menu item in the message',
  resolveSameVisitOrderAt({ ...named, mentionsMenuItem: false }),
  null,
)
check(
  'already asked on this visit (or the check-in was unreadable)',
  resolveSameVisitOrderAt({ ...named, alreadyAskedThisVisit: true }),
  null,
)
check(
  'a cold DM that names an item, with no scan',
  resolveSameVisitOrderAt({ ...named, scanAt: null, guestCreatedAt: at(-60) }),
  null,
)
check(
  'a text guest the counter sign created ten minutes ago',
  resolveSameVisitOrderAt({
    ...named,
    scanAt: null,
    guestCreatedVia: 'qr_scan',
    guestCreatedAt: at(-600),
  }),
  NOW,
)
check(
  'the same guest a day later, with no scan to go on',
  resolveSameVisitOrderAt({
    ...named,
    scanAt: null,
    guestCreatedVia: 'qr_scan',
    guestCreatedAt: at(-DAY),
  }),
  null,
)

// ---------------------------------------------------------------------------
// 4. Reading the answer.
// ---------------------------------------------------------------------------

check(
  'praise and a complaint in one burst is bad',
  classifyCheckinAnswer({
    category: 'comp_complaint',
    praisedExperience: true,
  }),
  'bad',
)
check(
  'praise is good',
  classifyCheckinAnswer({
    category: 'casual_chatter',
    praisedExperience: true,
  }),
  'good',
)
check(
  'anything else is not yet',
  classifyCheckinAnswer({ category: 'new_question', praisedExperience: false }),
  'not_yet',
)
check('nothing yet -> not yet', nextCheckinAnswer(null, 'not_yet'), 'not_yet')
check('not yet -> good', nextCheckinAnswer('not_yet', 'good'), 'good')
check(
  'good -> bad: a complaint overrides praise',
  nextCheckinAnswer('good', 'bad'),
  'bad',
)
check(
  'good is not downgraded by a neutral message',
  nextCheckinAnswer('good', 'not_yet'),
  null,
)
check('bad is final', nextCheckinAnswer('bad', 'good'), null)
const asked = { askedAt: at(-HOUR) } as VisitCheckin
check(
  'a reply an hour after the question is an answer',
  isAwaitingCheckinAnswer(asked, NOW),
  true,
)
check(
  'a reply three hours after is not',
  isAwaitingCheckinAnswer({ askedAt: at(-3 * HOUR) } as VisitCheckin, NOW),
  false,
)
check(
  'while the check-in is waiting on a good answer, nothing else renders',
  renderableIntentions(orderTurn.open, 'casual_chatter', false, false, true)
    .length,
  0,
)

// ---------------------------------------------------------------------------
// 5. After a warm close.
// ---------------------------------------------------------------------------

check('never closed: not quiet', isQuietAfterWarmClose(null, [NOW], []), false)
check(
  'one message after the close: quiet',
  isQuietAfterWarmClose(at(-100), [NOW], [at(-100)]),
  true,
)
check(
  'two messages in a burst, no reply between: still quiet',
  isQuietAfterWarmClose(at(-100), [at(-10), NOW], [at(-100)]),
  true,
)
check(
  'two messages with our reply between: questions may resume',
  isQuietAfterWarmClose(at(-100), [at(-50), NOW], [at(-100), at(-40)]),
  false,
)

// ---------------------------------------------------------------------------
// 6. What the prompt says on those turns.
// ---------------------------------------------------------------------------

const runtime = {
  currentMessage: {
    body: 'the iced sofi',
    receivedAt: NOW,
    channel: 'instagram',
  },
  recentMessages: [],
  mechanics: [],
  recentVisits: [],
  guestName: null,
  recognitionState: 'new',
} as unknown as RuntimeContext
const prose = (
  over: Partial<RuntimeContext>,
  category = 'casual_chatter',
): string =>
  runtimeToProse({ ...runtime, ...over }, category as never, NOW, 'instagram')

const requiredTurn = prose({
  openIntentions: [INTENTION_DEFINITION_BY_KEY.hows_it_so_far.promptLine],
  mustAskIntention: true,
  firstTouchAfterQrScan: true,
  firstConversation: true,
  askNothing: true,
})
check(
  'required turn: says it is not optional',
  requiredTurn.includes('This one is not optional.'),
  true,
)
check(
  'required turn: no "ask what they just got" opener',
  requiredTurn.includes('Ask what they just got'),
  false,
)
check(
  'required turn: no "not a checklist" paragraph',
  requiredTurn.includes('not a checklist'),
  false,
)
check(
  'required turn: no standalone no-questions block',
  requiredTurn.includes('## No questions this turn'),
  false,
)
check(
  'first reply with nothing open: the no-questions block',
  prose({ askNothing: true }).includes('## No questions this turn'),
  true,
)
check(
  'not on a complaint turn',
  prose({ askNothing: true }, 'comp_complaint').includes(
    '## No questions this turn',
  ),
  false,
)
check(
  'not on an ordinary turn',
  prose({}).includes('## No questions this turn'),
  false,
)

console.log(
  failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
