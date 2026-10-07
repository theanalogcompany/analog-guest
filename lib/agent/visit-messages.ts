// TAC-578: the rules behind the messages a visit ends in.
//
// Pure, split from visit-messages-store.ts the way visit-checkin.ts and
// warm-close.ts are split from their stores: every constant here decides
// something a guest reads, and the boundary should be drivable without a
// database (scripts/harness/post-visit-timing).
//
// THE SHAPE (ruled 2026-10-07). One quiet-gap timer used to drive every close.
// Now what happened in the conversation decides what follows it:
//
//   a question we can simply answer     the "always here" close, once ever
//   a question that arms a follow-up    nothing; the follow-up is the next touch
//   a visit, guest goes quiet in shop   a light sign-off about the visit
//   a first visit                       a thank-you the next morning (or that
//                                       evening), with the review ask
//   a later visit                       a compliment on the order, only when
//                                       it is fresh
//
// and no two of the follow-up, the thank-you or check-in, and the close land
// within three hours of each other.
//
// WHAT THIS MODULE DOES NOT DECIDE: quiet hours (isQuietHour,
// followup-rules.ts), and Meta's window at the moment of the send
// (dispatch-instagram-reply.ts re-derives it). It does read the window to
// choose a SLOT, which is a different question: not "may this go now" but
// "will tomorrow morning still be possible".

import { venueLocalInstant } from '@/lib/guests/commitment-expiry'
import {
  INSTAGRAM_WINDOW_MARGIN_MS,
  INSTAGRAM_WINDOW_MS,
} from '@/lib/messaging/instagram/window'
import { venueLocalDate } from '@/lib/schemas/venue-hours'
import type { WarmCloseBlockerRow } from './warm-close'

/** The three kinds of row `visit_messages` holds (migration 076). */
export const VISIT_MESSAGE_KINDS = [
  'sign_off',
  'first_visit_thanks',
  'visit_checkin',
] as const
export type VisitMessageKind = (typeof VISIT_MESSAGE_KINDS)[number]

/** The two that go out after the visit, in a slot. */
export type PostVisitKind = Exclude<VisitMessageKind, 'sign_off'>

export type PostVisitSlot = 'next_morning' | 'same_evening'

// ---------------------------------------------------------------------------
// Timing (ruling 6)
// ---------------------------------------------------------------------------

const MS_PER_MINUTE = 60 * 1000

/** How long the morning slot stays open after the venue's earliest hour. */
export const MORNING_SLOT_MINUTES = 120

/**
 * The earliest an evening message goes out, venue-local. Before this "thanks
 * for coming in today" lands in the middle of the day it is thanking them for.
 */
export const EVENING_SLOT_START_MINUTES = 17 * 60

/**
 * How far past the earliest hour one guest's morning message may be pushed.
 * Every guest landing on 09:00:00 reads as a batch job; a stable offset per
 * guest spreads them without a random draw that would move between ticks.
 */
export const MORNING_OFFSET_MAX_MINUTES = 20

/**
 * How long the thread has to have been still before a morning message.
 * A guest who asked something at 08:50 and was answered at 08:51 should not
 * be thanked for yesterday at 09:00.
 */
export const POST_VISIT_QUIET_FLOOR_MS = 30 * MS_PER_MINUTE

/**
 * How long after the visit's last message an evening message waits. The same
 * three hours as the one-message gap: the visit has to be over.
 */
export const EVENING_AFTER_VISIT_MS = 3 * 60 * MS_PER_MINUTE

/** Minutes past midnight for "HH:MM", or null when it is not one. */
export function parseLocalMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  if (match === null) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * A stable 0..MORNING_OFFSET_MAX_MINUTES for one guest. Not a hash anyone
 * should rely on for more than spreading sends across twenty minutes.
 */
export function morningOffsetMinutes(guestId: string): number {
  let sum = 0
  for (let i = 0; i < guestId.length; i += 1) {
    sum = (sum * 31 + guestId.charCodeAt(i)) % 9973
  }
  return sum % (MORNING_OFFSET_MAX_MINUTES + 1)
}

export type PostVisitSlotDecision =
  /** Send now, in this slot. */
  | { kind: 'send'; slot: PostVisitSlot }
  /** Not yet. Look again next tick. */
  | { kind: 'wait'; until: PostVisitSlot }
  /** No slot fits, or the one that did has gone. Final for this visit. */
  | { kind: 'skip'; reason: PostVisitSkipReason }

export type PostVisitSkipReason =
  /** The venue's clock or its send hours could not be read. */
  | 'clock_unreadable'
  /** The guest has no message with a Meta time, so no window can be derived. */
  | 'no_window'
  /** Neither slot fits inside both the window and the send hours. */
  | 'no_slot'
  /** The slot was open and nothing could be sent inside it. */
  | 'slot_passed'

export interface PostVisitSlotInput {
  /** The visit's venue-local day, `YYYY-MM-DD`. */
  visitLocalDate: string
  timezone: string | null
  /** `followup_rules.visit_message_earliest_local`. */
  earliestLocal: string
  /** `followup_rules.visit_message_latest_local`. */
  latestLocal: string
  /** The guest's newest message on META'S clock. Null when none has one. */
  lastInboundAt: Date | null
  /** The newest message in the thread, either direction. */
  threadQuietSince: Date | null
  guestId: string
  now: Date
}

/**
 * Which slot, if any, a visit's message goes out in, and whether it is time.
 *
 * Ruled 2026-10-07: the next morning if Instagram's 24-hour window is still
 * open at that time; otherwise the same evening; otherwise skip.
 *
 * RECOMPUTED EVERY TICK and nothing is stored between them. The window only
 * ever moves later (a guest writing again extends it), so "morning is
 * possible" can turn true during the day and never turns false, which is what
 * makes deciding at the evening slot safe: a visit that waits for the morning
 * at five o'clock still has its morning at nine.
 *
 * FAILS TOWARD NOT SENDING on every unreadable input. The opposite of
 * isQuietHour's direction, on purpose and for inquiry-followup-timing's
 * reason: that predicate guards replies a guest may be waiting on, and this
 * decides whether to start an unprompted conversation.
 */
export function resolvePostVisitSlot(
  input: PostVisitSlotInput,
): PostVisitSlotDecision {
  const { timezone, now } = input
  const earliest = parseLocalMinutes(input.earliestLocal)
  const latest = parseLocalMinutes(input.latestLocal)
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.visitLocalDate)
  if (timezone === null || earliest === null || latest === null || !day) {
    return { kind: 'skip', reason: 'clock_unreadable' }
  }
  if (venueLocalDate(now, timezone) === null) {
    return { kind: 'skip', reason: 'clock_unreadable' }
  }
  if (input.lastInboundAt === null) return { kind: 'skip', reason: 'no_window' }

  const [year, month, date] = [Number(day[1]), Number(day[2]), Number(day[3])]
  const at = (dayOffset: number, minutes: number) =>
    venueLocalInstant(timezone, year, month, date + dayOffset, minutes)

  // The gate the send itself will apply: Meta's close, less the margin.
  const windowCloses = new Date(
    input.lastInboundAt.getTime() +
      INSTAGRAM_WINDOW_MS -
      INSTAGRAM_WINDOW_MARGIN_MS,
  )
  const quietSince = input.threadQuietSince ?? input.lastInboundAt

  const morningStart = at(1, earliest + morningOffsetMinutes(input.guestId))
  const morningEnd = at(1, Math.min(earliest + MORNING_SLOT_MINUTES, latest))
  const eveningFloor = at(0, Math.max(EVENING_SLOT_START_MINUTES, earliest))
  const eveningEnd = at(0, latest)
  if (
    morningStart === null ||
    morningEnd === null ||
    eveningFloor === null ||
    eveningEnd === null
  ) {
    return { kind: 'skip', reason: 'clock_unreadable' }
  }

  // MORNING FIRST. Strictly after the slot's start: a window closing on the
  // exact minute is not one to plan a send against.
  if (
    morningStart.getTime() <= morningEnd.getTime() &&
    windowCloses.getTime() > morningStart.getTime()
  ) {
    if (now.getTime() < morningStart.getTime()) {
      return { kind: 'wait', until: 'next_morning' }
    }
    const lastMoment = Math.min(morningEnd.getTime(), windowCloses.getTime())
    if (now.getTime() > lastMoment) {
      return { kind: 'skip', reason: 'slot_passed' }
    }
    return now.getTime() - quietSince.getTime() >= POST_VISIT_QUIET_FLOOR_MS
      ? { kind: 'send', slot: 'next_morning' }
      : { kind: 'wait', until: 'next_morning' }
  }

  // THE SAME EVENING. Three hours after the visit's last message, and not
  // before five. The window cannot have closed on the day of the visit.
  const eveningStart = new Date(
    Math.max(
      eveningFloor.getTime(),
      quietSince.getTime() + EVENING_AFTER_VISIT_MS,
    ),
  )
  if (eveningStart.getTime() > eveningEnd.getTime()) {
    // Only final once the evening has actually gone: the thread's last message
    // can still be this visit's, and "no slot" at noon would settle the day on
    // a number that has not stopped moving. It has when `now` is past the end.
    return now.getTime() > eveningEnd.getTime() ||
      eveningFloor.getTime() > eveningEnd.getTime()
      ? { kind: 'skip', reason: 'no_slot' }
      : { kind: 'wait', until: 'same_evening' }
  }
  if (now.getTime() < eveningStart.getTime()) {
    return { kind: 'wait', until: 'same_evening' }
  }
  if (now.getTime() > Math.min(eveningEnd.getTime(), windowCloses.getTime())) {
    return { kind: 'skip', reason: 'slot_passed' }
  }
  return { kind: 'send', slot: 'same_evening' }
}

/** What the prompt says about when the visit was. A fact, never a guess. */
export const VISIT_WHEN = {
  next_morning: 'yesterday',
  same_evening: 'earlier today',
} as const satisfies Record<PostVisitSlot, string>

// ---------------------------------------------------------------------------
// Which message (rulings 4, 5 and 7)
// ---------------------------------------------------------------------------

/**
 * Is `visitLocalDate` the first day this guest is known to have been in?
 *
 * `visitDays` is every venue-local day with a scan or a recorded order, from
 * the sources recognition counts (lib/recognition/load-signals.ts). The day
 * itself may be in the list; only an EARLIER one makes this a later visit.
 */
export function isFirstVisitDay(
  visitLocalDate: string,
  visitDays: readonly string[],
): boolean {
  return !visitDays.some((day) => day < visitLocalDate)
}

/** Where a visit's complaint stands, as far as the thread shows. */
export type ComplaintStanding =
  /** Nothing went wrong on this visit. */
  | 'none'
  /** Something did, and a person's reply about it reached the guest last. */
  | 'resolved'
  /** Something did, and it is still open. */
  | 'unresolved'

/** The category a complaint turn's reply is stored under. */
const COMPLAINT_CATEGORY = 'comp_complaint'

/** A `messages.review_state` an operator's hand produced. */
const STAFF_REVIEW_STATES: ReadonlySet<string> = new Set(['approved', 'edited'])

/**
 * Was this visit's complaint put right by a person?
 *
 * Ruled 2026-10-07: "Bad experience: staff fix it first; once resolved, the
 * thank-you with the review ask. Unresolved: no thank-you and no ask."
 *
 * DERIVED, because nothing records "resolved" (migration 073 says as much: no
 * complaint state exists on a guest). What the thread does show:
 *
 *   a complaint     a reply of ours stored `comp_complaint`, in any state
 *                   (the category is stamped on our row, never on the guest's
 *                   inbound), or a check-in that reads `bad`.
 *   resolved        after the FIRST complaint row, a reply written or approved
 *                   by a person reached the guest, and no complaint reply is
 *                   newer than it. A hand-typed reply carries no
 *                   `generated_by`; an approved card carries a review state.
 *   unresolved      everything else: the reply is still on a card, was
 *                   skipped, auto-sent a clarifying question
 *                   (`openClarification`, complaint-thread.ts), or the guest
 *                   complained again after staff answered.
 *
 * `rows` is this visit's stretch, oldest first. A tapback is the one outbound
 * our own code writes with no `generated_by` and is not a person.
 */
export function complaintStanding(input: {
  rows: readonly (WarmCloseBlockerRow & { createdAt: Date })[]
  deliveredStatuses: ReadonlySet<string>
  checkinSaidBad: boolean
  /**
   * When the check-in was answered `bad`. The floor for "staff replied AFTER
   * the complaint" on a visit with no complaint reply of ours on file. Null
   * when it did not read bad.
   */
  checkinBadAt: Date | null
  /** isComplaintClarificationOpen for this thread (complaint-thread.ts). */
  openClarification: boolean
}): ComplaintStanding {
  const outbound = input.rows.filter((r) => r.direction === 'outbound')
  const complaints = outbound.filter((r) => r.category === COMPLAINT_CATEGORY)
  if (complaints.length === 0 && !input.checkinSaidBad) return 'none'
  if (input.openClarification) return 'unresolved'

  // WHEN IT WENT WRONG: our first complaint reply, or the moment the check-in
  // read bad when no such reply exists. Never zero: with no floor, a reply
  // staff typed BEFORE the complaint counted as the fix, and an unhappy guest
  // read as put right (found in review). A complaint with no time at all is
  // unresolved.
  const firstComplaintAt =
    complaints.length > 0
      ? Math.min(...complaints.map((r) => r.createdAt.getTime()))
      : (input.checkinBadAt?.getTime() ?? null)
  if (firstComplaintAt === null) return 'unresolved'
  const staffReplies = outbound.filter(
    (r) =>
      r.category !== 'reaction' &&
      input.deliveredStatuses.has(r.status) &&
      r.createdAt.getTime() >= firstComplaintAt &&
      (r.generatedBy === null ||
        (r.reviewState !== null && STAFF_REVIEW_STATES.has(r.reviewState))),
  )
  if (staffReplies.length === 0) return 'unresolved'
  const lastStaffAt = Math.max(
    ...staffReplies.map((r) => r.createdAt.getTime()),
  )
  const complaintAfterStaff = complaints.some(
    (r) => r.createdAt.getTime() > lastStaffAt,
  )
  return complaintAfterStaff ? 'unresolved' : 'resolved'
}

// ---------------------------------------------------------------------------
// The one-message rule (ruling 8)
// ---------------------------------------------------------------------------

/**
 * How far apart a follow-up, a thank-you or check-in, and a close have to be.
 *
 * THREE HOURS, a judgment approved 2026-10-07, in the posture of
 * PROACTIVE_SPACING_MINUTES: nobody has measured it. It matches the inquiry
 * follow-up's own delay. The scan greeting is NOT in this rule and keeps the
 * sixty minutes in proactive-spacing.ts, and a visit's own greeting,
 * check-back and sign-off are still not spaced against each other.
 */
export const ONE_MESSAGE_GAP_MS = 3 * 60 * MS_PER_MINUTE

/** The four messages the rule covers. */
export type SpacedMessage =
  'first_visit_thanks' | 'inquiry_followup' | 'visit_checkin' | 'close'

/**
 * Who wins when two are due together. Lower goes first.
 *
 * The thank-you is once per guest ever and carries the review ask, so it
 * yields to nothing. The close is the least specific thing we send and yields
 * to everything.
 */
export const SPACED_MESSAGE_PRIORITY = {
  first_visit_thanks: 0,
  inquiry_followup: 1,
  visit_checkin: 2,
  close: 3,
} as const satisfies Record<SpacedMessage, number>

/** Did one of the four reach this guest inside the gap? */
export function isInsideOneMessageGap(
  lastSpacedSendAt: Date | null,
  now: Date,
): boolean {
  if (lastSpacedSendAt === null) return false
  return now.getTime() - lastSpacedSendAt.getTime() < ONE_MESSAGE_GAP_MS
}

/**
 * Should `kind` stand down because something that outranks it is due?
 *
 * `pending` is every other message still owed to this guest with the moment
 * it is due. One that is already overdue counts: it has not gone yet, and
 * sending under it would make it the one that has to wait.
 */
export function standsDownFor(
  kind: SpacedMessage,
  now: Date,
  pending: readonly { kind: SpacedMessage; dueAt: Date }[],
): SpacedMessage | null {
  for (const other of pending) {
    if (SPACED_MESSAGE_PRIORITY[other.kind] >= SPACED_MESSAGE_PRIORITY[kind]) {
      continue
    }
    if (other.dueAt.getTime() - now.getTime() < ONE_MESSAGE_GAP_MS) {
      return other.kind
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Is a check-in fresh? (ruling 5)
// ---------------------------------------------------------------------------

/**
 * The angles a compliment on an order can take. JUDGE OUTPUT ONLY (ruled
 * 2026-10-07): the list must never appear in the generation prompt, where it
 * would become six templates.
 */
export const CHECKIN_ANGLE_KINDS = [
  'the_choice',
  'the_usual',
  'a_departure',
  'the_pairing',
  'the_timing',
  'their_taste',
] as const
export type CheckinAngleKind = (typeof CHECKIN_ANGLE_KINDS)[number]

export interface CheckinAngle {
  kind: CheckinAngleKind
  /** What the compliment is about, lowercased. '' when it names nothing. */
  item: string
}

/** How many earlier check-ins the model is shown and the checks read. */
export const PRIOR_CHECKIN_LIMIT = 10

/** How many earlier angles the kind-plus-item floor looks back over. */
export const ANGLE_LOOKBACK = 5

/** `<kind>:<item>`, the form `visit_messages.angle` stores. */
export function encodeAngle(angle: CheckinAngle): string {
  return `${angle.kind}:${angle.item.trim().toLowerCase()}`
}

export function decodeAngle(stored: string | null): CheckinAngle | null {
  if (stored === null) return null
  const split = stored.indexOf(':')
  const kind = split === -1 ? stored : stored.slice(0, split)
  if (!(CHECKIN_ANGLE_KINDS as readonly string[]).includes(kind)) return null
  return {
    kind: kind as CheckinAngleKind,
    item: split === -1 ? '' : stored.slice(split + 1),
  }
}

/**
 * A check-in must never thank the guest for the visit (ruled 2026-10-07: "NOT
 * a transactional thanks"). The prompt says so; this is the half that does not
 * depend on the prompt being obeyed.
 *
 * Reads OUR OWN outbound, so it can be as literal as it likes.
 */
const THANKS_FOR_VISITING =
  /\b(?:(?:thanks|thank you|thx)\b[^.!?\n]{0,40}\bfor\b|appreciate (?:you|it)\b)[^.!?\n]{0,25}\b(?:coming|stopp(?:ing|ed) (?:in|by)|visit(?:ing)?|swing(?:ing)? by|dropp(?:ing|ed) (?:in|by)|being here|popp(?:ing|ed) (?:in|by))\b/i

export function thanksForVisiting(body: string): boolean {
  return THANKS_FOR_VISITING.test(body)
}

/** Lowercased words with punctuation and emoji dropped. */
export function comparableWords(body: string): string[] {
  return body
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '')
}

/** How long a shared run of words has to be to count as a repeat. */
export const REPEAT_RUN_WORDS = 5

/** Do the two share any run of `REPEAT_RUN_WORDS` consecutive words? */
export function sharesWordRun(a: string, b: string): boolean {
  const wordsA = comparableWords(a)
  const wordsB = comparableWords(b)
  if (wordsA.length < REPEAT_RUN_WORDS || wordsB.length < REPEAT_RUN_WORDS) {
    // Too short to have a run: equal or not.
    return wordsA.length > 0 && wordsA.join(' ') === wordsB.join(' ')
  }
  const runs = new Set<string>()
  for (let i = 0; i + REPEAT_RUN_WORDS <= wordsA.length; i += 1) {
    runs.add(wordsA.slice(i, i + REPEAT_RUN_WORDS).join(' '))
  }
  for (let i = 0; i + REPEAT_RUN_WORDS <= wordsB.length; i += 1) {
    if (runs.has(wordsB.slice(i, i + REPEAT_RUN_WORDS).join(' '))) return true
  }
  return false
}

/** Why a drafted check-in is not sent. Each is a distinct cause. */
export type CheckinRejection =
  | 'thanks_for_visiting'
  | 'repeats_wording'
  | 'not_specific'
  | 'judge_says_repeat'
  | 'same_angle_as_last'
  | 'same_angle_and_item'

/** The part of the check that needs no model: the draft against the record. */
export function checkinWordingRejection(
  body: string,
  earlierBodies: readonly string[],
): CheckinRejection | null {
  if (thanksForVisiting(body)) return 'thanks_for_visiting'
  return earlierBodies.some((earlier) => sharesWordRun(body, earlier))
    ? 'repeats_wording'
    : null
}

/**
 * The safety floor, in code and over the judge's reading (approved
 * 2026-10-07): never the same angle kind as the previous check-in, and never
 * the same kind and item as any of the last ANGLE_LOOKBACK.
 *
 * It runs WHATEVER the judge said about repeating. The judge's own
 * `repeatsEarlier` is a reading; this is arithmetic on what it called the
 * angle, and the two can disagree.
 *
 * `earlier` is newest first. A stored angle that no longer decodes is skipped,
 * which can only let more through; the judge's own verdict still stands.
 */
export function checkinAngleRejection(
  angle: CheckinAngle,
  earlier: readonly (CheckinAngle | null)[],
): CheckinRejection | null {
  const previous = earlier[0] ?? null
  if (previous !== null && previous.kind === angle.kind) {
    return 'same_angle_as_last'
  }
  const encoded = encodeAngle(angle)
  const repeated = earlier
    .slice(0, ANGLE_LOOKBACK)
    .some((a) => a !== null && encodeAngle(a) === encoded)
  return repeated ? 'same_angle_and_item' : null
}
