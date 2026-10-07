// TAC-578: behavioural checks for the rules behind the messages a visit ends
// in. No model calls and no database: everything here drives the pure half,
// lib/agent/visit-messages.ts. See README.md beside this file for how to run
// it and for what it does NOT cover.

import { venueLocalInstant } from '@/lib/guests/commitment-expiry'
import { DELIVERED_OUTBOUND_STATUSES } from '@/lib/agent/group-responses'
import {
  replySignsOffVisit,
  signOffReplyQuestions,
  timedSignOffFor,
  type VisitCheckin,
} from '@/lib/agent/visit-checkin'
import {
  checkinAngleRejection,
  checkinWordingRejection,
  complaintStanding,
  decodeAngle,
  encodeAngle,
  isFirstVisitDay,
  isInsideOneMessageGap,
  morningOffsetMinutes,
  MORNING_OFFSET_MAX_MINUTES,
  ONE_MESSAGE_GAP_MS,
  resolvePostVisitSlot,
  sharesWordRun,
  SPACED_MESSAGE_PRIORITY,
  standsDownFor,
  thanksForVisiting,
  type PostVisitSlotInput,
  type SpacedMessage,
} from '@/lib/agent/visit-messages'

let failures = 0
/** Compares by JSON, prints one line, and says whether it matched. */
function check(name: string, actual: unknown, expected: unknown): boolean {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`ok    ${name}`)
    return true
  }
  failures += 1
  console.log(`FAIL  ${name}\n        expected ${e}\n        actual   ${a}`)
  return false
}

const MIN = 60 * 1000
const HOUR = 60 * MIN
const TZ = 'America/Los_Angeles'
const GUEST = 'guest-0001'
const OFFSET = morningOffsetMinutes(GUEST)

/** A venue-local wall clock on a given day, as an instant. */
function local(date: string, time: string, tz = TZ): Date {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  const at = venueLocalInstant(tz, y, m, d, hh * 60 + mm)
  if (at === null) throw new Error(`no instant for ${date} ${time}`)
  return at
}
const plus = (at: Date, ms: number): Date => new Date(at.getTime() + ms)

const DAY = '2026-10-06'
const NEXT = '2026-10-07'
const slot = (over: Partial<PostVisitSlotInput>) =>
  resolvePostVisitSlot({
    visitLocalDate: DAY,
    timezone: TZ,
    earliestLocal: '09:00',
    latestLocal: '20:00',
    lastInboundAt: local(DAY, '10:00'),
    threadQuietSince: local(DAY, '10:05'),
    guestId: GUEST,
    now: local(DAY, '17:30'),
    ...over,
  })

// ---------------------------------------------------------------------------
// 1. Timing: the window, the send hours, morning against evening.
// ---------------------------------------------------------------------------

check(
  'the per-guest offset stays inside its bound',
  OFFSET >= 0 && OFFSET <= MORNING_OFFSET_MAX_MINUTES,
  true,
)
check(
  'wrote at 10:00: the window is open tomorrow at nine, so the evening waits for the morning',
  slot({}),
  { kind: 'wait', until: 'next_morning' },
)
check(
  'the next morning, past the offset, thread still: send',
  slot({ now: local(NEXT, '09:25') }),
  { kind: 'send', slot: 'next_morning' },
)
check(
  'the next morning, a minute before the offset: not yet',
  slot({ now: plus(local(NEXT, '09:00'), (OFFSET - 1) * MIN) }),
  { kind: 'wait', until: 'next_morning' },
)
check(
  'the next morning, but we answered them ten minutes ago: wait',
  slot({ now: local(NEXT, '09:25'), threadQuietSince: local(NEXT, '09:15') }),
  { kind: 'wait', until: 'next_morning' },
)
check(
  'the morning slot has gone by 11:05: skip',
  slot({ now: local(NEXT, '11:05') }),
  { kind: 'skip', reason: 'slot_passed' },
)
check(
  'wrote at 08:10: the window shuts before nine tomorrow, so the same evening',
  slot({
    lastInboundAt: local(DAY, '08:10'),
    threadQuietSince: local(DAY, '08:15'),
    now: local(DAY, '17:00'),
  }),
  { kind: 'send', slot: 'same_evening' },
)
check(
  'the same guest at 16:59: the evening has not started',
  slot({
    lastInboundAt: local(DAY, '08:10'),
    threadQuietSince: local(DAY, '08:15'),
    now: local(DAY, '16:59'),
  }),
  { kind: 'wait', until: 'same_evening' },
)
// The margin. The send's own gate closes five minutes before Meta's window,
// so a window that Meta would still honour at the slot can be one we do not
// plan against.
const morningStart = plus(local(NEXT, '09:00'), OFFSET * MIN)
check(
  'window edge: Meta closes four minutes after the slot starts, inside the margin: evening',
  slot({
    lastInboundAt: plus(morningStart, -24 * HOUR + 4 * MIN),
    threadQuietSince: local(DAY, '09:40'),
    now: local(DAY, '17:00'),
  }),
  { kind: 'send', slot: 'same_evening' },
)
check(
  'window edge: Meta closes six minutes after the slot starts, outside the margin: morning',
  slot({
    lastInboundAt: plus(morningStart, -24 * HOUR + 6 * MIN),
    threadQuietSince: local(DAY, '09:40'),
    now: local(DAY, '17:00'),
  }),
  { kind: 'wait', until: 'next_morning' },
)
check(
  'our last message was at 19:30 and the morning is shut: three hours on is past eight, so wait out the evening',
  slot({
    lastInboundAt: local(DAY, '08:10'),
    threadQuietSince: local(DAY, '19:30'),
    now: local(DAY, '19:45'),
  }),
  { kind: 'wait', until: 'same_evening' },
)
check(
  'and once eight has passed: no slot',
  slot({
    lastInboundAt: local(DAY, '08:10'),
    threadQuietSince: local(DAY, '19:30'),
    now: local(DAY, '20:05'),
  }),
  { kind: 'skip', reason: 'no_slot' },
)
check(
  'evening blocked until after eight (a card was pending): skip',
  slot({
    lastInboundAt: local(DAY, '08:10'),
    threadQuietSince: local(DAY, '08:15'),
    now: local(DAY, '20:01'),
  }),
  { kind: 'skip', reason: 'slot_passed' },
)
check(
  'the morning after a visit whose window shut overnight: nothing',
  slot({
    lastInboundAt: local(DAY, '08:10'),
    threadQuietSince: local(DAY, '08:15'),
    now: local(NEXT, '09:25'),
  }),
  { kind: 'skip', reason: 'slot_passed' },
)
check(
  'a venue set to 08:00-18:00: an 08:30 visit gets the morning at 08:25',
  slot({
    earliestLocal: '08:00',
    latestLocal: '18:00',
    lastInboundAt: local(DAY, '08:30'),
    threadQuietSince: local(DAY, '08:35'),
    now: local(NEXT, '08:25'),
  }),
  { kind: 'send', slot: 'next_morning' },
)
check(
  'a venue that stops at 16:00 has no evening slot at all',
  slot({
    latestLocal: '16:00',
    lastInboundAt: local(DAY, '08:10'),
    threadQuietSince: local(DAY, '08:15'),
    now: local(DAY, '15:00'),
  }),
  { kind: 'skip', reason: 'no_slot' },
)
// Daylight saving. The night of 2026-10-31 is twenty-five hours long in Los
// Angeles, so nine the next morning is an hour FURTHER from yesterday's ten
// o'clock than on any other day. A slot computed by adding 24 hours of wall
// clock would call both of these open.
check(
  'the night the clocks go back: wrote at 10:30, window still open at nine: morning',
  slot({
    visitLocalDate: '2026-10-31',
    lastInboundAt: local('2026-10-31', '10:30'),
    threadQuietSince: local('2026-10-31', '10:35'),
    now: local('2026-11-01', '09:22'),
  }),
  { kind: 'send', slot: 'next_morning' },
)
check(
  'the night the clocks go back: wrote at 09:30, which is 24.5 real hours before 09:00: evening',
  slot({
    visitLocalDate: '2026-10-31',
    lastInboundAt: local('2026-10-31', '09:30'),
    threadQuietSince: local('2026-10-31', '09:35'),
    now: local('2026-10-31', '17:00'),
  }),
  { kind: 'send', slot: 'same_evening' },
)
check('no timezone: skip, never guess', slot({ timezone: null }), {
  kind: 'skip',
  reason: 'clock_unreadable',
})
check(
  'a timezone nobody can read: skip',
  slot({ timezone: 'Mars/Olympus_Mons' }),
  { kind: 'skip', reason: 'clock_unreadable' },
)
check('send hours that are not a time: skip', slot({ earliestLocal: '9am' }), {
  kind: 'skip',
  reason: 'clock_unreadable',
})
check(
  'no message of theirs with a Meta time: no window, skip',
  slot({ lastInboundAt: null }),
  { kind: 'skip', reason: 'no_window' },
)

// ---------------------------------------------------------------------------
// 2. Which message, and once ever.
// ---------------------------------------------------------------------------

check('first visit: the only day on file', isFirstVisitDay(DAY, [DAY]), true)
check('first visit: nothing on file at all', isFirstVisitDay(DAY, []), true)
check(
  'a later visit: one earlier day on file',
  isFirstVisitDay(DAY, ['2026-09-30', DAY]),
  false,
)
check(
  'still the first: the only other day is AFTER it (yesterday read this morning)',
  isFirstVisitDay(DAY, [DAY, NEXT]),
  true,
)

type Row = Parameters<typeof complaintStanding>[0]['rows'][number]
const row = (minute: number, over: Partial<Row>): Row => ({
  direction: 'outbound',
  status: 'sent',
  generatedBy: 'agent',
  reviewState: 'auto_sent',
  category: 'reply',
  createdAt: plus(local(DAY, '10:00'), minute * MIN),
  ...over,
})
const standing = (
  rows: Row[],
  over: {
    checkinSaidBad?: boolean
    checkinBadAt?: Date | null
    openClarification?: boolean
  } = {},
) =>
  complaintStanding({
    rows,
    deliveredStatuses: DELIVERED_OUTBOUND_STATUSES,
    checkinSaidBad: over.checkinSaidBad ?? false,
    checkinBadAt: over.checkinBadAt ?? null,
    openClarification: over.openClarification ?? false,
  })
const inbound = (minute: number): Row =>
  row(minute, { direction: 'inbound', generatedBy: null, reviewState: null })

check('no complaint on the visit', standing([inbound(0), row(1, {})]), 'none')
check(
  'complaint, reply still waiting on an operator: unresolved',
  standing([
    inbound(0),
    row(1, {
      category: 'comp_complaint',
      status: 'pending',
      reviewState: 'pending',
    }),
  ]),
  'unresolved',
)
check(
  'complaint, operator approved the reply and it went: resolved',
  standing([
    inbound(0),
    row(1, { category: 'comp_complaint', reviewState: 'approved' }),
  ]),
  'resolved',
)
check(
  'complaint, operator rewrote the reply: resolved',
  standing([
    inbound(0),
    row(1, { category: 'comp_complaint', reviewState: 'edited' }),
  ]),
  'resolved',
)
check(
  'complaint, card skipped, staff typed a reply by hand: resolved',
  standing([
    inbound(0),
    row(1, {
      category: 'comp_complaint',
      status: 'pending',
      reviewState: 'skipped',
    }),
    row(4, { category: null, generatedBy: null, reviewState: null }),
  ]),
  'resolved',
)
check(
  'complaint, card skipped, nobody wrote: unresolved',
  standing([
    inbound(0),
    row(1, {
      category: 'comp_complaint',
      status: 'pending',
      reviewState: 'skipped',
    }),
  ]),
  'unresolved',
)
check(
  'resolved, then they complained again and that reply is on a card: unresolved',
  standing([
    inbound(0),
    row(1, { category: 'comp_complaint', reviewState: 'approved' }),
    inbound(9),
    row(10, {
      category: 'comp_complaint',
      status: 'pending',
      reviewState: 'pending',
    }),
  ]),
  'unresolved',
)
check(
  'the clarifying question auto-sent and is still open: unresolved',
  standing([inbound(0), row(1, { category: 'comp_complaint' })], {
    openClarification: true,
  }),
  'unresolved',
)
check(
  'an auto-sent complaint reply is not a person: unresolved',
  standing([inbound(0), row(1, { category: 'comp_complaint' })]),
  'unresolved',
)
check(
  'the check-in read bad and no reply of ours exists: unresolved',
  standing([inbound(0)], { checkinSaidBad: true }),
  'unresolved',
)
// Found in review: with no complaint reply of ours on file, a reply staff typed
// earlier in the day used to count as the fix.
const handTyped = (minute: number): Row =>
  row(minute, { category: null, generatedBy: null, reviewState: null })
check(
  'check-in read bad at 10:00, staff had typed a hello at 09:30, nothing since: unresolved',
  standing([handTyped(-30), inbound(0)], {
    checkinSaidBad: true,
    checkinBadAt: local(DAY, '10:00'),
  }),
  'unresolved',
)
check(
  'check-in read bad at 10:00, staff typed a reply at 10:06: resolved',
  standing([inbound(0), handTyped(6)], {
    checkinSaidBad: true,
    checkinBadAt: local(DAY, '10:00'),
  }),
  'resolved',
)
check(
  'check-in read bad with no time on it: unresolved, whatever staff typed',
  standing([inbound(0), handTyped(6)], { checkinSaidBad: true }),
  'unresolved',
)
check(
  'a tapback is not staff putting it right',
  standing([
    inbound(0),
    row(1, {
      category: 'comp_complaint',
      status: 'pending',
      reviewState: 'pending',
    }),
    row(2, { category: 'reaction', generatedBy: null, reviewState: null }),
  ]),
  'unresolved',
)
check(
  'staff wrote BEFORE the complaint, and nothing after: unresolved',
  standing([
    row(-30, { category: null, generatedBy: null, reviewState: null }),
    inbound(0),
    row(1, {
      category: 'comp_complaint',
      status: 'pending',
      reviewState: 'pending',
    }),
  ]),
  'unresolved',
)

// Rule 3 as re-ruled 2026-10-07: the reply to "it's good" is the sign-off,
// and the timer signs off only a guest who was asked, never said, and chatted.
const asked = local(DAY, '10:00')
const visitCheckin = (
  answer: VisitCheckin['answer'],
  answeredAt: Date | null = null,
): VisitCheckin => ({
  id: 'c-1',
  venueLocalDate: DAY,
  orderedAt: plus(asked, -MIN),
  askedAt: asked,
  answer,
  answeredAt,
  checkbackClaimedAt: null,
  checkbackSentAt: null,
})
const at1030 = local(DAY, '10:30')
check(
  'timer: they said it is good, so no timed sign-off, whatever the reply was',
  timedSignOffFor(
    visitCheckin('good', plus(asked, 2 * MIN)),
    plus(asked, 2 * MIN),
    at1030,
  ),
  'answered_good',
)
check(
  'timer: asked, said not yet, went quiet: the light line',
  timedSignOffFor(
    visitCheckin('not_yet', plus(asked, 3 * MIN)),
    plus(asked, 3 * MIN),
    at1030,
  ),
  'send',
)
check(
  'timer: asked, the answer never got written, but they wrote since: the light line',
  timedSignOffFor(visitCheckin(null), plus(asked, 5 * MIN), at1030),
  'send',
)
check(
  'timer: asked, and nothing from them since: nothing',
  timedSignOffFor(visitCheckin(null), plus(asked, -MIN), at1030),
  'nothing_since_checkin',
)
check(
  'timer: asked, and they have never written at all: nothing',
  timedSignOffFor(visitCheckin(null), null, at1030),
  'nothing_since_checkin',
)
check(
  'timer: it read bad: not a visit sign-off (the complaint stop handles it)',
  timedSignOffFor(
    visitCheckin('bad', plus(asked, 2 * MIN)),
    plus(asked, 2 * MIN),
    at1030,
  ),
  'not_a_visit_sign_off',
)
check(
  'timer: a check-in from seven hours ago is not this visit',
  timedSignOffFor(
    visitCheckin('not_yet', plus(asked, 3 * MIN)),
    plus(asked, 3 * MIN),
    local(DAY, '17:30'),
  ),
  'not_a_visit_sign_off',
)
check(
  'timer: no check-in at all',
  timedSignOffFor(null, at1030, at1030),
  'not_a_visit_sign_off',
)
// Found in review: a burst re-runs the turn after the answer is written, and
// the block must not sit over a question or an opt-out.
const signs = (over: Partial<Parameters<typeof replySignsOffVisit>[0]>) =>
  replySignsOffVisit({
    category: 'reply',
    answerThisTurn: null,
    rowAnswer: null,
    rowAnsweredAt: null,
    lastDeliveredOutboundAt: null,
    ...over,
  })
check(
  'reply sign-off: this message says it is good',
  signs({ answerThisTurn: 'good' }),
  true,
)
check(
  'reply sign-off: BURST. the row already says good, and nothing of ours has gone since',
  signs({
    rowAnswer: 'good',
    rowAnsweredAt: plus(asked, 2 * MIN),
    lastDeliveredOutboundAt: asked,
  }),
  true,
)
check(
  'not a sign-off: the row says good and our reply to that has already reached them',
  signs({
    rowAnswer: 'good',
    rowAnsweredAt: plus(asked, 2 * MIN),
    lastDeliveredOutboundAt: plus(asked, 3 * MIN),
  }),
  false,
)
check(
  'not a sign-off: praise inside an opt-out',
  signs({ category: 'opt_out', answerThisTurn: 'good' }),
  false,
)
check(
  'not a sign-off: praise with a question attached',
  signs({ category: 'new_question', answerThisTurn: 'good' }),
  false,
)
check(
  'not a sign-off: this message says not yet',
  signs({ answerThisTurn: 'not_yet' }),
  false,
)
check('not a sign-off: nothing on the row at all', signs({}), false)
const openQuestions = [
  { key: 'are_they_new_here' },
  { key: 'learn_name' },
  { key: 'are_they_local' },
]
check(
  'sign-off reply on a first visit: the name ask and nothing else',
  signOffReplyQuestions(openQuestions, true),
  [{ key: 'learn_name' }],
)
check(
  'sign-off reply on a first visit with the name already known or held back: nothing',
  signOffReplyQuestions([{ key: 'are_they_new_here' }], true),
  [],
)
check(
  'sign-off reply on a later visit: nothing, whatever is open',
  signOffReplyQuestions(openQuestions, false),
  [],
)

// ---------------------------------------------------------------------------
// 3. The one-message rule.
// ---------------------------------------------------------------------------

const NOW = local(DAY, '12:00')
check('gap: nothing has ever gone', isInsideOneMessageGap(null, NOW), false)
check(
  'gap: one went 2h59 ago',
  isInsideOneMessageGap(plus(NOW, -ONE_MESSAGE_GAP_MS + MIN), NOW),
  true,
)
check(
  'gap: one went exactly three hours ago',
  isInsideOneMessageGap(plus(NOW, -ONE_MESSAGE_GAP_MS), NOW),
  false,
)

// Every ordered pair, twice: the other one due in an hour, and in four.
const KINDS = Object.keys(SPACED_MESSAGE_PRIORITY) as SpacedMessage[]
for (const mine of KINDS) {
  for (const other of KINDS) {
    if (mine === other) continue
    const outranked =
      SPACED_MESSAGE_PRIORITY[other] < SPACED_MESSAGE_PRIORITY[mine]
    check(
      `${mine} with ${other} due in an hour: ${outranked ? `stands down for ${other}` : 'goes'}`,
      standsDownFor(mine, NOW, [{ kind: other, dueAt: plus(NOW, HOUR) }]),
      outranked ? other : null,
    )
    check(
      `${mine} with ${other} due in four hours: goes`,
      standsDownFor(mine, NOW, [{ kind: other, dueAt: plus(NOW, 4 * HOUR) }]),
      null,
    )
  }
}
check(
  'an overdue thank-you still outranks a check-in',
  standsDownFor('visit_checkin', NOW, [
    { kind: 'first_visit_thanks', dueAt: plus(NOW, -HOUR) },
  ]),
  'first_visit_thanks',
)
check(
  'the order is thank-you, follow-up, check-in, close',
  KINDS.slice().sort(
    (a, b) => SPACED_MESSAGE_PRIORITY[a] - SPACED_MESSAGE_PRIORITY[b],
  ),
  ['first_visit_thanks', 'inquiry_followup', 'visit_checkin', 'close'],
)

// ---------------------------------------------------------------------------
// 4. Is a check-in fresh? The parts that need no model.
// ---------------------------------------------------------------------------

// Pre-registered control C3 (TAC-578): five seeded, five clean.
const SEEDED = [
  'thanks for coming in yesterday!',
  'Thank you so much for stopping by, the flat white suits you',
  'thx for visiting us again',
  'really appreciate you coming by this morning',
  'thanks again for popping in, see you soon',
]
const CLEAN = [
  'the oat flat white again. you know exactly what you like',
  'branching out to the cortado after six flat whites, bold move',
  'that almond croissant with the cold brew is the right call',
  'thanks to you we finally sold out of the cardamom buns',
  'a flat white before nine, every time. respect',
]
check(
  'C3: every seeded thanks-for-visiting line is caught',
  SEEDED.map(thanksForVisiting),
  [true, true, true, true, true],
)
check(
  'C3: no clean line is caught, including one that says "thanks to you"',
  CLEAN.map(thanksForVisiting),
  [false, false, false, false, false],
)
check(
  'a five-word run shared with an earlier check-in is a repeat',
  sharesWordRun(
    'you know exactly what you like, and it shows',
    'The oat flat white again. You know exactly what you like!',
  ),
  true,
)
check(
  'four shared words are not',
  sharesWordRun(
    'you know exactly what works for you',
    'the oat flat white again. you know exactly what you like',
  ),
  false,
)
check(
  'a short line repeated word for word is',
  sharesWordRun('good call 👌', 'Good call'),
  true,
)
check(
  'wording: thanks first, then the repeat, then nothing',
  [
    checkinWordingRejection(SEEDED[0], []),
    checkinWordingRejection(CLEAN[0], [CLEAN[0]]),
    checkinWordingRejection(CLEAN[1], [CLEAN[0], CLEAN[2]]),
  ],
  ['thanks_for_visiting', 'repeats_wording', null],
)
const usual = { kind: 'the_usual', item: 'flat white' } as const
const choice = { kind: 'the_choice', item: 'cortado' } as const
check(
  'floor: the same angle kind as the last check-in',
  checkinAngleRejection({ kind: 'the_usual', item: 'cortado' }, [usual]),
  'same_angle_as_last',
)
check(
  'floor: the same kind and item as one three back',
  checkinAngleRejection(usual, [choice, null, usual]),
  'same_angle_and_item',
)
check(
  'floor: the same kind and item, but six back: allowed',
  checkinAngleRejection(usual, [choice, null, null, null, null, usual]),
  null,
)
check(
  'floor: the same kind about a different item, not the last one: allowed',
  checkinAngleRejection({ kind: 'the_usual', item: 'cortado' }, [
    choice,
    usual,
  ]),
  null,
)
check('floor: nothing sent before', checkinAngleRejection(usual, []), null)
check(
  'an angle survives being stored',
  decodeAngle(encodeAngle({ kind: 'the_pairing', item: ' Cold Brew ' })),
  { kind: 'the_pairing', item: 'cold brew' },
)
check(
  'a stored angle nobody recognises reads as none',
  decodeAngle('x:y'),
  null,
)

// ---------------------------------------------------------------------------
// 5. Can this harness fail? One check, with an expectation that is wrong on
// purpose, run through the same comparison and required to be reported.
// ---------------------------------------------------------------------------

const before = failures
const silent = console.log
console.log = () => {}
const matched = check('deliberately wrong', slot({}), {
  kind: 'send',
  slot: 'next_morning',
})
console.log = silent
failures = before
check('CONTROL: a wrong expectation is reported as a failure', matched, false)

console.log(
  failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
