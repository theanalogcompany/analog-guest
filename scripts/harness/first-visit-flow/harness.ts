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
import { deriveSignOffReviewAsk } from '@/lib/agent/review-ask'
import {
  classifyCheckinAnswer,
  isAwaitingCheckinAnswer,
  checkbackWentUnanswered,
  hasBeenQuietLongEnough,
  isCheckbackTooLate,
  isCheckinFresh,
  lastProactiveWasThisVisit,
  nextCheckinAnswer,
  orderTurnVerdict,
  owesCheckback,
  resolveCheckbackDueAt,
  resolveSameVisitOrderAt,
  type VisitCheckin,
} from '@/lib/agent/visit-checkin'
import { isQuietAfterWarmClose } from '@/lib/agent/warm-close'
import { categoryInstructionsFor } from '@/lib/ai/prompts/categories'
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
    checkbackDueAt: null,
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
    promptSource: 'classified',
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
  checkbackDueAt: null,
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
  'the two order questions are required and every other intention is left to judgement',
  Object.values(INTENTION_DEFINITION_BY_KEY)
    .filter((d) => d.raise === 'always')
    .map((d) => d.key),
  ['hows_it_so_far', 'check_back_on_order'],
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
  'asked once and no new order event: it does not render again',
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
    checkbackDueAt: null,
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
  answeringOurQuestion: true,
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
  'names a menu item but is not answering a question of ours',
  resolveSameVisitOrderAt({ ...named, answeringOurQuestion: false }),
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
const optionalOpen = [
  {
    key: 'learn_name' as const,
    promptLine: INTENTION_DEFINITION_BY_KEY.learn_name.promptLine,
    eligibleAt: NOW,
  },
  {
    key: 'are_they_local' as const,
    promptLine: INTENTION_DEFINITION_BY_KEY.are_they_local.promptLine,
    eligibleAt: NOW,
  },
]
check(
  'CONTROL without the hold, the optional questions render',
  renderableIntentions(optionalOpen, 'casual_chatter', false, false, false)
    .length,
  2,
)
check(
  'while the check-in is waiting on a good answer, no optional question renders',
  renderableIntentions(optionalOpen, 'casual_chatter', false, false, true)
    .length,
  0,
)
check(
  'the check-back itself survives the hold',
  renderableIntentions(
    [
      {
        key: 'check_back_on_order' as const,
        promptLine: INTENTION_DEFINITION_BY_KEY.check_back_on_order.promptLine,
        eligibleAt: NOW,
      },
      ...optionalOpen,
    ],
    'casual_chatter',
    false,
    false,
    true,
  ).map((o) => o.key),
  ['check_back_on_order'],
)

check(
  'order turn, an order report: ask',
  orderTurnVerdict({ category: 'casual_chatter', praisedExperience: false }),
  'ask',
)
check(
  'order turn, "got the sofi" classified as a sign-off: ask',
  orderTurnVerdict({ category: 'acknowledgment', praisedExperience: false }),
  'ask',
)
check(
  'order turn that already praises it: recorded good, not asked',
  orderTurnVerdict({ category: 'casual_chatter', praisedExperience: true }),
  'good',
)
check(
  'order turn that is a complaint: recorded bad',
  orderTurnVerdict({ category: 'comp_complaint', praisedExperience: false }),
  'bad',
)
check(
  'a question that names a menu item: nothing',
  orderTurnVerdict({ category: 'new_question', praisedExperience: false }),
  'skip',
)
check(
  'a recommendation ask that praises the place: nothing',
  orderTurnVerdict({
    category: 'recommendation_request',
    praisedExperience: true,
  }),
  'skip',
)

// DOCUMENTED, NOT ENDORSED. Two behaviours of the derivation that the caller,
// not the derivation, is responsible for. They are here so a change to either
// is noticed.
check(
  'EXPECTED: a second order event in one visit re-arms in the derivation (the caller withholds the event)',
  openKeys({
    repliedMessageCount: 3,
    facts: oneOrder,
    sameVisitOrderAt: NOW,
    rows: {
      prompted: [row('hows_it_so_far', at(-300), at(-290))],
      eligible: [],
    },
    inboundTimes: [at(-200), NOW],
  }),
  ['hows_it_so_far'],
)
check(
  'EXPECTED: a guest who ignored the question last visit is not asked on the next one',
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
    inboundTimes: [at(-400), at(3 * DAY)],
  }).includes('hows_it_so_far'),
  false,
)

// ---------------------------------------------------------------------------
// 4b. The check-back.
// ---------------------------------------------------------------------------

const MIN = 60
const checkin = (over: Partial<VisitCheckin>): VisitCheckin => ({
  id: 'c-1',
  venueLocalDate: '2026-10-06',
  orderedAt: at(-11 * MIN),
  askedAt: at(-11 * MIN + 5),
  answer: null,
  answeredAt: null,
  checkbackClaimedAt: null,
  checkbackSentAt: null,
  ...over,
})
check('owed: asked and no answer', owesCheckback(checkin({})), true)
check(
  'owed: they had not tried it',
  owesCheckback(checkin({ answer: 'not_yet' })),
  true,
)
check(
  'not owed: they said it is good',
  owesCheckback(checkin({ answer: 'good' })),
  false,
)
check(
  'not owed: they complained',
  owesCheckback(checkin({ answer: 'bad' })),
  false,
)
check(
  'not owed: already claimed',
  owesCheckback(checkin({ checkbackClaimedAt: at(-60) })),
  false,
)
check(
  'timed: thirty minutes after the order is still in time',
  isCheckbackTooLate(at(-30 * MIN), NOW),
  false,
)
check(
  'timed: thirty-one minutes after is too late',
  isCheckbackTooLate(at(-31 * MIN), NOW),
  true,
)
check(
  'timed: our reply a minute ago is too fresh to follow',
  hasBeenQuietLongEnough(at(-60), NOW),
  false,
)
check(
  'timed: our reply two minutes ago is not',
  hasBeenQuietLongEnough(at(-2 * MIN), NOW),
  true,
)
check(
  'in conversation: four minutes after the order, not yet',
  resolveCheckbackDueAt(
    checkin({ orderedAt: at(-4 * MIN), askedAt: at(-4 * MIN) }),
    NOW,
  ),
  null,
)
check(
  'in conversation: six minutes after the order, anchored at order plus five',
  resolveCheckbackDueAt(
    checkin({ orderedAt: at(-6 * MIN), askedAt: at(-6 * MIN) }),
    NOW,
  ),
  at(-1 * MIN),
)
check(
  'in conversation: "not yet" two minutes ago restarts the wait',
  resolveCheckbackDueAt(
    checkin({
      orderedAt: at(-8 * MIN),
      askedAt: at(-8 * MIN),
      answer: 'not_yet',
      answeredAt: at(-2 * MIN),
    }),
    NOW,
  ),
  null,
)
check(
  'in conversation: "not yet" six minutes ago, anchored at that answer plus five',
  resolveCheckbackDueAt(
    checkin({
      orderedAt: at(-12 * MIN),
      askedAt: at(-12 * MIN),
      answer: 'not_yet',
      answeredAt: at(-6 * MIN),
    }),
    NOW,
  ),
  at(-1 * MIN),
)
check(
  'in conversation: not once they have said it is good',
  resolveCheckbackDueAt(
    checkin({ orderedAt: at(-6 * MIN), askedAt: at(-6 * MIN), answer: 'good' }),
    NOW,
  ),
  null,
)
check(
  'in conversation: not once the timer has claimed it',
  resolveCheckbackDueAt(
    checkin({
      orderedAt: at(-6 * MIN),
      askedAt: at(-6 * MIN),
      checkbackClaimedAt: at(-30),
    }),
    NOW,
  ),
  null,
)
check(
  'in conversation: not the next morning',
  resolveCheckbackDueAt(
    checkin({ orderedAt: at(-20 * HOUR), askedAt: at(-20 * HOUR) }),
    NOW,
  ),
  null,
)
check(
  'in conversation: no check-in (or unreadable)',
  resolveCheckbackDueAt(null, NOW),
  null,
)
check(
  'in conversation: the due check-back renders alone, ahead of the name',
  openKeys({
    repliedMessageCount: 5,
    facts: oneOrder,
    recordedOrderTimes: [at(-600)],
    checkbackDueAt: at(-1 * MIN),
  }),
  ['check_back_on_order'],
)
check(
  'in conversation: the anchor does not re-arm on the next turn',
  openKeys({
    repliedMessageCount: 6,
    facts: oneOrder,
    recordedOrderTimes: [at(-600)],
    checkbackDueAt: at(-1 * MIN),
    rows: {
      prompted: [row('check_back_on_order', at(-1 * MIN), at(-30))],
      eligible: [],
    },
    inboundTimes: [at(-20), NOW],
  }).includes('check_back_on_order'),
  false,
)
check(
  'spacing: the greeting eight minutes before the order is this visit',
  lastProactiveWasThisVisit(at(-19 * MIN), at(-11 * MIN)),
  true,
)
check(
  'spacing: a follow-up fifty minutes before the order is not',
  lastProactiveWasThisVisit(at(-61 * MIN), at(-11 * MIN)),
  false,
)
check(
  'spacing: no earlier unprompted message',
  lastProactiveWasThisVisit(null, at(-11 * MIN)),
  false,
)
check(
  'unanswered: sent, and nothing from the guest since',
  checkbackWentUnanswered(
    checkin({ checkbackSentAt: at(-5 * MIN) }),
    at(-8 * MIN),
  ),
  true,
)
check(
  'unanswered: sent, and they replied',
  checkbackWentUnanswered(
    checkin({ checkbackSentAt: at(-5 * MIN) }),
    at(-2 * MIN),
  ),
  false,
)
check(
  'unanswered: never claimed or sent',
  checkbackWentUnanswered(checkin({}), null),
  false,
)
check(
  'unanswered: held for an operator (claimed, no sent stamp), nothing from the guest since',
  checkbackWentUnanswered(
    checkin({ checkbackClaimedAt: at(-5 * MIN) }),
    at(-8 * MIN),
  ),
  true,
)
check(
  'unanswered: read against the GUEST, so our own later message time cannot make it false',
  checkbackWentUnanswered(
    checkin({ checkbackSentAt: at(-5 * MIN) }),
    at(-5 * MIN - 30),
  ),
  true,
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
const ordinaryTurn = prose({
  openIntentions: [INTENTION_DEFINITION_BY_KEY.understand_order.promptLine],
  firstTouchAfterQrScan: true,
  firstConversation: true,
})
check(
  'CONTROL ordinary turn: has the opener',
  ordinaryTurn.includes('Ask what they just got'),
  true,
)
check(
  'CONTROL ordinary turn: has the "not a checklist" paragraph',
  ordinaryTurn.includes('not a checklist'),
  true,
)
check(
  'CONTROL ordinary turn: not marked required',
  ordinaryTurn.includes('This one is not optional.'),
  false,
)
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

// ---------------------------------------------------------------------------
// 7. The sign-off.
// ---------------------------------------------------------------------------

const REVIEW_URL = 'https://reviews.example.test/write?id=abc'
const links = [{ label: 'Leave a review', url: REVIEW_URL, kind: 'review' }]
check(
  'happy: check-in good, never asked, venue has a link',
  deriveSignOffReviewAsk({ checkinAnswer: 'good', reviewAskedAt: null, links }),
  { url: REVIEW_URL, label: 'Leave a review' },
)
check(
  'not happy: they never said it was good',
  deriveSignOffReviewAsk({
    checkinAnswer: 'not_yet',
    reviewAskedAt: null,
    links,
  }),
  null,
)
check(
  'not happy: they complained',
  deriveSignOffReviewAsk({ checkinAnswer: 'bad', reviewAskedAt: null, links }),
  null,
)
check(
  'not happy: no check-in at all',
  deriveSignOffReviewAsk({ checkinAnswer: null, reviewAskedAt: null, links }),
  null,
)
check(
  'not happy: already asked once',
  deriveSignOffReviewAsk({
    checkinAnswer: 'good',
    reviewAskedAt: at(-DAY),
    links,
  }),
  null,
)
check(
  'not happy: the venue has no review link',
  deriveSignOffReviewAsk({
    checkinAnswer: 'good',
    reviewAskedAt: null,
    links: [],
  }),
  null,
)
check(
  'not happy: a link that is not marked as the review link',
  deriveSignOffReviewAsk({
    checkinAnswer: 'good',
    reviewAskedAt: null,
    links: [{ label: 'Menu', url: REVIEW_URL }],
  }),
  null,
)

check(
  'same visit: answered "so good" twenty minutes ago',
  isCheckinFresh(
    checkin({
      askedAt: at(-30 * MIN),
      answer: 'good',
      answeredAt: at(-20 * MIN),
    }),
    NOW,
  ),
  true,
)
check(
  'not the same visit: answered "so good" seven hours ago',
  isCheckinFresh(
    checkin({
      askedAt: at(-7 * HOUR - 600),
      answer: 'good',
      answeredAt: at(-7 * HOUR),
    }),
    NOW,
  ),
  false,
)
check(
  'same visit: asked three hours ago but answered an hour ago',
  isCheckinFresh(
    checkin({ askedAt: at(-3 * HOUR), answer: 'good', answeredAt: at(-HOUR) }),
    NOW,
  ),
  true,
)

const happyTurn = prose(
  { signOff: 'happy', reviewAsk: { url: REVIEW_URL, label: 'Leave a review' } },
  'acknowledgment',
)
check('happy turn: the sign-off block', happyTurn.includes('## Sign off'), true)
check(
  'happy turn: the link, character for character',
  happyTurn.includes(`exactly as written: ${REVIEW_URL}`),
  true,
)
check(
  'happy turn: never a rating',
  happyTurn.includes('Never ask for a particular rating or number of stars.'),
  true,
)
check(
  'happy turn: not the praise block as well',
  happyTurn.includes('## Ask for a review'),
  false,
)
check(
  'happy turn: not the plain close as well',
  happyTurn.includes('## Closing this conversation'),
  false,
)
const praiseTurn = prose({
  reviewAsk: { url: REVIEW_URL, label: 'Leave a review' },
})
check(
  'CONTROL praise turn: the praise block, not the sign-off',
  [
    praiseTurn.includes('## Ask for a review'),
    praiseTurn.includes('## Sign off'),
  ],
  [true, false],
)
check(
  'happy with no link handed over renders no sign-off block',
  prose({ signOff: 'happy' }, 'acknowledgment').includes('## Sign off'),
  false,
)
const plainTurn = prose(
  {
    signOff: 'plain',
    warmCloseGuidance: 'coffee and beans, what to get next time',
  },
  'acknowledgment',
)
check(
  'plain turn: the close block',
  plainTurn.includes('## Closing this conversation'),
  true,
)
check(
  'plain turn: the venue text, as a guide',
  plainTurn.includes(
    'not as words to reuse: coffee and beans, what to get next time',
  ),
  true,
)
check(
  'plain turn: a soft hope to see them is allowed, an invitation for something specific is not',
  [
    plainTurn.includes('A soft hope to see them again is fine.'),
    plainTurn.includes('Do not invite them in'),
    plainTurn.includes('do not name any item they did not mention'),
  ],
  [true, true, true],
)
check(
  'plain turn: no link block',
  [
    plainTurn.includes('## Sign off'),
    plainTurn.includes('## Ask for a review'),
  ],
  [false, false],
)
check(
  'plain turn with no venue text: the block, without the guide sentence',
  (() => {
    const p = prose({ signOff: 'plain' }, 'acknowledgment')
    return [
      p.includes('## Closing this conversation'),
      p.includes('as a guide to its content'),
    ]
  })(),
  [true, false],
)
check(
  'CONTROL ordinary turn: neither block',
  [
    prose({}).includes('## Sign off'),
    prose({}).includes('## Closing this conversation'),
  ],
  [false, false],
)

const timedClose = categoryInstructionsFor(
  'acknowledgment',
  'instagram',
  null,
  false,
  false,
  true,
)
const goodbye = categoryInstructionsFor(
  'acknowledgment',
  'instagram',
  null,
  false,
  false,
  false,
)
check(
  'timed close: says the guest went quiet',
  timedClose.includes('The guest has gone quiet'),
  true,
)
check('timed close: not the goodbye text', timedClose === goodbye, false)
check(
  'CONTROL goodbye turn: says the guest is wrapping up',
  goodbye.includes('wrapping up'),
  true,
)

console.log(
  failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
