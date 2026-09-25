// TAC-536: the every-minute processor that turns a pending scan into a
// greeting, or records why it did not.
//
// Run against an in-memory store that MODELS MIGRATION 064'S PARTIAL UNIQUE
// INDEX (testing/scan-arrivals-fake.ts). That is what makes the repeat-guard
// test mean anything: the guard is Postgres, so a fake without the index would
// let the guard be deleted and every test still pass.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const handleFollowupMock = vi.fn()
const insertLedgerMock = vi.fn()
const captureMock = vi.fn()

vi.mock('./handle-followup', () => ({
  handleFollowup: (...args: unknown[]) => handleFollowupMock(...args),
}))
vi.mock('./record-inbound-turn-outcome', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./record-inbound-turn-outcome')>()
  return {
    ...actual,
    insertInboundTurnOutcome: (...args: unknown[]) => insertLedgerMock(...args),
  }
})
vi.mock('@/lib/analytics/posthog', () => ({
  captureInstagramScanGreeting: (...args: unknown[]) => captureMock(...args),
}))

import { processDueScanGreetings } from './instagram-scan-greeting'
import {
  createScanArrivalsFake,
  type ScanArrivalRow,
  type ScanArrivalsSeed,
} from './testing/scan-arrivals-fake'

const VENUE_ID = 'venue-1'
const GUEST_ID = 'guest-1'
const MINUTE = 60 * 1000

/** 2026-09-20 20:18:08Z is 13:18 in Los Angeles, mid-service. */
const SCAN_ISO = '2026-09-20T20:18:08.000Z'
const SCAN = new Date(SCAN_ISO)
const at = (ms: number) => new Date(SCAN.getTime() + ms)

/** Open 07:00 to 15:00 every day, so the scan above lands inside service. */
const OPEN_ALL_WEEK = {
  hours: {
    monday: '7:00 AM - 3:00 PM',
    tuesday: '7:00 AM - 3:00 PM',
    wednesday: '7:00 AM - 3:00 PM',
    thursday: '7:00 AM - 3:00 PM',
    friday: '7:00 AM - 3:00 PM',
    saturday: '7:00 AM - 3:00 PM',
    sunday: '7:00 AM - 3:00 PM',
  },
}

function arrival(over: Partial<ScanArrivalRow> = {}): ScanArrivalRow {
  return {
    id: 'scan-arrival-1',
    venue_id: VENUE_ID,
    guest_id: GUEST_ID,
    scan_message_id: 'scan-msg-1',
    scanned_at: SCAN_ISO,
    had_prior_conversation: true,
    claimed_at: null,
    venue_local_date: null,
    outcome: null,
    resolved_at: null,
    ...over,
  }
}

function seed(over: Partial<ScanArrivalsSeed> = {}): ScanArrivalsSeed {
  return {
    arrivals: [arrival()],
    venues: [{ id: VENUE_ID, timezone: 'America/Los_Angeles', status: 'active' }],
    guests: [{ id: GUEST_ID, opted_out_at: null }],
    messages: [],
    venueInfo: OPEN_ALL_WEEK,
    ...over,
  }
}

/** The ledger rows this run wrote, newest last. */
function ledgerReasons(): Array<string | null> {
  return insertLedgerMock.mock.calls.map((c) => (c[0] as { entry: { reason: string | null } }).entry.reason)
}

beforeEach(() => {
  vi.clearAllMocks()
  handleFollowupMock.mockResolvedValue({ status: 'sent', outboundMessageId: 'out-1' })
})

describe('the greeting fires', () => {
  it('calls handleFollowup with the scan trigger once the five minutes are up', async () => {
    const db = createScanArrivalsFake(seed())
    const result = await processDueScanGreetings(at(6 * MINUTE), db.client)

    expect(handleFollowupMock).toHaveBeenCalledTimes(1)
    expect(handleFollowupMock.mock.calls[0]?.[0]).toMatchObject({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      trigger: {
        reason: 'instagram_scan_arrival',
        instagramScanArrival: { scanMessageId: 'scan-msg-1', hadPriorConversation: true },
      },
    })
    expect(result.greeted).toBe(1)
    expect(db.arrivals[0]?.outcome).toBe('greeted')
  })

  // The run id on the Langfuse trace and the one on the ledger row have to be
  // the same value, or a trace cannot be found from a row.
  it('records the turn under the same agentRunId it handed handleFollowup', async () => {
    const db = createScanArrivalsFake(seed())
    await processDueScanGreetings(at(6 * MINUTE), db.client)

    const passed = (handleFollowupMock.mock.calls[0]?.[0] as { agentRunId: string }).agentRunId
    const recorded = (insertLedgerMock.mock.calls[0]?.[0] as { agentRunId: string }).agentRunId
    expect(typeof passed).toBe('string')
    expect(recorded).toBe(passed)
  })

  it('records the AgentResult, not a fixed success', async () => {
    handleFollowupMock.mockResolvedValue({
      status: 'queued',
      outboundMessageId: 'card-1',
      triggers: ['model_flagged'],
      primaryTrigger: 'model_flagged',
    })
    const db = createScanArrivalsFake(seed())
    await processDueScanGreetings(at(6 * MINUTE), db.client)

    expect(insertLedgerMock.mock.calls[0]?.[0]).toMatchObject({
      layer: 'agent',
      channel: 'instagram',
      inboundMessageId: 'scan-msg-1',
      entry: { outcome: 'queued', outboundMessageId: 'card-1' },
    })
  })

  it('waits while the five minutes are still running', async () => {
    const db = createScanArrivalsFake(seed())
    const result = await processDueScanGreetings(at(2 * MINUTE), db.client)

    expect(handleFollowupMock).not.toHaveBeenCalled()
    expect(result.notYet).toBe(1)
    // Still pending: a later tick must find it.
    expect(db.arrivals[0]?.resolved_at).toBeNull()
    expect(db.arrivals[0]?.claimed_at).toBeNull()
  })
})

describe('the repeat guard', () => {
  // THE SCENARIO THE RULING NAMED. Three scans in one venue-local day greet
  // once. Fails when the unique index key is removed from the claim, and
  // separately when the 23505 branch is deleted, because the fake models the
  // index rather than trusting the code's own opinion of it.
  it('greets once across three scans on one venue-local day', async () => {
    const db = createScanArrivalsFake(
      seed({
        arrivals: [
          arrival({ id: 'a1', scanned_at: SCAN_ISO }),
          arrival({ id: 'a2', scanned_at: at(20 * MINUTE).toISOString() }),
          arrival({ id: 'a3', scanned_at: at(40 * MINUTE).toISOString() }),
        ],
      }),
    )

    // Three ticks, each six minutes after one of the scans.
    await processDueScanGreetings(at(6 * MINUTE), db.client)
    await processDueScanGreetings(at(26 * MINUTE), db.client)
    await processDueScanGreetings(at(46 * MINUTE), db.client)

    expect(handleFollowupMock).toHaveBeenCalledTimes(1)
    expect(db.arrivals.map((r) => r.outcome)).toEqual([
      'greeted',
      'already_greeted_today',
      'already_greeted_today',
    ])
    expect(ledgerReasons()).toEqual([null, 'already_greeted_today', 'already_greeted_today'])
  })

  // A suppressed scan leaves claimed_at null, so it is not in the index and
  // the day is not burned. Without that, a guest whose greeting was withheld
  // because the venue was shut could never be greeted later that day.
  it('does not burn the day when a scan was suppressed rather than greeted', async () => {
    const db = createScanArrivalsFake(
      seed({
        arrivals: [
          arrival({ id: 'a1', scanned_at: SCAN_ISO }),
          arrival({ id: 'a2', scanned_at: at(20 * MINUTE).toISOString() }),
        ],
        // A real message after the first scan suppresses it.
        messages: [
          {
            id: 'm1',
            venue_id: VENUE_ID,
            guest_id: GUEST_ID,
            direction: 'inbound',
            provider_message_id: 'mid-1',
            created_at: at(MINUTE).toISOString(),
          },
        ],
      }),
    )

    await processDueScanGreetings(at(6 * MINUTE), db.client)
    expect(db.arrivals[0]?.outcome).toBe('inbound_during_window')
    expect(db.arrivals[0]?.claimed_at).toBeNull()

    // The second scan is after that message, so nothing suppresses it.
    db.arrivals[1]!.scanned_at = at(20 * MINUTE).toISOString()
    await processDueScanGreetings(at(26 * MINUTE), db.client)
    expect(handleFollowupMock).toHaveBeenCalledTimes(1)
    expect(db.arrivals[1]?.outcome).toBe('greeted')
  })

  // Without this the first test passes against a guard that greets once ever.
  it('greets again on the next venue-local day', async () => {
    const dayTwo = new Date(SCAN.getTime() + 24 * 60 * MINUTE)
    const db = createScanArrivalsFake(
      seed({
        arrivals: [
          arrival({ id: 'a1', scanned_at: SCAN_ISO }),
          arrival({ id: 'a2', scanned_at: dayTwo.toISOString() }),
        ],
      }),
    )

    await processDueScanGreetings(at(6 * MINUTE), db.client)
    await processDueScanGreetings(new Date(dayTwo.getTime() + 6 * MINUTE), db.client)

    expect(handleFollowupMock).toHaveBeenCalledTimes(2)
    expect(db.arrivals.map((r) => r.outcome)).toEqual(['greeted', 'greeted'])
  })

  // The guard is keyed on the VENUE's day. Two scans either side of UTC
  // midnight but inside one Los Angeles day are still one day.
  it('keys the day on the venue timezone, not UTC', async () => {
    // 23:30 and 00:30 UTC: the 20th and the 21st in UTC, both the 20th in LA.
    const first = new Date('2026-09-20T23:30:00.000Z')
    const second = new Date('2026-09-21T00:30:00.000Z')
    // Long hours for this one: 07:00 to 15:00 puts 16:30 and 17:30 local
    // outside service, and the venue-closed check would suppress both before
    // the day key was ever compared.
    const lateHours = {
      hours: {
        monday: '6:00 AM - 11:00 PM',
        tuesday: '6:00 AM - 11:00 PM',
        wednesday: '6:00 AM - 11:00 PM',
        thursday: '6:00 AM - 11:00 PM',
        friday: '6:00 AM - 11:00 PM',
        saturday: '6:00 AM - 11:00 PM',
        sunday: '6:00 AM - 11:00 PM',
      },
    }
    const db = createScanArrivalsFake(
      seed({
        venueInfo: lateHours,
        arrivals: [
          arrival({ id: 'a1', scanned_at: first.toISOString() }),
          arrival({ id: 'a2', scanned_at: second.toISOString() }),
        ],
      }),
    )

    await processDueScanGreetings(new Date(first.getTime() + 6 * MINUTE), db.client)
    await processDueScanGreetings(new Date(second.getTime() + 6 * MINUTE), db.client)

    expect(handleFollowupMock).toHaveBeenCalledTimes(1)
    expect(db.arrivals[1]?.outcome).toBe('already_greeted_today')
  })
})

describe('the suppressions, each re-checked at fire time', () => {
  it.each<[string, Partial<ScanArrivalsSeed>, number, string, string]>([
    [
      'a guest who wrote inside the window',
      {
        messages: [
          {
            id: 'm1',
            venue_id: VENUE_ID,
            guest_id: GUEST_ID,
            direction: 'inbound',
            provider_message_id: 'mid-1',
            created_at: at(2 * MINUTE).toISOString(),
          },
        ],
      },
      6 * MINUTE,
      'inbound_during_window',
      'inbound_during_window',
    ],
    [
      'a paused venue',
      { venues: [{ id: VENUE_ID, timezone: 'America/Los_Angeles', status: 'paused' }] },
      6 * MINUTE,
      'venue_paused',
      'venue_paused',
    ],
    [
      'a guest who opted out',
      { guests: [{ id: GUEST_ID, opted_out_at: '2026-09-01T00:00:00.000Z' }] },
      6 * MINUTE,
      'guest_opted_out',
      'guest_opted_out',
    ],
    [
      'a venue that is shut',
      { venueInfo: { hours: { sunday: 'Closed', monday: 'Closed', tuesday: 'Closed', wednesday: 'Closed', thursday: 'Closed', friday: 'Closed', saturday: 'Closed' } } },
      6 * MINUTE,
      'venue_closed',
      'venue_closed',
    ],
    ['a scan the cron got to too late', {}, 20 * MINUTE, 'too_stale', 'scan_too_stale'],
  ])('suppresses for %s', async (_label, over, tickOffset, outcome, ledgerReason) => {
    const db = createScanArrivalsFake(seed(over))
    await processDueScanGreetings(at(tickOffset), db.client)

    expect(handleFollowupMock).not.toHaveBeenCalled()
    expect(db.arrivals[0]?.outcome).toBe(outcome)
    expect(db.arrivals[0]?.claimed_at).toBeNull()
    expect(ledgerReasons()).toEqual([ledgerReason])
  })

  // A SECOND SCAN is not the guest writing. Without the provider_message_id
  // filter every repeat scanner would be silently suppressed instead of being
  // handled by the once-per-day rule, which is a different behaviour with a
  // different record.
  it('does not treat a later scan row as the guest having written', async () => {
    const db = createScanArrivalsFake(
      seed({
        messages: [
          {
            id: 'later-scan',
            venue_id: VENUE_ID,
            guest_id: GUEST_ID,
            direction: 'inbound',
            provider_message_id: null,
            created_at: at(MINUTE).toISOString(),
          },
        ],
      }),
    )
    await processDueScanGreetings(at(6 * MINUTE), db.client)
    expect(handleFollowupMock).toHaveBeenCalledTimes(1)
  })

  // TAC-363's rule: unknown hours behave as open. Refusing on merely
  // unreadable data would silence the greeting at every venue whose hours
  // nobody has filled in.
  it('greets when the hours cannot be read', async () => {
    const db = createScanArrivalsFake(seed({ venueInfo: null }))
    await processDueScanGreetings(at(6 * MINUTE), db.client)
    expect(handleFollowupMock).toHaveBeenCalledTimes(1)
  })

  // Fails CLOSED, unlike the hours: greeting over a guest mid-sentence is what
  // the five-minute delay exists to prevent, so an unreadable answer holds.
  it('suppresses when the inbound-since read fails', async () => {
    const db = createScanArrivalsFake(seed())
    db.failNext('messages', 'select', { message: 'boom' })
    await processDueScanGreetings(at(6 * MINUTE), db.client)

    expect(handleFollowupMock).not.toHaveBeenCalled()
    expect(db.arrivals[0]?.outcome).toBe('inbound_during_window')
  })

  it('suppresses when the opt-out read fails', async () => {
    const db = createScanArrivalsFake(seed())
    db.failNext('guests', 'select', { message: 'boom' })
    await processDueScanGreetings(at(6 * MINUTE), db.client)

    expect(handleFollowupMock).not.toHaveBeenCalled()
    expect(db.arrivals[0]?.outcome).toBe('guest_opted_out')
  })
})

describe('failure handling', () => {
  it('keeps going when one row throws', async () => {
    handleFollowupMock.mockRejectedValueOnce(new Error('generation exploded'))
    const db = createScanArrivalsFake(
      seed({
        arrivals: [
          arrival({ id: 'a1', guest_id: 'guest-a', scanned_at: SCAN_ISO }),
          arrival({ id: 'a2', guest_id: 'guest-b', scanned_at: SCAN_ISO }),
        ],
        guests: [
          { id: 'guest-a', opted_out_at: null },
          { id: 'guest-b', opted_out_at: null },
        ],
      }),
    )
    const result = await processDueScanGreetings(at(6 * MINUTE), db.client)

    expect(result.errored).toBe(1)
    expect(result.greeted).toBe(1)
    expect(db.arrivals[0]?.outcome).toBe('errored')
    expect(db.arrivals[1]?.outcome).toBe('greeted')
  })

  it('reports an unreadable scan rather than throwing', async () => {
    const db = createScanArrivalsFake(seed())
    db.failNext('instagram_scan_arrivals', 'select', { message: 'boom' })
    const result = await processDueScanGreetings(at(6 * MINUTE), db.client)

    expect(result.errored).toBe(1)
    expect(result.scanned).toBe(0)
    expect(handleFollowupMock).not.toHaveBeenCalled()
  })
})
