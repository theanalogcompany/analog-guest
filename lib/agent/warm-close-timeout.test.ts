// TAC-560: the processor's decision order, and one test per skip or defer.
//
// The store is mocked here and its FILTERS are asserted separately in
// warm-close-store.test.ts. What this file owns is the ORDER of the checks (every
// "this should never happen" read runs before the claim, so a suppressed close
// does not burn the guest's one close) and the claim / release decision.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/analytics/posthog', () => ({
  captureWarmCloseSent: vi.fn(async () => undefined),
  captureWarmCloseSkipped: vi.fn(async () => undefined),
}))

// vi.hoisted, because vi.mock factories are hoisted above every const in this
// file and would otherwise read these before initialization.
const { handleFollowupMock, loadPendingRowsBySlotMock, store } = vi.hoisted(
  () => ({
    handleFollowupMock: vi.fn(),
    loadPendingRowsBySlotMock: vi.fn(),
    store: {
      loadWarmCloseVenues: vi.fn(),
      loadWarmCloseCandidates: vi.fn(),
      loadWarmCloseGuestFacts: vi.fn(),
      loadLastInboundCategory: vi.fn(),
      claimWarmClose: vi.fn(),
      releaseWarmCloseClaim: vi.fn(),
    },
  }),
)
vi.mock('./handle-followup', () => ({ handleFollowup: handleFollowupMock }))
vi.mock('./pending-slots', () => ({
  loadPendingRowsBySlot: loadPendingRowsBySlotMock,
}))
vi.mock('./warm-close-store', () => store)

// TAC-386: the spacing marker lives on TAC-386's store because that ticket owns
// the column. Mocked here so this file's fake client never has to know it.
// `vi.hoisted` because vi.mock's factory is hoisted above every top-level
// declaration, so a factory closing over a plain `const` throws
// "Cannot access ... before initialization".
const { recordProactiveSendMock } = vi.hoisted(() => ({
  recordProactiveSendMock: vi.fn(async () => ({
    ok: true as const,
    data: null,
  })),
}))
vi.mock('@/lib/followups/inquiry-followup-store', () => ({
  recordProactiveSend: recordProactiveSendMock,
}))

import { processDueWarmCloses } from './warm-close-timeout'

const VENUE = '11111111-1111-4111-8111-111111111111'
const GUEST = '22222222-2222-4222-8222-222222222222'
// 18:15 UTC is 11:15 in Los Angeles: OUTSIDE the default 21:00-08:00 quiet
// window, so the quiet-hours gate does not fire unless a test asks it to. Note
// 07:15 local would be inside it, which is the trap: the window crosses midnight.
const NOW = new Date('2026-09-29T18:15:00.000Z')
/** 15 minutes before NOW: past the 10-minute floor, inside the 2-hour bound. */
const SENT_AT = new Date('2026-09-29T18:00:00.000Z')

// TAC-568: a stand-in for a venue's configured close. NOT Le Mil's live wording:
// these tests assert that whatever the setting holds is what goes out, and
// pinning production copy here would let one pass by agreeing with a literal.
const WARM_CLOSE_TEXT = 'the line is open here, message us anytime \u2615'

function venue(over: Record<string, unknown> = {}) {
  return {
    id: VENUE,
    timezone: 'America/Los_Angeles',
    status: 'pending',
    instagramAccountId: 'ig-account',
    // TAC-568: a venue with no configured close is skipped venue-wide before the
    // candidate scan, so the default fixture carries one. The skip has its own
    // test below.
    followupRules: { warm_close_text: WARM_CLOSE_TEXT },
    ...over,
  }
}

function candidate(over: Record<string, unknown> = {}) {
  return {
    venueId: VENUE,
    guestId: GUEST,
    messageId: 'm-out',
    sentAt: SENT_AT,
    body: 'glad it landed',
    ...over,
  }
}

function facts(over: Record<string, unknown> = {}) {
  return {
    createdVia: 'qr_scan',
    firstContactedAt: new Date('2026-09-29T17:40:00.000Z'),
    warmCloseSentAt: null,
    optedOutAt: null,
    instagramScopedId: 'igsid',
    phoneNumber: null,
    // TAC-386. Present, not omitted: WarmCloseGuestFacts types this `Date |
    // null`, and a fixture that leaves it undefined does not match the
    // interface it stands in for. Omitting it made every happy-path test in this
    // file fail as `errored` rather than as the gate it was testing.
    lastProactiveSendAt: null,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  store.loadWarmCloseVenues.mockResolvedValue({ ok: true, data: [venue()] })
  store.loadWarmCloseCandidates.mockResolvedValue({
    ok: true,
    data: [candidate()],
  })
  store.loadWarmCloseGuestFacts.mockResolvedValue({ ok: true, data: facts() })
  store.loadLastInboundCategory.mockResolvedValue('reply')
  store.claimWarmClose.mockResolvedValue({ status: 'claimed' })
  store.releaseWarmCloseClaim.mockResolvedValue(undefined)
  loadPendingRowsBySlotMock.mockResolvedValue({
    obligation: null,
    conversation: [],
  })
  handleFollowupMock.mockResolvedValue({
    status: 'sent',
    outboundMessageId: 'm-close',
  })
})

describe('processDueWarmCloses: the happy path (TAC-560)', () => {
  it('claims, then closes, in that order', async () => {
    const r = await processDueWarmCloses(NOW)
    expect(r.closed).toBe(1)
    expect(store.claimWarmClose).toHaveBeenCalledWith(
      expect.anything(),
      GUEST,
      NOW,
    )
    expect(handleFollowupMock).toHaveBeenCalledTimes(1)
    // CLAIM BEFORE THE SIDE EFFECT. A process dying between the two loses one
    // close rather than sending two.
    const claimOrder = store.claimWarmClose.mock.invocationCallOrder[0]
    expect(claimOrder).toBeLessThan(
      handleFollowupMock.mock.invocationCallOrder[0],
    )
  })

  it('hands the trigger the outbound row the guest went quiet after', async () => {
    await processDueWarmCloses(NOW)
    expect(handleFollowupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: VENUE,
        guestId: GUEST,
        trigger: expect.objectContaining({
          reason: 'warm_close',
          // Not optional: a reply naming nothing is read by the Instagram reply
          // check as answering everything before it.
          warmClose: { answersMessageId: 'm-out' },
        }),
      }),
    )
  })
})

describe('processDueWarmCloses: every skip and defer (TAC-560)', () => {
  /** Asserts the run skipped for `reason` and never claimed. */
  async function expectSkip(reason: string) {
    const r = await processDueWarmCloses(NOW)
    expect(r.closed).toBe(0)
    expect(
      r.skipped[reason],
      `expected skip ${reason}, got ${JSON.stringify(r.skipped)}`,
    ).toBe(1)
    expect(store.claimWarmClose).not.toHaveBeenCalled()
    expect(handleFollowupMock).not.toHaveBeenCalled()
  }

  it('not_yet: the floor has not elapsed', async () => {
    store.loadWarmCloseCandidates.mockResolvedValue({
      ok: true,
      data: [candidate({ sentAt: new Date(NOW.getTime() - 9 * 60 * 1000) })],
    })
    await expectSkip('not_yet')
  })

  it('DEFERS ONCE when our last message asked a question, then fires at double', async () => {
    // At 15 minutes the plain floor has passed but the doubled one has not.
    store.loadWarmCloseCandidates.mockResolvedValue({
      ok: true,
      data: [candidate({ body: 'glad it landed. first time in?' })],
    })
    const deferred = await processDueWarmCloses(NOW)
    expect(deferred.closed).toBe(0)
    expect(deferred.skipped.not_yet).toBe(1)
    expect(store.claimWarmClose).not.toHaveBeenCalled()

    // At 21 minutes it fires.
    vi.clearAllMocks()
    store.loadWarmCloseVenues.mockResolvedValue({ ok: true, data: [venue()] })
    store.loadWarmCloseCandidates.mockResolvedValue({
      ok: true,
      data: [candidate({ body: 'glad it landed. first time in?' })],
    })
    store.loadWarmCloseGuestFacts.mockResolvedValue({ ok: true, data: facts() })
    store.loadLastInboundCategory.mockResolvedValue('reply')
    store.claimWarmClose.mockResolvedValue({ status: 'claimed' })
    loadPendingRowsBySlotMock.mockResolvedValue({
      obligation: null,
      conversation: [],
    })
    handleFollowupMock.mockResolvedValue({
      status: 'sent',
      outboundMessageId: 'm-close',
    })
    const fired = await processDueWarmCloses(
      new Date(SENT_AT.getTime() + 21 * 60 * 1000),
    )
    expect(fired.closed).toBe(1)
  })

  it('DEFERS on a raised getting-to-know-you question, which IS the last bubble', async () => {
    // TAC-554 puts that question in its own last message and the candidate IS
    // the newest row, so the body carries it. This is the case the deleted
    // rendered-intentions arm was written for and could never actually see.
    store.loadWarmCloseCandidates.mockResolvedValue({
      ok: true,
      data: [candidate({ body: "what's your name, by the way?" })],
    })
    await expectSkip('not_yet')
  })

  // THE DOUBLED-PAUSE BUG (TAC-568), from the side that used to be wrong.
  //
  // This body is a plain statement on a turn where the intentions block
  // rendered and the model raised nothing. Before the fix the candidate carried
  // renderedIntentionCount: 1 and the floor doubled, so the close waited twenty
  // minutes instead of ten. The clock below is 11 minutes — past the real floor,
  // inside the doubled one — so restoring the old arm turns this red.
  it('does NOT defer when the reply asked nothing, however much rendered', async () => {
    store.loadWarmCloseCandidates.mockResolvedValue({
      ok: true,
      data: [candidate({ body: 'nice, glad it landed' })],
    })
    store.claimWarmClose.mockResolvedValue({ status: 'claimed' })
    handleFollowupMock.mockResolvedValue({
      status: 'sent',
      outboundMessageId: 'm-close',
    })
    const fired = await processDueWarmCloses(
      new Date(SENT_AT.getTime() + 11 * 60 * 1000),
    )
    expect(fired.closed).toBe(1)
  })

  it('too_late: past the two-hour bound', async () => {
    store.loadWarmCloseCandidates.mockResolvedValue({
      ok: true,
      data: [candidate({ sentAt: new Date(NOW.getTime() - 121 * 60 * 1000) })],
    })
    await expectSkip('too_late')
  })

  it('already_closed: the marker is set', async () => {
    store.loadWarmCloseGuestFacts.mockResolvedValue({
      ok: true,
      data: facts({ warmCloseSentAt: new Date('2026-09-01T00:00:00.000Z') }),
    })
    await expectSkip('already_closed')
  })

  it('closed_in_conversation: their last inbound was a sign-off', async () => {
    // The belt behind the model's own self-report. `acknowledgment` IS the turn
    // Le Mil's rule 15 fires on, so the in-conversation close already went out.
    store.loadLastInboundCategory.mockResolvedValue('acknowledgment')
    await expectSkip('closed_in_conversation')
  })

  it('not_a_scan_guest: a first conversation that did not start from a counter scan', async () => {
    // Ruled 2026-09-29: first-visit QR scans only for now. A guest who DM'd
    // without scanning is NEVER closed by the timer.
    store.loadWarmCloseGuestFacts.mockResolvedValue({
      ok: true,
      data: facts({ createdVia: 'inbound_message' }),
    })
    await expectSkip('not_a_scan_guest')
  })

  it('not_first_conversation: their first contact is outside the conversation window', async () => {
    store.loadWarmCloseGuestFacts.mockResolvedValue({
      ok: true,
      data: facts({ firstContactedAt: new Date('2026-09-20T00:00:00.000Z') }),
    })
    await expectSkip('not_first_conversation')
  })

  it('opted_out', async () => {
    store.loadWarmCloseGuestFacts.mockResolvedValue({
      ok: true,
      data: facts({ optedOutAt: new Date('2026-09-29T18:05:00.000Z') }),
    })
    await expectSkip('opted_out')
  })

  it('not_instagram: the guest has no Instagram identifier', async () => {
    store.loadWarmCloseGuestFacts.mockResolvedValue({
      ok: true,
      data: facts({ instagramScopedId: null, phoneNumber: '+14155550123' }),
    })
    await expectSkip('not_instagram')
  })

  it('card_pending: an operator holds a card in either slot', async () => {
    for (const slots of [
      { obligation: { id: 'card' }, conversation: [] },
      { obligation: null, conversation: [{ id: 'card' }] },
    ]) {
      vi.clearAllMocks()
      store.loadWarmCloseVenues.mockResolvedValue({ ok: true, data: [venue()] })
      store.loadWarmCloseCandidates.mockResolvedValue({
        ok: true,
        data: [candidate()],
      })
      store.loadWarmCloseGuestFacts.mockResolvedValue({
        ok: true,
        data: facts(),
      })
      store.loadLastInboundCategory.mockResolvedValue('reply')
      loadPendingRowsBySlotMock.mockResolvedValue(slots)
      await expectSkip('card_pending')
    }
  })

  it('guest_unreadable: the guest read failed', async () => {
    store.loadWarmCloseGuestFacts.mockResolvedValue({
      ok: false,
      error: 'boom',
    })
    await expectSkip('guest_unreadable')
  })

  it('claim_lost: another tick got there first', async () => {
    store.claimWarmClose.mockResolvedValue({ status: 'lost' })
    const r = await processDueWarmCloses(NOW)
    expect(r.closed).toBe(0)
    expect(r.skipped.claim_lost).toBe(1)
    expect(handleFollowupMock).not.toHaveBeenCalled()
  })
})

describe('processDueWarmCloses: venue-wide gates (TAC-560)', () => {
  it('skips a paused venue before it scans for candidates', async () => {
    store.loadWarmCloseVenues.mockResolvedValue({
      ok: true,
      data: [venue({ status: 'paused' })],
    })
    const r = await processDueWarmCloses(NOW)
    expect(r.scanned).toBe(0)
    expect(store.loadWarmCloseCandidates).not.toHaveBeenCalled()
  })

  // TAC-568: no configured close, nothing to send. Gated venue-wide and BEFORE
  // the candidate scan, for the same reason the paused gate is: a venue that can
  // never close anyone should cost one venues row per tick, not a scan.
  //
  // COUNTED rather than silent. An unconfigured venue has to be distinguishable
  // in the tick summary from a venue with no candidates, or the feature can ship
  // inert at a venue and nothing says so.
  it('no_warm_close_text: the venue has no configured close', async () => {
    store.loadWarmCloseVenues.mockResolvedValue({
      ok: true,
      data: [venue({ followupRules: { warm_close_text: '' } })],
    })
    const r = await processDueWarmCloses(NOW)
    expect(r.closed).toBe(0)
    expect(r.scanned).toBe(0)
    expect(r.skipped.no_warm_close_text).toBe(1)
    expect(store.loadWarmCloseCandidates).not.toHaveBeenCalled()
  })

  it('no_warm_close_text: followup_rules carries no key at all', async () => {
    // A venue whose row predates the key takes the schema default, which is ''.
    store.loadWarmCloseVenues.mockResolvedValue({
      ok: true,
      data: [venue({ followupRules: null })],
    })
    const r = await processDueWarmCloses(NOW)
    expect(r.closed).toBe(0)
    expect(r.skipped.no_warm_close_text).toBe(1)
  })

  it('reads the close text off the venue setting, not a constant', async () => {
    // What the guest receives must be THIS venue's string. Two venues with
    // different settings must not be able to send the same text.
    const OTHER = 'drop us a line whenever'
    store.loadWarmCloseVenues.mockResolvedValue({
      ok: true,
      data: [venue({ followupRules: { warm_close_text: OTHER } })],
    })
    await processDueWarmCloses(NOW)
    expect(handleFollowupMock).toHaveBeenCalledTimes(1)
    // The processor hands the reason and the guest; handleFollowup reads the text
    // off the context it builds for that venue. What this pins is that the
    // processor did NOT pass a body of its own, which would be a second source
    // of truth for the wording.
    const input = handleFollowupMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >
    expect(input).not.toHaveProperty('body')
    expect(input.trigger).toMatchObject({ reason: 'warm_close' })
  })

  it('processes a `pending` venue, because the gate is a DENY-list', async () => {
    // The live pilot venue is `pending`. An allow-list on `active` would switch
    // this off for the only venue that has it (docs/decisions/0002).
    const r = await processDueWarmCloses(NOW)
    expect(r.closed).toBe(1)
  })

  it('skips inside quiet hours, and does NOT defer to venue open', async () => {
    // Ruled 2026-09-29: the close may send while the venue is CLOSED, as long as
    // it is outside quiet hours. So there is no open/closed check at all here,
    // and quiet hours are the only clock gate. 06:30 UTC is 23:30 in Los Angeles.
    const inQuietHours = new Date('2026-09-30T06:30:00.000Z')
    store.loadWarmCloseCandidates.mockResolvedValue({
      ok: true,
      data: [
        candidate({
          sentAt: new Date(inQuietHours.getTime() - 15 * 60 * 1000),
        }),
      ],
    })
    const r = await processDueWarmCloses(inQuietHours)
    expect(r.scanned).toBe(0)
    expect(store.loadWarmCloseCandidates).not.toHaveBeenCalled()
  })

  it('skips a venue with no Instagram account', async () => {
    store.loadWarmCloseVenues.mockResolvedValue({
      ok: true,
      data: [venue({ instagramAccountId: null })],
    })
    const r = await processDueWarmCloses(NOW)
    expect(r.scanned).toBe(0)
  })

  it('reads the pause length off the venue setting', async () => {
    // followup_rules.warm_close_pause_minutes. At 30 minutes, 15 is not yet due.
    store.loadWarmCloseVenues.mockResolvedValue({
      ok: true,
      data: [
        venue({
          followupRules: {
            warm_close_pause_minutes: 30,
            // TAC-568: kept, or the venue-wide no-text gate skips before the
            // pause length is ever consulted.
            warm_close_text: WARM_CLOSE_TEXT,
          },
        }),
      ],
    })
    const r = await processDueWarmCloses(NOW)
    expect(r.closed).toBe(0)
    expect(r.skipped.not_yet).toBe(1)
  })
})

describe('processDueWarmCloses: the claim release (TAC-560)', () => {
  it('releases the claim when the close was refused, so a later tick can retry', async () => {
    handleFollowupMock.mockResolvedValue({
      status: 'refused',
      reason: 'no_warm_close_text',
    })
    const r = await processDueWarmCloses(NOW)
    expect(r.closed).toBe(0)
    expect(store.releaseWarmCloseClaim).toHaveBeenCalledWith(
      expect.anything(),
      GUEST,
      NOW,
    )
  })

  it('KEEPS the claim on a queued close, because an operator can still send it', async () => {
    // The double-send this closes: releasing here, then the operator approving the
    // card (which writes no marker), leaves a null marker and no pending card, and
    // the next tick closes the guest a second time.
    handleFollowupMock.mockResolvedValue({
      status: 'queued',
      outboundMessageId: 'm-card',
      triggers: ['model_flagged'],
      primaryTrigger: 'model_flagged',
    })
    await processDueWarmCloses(NOW)
    expect(store.releaseWarmCloseClaim).not.toHaveBeenCalled()
  })

  it('KEEPS the claim when something already answered the guest', async () => {
    handleFollowupMock.mockResolvedValue({
      status: 'superseded',
      byMessageId: 'm-staff',
    })
    await processDueWarmCloses(NOW)
    expect(store.releaseWarmCloseClaim).not.toHaveBeenCalled()
  })

  it('releases on a venue paused between the gate and the run', async () => {
    handleFollowupMock.mockResolvedValue({ status: 'venue_halted' })
    await processDueWarmCloses(NOW)
    expect(store.releaseWarmCloseClaim).toHaveBeenCalled()
  })
})

describe('processDueWarmCloses: failure posture (TAC-560)', () => {
  it('never throws when one candidate throws, and keeps going', async () => {
    store.loadWarmCloseCandidates.mockResolvedValue({
      ok: true,
      data: [candidate({ guestId: 'g-bad' }), candidate()],
    })
    store.loadWarmCloseGuestFacts.mockImplementation(
      async (_c: unknown, id: string) => {
        if (id === 'g-bad') throw new Error('boom')
        return { ok: true, data: facts() }
      },
    )
    const r = await processDueWarmCloses(NOW)
    expect(r.errored).toBe(1)
    expect(r.closed).toBe(1)
  })

  it('reports an unreadable venue list rather than throwing', async () => {
    store.loadWarmCloseVenues.mockResolvedValue({ ok: false, error: 'boom' })
    const r = await processDueWarmCloses(NOW)
    expect(r).toMatchObject({ errored: 1, closed: 0, scanned: 0 })
  })
})

// TAC-386: no two proactive messages to one guest within the hour.
describe('processDueWarmCloses: proactive spacing (TAC-386)', () => {
  it('holds the close when a proactive message reached them 30 minutes ago', async () => {
    store.loadWarmCloseGuestFacts.mockResolvedValue({
      ok: true,
      data: facts({
        lastProactiveSendAt: new Date(NOW.getTime() - 30 * 60 * 1000),
      }),
    })
    const r = await processDueWarmCloses(NOW)
    expect(r.closed).toBe(0)
    expect(r.skipped.too_soon_after_proactive).toBe(1)
    // A DELAY, not a refusal: the claim must not have been spent.
    expect(store.claimWarmClose).not.toHaveBeenCalled()
  })

  it('closes when the last proactive message was over an hour ago', async () => {
    store.loadWarmCloseGuestFacts.mockResolvedValue({
      ok: true,
      data: facts({
        lastProactiveSendAt: new Date(NOW.getTime() - 61 * 60 * 1000),
      }),
    })
    const r = await processDueWarmCloses(NOW)
    expect(r.closed).toBe(1)
  })

  it('closes when no proactive message has ever reached them', async () => {
    const r = await processDueWarmCloses(NOW)
    expect(r.closed).toBe(1)
  })

  it('writes the spacing marker after a confirmed send', async () => {
    await processDueWarmCloses(NOW)
    expect(recordProactiveSendMock).toHaveBeenCalled()
  })

  it('writes NO marker when the close was only queued', async () => {
    // A card is an operator's decision and an operator can see the whole
    // thread, so it does not consume the guest's spacing window.
    handleFollowupMock.mockResolvedValue({ status: 'queued' })
    await processDueWarmCloses(NOW)
    expect(recordProactiveSendMock).not.toHaveBeenCalled()
  })
})
