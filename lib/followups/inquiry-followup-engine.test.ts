// TAC-386. The gate table, one branch forced at a time.
//
// The distinction every test here turns on is PERMANENT versus TRANSIENT. A gate
// meaning "this should never send" must RESOLVE the row, and a gate meaning "not
// yet" must leave it `pending`. Getting those the wrong way round is how a
// one-shot mechanism either loops or silently stops, and neither shows up as a
// failure anywhere else, so each test asserts which of the two happened rather
// than only that nothing was sent.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  loadInquiryFollowupVenues: vi.fn(),
  loadDueInquiryFollowups: vi.fn(),
  loadInquiryGuestFacts: vi.fn(),
  hasInboundSince: vi.fn(),
  loadOurAnswer: vi.fn(),
  loadIntentionRulesRaw: vi.fn(),
  loadRecentInboundTimes: vi.fn(),
  claimInquiryFollowup: vi.fn(),
  recordInquiryDispatch: vi.fn(),
  recordProactiveSend: vi.fn(),
  releaseInquiryFollowupClaim: vi.fn(),
  resolveInquiryFollowup: vi.fn(),
  isInquiryFollowupMessage: vi.fn(),
  INQUIRY_FOLLOWUP_HORIZON_MS: 24 * 60 * 60 * 1000,
  INQUIRY_FOLLOWUP_SCAN_LIMIT: 50,
}))
vi.mock('./inquiry-followup-store', () => store)

const log = vi.hoisted(() => ({
  claimFollowupLogRows: vi.fn(),
  finalizeFollowupLogClaim: vi.fn(),
  releaseFollowupLogClaim: vi.fn(),
  loadFollowupSnapshotsForVenue: vi.fn(),
}))
vi.mock('./log', () => log)

const agent = vi.hoisted(() => ({
  handleFollowupMock: vi.fn(),
  loadPendingRowsBySlotMock: vi.fn(),
  loadLastGuestActionAtMock: vi.fn(),
  loadIntentionRowsMock: vi.fn(),
}))
vi.mock('@/lib/agent/handle-followup', () => ({
  handleFollowup: agent.handleFollowupMock,
}))
vi.mock('@/lib/agent/pending-slots', () => ({
  loadPendingRowsBySlot: agent.loadPendingRowsBySlotMock,
}))
vi.mock('@/lib/agent/intentions/load', () => ({
  loadIntentionRows: agent.loadIntentionRowsMock,
}))
vi.mock('@/lib/messaging/instagram/window', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/lib/messaging/instagram/window')>()
  return { ...real, loadLastGuestActionAt: agent.loadLastGuestActionAtMock }
})
vi.mock('@/lib/db/admin', () => ({ createAdminClient: () => ({}) }))

// The engine imports the history window from build-runtime-context, which is the
// right place for it to come from (one definition) but which reaches the Voyage
// client at module load, so this file cannot load it. Mocked with the real
// values, and a test at the bottom reads the real module's SOURCE to prove these
// are still them, which is the same trick build-runtime-context.test.ts uses on
// its own query.
const { HISTORY } = vi.hoisted(() => ({
  HISTORY: { days: 14, messages: 30 },
}))
vi.mock('@/lib/agent/build-runtime-context', () => ({
  MAX_HISTORY_DAYS: HISTORY.days,
  MAX_HISTORY_MESSAGES: HISTORY.messages,
}))

import { processDueInquiryFollowups } from './inquiry-followup-engine'

const VENUE = '11111111-1111-4111-8111-111111111111'
const GUEST = '22222222-2222-4222-8222-222222222222'
const ROW = '44444444-4444-4444-8444-444444444444'
const SOURCE = '33333333-3333-4333-8333-333333333333'

/** Tue 2026-09-29 10:00 PDT: inside Le Mil's hours, outside quiet hours. */
const NOW = new Date('2026-09-29T17:00:00.000Z')
/** Mon 2026-09-28 20:00 PDT, so the window shuts Tue 20:00 PDT. */
const ASKED_AT = new Date('2026-09-29T03:00:00.000Z')

const HOURS = {
  monday: '7:00 AM – 3:00 PM',
  tuesday: '7:00 AM – 3:00 PM',
  wednesday: '7:00 AM – 3:00 PM',
  thursday: '7:00 AM – 3:00 PM',
  friday: '7:00 AM – 3:00 PM',
  saturday: '7:00 AM – 3:00 PM',
  sunday: '7:00 AM – 3:00 PM',
}

function venue(over: Record<string, unknown> = {}) {
  return {
    id: VENUE,
    timezone: 'America/Los_Angeles',
    status: 'pending',
    instagramAccountId: 'ig-account',
    followupRules: null,
    venueInfo: { hours: HOURS },
    ...over,
  }
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: ROW,
    venueId: VENUE,
    guestId: GUEST,
    sourceMessageId: SOURCE,
    question: 'where do I park around there',
    askedAt: ASKED_AT,
    windowClosesAt: new Date(ASKED_AT.getTime() + 24 * 60 * 60 * 1000),
    dueAt: new Date('2026-09-29T17:00:00.000Z'),
    ...over,
  }
}

function facts(over: Record<string, unknown> = {}) {
  return {
    optedOutAt: null,
    instagramScopedId: 'igsid',
    lastProactiveSendAt: null,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  store.loadInquiryFollowupVenues.mockResolvedValue({
    ok: true,
    data: [venue()],
  })
  store.loadDueInquiryFollowups.mockResolvedValue({ ok: true, data: [row()] })
  store.loadInquiryGuestFacts.mockResolvedValue({ ok: true, data: facts() })
  store.hasInboundSince.mockResolvedValue({ ok: true, data: false })
  store.loadOurAnswer.mockResolvedValue({
    ok: true,
    data: { messageId: 'm-answer', body: 'Street parking on Polk is fine.' },
  })
  store.loadIntentionRulesRaw.mockResolvedValue({ ok: true, data: null })
  store.loadRecentInboundTimes.mockResolvedValue({ ok: true, data: [] })
  store.claimInquiryFollowup.mockResolvedValue({ status: 'claimed' })
  store.recordInquiryDispatch.mockResolvedValue({ ok: true, data: null })
  store.recordProactiveSend.mockResolvedValue({ ok: true, data: null })
  store.releaseInquiryFollowupClaim.mockResolvedValue({ status: 'released' })
  store.resolveInquiryFollowup.mockResolvedValue({ ok: true, data: null })

  log.claimFollowupLogRows.mockResolvedValue({
    ok: true,
    claimed: [{ id: 'log-1', reason: 'inquiry_followup', dedupKey: 'k' }],
  })
  log.finalizeFollowupLogClaim.mockResolvedValue({
    ok: true,
    data: { updatedCount: 1 },
  })
  log.releaseFollowupLogClaim.mockResolvedValue({
    ok: true,
    data: { deletedCount: 1 },
  })
  log.loadFollowupSnapshotsForVenue.mockResolvedValue({
    ok: true,
    data: new Map([[GUEST, { weeklyCount: 0, lastByReason: {} }]]),
  })

  // Window open: the guest acted an hour before `now`.
  agent.loadLastGuestActionAtMock.mockResolvedValue({
    ok: true,
    value: ASKED_AT,
  })
  agent.loadPendingRowsBySlotMock.mockResolvedValue({
    obligation: null,
    conversation: [],
  })
  agent.loadIntentionRowsMock.mockResolvedValue({ prompted: [], eligible: [] })
  agent.handleFollowupMock.mockResolvedValue({
    status: 'sent',
    outboundMessageId: 'out-1',
  })
})

/** Did the row get resolved (permanent) or left alone (transient)? */
const resolvedWith = () =>
  store.resolveInquiryFollowup.mock.calls.map((c) => [c[2], c[3]])

describe('processDueInquiryFollowups — the happy path', () => {
  it('sends, and hands the trigger the question AND our answer', async () => {
    const r = await processDueInquiryFollowups(NOW)
    expect(r).toMatchObject({ scanned: 1, sent: 1, errored: 0 })
    expect(agent.handleFollowupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: VENUE,
        guestId: GUEST,
        trigger: expect.objectContaining({
          reason: 'inquiry_followup',
          inquiryFollowup: {
            question: 'where do I park around there',
            answer: 'Street parking on Polk is fine.',
            answerMessageId: 'm-answer',
          },
        }),
      }),
    )
  })

  it('claims before generating, never after', async () => {
    const order: string[] = []
    store.claimInquiryFollowup.mockImplementation(async () => {
      order.push('claim')
      return { status: 'claimed' }
    })
    agent.handleFollowupMock.mockImplementation(async () => {
      order.push('generate')
      return { status: 'sent', outboundMessageId: 'out-1' }
    })
    await processDueInquiryFollowups(NOW)
    expect(order).toEqual(['claim', 'generate'])
  })

  it('records the dispatched message and finalizes the audit row', async () => {
    await processDueInquiryFollowups(NOW)
    expect(store.recordInquiryDispatch).toHaveBeenCalledWith({}, ROW, 'out-1')
    expect(log.finalizeFollowupLogClaim).toHaveBeenCalledWith(
      ['log-1'],
      'out-1',
    )
  })

  it('writes the audit row keyed on the question, so it is once per question', async () => {
    await processDueInquiryFollowups(NOW)
    expect(log.claimFollowupLogRows).toHaveBeenCalledWith([
      {
        venueId: VENUE,
        guestId: GUEST,
        reason: 'inquiry_followup',
        dedupKey: `inquiry_followup:${SOURCE}`,
      },
    ])
  })

  it('writes the proactive spacing marker on a confirmed send', async () => {
    await processDueInquiryFollowups(NOW)
    expect(store.recordProactiveSend).toHaveBeenCalledWith({}, GUEST, NOW)
  })

  it('writes NO spacing marker when the send was only queued', async () => {
    agent.handleFollowupMock.mockResolvedValue({
      status: 'queued',
      outboundMessageId: 'out-1',
    })
    await processDueInquiryFollowups(NOW)
    expect(store.recordProactiveSend).not.toHaveBeenCalled()
  })
})

describe('processDueInquiryFollowups — venue-wide gates', () => {
  it('skips a halted venue as a deny-list, not an allow-list on active', async () => {
    // The live pilot venue is `pending`, so an allow-list on 'active' would
    // switch the whole mechanism off there (docs/decisions/0002).
    store.loadInquiryFollowupVenues.mockResolvedValue({
      ok: true,
      data: [venue({ status: 'paused' })],
    })
    const r = await processDueInquiryFollowups(NOW)
    expect(r.scanned).toBe(0)
    expect(store.loadDueInquiryFollowups).not.toHaveBeenCalled()
  })

  it('runs at a `pending` venue', async () => {
    const r = await processDueInquiryFollowups(NOW)
    expect(r.sent).toBe(1)
  })

  it('skips a venue with no Instagram account', async () => {
    store.loadInquiryFollowupVenues.mockResolvedValue({
      ok: true,
      data: [venue({ instagramAccountId: null })],
    })
    const r = await processDueInquiryFollowups(NOW)
    expect(r.scanned).toBe(0)
  })

  it('skips the venue during quiet hours', async () => {
    // 2026-09-29T09:00Z is 02:00 PDT, inside the default 21:00-08:00 window.
    const r = await processDueInquiryFollowups(
      new Date('2026-09-29T09:00:00.000Z'),
    )
    expect(r.scanned).toBe(0)
  })

  it('honours the per-venue kill switch', async () => {
    store.loadInquiryFollowupVenues.mockResolvedValue({
      ok: true,
      data: [venue({ followupRules: { inquiry_followup_enabled: false } })],
    })
    const r = await processDueInquiryFollowups(NOW)
    expect(r.scanned).toBe(0)
  })
})

describe('processDueInquiryFollowups — permanent refusals resolve the row', () => {
  it('resolves when Metas window has shut', async () => {
    agent.loadLastGuestActionAtMock.mockResolvedValue({
      ok: true,
      value: new Date(NOW.getTime() - 25 * 60 * 60 * 1000),
    })
    const r = await processDueInquiryFollowups(NOW)
    expect(r.sent).toBe(0)
    expect(r.skipped.window_closed).toBe(1)
    expect(resolvedWith()).toEqual([['expired', 'window_closed']])
    expect(store.claimInquiryFollowup).not.toHaveBeenCalled()
  })

  it('resolves an opted-out guest', async () => {
    store.loadInquiryGuestFacts.mockResolvedValue({
      ok: true,
      data: facts({ optedOutAt: new Date('2026-09-01T00:00:00.000Z') }),
    })
    await processDueInquiryFollowups(NOW)
    expect(resolvedWith()).toEqual([['skipped', 'opted_out']])
  })

  it('resolves when the guest wrote again since the question (ruling 5b)', async () => {
    store.hasInboundSince.mockResolvedValue({ ok: true, data: true })
    await processDueInquiryFollowups(NOW)
    expect(resolvedWith()).toEqual([['skipped', 'guest_wrote_again']])
  })

  it('compares against the QUESTION, not against now or due_at', async () => {
    // Ruling 5(b)'s own wording. Comparing against `now` would skip a guest who
    // wrote before the question and never skip one who wrote after it.
    await processDueInquiryFollowups(NOW)
    expect(store.hasInboundSince).toHaveBeenCalledWith(
      {},
      VENUE,
      GUEST,
      ASKED_AT,
      // And the question's own row is excluded: on our clock it is NEWER than
      // asked_at, so without this the gate matched it and nothing could send.
      SOURCE,
    )
  })

  it('resolves when our answer never reached the guest', async () => {
    store.loadOurAnswer.mockResolvedValue({ ok: true, data: null })
    await processDueInquiryFollowups(NOW)
    expect(resolvedWith()).toEqual([['skipped', 'no_answer_sent']])
  })

  it('resolves when the weekly cap is spent (the cap BLOCKS)', async () => {
    // Ruled 2026-09-30, superseding ruling 6(b) for this reason: a regular who
    // asks something every visit does not get a check-in every visit.
    log.loadFollowupSnapshotsForVenue.mockResolvedValue({
      ok: true,
      data: new Map([[GUEST, { weeklyCount: 1, lastByReason: {} }]]),
    })
    const r = await processDueInquiryFollowups(NOW)
    expect(r.sent).toBe(0)
    expect(resolvedWith()).toEqual([['skipped', 'weekly_cap']])
  })

  it('sends when the venue raised its cap above the count', async () => {
    store.loadInquiryFollowupVenues.mockResolvedValue({
      ok: true,
      data: [venue({ followupRules: { weekly_cap: 2 } })],
    })
    log.loadFollowupSnapshotsForVenue.mockResolvedValue({
      ok: true,
      data: new Map([[GUEST, { weeklyCount: 1, lastByReason: {} }]]),
    })
    const r = await processDueInquiryFollowups(NOW)
    expect(r.sent).toBe(1)
  })

  it('resolves when the unanswered-prompt brake is engaged (ruling 10b)', async () => {
    agent.loadIntentionRowsMock.mockResolvedValue({
      prompted: [
        {
          promptedAt: new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000),
          messageId: 'p1',
          promptSource: 'rendered',
          intentionKey: 'learn_name',
        },
        {
          promptedAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000),
          messageId: 'p2',
          promptSource: 'rendered',
          intentionKey: 'learn_name',
        },
      ],
      eligible: [],
    })
    store.loadRecentInboundTimes.mockResolvedValue({ ok: true, data: [] })
    const r = await processDueInquiryFollowups(NOW)
    expect(r.sent).toBe(0)
    expect(resolvedWith()).toEqual([['skipped', 'brake_engaged']])
  })

  it('never records a prompt of its own, so it cannot feed the brake', async () => {
    // Ruling 10(b): respects the brake's state, is never counted toward it.
    //
    // ASSERTED ON THE SOURCE, not on a mock's arguments. The first version of
    // this test stringified `loadIntentionRows`'s calls (two UUIDs) and checked
    // they did not contain "insert" - a string that could never appear either
    // way, so the assertion held whatever the engine did. Found in review.
    //
    // The property is that this module imports no WRITER from the intentions
    // system, which is what makes "the send is not counted" structural rather
    // than a habit. Same technique as the history-window guard below.
    const source = readFileSync(
      join(__dirname, 'inquiry-followup-engine.ts'),
      'utf8',
    )
    const intentionImports = source.match(
      /from '@\/lib\/agent\/intentions[^']*'/g,
    )
    // Guards the guard: it imports the brake and the loader, so a regex that
    // matched nothing would make the assertion below vacuous in a new way.
    expect(intentionImports?.length).toBe(2)
    for (const writer of [
      'recordIntentionPrompt',
      'recordIntentionEligibility',
      // The write shape, not the bare table name: the module's own header says
      // it writes no `guest_intention_prompts` row, so the name appears in
      // prose and banning it outright fails on the comment that documents it.
      ".from('guest_intention_prompts')",
    ]) {
      expect(source, writer).not.toContain(writer)
    }
  })

  it('resolves a guest with no Instagram identifier', async () => {
    store.loadInquiryGuestFacts.mockResolvedValue({
      ok: true,
      data: facts({ instagramScopedId: null }),
    })
    await processDueInquiryFollowups(NOW)
    expect(resolvedWith()).toEqual([['skipped', 'not_instagram']])
  })
})

describe('processDueInquiryFollowups — transient holds leave the row pending', () => {
  it('holds when the venue is closed now, and does NOT resolve', async () => {
    store.loadDueInquiryFollowups.mockResolvedValue({
      ok: true,
      data: [row({ dueAt: new Date('2026-09-29T23:00:00.000Z') })],
    })
    // 16:00 PDT: past the 15:00 close, still inside the window.
    const at = new Date('2026-09-29T23:00:00.000Z')
    agent.loadLastGuestActionAtMock.mockResolvedValue({ ok: true, value: at })
    const r = await processDueInquiryFollowups(at)
    expect(r.skipped.venue_closed_now).toBe(1)
    expect(store.resolveInquiryFollowup).not.toHaveBeenCalled()
    expect(store.claimInquiryFollowup).not.toHaveBeenCalled()
  })

  it('holds when a proactive message reached them within the hour', async () => {
    store.loadInquiryGuestFacts.mockResolvedValue({
      ok: true,
      data: facts({
        lastProactiveSendAt: new Date(NOW.getTime() - 30 * 60 * 1000),
      }),
    })
    const r = await processDueInquiryFollowups(NOW)
    expect(r.skipped.too_soon_after_proactive).toBe(1)
    expect(store.resolveInquiryFollowup).not.toHaveBeenCalled()
  })

  it('holds when an operator has a card for this guest', async () => {
    agent.loadPendingRowsBySlotMock.mockResolvedValue({
      obligation: null,
      conversation: [{ id: 'card-1' }],
    })
    const r = await processDueInquiryFollowups(NOW)
    expect(r.skipped.card_pending).toBe(1)
    expect(store.resolveInquiryFollowup).not.toHaveBeenCalled()
  })

  it('holds when another tick already claimed the row', async () => {
    store.claimInquiryFollowup.mockResolvedValue({ status: 'lost' })
    const r = await processDueInquiryFollowups(NOW)
    expect(r.skipped.claim_lost).toBe(1)
    expect(agent.handleFollowupMock).not.toHaveBeenCalled()
  })

  it('gives up once the row is past its horizon rather than holding for ever', async () => {
    // The backstop for a venue whose hours became unreadable: without it the row
    // would hold the guest's one pending slot indefinitely.
    store.loadDueInquiryFollowups.mockResolvedValue({
      ok: true,
      data: [row({ dueAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000) })],
    })
    store.loadInquiryFollowupVenues.mockResolvedValue({
      ok: true,
      data: [venue({ venueInfo: { hours: {} } })],
    })
    const r = await processDueInquiryFollowups(NOW)
    expect(r.skipped.past_horizon).toBe(1)
    expect(resolvedWith()).toEqual([['expired', 'past_horizon']])
  })
})

describe('processDueInquiryFollowups — a send that never reached the guest', () => {
  it('releases the claim so a later tick can try again', async () => {
    agent.handleFollowupMock.mockResolvedValue({
      status: 'refused',
      reason: 'below_floor',
    })
    const r = await processDueInquiryFollowups(NOW)
    expect(r.sent).toBe(0)
    expect(store.releaseInquiryFollowupClaim).toHaveBeenCalledWith({}, ROW)
    expect(log.releaseFollowupLogClaim).toHaveBeenCalledWith(['log-1'])
    expect(r.skipped.generation_did_not_send).toBe(1)
  })

  it('KEEPS the claim on a queued card, because approving it would send', async () => {
    // The asymmetry the total map exists for. Releasing here opens a double
    // send: the operator approves the card, nothing writes the marker, and the
    // next tick finds the row pending again.
    agent.handleFollowupMock.mockResolvedValue({
      status: 'queued',
      outboundMessageId: 'out-1',
    })
    await processDueInquiryFollowups(NOW)
    expect(store.releaseInquiryFollowupClaim).not.toHaveBeenCalled()
  })

  it('marks the row superseded when a newer question took the pending slot', async () => {
    // The claim freed the slot, so a question asked in the meantime may already
    // occupy it and the release violates the partial unique index. That is the
    // correct outcome, not an error to swallow.
    agent.handleFollowupMock.mockResolvedValue({ status: 'refused' })
    store.releaseInquiryFollowupClaim.mockResolvedValue({
      status: 'superseded',
    })
    const r = await processDueInquiryFollowups(NOW)
    expect(r.skipped.superseded).toBe(1)
    expect(resolvedWith()).toEqual([['skipped', 'superseded']])
  })
})

describe('processDueInquiryFollowups — unreadable state never spends the row', () => {
  it('holds when the window read itself failed', async () => {
    // A failed read has NOT shown the window is shut, and treating it as shut
    // would spend the row on nothing.
    agent.loadLastGuestActionAtMock.mockResolvedValue({
      ok: false,
      error: 'boom',
    })
    const r = await processDueInquiryFollowups(NOW)
    expect(r.skipped.guest_unreadable).toBe(1)
    expect(store.resolveInquiryFollowup).not.toHaveBeenCalled()
  })

  it('holds when the guest row could not be read', async () => {
    store.loadInquiryGuestFacts.mockResolvedValue({ ok: false, error: 'boom' })
    const r = await processDueInquiryFollowups(NOW)
    expect(r.skipped.guest_unreadable).toBe(1)
    expect(store.resolveInquiryFollowup).not.toHaveBeenCalled()
  })

  it('counts a throw and carries on to the next row', async () => {
    store.loadDueInquiryFollowups.mockResolvedValue({
      ok: true,
      data: [row({ id: 'row-a' }), row({ id: 'row-b' })],
    })
    store.loadInquiryGuestFacts
      .mockRejectedValueOnce(new Error('kaboom'))
      .mockResolvedValue({ ok: true, data: facts() })
    const r = await processDueInquiryFollowups(NOW)
    expect(r.errored).toBe(1)
    expect(r.sent).toBe(1)
  })

  it('reports a venues read failure without throwing', async () => {
    store.loadInquiryFollowupVenues.mockResolvedValue({
      ok: false,
      error: 'boom',
    })
    const r = await processDueInquiryFollowups(NOW)
    expect(r).toMatchObject({ scanned: 0, sent: 0, errored: 1 })
  })
})

// Guards the mock above. Without this the engine could be reading a 14-day
// window while this file asserts against whatever number it invented.
describe('the mocked history window matches the real one', () => {
  it('reads the live constants out of build-runtime-context.ts', () => {
    const source = readFileSync(
      join(__dirname, '..', 'agent', 'build-runtime-context.ts'),
      'utf8',
    )
    const days = source.match(/export const MAX_HISTORY_DAYS = (\d+)/)
    const messages = source.match(/export const MAX_HISTORY_MESSAGES = (\d+)/)
    // Guards the guard: a regex that stopped matching would make both
    // assertions below vacuous.
    expect(days, 'MAX_HISTORY_DAYS should be findable').toBeTruthy()
    expect(messages, 'MAX_HISTORY_MESSAGES should be findable').toBeTruthy()
    expect(Number(days?.[1])).toBe(HISTORY.days)
    expect(Number(messages?.[1])).toBe(HISTORY.messages)
  })
})
