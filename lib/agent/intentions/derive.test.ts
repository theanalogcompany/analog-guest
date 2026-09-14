import { describe, expect, it } from 'vitest'
import { REPORTED_ORDER_WINDOW_DAYS } from '@/lib/agent/extract-reported-order'
import { INTENTION_RULES_DEFAULT } from '@/lib/schemas/intention-rules'
import {
  EVENT_ARMED_WINDOW_DAYS,
  FIRST_CONTACT_WINDOW_DAYS,
  type IntentionKey,
  resolveIntentionKey,
  UNDERSTAND_ORDER_WINDOW_DAYS,
} from './definitions'
import {
  applyCurrentTurnSuppression,
  type DeriveOpenIntentionsInput,
  deriveIntentionState,
  deriveOpenIntentions,
  type IntentionStateEntry,
  isIntentionBrakeEngaged,
  type OpenIntention,
  renderableIntentions,
  resolveInboundHistoryFrom,
} from './derive'
import type { PromptedIntentionRow } from './load'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const MS_PER_HOUR = 60 * 60 * 1000
const NOW = new Date('2026-09-14T12:00:00.000Z')
const WINDOW_48H = 48 * MS_PER_HOUR

const daysAgo = (n: number) => new Date(NOW.getTime() - n * MS_PER_DAY)
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * MS_PER_HOUR)
const keysOf = (open: readonly OpenIntention[]): IntentionKey[] => open.map((o) => o.key)

const NO_FACTS = { hasQualifyingTransaction: false, hasFirstName: false, hasHomeBase: false }

/**
 * A baseline where nothing is eligible: an inbound_message guest (so
 * understand_order is unarmed), no replies, no events. Each test turns on
 * exactly what it's about.
 */
function input(overrides: Partial<DeriveOpenIntentionsInput> = {}): DeriveOpenIntentionsInput {
  return {
    now: NOW,
    guest: { createdVia: 'inbound_message', createdAt: daysAgo(30) },
    responseRate: 0,
    repliedMessageCount: 0,
    rules: INTENTION_RULES_DEFAULT,
    facts: NO_FACTS,
    openRecommendationTimes: [],
    openRecommendationTouchedTimes: [],
    openRecommendationsUnreadable: false,
    recordedOrderTimes: [],
    rows: { prompted: [], eligible: [] },
    inboundTimes: [NOW],
    conversationWindowMs: WINDOW_48H,
    inboundHistoryFrom: daysAgo(14),
    ...overrides,
  }
}

/** A guest who replies to everything, with `replies` lifetime inbound messages. */
const engaged = (replies: number) => ({ responseRate: 100, repliedMessageCount: replies })

function promptedRow(
  key: string,
  at: Date,
  extra: Partial<PromptedIntentionRow> = {},
): PromptedIntentionRow {
  return {
    intentionKey: key,
    promptedAt: at,
    eligibleAt: at,
    promptSource: 'classified',
    messageId: `m-${key}-${at.getTime()}`,
    ...extra,
  }
}

describe('window constants', () => {
  // Carried over from TAC-324 under the renamed constant: how long Sana still
  // ASKS about the first order must not outlast how long TAC-323's extractor
  // still LISTENS for one.
  it('never lets the understand_order ask-window outlast the listen-window', () => {
    expect(UNDERSTAND_ORDER_WINDOW_DAYS).toBeLessThanOrEqual(REPORTED_ORDER_WINDOW_DAYS)
  })
})

describe('deriveOpenIntentions — state rows (trap 1)', () => {
  // The behavioural half of trap 1 (the SQL half is in load.test.ts). An
  // eligibility row means "askable since eligible_at", not "already asked".
  it('leaves an intention OPEN when only an eligibility row exists (prompted_at null)', () => {
    const result = deriveOpenIntentions(
      input({ rows: { prompted: [], eligible: [{ intentionKey: 'learn_name', eligibleAt: daysAgo(1) }] } }),
    )
    expect(keysOf(result.open)).toContain('learn_name')
  })

  it('closes an intention for good once a prompted row exists, and never re-writes it', () => {
    const result = deriveOpenIntentions(
      input({
        ...engaged(11),
        rows: { prompted: [promptedRow('learn_name', daysAgo(1))], eligible: [] },
      }),
    )
    expect(keysOf(result.open)).not.toContain('learn_name')
    expect(result.newlyEligible.map((e) => e.key)).not.toContain('learn_name')
  })

  it('fails closed when the rows could not be read', () => {
    const result = deriveOpenIntentions(input({ ...engaged(11), rows: null }))
    expect(result).toEqual({ open: [], newlyEligible: [], brakeEngaged: false })
  })

  // TAC-380 deploy window: rows the OLD code writes between applying migration
  // 040 and deploying keep the learn_first_order key until the backfill block
  // is re-run. Read as understand_order, a guest asked in that window is not
  // asked again; skipped as an orphan, they would be.
  it('reads a legacy learn_first_order prompt as a closed understand_order', () => {
    const result = deriveOpenIntentions(
      input({
        guest: { createdVia: 'qr_scan', createdAt: hoursAgo(3) },
        rows: { prompted: [promptedRow('learn_first_order', hoursAgo(2))], eligible: [] },
      }),
    )
    expect(keysOf(result.open)).not.toContain('understand_order')
    expect(result.newlyEligible.map((e) => e.key)).not.toContain('understand_order')
  })

  // invite_contact_save is retired; its one production row is left orphaned
  // rather than migrated (ruling 5).
  it('ignores a row whose key matches no live definition', () => {
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        rows: { prompted: [promptedRow('invite_contact_save', daysAgo(1))], eligible: [] },
      }),
    )
    expect(keysOf(result.open)).toEqual(['learn_name'])
  })
})

describe('deriveOpenIntentions — arming', () => {
  // Ruling 4: a scan confirms a visit, which is what lets understand_order ask
  // about an order without breaking R1. No scan, no arm.
  it('arms understand_order on a qr_scan enrollment, ungated, anchored to enrollment', () => {
    const createdAt = hoursAgo(1)
    const result = deriveOpenIntentions(input({ guest: { createdVia: 'qr_scan', createdAt } }))
    expect(keysOf(result.open)).toEqual(['understand_order'])
    expect(result.newlyEligible).toEqual([{ key: 'understand_order', eligibleAt: createdAt, rearm: false }])
  })

  it('never arms understand_order for a guest who texted in without scanning (R1)', () => {
    const result = deriveOpenIntentions(
      input({ ...engaged(11), guest: { createdVia: 'inbound_message', createdAt: hoursAgo(1) } }),
    )
    expect(keysOf(result.open)).not.toContain('understand_order')
  })

  it('expires understand_order its window after enrollment', () => {
    const result = deriveOpenIntentions(
      input({ guest: { createdVia: 'qr_scan', createdAt: daysAgo(UNDERSTAND_ORDER_WINDOW_DAYS + 1) } }),
    )
    expect(result.open).toEqual([])
    expect(result.newlyEligible).toEqual([])
  })

  // Ruling 2: anchored to the moment the recommendation became part of a
  // different conversation, 48h after it was made at the default window.
  it('arms got_the_recommendation once the recommendation is from an earlier conversation, anchored to that moment', () => {
    const result = deriveOpenIntentions(
      input({ ...engaged(3), openRecommendationTimes: [hoursAgo(50)] }),
    )
    expect(keysOf(result.open)).toContain('got_the_recommendation')
    expect(result.newlyEligible.find((e) => e.key === 'got_the_recommendation')).toEqual({
      key: 'got_the_recommendation',
      eligibleAt: hoursAgo(2),
      rearm: false,
    })
  })

  // Ruling 3: event-armed intentions are perishable.
  it('does not arm off a recommendation older than the window', () => {
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        openRecommendationTimes: [
          new Date(NOW.getTime() - WINDOW_48H - EVENT_ARMED_WINDOW_DAYS * MS_PER_DAY - MS_PER_HOUR),
        ],
      }),
    )
    expect(keysOf(result.open)).not.toContain('got_the_recommendation')
    expect(result.newlyEligible.map((e) => e.key)).not.toContain('got_the_recommendation')
  })

  it('arms did_they_like_it off a recorded order, and not without one', () => {
    const withOrder = deriveOpenIntentions(
      input({
        ...engaged(3),
        recordedOrderTimes: [hoursAgo(50)],
        facts: { ...NO_FACTS, hasQualifyingTransaction: true },
      }),
    )
    const without = deriveOpenIntentions(input({ ...engaged(3) }))
    expect(keysOf(withOrder.open)).toContain('did_they_like_it')
    expect(keysOf(without.open)).not.toContain('did_they_like_it')
  })

  // Ruling 1's shape again: arming off the first order ever would leave a guest
  // whose first order is long past unasked about every later one.
  it('arms did_they_like_it off the newest askable order, not the first one ever', () => {
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        recordedOrderTimes: [daysAgo(30), hoursAgo(50), hoursAgo(100)],
        facts: { ...NO_FACTS, hasQualifyingTransaction: true },
      }),
    )
    expect(result.newlyEligible).toContainEqual({ key: 'did_they_like_it', eligibleAt: hoursAgo(2), rearm: false })
  })
  // Ruling 2: an event arms only once it is from a different conversation.
  // Raising "did you try it?" in the exchange where it was suggested closes the
  // intention for good on the one turn it can't land.
  it('does not arm got_the_recommendation inside the conversation it was made in', () => {
    const result = deriveOpenIntentions(
      input({ ...engaged(3), openRecommendationTimes: [hoursAgo(1)] }),
    )
    expect(keysOf(result.open)).not.toContain('got_the_recommendation')
    expect(result.newlyEligible.map((e) => e.key)).not.toContain('got_the_recommendation')
  })

  it('does not arm did_they_like_it inside the conversation the order was reported in', () => {
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        recordedOrderTimes: [hoursAgo(1)],
        facts: { ...NO_FACTS, hasQualifyingTransaction: true },
      }),
    )
    expect(keysOf(result.open)).not.toContain('did_they_like_it')
    expect(result.newlyEligible.map((e) => e.key)).not.toContain('did_they_like_it')
  })

  // One number: the window comes from config (recent_conversation_hours), never
  // a second constant. Anchoring at the askable moment keeps the full window at
  // a long configured conversation, where anchoring at the event would leave
  // nothing askable once the conversation length reached the window.
  it('takes the conversation length from config, short or long', () => {
    const short = deriveOpenIntentions(
      input({ ...engaged(3), conversationWindowMs: 6 * MS_PER_HOUR, openRecommendationTimes: [hoursAgo(7)] }),
    )
    expect(short.newlyEligible).toContainEqual({ key: 'got_the_recommendation', eligibleAt: hoursAgo(1), rearm: false })

    const long = deriveOpenIntentions(
      input({ ...engaged(3), conversationWindowMs: 96 * MS_PER_HOUR, openRecommendationTimes: [hoursAgo(100)] }),
    )
    expect(long.newlyEligible).toContainEqual({ key: 'got_the_recommendation', eligibleAt: hoursAgo(4), rearm: false })
  })

  // Ruling 1: the newest recommendation still inside its window, never the
  // first one ever. Two are askable here, so "earliest" and "newest" differ.
  it('arms off the newest askable recommendation, not the first one ever', () => {
    const result = deriveOpenIntentions(
      input({ ...engaged(3), openRecommendationTimes: [daysAgo(30), hoursAgo(50), hoursAgo(100)] }),
    )
    expect(result.newlyEligible).toContainEqual({ key: 'got_the_recommendation', eligibleAt: hoursAgo(2), rearm: false })
  })

  // Ruling 2, held at render time. The line doesn't say which recommendation it
  // means and ## Active commitments lists them all, so arming off the older one
  // would let the model ask about the one it just suggested. Found in review: an
  // earlier version fell back to the older recommendation, and a test pinned it.
  it('arms nothing off an older recommendation while the newest is still in this conversation', () => {
    const result = deriveOpenIntentions(
      input({ ...engaged(3), openRecommendationTimes: [hoursAgo(1), hoursAgo(60)] }),
    )
    expect(keysOf(result.open)).not.toContain('got_the_recommendation')
    expect(result.newlyEligible.map((e) => e.key)).not.toContain('got_the_recommendation')
  })

  it('holds an already-open row off the prompt while the newest recommendation is in this conversation', () => {
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        openRecommendationTimes: [hoursAgo(1), hoursAgo(60)],
        rows: { prompted: [], eligible: [{ intentionKey: 'got_the_recommendation', eligibleAt: hoursAgo(12) }] },
      }),
    )
    expect(keysOf(result.open)).not.toContain('got_the_recommendation')
    expect(result.newlyEligible.map((e) => e.key)).not.toContain('got_the_recommendation')
  })

  // A repeated recommendation is deduped onto its existing row (TAC-318), which
  // bumps updated_at and never created_at, so the hold has to read it. Found in
  // review: without it, re-suggesting a months-old recommendation let "did you
  // try it?" follow in the same exchange.
  it('holds got_the_recommendation while an old recommendation was re-suggested in this conversation', () => {
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        openRecommendationTimes: [daysAgo(90), hoursAgo(60)],
        openRecommendationTouchedTimes: [hoursAgo(1), hoursAgo(60)],
        rows: { prompted: [], eligible: [{ intentionKey: 'got_the_recommendation', eligibleAt: hoursAgo(12) }] },
      }),
    )
    expect(keysOf(result.open)).not.toContain('got_the_recommendation')
  })

  // Fail closed (ruling 4). With the open recommendations unreadable the hold
  // can't be judged, and an empty list would silently lift it. Found in review.
  it('holds got_the_recommendation when the open recommendations could not be read', () => {
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        openRecommendationsUnreadable: true,
        rows: { prompted: [], eligible: [{ intentionKey: 'got_the_recommendation', eligibleAt: hoursAgo(12) }] },
      }),
    )
    expect(keysOf(result.open)).not.toContain('got_the_recommendation')
  })

  // Touched times hold; they never arm. Arming off them would arm a months-old
  // recommendation off the moment it was re-suggested.
  it('never arms off a touched time', () => {
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        openRecommendationTimes: [daysAgo(90)],
        openRecommendationTouchedTimes: [hoursAgo(60)],
      }),
    )
    expect(keysOf(result.open)).not.toContain('got_the_recommendation')
    expect(result.newlyEligible.map((e) => e.key)).not.toContain('got_the_recommendation')
  })

  // Nor re-arm. A re-suggestion lands on the same row (TAC-318 dedup), so it is a
  // repeat of what was already asked, not a newer event.
  it('never re-arms off a touched time', () => {
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        openRecommendationTimes: [daysAgo(90)],
        openRecommendationTouchedTimes: [hoursAgo(60)],
        rows: {
          prompted: [promptedRow('got_the_recommendation', daysAgo(80), { eligibleAt: daysAgo(88) })],
          eligible: [],
        },
      }),
    )
    expect(keysOf(result.open)).not.toContain('got_the_recommendation')
    expect(result.newlyEligible.map((e) => e.key)).not.toContain('got_the_recommendation')
  })

  // A re-armable row with no anchor could never be stamped closed. Nothing writes
  // one; if one appears it is left alone rather than asked every turn.
  it('does not render a re-armable eligibility row that has no anchor', () => {
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        openRecommendationTimes: [hoursAgo(50)],
        rows: { prompted: [], eligible: [{ intentionKey: 'got_the_recommendation', eligibleAt: null }] },
      }),
    )
    expect(keysOf(result.open)).not.toContain('got_the_recommendation')
  })
})

// TAC-380 acceptance criteria, corrected 2026-09-14. First-contact intentions
// never re-arm; event-armed ones re-arm on a strictly newer event, because a new
// recommendation or order is a new thing to ask about. Without it a guest whose
// window ran out would never be asked about any later event: one row per guest
// per intention, and it stays closed.
describe('deriveOpenIntentions — re-arming', () => {
  // A recommendation made 12 days ago, askable (and anchored) 10 days ago.
  const OLD_ANCHOR = daysAgo(10)
  const promptedRecommendation = () =>
    promptedRow('got_the_recommendation', daysAgo(9), { eligibleAt: OLD_ANCHOR })
  // The guest replied to that prompt within the hour. A re-arm waits while its
  // own last prompt went unanswered, so the cases below answer it unless they
  // are about exactly that.
  const ANSWERED = [new Date(daysAgo(9).getTime() + MS_PER_HOUR), NOW]

  it('re-arms got_the_recommendation after a prompt, on a recommendation from a later conversation', () => {
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        openRecommendationTimes: [daysAgo(12), hoursAgo(50)],
        rows: { prompted: [promptedRecommendation()], eligible: [] },
        inboundTimes: ANSWERED,
      }),
    )
    expect(keysOf(result.open)).toContain('got_the_recommendation')
    expect(result.newlyEligible).toContainEqual({
      key: 'got_the_recommendation',
      eligibleAt: hoursAgo(2),
      rearm: true,
    })
  })

  // The case the corrected criterion names: the window ran out with the
  // intention never raised.
  it('re-arms a row that expired unraised, on a newer recommendation', () => {
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        openRecommendationTimes: [daysAgo(12), hoursAgo(50)],
        rows: { prompted: [], eligible: [{ intentionKey: 'got_the_recommendation', eligibleAt: OLD_ANCHOR }] },
      }),
    )
    expect(keysOf(result.open)).toContain('got_the_recommendation')
    expect(result.newlyEligible).toContainEqual({
      key: 'got_the_recommendation',
      eligibleAt: hoursAgo(2),
      rearm: true,
    })
  })

  it('re-arms did_they_like_it on a newer recorded order', () => {
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        recordedOrderTimes: [daysAgo(12), hoursAgo(50)],
        facts: { ...NO_FACTS, hasQualifyingTransaction: true },
        rows: {
          prompted: [promptedRow('did_they_like_it', daysAgo(9), { eligibleAt: OLD_ANCHOR })],
          eligible: [],
        },
        inboundTimes: ANSWERED,
      }),
    )
    expect(keysOf(result.open)).toContain('did_they_like_it')
    expect(result.newlyEligible).toContainEqual({ key: 'did_they_like_it', eligibleAt: hoursAgo(2), rearm: true })
  })

  it('does not re-arm off the recommendation the row is already anchored on', () => {
    // Made 98h ago, askable 50h ago, which is the stored anchor.
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        openRecommendationTimes: [hoursAgo(98)],
        rows: {
          prompted: [promptedRow('got_the_recommendation', hoursAgo(40), { eligibleAt: hoursAgo(50) })],
          eligible: [],
        },
      }),
    )
    expect(keysOf(result.open)).not.toContain('got_the_recommendation')
    expect(result.newlyEligible.map((e) => e.key)).not.toContain('got_the_recommendation')
  })

  // Ruling 2's one definition of a different visit. The second recommendation
  // was made before the first had even become askable, so it is from the same
  // conversation, and asking about it after asking about the first is nagging.
  it('does not re-arm on a recommendation from the same conversation as the one already asked about', () => {
    // First at 120h ago (askable 72h ago, asked 70h ago); second at 100h ago.
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        openRecommendationTimes: [hoursAgo(120), hoursAgo(100)],
        rows: {
          prompted: [promptedRow('got_the_recommendation', hoursAgo(70), { eligibleAt: hoursAgo(72) })],
          eligible: [],
        },
        inboundTimes: [hoursAgo(69), NOW],
      }),
    )
    expect(result.newlyEligible.map((e) => e.key)).not.toContain('got_the_recommendation')
  })

  // The stored anchor is compared as stored, never an old event recomputed
  // through today's window. Lengthening recent_conversation_hours must not make
  // the same recommendation look newer than itself.
  it('does not re-arm off the same recommendation when the conversation window grows', () => {
    // Made 100h ago and anchored under a 48h window (52h ago); the window is now 96h.
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        conversationWindowMs: 96 * MS_PER_HOUR,
        openRecommendationTimes: [hoursAgo(100)],
        rows: {
          prompted: [promptedRow('got_the_recommendation', hoursAgo(50), { eligibleAt: hoursAgo(52) })],
          eligible: [],
        },
      }),
    )
    expect(result.newlyEligible.map((e) => e.key)).not.toContain('got_the_recommendation')
  })

  // Asking a guest's name twice is nagging.
  it('never re-arms a first-contact intention', () => {
    const result = deriveOpenIntentions(
      input({ ...engaged(11), rows: { prompted: [promptedRow('learn_name', daysAgo(20))], eligible: [] } }),
    )
    expect(keysOf(result.open)).not.toContain('learn_name')
    expect(result.newlyEligible.map((e) => e.key)).not.toContain('learn_name')
  })

  // A re-arm is a fresh arming, so the gate is checked again.
  it('does not re-arm while the gate is closed', () => {
    const result = deriveOpenIntentions(
      input({
        responseRate: 0,
        repliedMessageCount: 0,
        openRecommendationTimes: [hoursAgo(50)],
        rows: { prompted: [promptedRecommendation()], eligible: [] },
        inboundTimes: ANSWERED,
      }),
    )
    expect(result.open).toEqual([])
    expect(result.newlyEligible).toEqual([])
  })

  it('does not re-arm on a newer recommendation that is already past its window', () => {
    // Made 7 days ago: askable 5 days ago, expired 2 days ago.
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        openRecommendationTimes: [daysAgo(7)],
        rows: { prompted: [promptedRecommendation()], eligible: [] },
        inboundTimes: ANSWERED,
      }),
    )
    expect(result.newlyEligible.map((e) => e.key)).not.toContain('got_the_recommendation')
  })

  // Found in review. A re-arm used to clear the old prompt, which erased the
  // evidence the brake runs on: a guest who ignored every question but kept
  // ordering was asked after every order. Now a re-arm waits on an ignored
  // prompt, judged by the brake's own rule.
  it('waits to re-arm while its own last prompt went unanswered', () => {
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        openRecommendationTimes: [daysAgo(12), hoursAgo(50)],
        rows: { prompted: [promptedRecommendation()], eligible: [] },
        inboundTimes: [NOW], // came back nine days later
      }),
    )
    expect(keysOf(result.open)).not.toContain('got_the_recommendation')
    expect(result.newlyEligible.map((e) => e.key)).not.toContain('got_the_recommendation')
  })

  // The brake's own lift: a prompt the visible history can't judge doesn't count
  // against the guest.
  it('re-arms once that unanswered prompt is older than the visible inbound history', () => {
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        openRecommendationTimes: [daysAgo(12), hoursAgo(50)],
        rows: { prompted: [promptedRecommendation()], eligible: [] },
        inboundTimes: [NOW],
        inboundHistoryFrom: daysAgo(5),
      }),
    )
    expect(result.newlyEligible).toContainEqual({ key: 'got_the_recommendation', eligibleAt: hoursAgo(2), rearm: true })
  })

  it('does not let a pessimistic closure hold up a re-arm', () => {
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        openRecommendationTimes: [daysAgo(12), hoursAgo(50)],
        rows: {
          prompted: [
            promptedRow('got_the_recommendation', daysAgo(9), { eligibleAt: OLD_ANCHOR, promptSource: 'pessimistic' }),
          ],
          eligible: [],
        },
        inboundTimes: [NOW],
      }),
    )
    expect(result.newlyEligible).toContainEqual({ key: 'got_the_recommendation', eligibleAt: hoursAgo(2), rearm: true })
  })

  // The brake regression the review asked for, over two turns. Turn one: two
  // ignored prompts engage the brake, a newer order arrives, and the re-arm
  // waits. Turn two, as if a re-arm had been written anyway: the row keeps its
  // prompt, so the brake still counts both.
  it('keeps the brake engaged when a newer order arrives after two ignored prompts', () => {
    const prompted = [
      promptedRow('are_they_local', hoursAgo(200), { messageId: 'm1' }),
      promptedRow('did_they_like_it', hoursAgo(149), { messageId: 'm2', eligibleAt: hoursAgo(151) }),
    ]
    const orderTurn = {
      ...engaged(5),
      recordedOrderTimes: [hoursAgo(50)],
      facts: { ...NO_FACTS, hasQualifyingTransaction: true },
      inboundTimes: [hoursAgo(150), NOW],
    }

    const turnOne = deriveOpenIntentions(input({ ...orderTurn, rows: { prompted, eligible: [] } }))
    expect(turnOne.brakeEngaged).toBe(true)
    expect(turnOne.newlyEligible.map((e) => e.key)).not.toContain('did_they_like_it')

    const rearmed = [prompted[0], { ...prompted[1], eligibleAt: hoursAgo(2) }]
    const turnTwo = deriveOpenIntentions(input({ ...orderTurn, rows: { prompted: rearmed, eligible: [] } }))
    expect(turnTwo.brakeEngaged).toBe(true)
    expect(turnTwo.open).toEqual([])
  })
})

describe('deriveOpenIntentions — conversational gate', () => {
  it('opens nothing gated while responseRate is below the floor, however many replies', () => {
    const result = deriveOpenIntentions(input({ responseRate: 49, repliedMessageCount: 50 }))
    expect(result.open).toEqual([])
    expect(result.newlyEligible).toEqual([])
  })

  // Correction B from the 2026-09-14 plan: tiers stagger on the monotone reply
  // count, never on the ratio.
  it.each([
    [2, []],
    [3, ['learn_name']],
    [5, ['learn_name', 'are_they_local']],
    [8, ['learn_name', 'are_they_local', 'their_rhythm']],
    [11, ['learn_name', 'are_they_local', 'their_rhythm', 'why_theyre_here']],
  ] as const)('with %i replies opens exactly %j', (replies, expected) => {
    const result = deriveOpenIntentions(input(engaged(replies)))
    expect(keysOf(result.open)).toEqual(expected)
  })

  // A ratio tier would open every intention the moment responseRate reaches
  // 100 — which for a guest who replies to everything is the fourth inbound.
  it('does not open every tier at once when the ratio is already at 100', () => {
    const result = deriveOpenIntentions(input({ responseRate: 100, repliedMessageCount: 4 }))
    expect(keysOf(result.open)).toEqual(['learn_name'])
  })

  it('honours a per-venue min_replies override from config', () => {
    const result = deriveOpenIntentions(
      input({
        ...engaged(5),
        rules: { ...INTENTION_RULES_DEFAULT, min_replies: { learn_name: 6 } },
      }),
    )
    expect(keysOf(result.open)).toEqual(['are_they_local'])
  })

  it('honours a per-venue response_rate_floor from config', () => {
    const result = deriveOpenIntentions(
      input({
        responseRate: 30,
        repliedMessageCount: 3,
        rules: { ...INTENTION_RULES_DEFAULT, response_rate_floor: 25 },
      }),
    )
    expect(keysOf(result.open)).toEqual(['learn_name'])
  })

  it('anchors a first-contact intention to the turn its gate was first seen open', () => {
    const result = deriveOpenIntentions(input(engaged(3)))
    expect(result.newlyEligible).toEqual([{ key: 'learn_name', eligibleAt: NOW, rearm: false }])
  })
})

describe('deriveOpenIntentions — eligibility-anchored expiry (ruling 5)', () => {
  it('keeps a first-contact intention open for its window from ELIGIBILITY, not guest creation', () => {
    const result = deriveOpenIntentions(
      input({
        guest: { createdVia: 'inbound_message', createdAt: daysAgo(60) },
        rows: {
          prompted: [],
          eligible: [{ intentionKey: 'learn_name', eligibleAt: daysAgo(FIRST_CONTACT_WINDOW_DAYS - 1) }],
        },
      }),
    )
    expect(keysOf(result.open)).toContain('learn_name')
  })

  it('expires it once the window has run from eligibility', () => {
    const result = deriveOpenIntentions(
      input({
        rows: {
          prompted: [],
          eligible: [{ intentionKey: 'learn_name', eligibleAt: daysAgo(FIRST_CONTACT_WINDOW_DAYS + 1) }],
        },
      }),
    )
    expect(keysOf(result.open)).not.toContain('learn_name')
  })

  // Sticky: once eligibility is recorded the gate is not re-checked. A dropping
  // rate is the brake's job, not this one's.
  it('keeps an already-eligible intention open after its gate closes', () => {
    const result = deriveOpenIntentions(
      input({
        responseRate: 0,
        repliedMessageCount: 0,
        rows: { prompted: [], eligible: [{ intentionKey: 'are_they_local', eligibleAt: daysAgo(2) }] },
      }),
    )
    expect(keysOf(result.open)).toEqual(['are_they_local'])
  })

  it('does not re-write an eligibility row that already exists', () => {
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        rows: { prompted: [], eligible: [{ intentionKey: 'learn_name', eligibleAt: daysAgo(1) }] },
      }),
    )
    expect(result.newlyEligible).toEqual([])
  })
})

describe('deriveOpenIntentions — satisfaction proxies', () => {
  it('closes learn_name when a first name is already on record, and does not record it eligible', () => {
    const result = deriveOpenIntentions(
      input({ ...engaged(5), facts: { ...NO_FACTS, hasFirstName: true } }),
    )
    expect(keysOf(result.open)).toEqual(['are_they_local'])
    expect(result.newlyEligible.map((e) => e.key)).not.toContain('learn_name')
  })

  it('closes are_they_local when a home base is already on record', () => {
    const result = deriveOpenIntentions(
      input({ ...engaged(5), facts: { ...NO_FACTS, hasHomeBase: true } }),
    )
    expect(keysOf(result.open)).toEqual(['learn_name'])
  })

  it('closes understand_order once any transaction exists', () => {
    const result = deriveOpenIntentions(
      input({
        guest: { createdVia: 'qr_scan', createdAt: hoursAgo(1) },
        facts: { ...NO_FACTS, hasQualifyingTransaction: true },
      }),
    )
    expect(keysOf(result.open)).not.toContain('understand_order')
  })
})

describe('deriveOpenIntentions — priority', () => {
  it('returns open intentions in priority order, event-armed right after understand_order', () => {
    const result = deriveOpenIntentions(
      input({
        ...engaged(11),
        guest: { createdVia: 'qr_scan', createdAt: hoursAgo(1) },
        openRecommendationTimes: [hoursAgo(50)],
        recordedOrderTimes: [hoursAgo(50)],
        facts: { ...NO_FACTS, hasQualifyingTransaction: true },
      }),
    )
    expect(keysOf(result.open)).toEqual([
      'got_the_recommendation',
      'did_they_like_it',
      'learn_name',
      'are_they_local',
      'their_rhythm',
      'why_theyre_here',
    ])
  })
})

describe('deriveOpenIntentions — brake', () => {
  it('suppresses every open intention when the brake is engaged, but still records eligibility', () => {
    const result = deriveOpenIntentions(
      input({
        ...engaged(3),
        rows: {
          prompted: [
            promptedRow('are_they_local', hoursAgo(200), { messageId: 'm1' }),
            promptedRow('their_rhythm', hoursAgo(149), { messageId: 'm2' }),
          ],
          eligible: [],
        },
        inboundTimes: [hoursAgo(150), NOW],
      }),
    )
    expect(result.brakeEngaged).toBe(true)
    expect(result.open).toEqual([])
    expect(result.newlyEligible.map((e) => e.key)).toContain('learn_name')
  })
})

describe('isIntentionBrakeEngaged', () => {
  const brake = (overrides: Partial<Parameters<typeof isIntentionBrakeEngaged>[0]>) =>
    isIntentionBrakeEngaged({
      prompted: [],
      inboundTimes: [NOW],
      conversationWindowMs: WINDOW_48H,
      inboundHistoryFrom: daysAgo(14),
      streak: 2,
      ...overrides,
    })

  // The true positive, proving the brake can fire. The ticket's original
  // definition ("saw no subsequent inbound") is false on every turn it can be
  // evaluated, because intentions only record on replies to inbounds — so under
  // that definition this exact sequence would NOT engage. Both prompts here DID
  // see a later inbound; the guest just came back days afterwards each time.
  it('engages when the guest came back to each of the last two prompts only days later', () => {
    expect(
      brake({
        prompted: [
          promptedRow('are_they_local', hoursAgo(200), { messageId: 'm1' }),
          promptedRow('their_rhythm', hoursAgo(149), { messageId: 'm2' }),
        ],
        inboundTimes: [hoursAgo(150), NOW],
      }),
    ).toBe(true)
  })

  it('does not engage when a reply landed inside the conversation window', () => {
    expect(
      brake({
        prompted: [
          promptedRow('are_they_local', hoursAgo(200), { messageId: 'm1' }),
          promptedRow('their_rhythm', hoursAgo(149), { messageId: 'm2' }),
        ],
        inboundTimes: [hoursAgo(199), hoursAgo(150), NOW],
      }),
    ).toBe(false)
  })

  it('does not engage when the most recent prompt was answered', () => {
    expect(
      brake({
        prompted: [
          promptedRow('are_they_local', hoursAgo(200), { messageId: 'm1' }),
          promptedRow('their_rhythm', hoursAgo(1), { messageId: 'm2' }),
        ],
        inboundTimes: [NOW],
      }),
    ).toBe(false)
  })

  it('never engages with fewer prompts than the streak', () => {
    expect(brake({ prompted: [promptedRow('learn_name', hoursAgo(200))] })).toBe(false)
  })

  // One send can raise two intentions. Counting rows would let a single ignored
  // message fill a streak of two.
  it('counts two intentions raised by ONE message as one prompt', () => {
    expect(
      brake({
        prompted: [
          promptedRow('learn_name', hoursAgo(200), { messageId: 'm1' }),
          promptedRow('are_they_local', hoursAgo(200), { messageId: 'm1' }),
        ],
      }),
    ).toBe(false)
  })

  // A pessimistic closure may not have asked anything, so it can't have gone
  // unanswered.
  it('does not count pessimistic closures as prompts', () => {
    expect(
      brake({
        prompted: [
          promptedRow('are_they_local', hoursAgo(200), { messageId: 'm1' }),
          promptedRow('their_rhythm', hoursAgo(149), { messageId: 'm2', promptSource: 'pessimistic' }),
        ],
        inboundTimes: [hoursAgo(150), NOW],
      }),
    ).toBe(false)
  })

  it('counts rows with a null prompt_source (written before the migration 040 backfill)', () => {
    expect(
      brake({
        prompted: [
          promptedRow('are_they_local', hoursAgo(200), { messageId: 'm1', promptSource: null }),
          promptedRow('their_rhythm', hoursAgo(149), { messageId: 'm2', promptSource: null }),
        ],
        inboundTimes: [hoursAgo(150), NOW],
      }),
    ).toBe(true)
  })

  // Visibility. Inbound history loads 14 days, fewer when the message cap bites,
  // so an answer to an older prompt can't be seen. Counting that prompt as
  // unanswered would brake a guest who replied to everything, and the brake
  // never lifts on its own: nothing renders, so no newer prompt is recorded.
  // Found in self-review, not by a test; ruling 1 put under-braking on the
  // right side, so an unjudgeable prompt is left out.
  it('ignores prompts older than the visible inbound history', () => {
    expect(
      brake({
        prompted: [
          promptedRow('are_they_local', daysAgo(20), { messageId: 'm1' }),
          promptedRow('their_rhythm', daysAgo(16), { messageId: 'm2' }),
        ],
        inboundTimes: [NOW],
        inboundHistoryFrom: daysAgo(14),
      }),
    ).toBe(false)
  })

  it('still engages on visible prompts when an older one falls outside the history', () => {
    expect(
      brake({
        prompted: [
          promptedRow('learn_name', daysAgo(20), { messageId: 'm0' }),
          promptedRow('are_they_local', hoursAgo(200), { messageId: 'm1' }),
          promptedRow('their_rhythm', hoursAgo(149), { messageId: 'm2' }),
        ],
        inboundTimes: [hoursAgo(150), NOW],
        inboundHistoryFrom: daysAgo(14),
      }),
    ).toBe(true)
  })

  it('does not treat an inbound from before the prompt as its answer', () => {
    expect(
      brake({
        streak: 1,
        prompted: [promptedRow('learn_name', hoursAgo(10))],
        inboundTimes: [hoursAgo(11)],
      }),
    ).toBe(true)
  })
})

describe('resolveIntentionKey', () => {
  it('maps a live key to itself', () => {
    expect(resolveIntentionKey('understand_order')).toBe('understand_order')
    expect(resolveIntentionKey('why_theyre_here')).toBe('why_theyre_here')
  })

  it('maps the renamed learn_first_order to understand_order', () => {
    expect(resolveIntentionKey('learn_first_order')).toBe('understand_order')
  })

  it('resolves a retired key to nothing', () => {
    expect(resolveIntentionKey('invite_contact_save')).toBeNull()
    expect(resolveIntentionKey('')).toBeNull()
  })
})

// TAC-380: where the brake's view of inbound history starts.
// build-runtime-context.test.ts pins that the context build calls this.
describe('resolveInboundHistoryFrom', () => {
  const CUTOFF = daysAgo(14)
  const base = { responseCap: 30, rowCap: 90, historyCutoff: CUTOFF }
  const responses = (...hoursAgoList: number[]) => hoursAgoList.map((h) => ({ createdAt: hoursAgo(h) }))

  it('starts at the history cutoff when neither cap bit', () => {
    expect(
      resolveInboundHistoryFrom({ ...base, recentMessages: responses(100, 50, 1), rowsFetched: 3 }),
    ).toEqual(CUTOFF)
  })

  it('starts at the cutoff one response below the response cap', () => {
    const recentMessages = Array.from({ length: 29 }, (_, i) => ({ createdAt: hoursAgo(29 - i) }))
    expect(resolveInboundHistoryFrom({ ...base, recentMessages, rowsFetched: 29 })).toEqual(CUTOFF)
  })

  // At the cap the window may be truncated, so visibility starts at the oldest
  // response loaded. Exactly 30 that happen to be the whole window read as
  // capped too; that only excludes more prompts (under-braking).
  it('starts at the oldest loaded response when the response cap bit', () => {
    const recentMessages = Array.from({ length: 30 }, (_, i) => ({ createdAt: hoursAgo(60 - i) }))
    expect(resolveInboundHistoryFrom({ ...base, recentMessages, rowsFetched: 30 })).toEqual(
      hoursAgo(60),
    )
  })

  it('starts at the oldest loaded response when the row cap bit first', () => {
    expect(
      resolveInboundHistoryFrom({ ...base, recentMessages: responses(40, 20, 2), rowsFetched: 90 }),
    ).toEqual(hoursAgo(40))
  })

  it('picks the oldest response whatever order it is handed, never the newest', () => {
    expect(
      resolveInboundHistoryFrom({ ...base, recentMessages: responses(2, 40, 20), rowsFetched: 90 }),
    ).toEqual(hoursAgo(40))
  })

  it('never starts earlier than the history cutoff', () => {
    expect(
      resolveInboundHistoryFrom({
        ...base,
        recentMessages: [{ createdAt: daysAgo(20) }],
        rowsFetched: 90,
      }),
    ).toEqual(CUTOFF)
  })

  it('falls back to the cutoff when capped with nothing loaded', () => {
    expect(resolveInboundHistoryFrom({ ...base, recentMessages: [], rowsFetched: 90 })).toEqual(CUTOFF)
  })
})

describe('deriveIntentionState (shared core)', () => {
  const entries = (pairs: [IntentionKey, IntentionStateEntry][]) => new Map(pairs)

  it('is open when eligible, unprompted, unexpired and unsatisfied', () => {
    const open = deriveIntentionState({
      entries: entries([['learn_name', { eligibleAt: daysAgo(1), promptedAt: null }]]),
      facts: NO_FACTS,
      now: NOW,
    })
    expect(open).toEqual([
      { key: 'learn_name', promptLine: "You don't know this guest's name yet.", eligibleAt: daysAgo(1) },
    ])
  })

  it('is closed once prompted', () => {
    const open = deriveIntentionState({
      entries: entries([['learn_name', { eligibleAt: daysAgo(1), promptedAt: hoursAgo(2) }]]),
      facts: NO_FACTS,
      now: NOW,
    })
    expect(open).toEqual([])
  })

  // Re-arming keeps the last prompt on the row and moves eligible_at past it.
  it('reopens an event-armed intention whose last prompt predates its anchor', () => {
    const open = deriveIntentionState({
      entries: entries([['got_the_recommendation', { eligibleAt: hoursAgo(2), promptedAt: daysAgo(9) }]]),
      facts: NO_FACTS,
      now: NOW,
    })
    expect(keysOf(open)).toEqual(['got_the_recommendation'])
  })

  it('keeps an event-armed intention closed once prompted at or after its anchor', () => {
    const open = deriveIntentionState({
      entries: entries([['got_the_recommendation', { eligibleAt: hoursAgo(2), promptedAt: hoursAgo(1) }]]),
      facts: NO_FACTS,
      now: NOW,
    })
    expect(open).toEqual([])
  })

  // First-contact intentions never re-arm, so nothing may reopen one.
  it('never reopens a first-contact intention, whatever its anchor', () => {
    const open = deriveIntentionState({
      entries: entries([['learn_name', { eligibleAt: hoursAgo(2), promptedAt: daysAgo(9) }]]),
      facts: NO_FACTS,
      now: NOW,
    })
    expect(open).toEqual([])
  })

  it('returns priority order regardless of entry order', () => {
    const open = deriveIntentionState({
      entries: entries([
        ['why_theyre_here', { eligibleAt: daysAgo(1), promptedAt: null }],
        ['learn_name', { eligibleAt: daysAgo(1), promptedAt: null }],
      ]),
      facts: NO_FACTS,
      now: NOW,
    })
    expect(keysOf(open)).toEqual(['learn_name', 'why_theyre_here'])
  })
})

const ORDER_LINE = "You haven't heard what this guest ordered yet."
const NAME_LINE = "You don't know this guest's name yet."
const bothOpen: OpenIntention[] = [
  { key: 'understand_order', promptLine: ORDER_LINE, eligibleAt: hoursAgo(1) },
  { key: 'learn_name', promptLine: NAME_LINE, eligibleAt: hoursAgo(1) },
]

describe('applyCurrentTurnSuppression', () => {
  const menuItems = [{ name: 'Gibraltar / Cortado' }, { name: 'Almond Croissant' }]

  it('passes the set through unchanged when there is no current inbound', () => {
    expect(applyCurrentTurnSuppression(bothOpen, null, menuItems)).toEqual(bothOpen)
  })

  it('passes the set through unchanged when the inbound mentions no menu item', () => {
    expect(applyCurrentTurnSuppression(bothOpen, 'is there parking nearby?', menuItems)).toEqual(bothOpen)
  })

  it('drops understand_order when the inbound names a menu item', () => {
    const result = applyCurrentTurnSuppression(bothOpen, 'i got an oat cortado', menuItems)
    expect(keysOf(result)).toEqual(['learn_name'])
  })

  it('does not mutate the input array', () => {
    const copy = [...bothOpen]
    applyCurrentTurnSuppression(bothOpen, 'i got an oat cortado', menuItems)
    expect(bothOpen).toEqual(copy)
  })
})

// TAC-380 trap 4. Once ruling 4 closes intentions pessimistically on a
// classifier failure, the recording path must only ever receive what was
// actually rendered — or a failure on an opt_out turn would close intentions
// the guest never saw.
describe('renderableIntentions (trap 4)', () => {
  it('renders nothing on an opt_out turn', () => {
    expect(renderableIntentions(bothOpen, 'opt_out', false)).toEqual([])
  })

  // Ruling 6: an outstanding knowledge-gap question suppresses intentions. It
  // burns a turn; it doesn't lose the intention.
  it('renders nothing while a question is still owed to the guest', () => {
    expect(renderableIntentions(bothOpen, 'reply', true)).toEqual([])
  })

  it('passes the set through on an ordinary turn', () => {
    expect(renderableIntentions(bothOpen, 'reply', false)).toEqual(bothOpen)
  })

  it('passes the set through when no classification exists yet', () => {
    expect(renderableIntentions(bothOpen, null, false)).toEqual(bothOpen)
  })

  it('does not mutate the input array', () => {
    const copy = [...bothOpen]
    renderableIntentions(bothOpen, 'opt_out', false)
    expect(bothOpen).toEqual(copy)
  })
})

// TAC-326: regression corpus through the real, unmocked bodyMentionsMenuItem.
describe('applyCurrentTurnSuppression — real-word-collision regression corpus (TAC-326)', () => {
  it('"Hi Sana!" against a menu containing San Pellegrino does not suppress understand_order (the production symptom)', () => {
    const result = applyCurrentTurnSuppression(bothOpen, 'Hi Sana!', [{ name: 'San Pellegrino' }])
    expect(keysOf(result)).toContain('understand_order')
  })

  it('"nice, thanks" against a menu containing Hibiscus Ice Tea does not suppress understand_order', () => {
    const result = applyCurrentTurnSuppression(bothOpen, 'nice, thanks', [{ name: 'Hibiscus Ice Tea' }])
    expect(keysOf(result)).toContain('understand_order')
  })

  // Known, deferred gap — see TAC-326. "san" is a correctly boundaried word in
  // "San Francisco", so this is a granularity problem, not a matching bug. The
  // tempting fixes each break a deliberately shipped single-word match; don't
  // make this pass without re-opening that discussion. Asserts CURRENT
  // behaviour so an accidental change gets noticed.
  it('a "San Francisco" mention against a menu containing San Pellegrino still suppresses understand_order today (known, deferred gap)', () => {
    const result = applyCurrentTurnSuppression(bothOpen, 'anyone been to San Francisco', [
      { name: 'San Pellegrino' },
    ])
    expect(keysOf(result)).not.toContain('understand_order')
  })
})
