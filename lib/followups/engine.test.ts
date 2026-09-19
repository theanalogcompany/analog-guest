/* eslint-disable @typescript-eslint/no-unused-vars */

// Focused smoke test for the engine's claim-before-dispatch sequencing.
// Full per-stage coverage lives on the unit modules (detectors,
// followup-rules, log). This file asserts:
//   - the engine actually CALLS detectors → gate → claim → handleFollowup
//     → finalize in that order;
//   - the primary reason picker honours PRIMARY_REASON_PRIORITY;
//   - dispatch refusal triggers releaseFollowupLogClaim, not finalize.
//
// Mocks every external touchpoint at the module boundary so this test can
// run without a DB. The engine itself is the System Under Test.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: vi.fn(),
}))
vi.mock('@/lib/recognition/compute-state', () => ({
  computeGuestState: vi.fn(),
}))
vi.mock('@/lib/agent/handle-followup', () => ({
  handleFollowup: vi.fn(),
}))
vi.mock('@/lib/analytics/posthog', () => ({
  captureFollowupSuppressed: vi.fn(),
  captureFollowupScanComplete: vi.fn(),
  captureFollowupManualTaskRecorded: vi.fn(),
}))
vi.mock('./log', () => ({
  claimFollowupLogRows: vi.fn(),
  finalizeFollowupLogClaim: vi.fn(),
  releaseFollowupLogClaim: vi.fn(),
  recordManualFollowupTask: vi.fn(),
  loadFollowupSnapshotsForVenue: vi.fn(),
  emptyFollowupGuestSignals: () => ({
    weeklyCount: 0,
    lastByReason: {},
    announcedMechanicIds: new Set(),
  }),
}))

import { createAdminClient } from '@/lib/db/admin'
import { computeGuestState } from '@/lib/recognition/compute-state'
import { handleFollowup } from '@/lib/agent/handle-followup'
import {
  captureFollowupManualTaskRecorded,
  captureFollowupScanComplete,
  captureFollowupSuppressed,
} from '@/lib/analytics/posthog'
import {
  claimFollowupLogRows,
  finalizeFollowupLogClaim,
  loadFollowupSnapshotsForVenue,
  recordManualFollowupTask,
  releaseFollowupLogClaim,
} from './log'
import { processDueFollowups } from './engine'

const VENUE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const GUEST_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

// "Now" pinned to a moment that's 10:00 in America/Los_Angeles, so the
// engine's per-venue local-hour filter passes for the default
// cron_hour_local=10.
const NOW = new Date('2026-06-04T17:00:00Z')

interface VenueLoadShape {
  id: string
  timezone: string
  venue_configs: { followup_rules: unknown; messaging_cadence: unknown } | null
}

// TAC-377: the guests SELECT string, captured so a test can assert the
// precision column is actually requested. The mock's select() ignores its
// argument (it returns opts.guests regardless), so without this a mutant
// that drops the column from the query passes every behavioural test while
// production reads `undefined` and silently degrades to always-permissive.
let capturedGuestSelect: string | null = null
let capturedGuestOrFilter: string | null = null

function makeSupabaseMock(opts: {
  venues: VenueLoadShape[]
  guests: Array<{
    id: string
    opted_out_at: string | null
    last_inbound_at: string | null
    last_visit_at: string | null
    // TAC-377. Present in the shape because the engine SELECTs it and the
    // post-visit detector gates on it — omitting it made every test read
    // `undefined`, so the gate was unreachable and two wiring mutants
    // (passing null at the call site; dropping the column from the SELECT)
    // survived the whole suite.
    last_visit_precision?: string | null
    // TAC-469 PR B. REQUIRED, for the same reason last_visit_precision carries
    // the comment above: the engine now resolves a channel from these two, and
    // a fixture omitting them reads `undefined` on both, which resolves to no
    // channel and quietly takes the SMS branch. Every test would stay green
    // while the Instagram branch was unreachable.
    phone_number: string | null
    instagram_scoped_id: string | null
  }>
}) {
  const builders: Record<string, unknown> = {
    venues: {
      select: () => Promise.resolve({ data: opts.venues, error: null }),
    },
    guests: {
      select: (columns: string) => ({
        eq: (_c: string, _v: unknown) => ({
          or: (filter: string) => ({
            is: (_c3: string, _v3: unknown) => ({
              in: (_c4: string, _vs: unknown[]) => {
                capturedGuestSelect = columns
                capturedGuestOrFilter = filter
                return Promise.resolve({ data: opts.guests, error: null })
              },
            }),
          }),
        }),
      }),
    },
    mechanics: {
      select: () => ({
        eq: (_c: string, _v: unknown) => ({
          eq: (_c2: string, _v2: unknown) => Promise.resolve({ data: [], error: null }),
        }),
      }),
    },
    engagement_events: {
      select: () => ({
        eq: (_c: string, _v: unknown) => ({
          eq: (_c2: string, _v2: unknown) => ({
            not: (_c3: string, _op: string, _v3: unknown) =>
              Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    },
  }
  return {
    from: (table: string) => builders[table],
  }
}

beforeEach(() => {
  capturedGuestSelect = null
  capturedGuestOrFilter = null
  vi.mocked(createAdminClient).mockReset()
  vi.mocked(computeGuestState).mockReset()
  vi.mocked(handleFollowup).mockReset()
  vi.mocked(captureFollowupSuppressed).mockReset()
  vi.mocked(captureFollowupScanComplete).mockReset()
  vi.mocked(claimFollowupLogRows).mockReset()
  vi.mocked(finalizeFollowupLogClaim).mockReset()
  vi.mocked(releaseFollowupLogClaim).mockReset()
  vi.mocked(loadFollowupSnapshotsForVenue).mockReset()
  vi.mocked(recordManualFollowupTask).mockReset()
  vi.mocked(captureFollowupManualTaskRecorded).mockReset()

  // Default mock returns suitable for a single-venue, single-guest happy path.
  vi.mocked(createAdminClient).mockImplementation(
    () =>
      makeSupabaseMock({
        venues: [
          {
            id: VENUE_ID,
            timezone: 'America/Los_Angeles',
            venue_configs: {
              followup_rules: null, // → FOLLOWUP_RULES_DEFAULT
              messaging_cadence: { day_1: false, day_3: false, day_7: true, day_14: true },
            },
          },
        ],
        guests: [
          {
            id: GUEST_ID,
            opted_out_at: null,
            last_inbound_at: null,
            // 7 days ago → post_visit_day_7 detector fires.
            last_visit_at: new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
            phone_number: '+15551230000',
            instagram_scoped_id: null,
          },
        ],
      }) as unknown as ReturnType<typeof createAdminClient>,
  )
  vi.mocked(loadFollowupSnapshotsForVenue).mockResolvedValue({
    ok: true,
    data: new Map(),
  })
  vi.mocked(computeGuestState).mockResolvedValue({
    ok: true,
    data: {
      state: 'regular',
      score: 50,
      signals: {} as never,
      weights: undefined,
      contributions: undefined,
    },
  } as never)
  vi.mocked(claimFollowupLogRows).mockResolvedValue({
    ok: true,
    claimed: [{ id: 'log-1', reason: 'post_visit_day_7', dedupKey: 'day_7:x' }],
  })
  vi.mocked(handleFollowup).mockResolvedValue({
    status: 'sent',
    outboundMessageId: 'msg-1',
  })
  vi.mocked(finalizeFollowupLogClaim).mockResolvedValue({
    ok: true,
    data: { updatedCount: 1 },
  })
  vi.mocked(recordManualFollowupTask).mockResolvedValue({
    ok: true,
    data: { updatedCount: 1 },
  })
})

describe('processDueFollowups — happy path (sent)', () => {
  it('claims, dispatches, then finalizes the log row', async () => {
    const result = await processDueFollowups(NOW)
    expect(claimFollowupLogRows).toHaveBeenCalledOnce()
    expect(handleFollowup).toHaveBeenCalledOnce()
    expect(finalizeFollowupLogClaim).toHaveBeenCalledWith(['log-1'], 'msg-1')
    expect(releaseFollowupLogClaim).not.toHaveBeenCalled()
    expect(result.guestsDispatched).toBe(1)
    expect(result.guestsDispatchFailed).toBe(0)
    expect(captureFollowupScanComplete).toHaveBeenCalledOnce()
  })

  it('passes a FollowupTrigger with primary mapped to day_7 (the detected reason)', async () => {
    await processDueFollowups(NOW)
    const callArg = vi.mocked(handleFollowup).mock.calls[0]?.[0]
    expect(callArg?.trigger.reason).toBe('day_7')
    expect(callArg?.trigger.additionalReasons).toBeUndefined()
    expect(callArg?.trigger.perkMechanic).toBeUndefined()
  })
})

// TAC-377: the engine is the ONLY production consumer of the precision gate,
// and until these tests existed two wiring mutants survived the whole suite —
// passing `null` at the detector call site (which restores pre-TAC-377
// always-permissive behaviour, i.e. makes the feature inert) and dropping the
// column from the SELECT. Both are killed here.
describe('processDueFollowups — visit-time precision gate (TAC-377)', () => {
  const guestWithPrecision = (precision: string | null) => ({
    venues: [
      {
        id: VENUE_ID,
        timezone: 'America/Los_Angeles',
        venue_configs: {
          followup_rules: null,
          messaging_cadence: { day_1: false, day_3: false, day_7: true, day_14: true },
        },
      },
    ],
    guests: [
      {
        id: GUEST_ID,
        opted_out_at: null,
        last_inbound_at: null,
        // 7 days ago — post_visit_day_7 is due on elapsed time alone, so
        // precision is the only thing that can stop it.
        last_visit_at: new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        last_visit_precision: precision,
        phone_number: '+15551230000',
        instagram_scoped_id: null,
      },
    ],
  })

  it('does not dispatch a post-visit followup off an approximate visit', async () => {
    vi.mocked(createAdminClient).mockImplementation(
      () =>
        makeSupabaseMock(
          guestWithPrecision('approximate'),
        ) as unknown as ReturnType<typeof createAdminClient>,
    )
    const result = await processDueFollowups(NOW)
    expect(handleFollowup).not.toHaveBeenCalled()
    expect(claimFollowupLogRows).not.toHaveBeenCalled()
    expect(result.guestsDispatched).toBe(0)
  })

  it('dispatches on a pinned visit', async () => {
    vi.mocked(createAdminClient).mockImplementation(
      () =>
        makeSupabaseMock(guestWithPrecision('pinned')) as unknown as ReturnType<
          typeof createAdminClient
        >,
    )
    const result = await processDueFollowups(NOW)
    expect(handleFollowup).toHaveBeenCalledOnce()
    expect(vi.mocked(handleFollowup).mock.calls[0]?.[0]?.trigger.reason).toBe('day_7')
    expect(result.guestsDispatched).toBe(1)
  })

  it('actually SELECTs last_visit_precision (the gate is inert without it)', async () => {
    await processDueFollowups(NOW)
    expect(capturedGuestSelect).toContain('last_visit_precision')
  })

  it('dispatches when precision was never recorded (null is permissive)', async () => {
    vi.mocked(createAdminClient).mockImplementation(
      () =>
        makeSupabaseMock(guestWithPrecision(null)) as unknown as ReturnType<
          typeof createAdminClient
        >,
    )
    const result = await processDueFollowups(NOW)
    expect(handleFollowup).toHaveBeenCalledOnce()
    expect(result.guestsDispatched).toBe(1)
  })
})

describe('processDueFollowups — happy path (queued)', () => {
  it('finalizes the log row when handleFollowup returns queued (gate routed draft to operator review)', async () => {
    vi.mocked(handleFollowup).mockResolvedValue({
      status: 'queued',
      outboundMessageId: 'msg-queued-1',
      triggers: ['fidelity_below_auto_send_floor'],
      primaryTrigger: 'fidelity_below_auto_send_floor',
    })
    const result = await processDueFollowups(NOW)
    expect(finalizeFollowupLogClaim).toHaveBeenCalledWith(['log-1'], 'msg-queued-1')
    expect(releaseFollowupLogClaim).not.toHaveBeenCalled()
    expect(result.guestsDispatched).toBe(1)
  })
})

describe('processDueFollowups — multi-reason claim sharing one message_id', () => {
  it('builds N claim rows for N reasons and stamps them all with the same message_id', async () => {
    // Two reasons emerge from the detector (post_visit_day_7 from elapsed
    // + perk_unlock from a newly-eligible mechanic). Engine claims both,
    // dispatches once, finalizes both rows with the same outboundMessageId.
    vi.mocked(createAdminClient).mockImplementation(
      () =>
        makeSupabaseMock({
          venues: [
            {
              id: VENUE_ID,
              timezone: 'America/Los_Angeles',
              venue_configs: {
                followup_rules: null,
                messaging_cadence: { day_1: false, day_3: false, day_7: true, day_14: true },
              },
            },
          ],
          guests: [
            {
              id: GUEST_ID,
              opted_out_at: null,
              last_inbound_at: null,
              last_visit_at: new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
              phone_number: '+15551230000',
              instagram_scoped_id: null,
            },
          ],
        }) as unknown as ReturnType<typeof createAdminClient>,
    )
    // Single eligible mechanic, not in announcedMechanicIds → perk_unlock detector fires.
    // BUT mechanics are loaded via the supabase mock which returns [] (the SelectChain
    // builders we wired). So perk_unlock would NOT actually fire end-to-end here.
    // For this assertion we only care about claim row count when multiple reasons exist;
    // simulate via a claim mock that returns two rows.
    vi.mocked(claimFollowupLogRows).mockResolvedValue({
      ok: true,
      claimed: [
        { id: 'log-1', reason: 'post_visit_day_7', dedupKey: 'day_7:x' },
        { id: 'log-2', reason: 'perk_unlock', dedupKey: 'perk:y' },
      ],
    })
    vi.mocked(handleFollowup).mockResolvedValue({
      status: 'sent',
      outboundMessageId: 'msg-shared-1',
    })
    await processDueFollowups(NOW)
    expect(finalizeFollowupLogClaim).toHaveBeenCalledWith(['log-1', 'log-2'], 'msg-shared-1')
  })
})

describe('processDueFollowups — claim conflict (concurrent run)', () => {
  it('skips dispatch and counts the conflict', async () => {
    vi.mocked(claimFollowupLogRows).mockResolvedValue({ ok: true, conflict: true })
    const result = await processDueFollowups(NOW)
    expect(handleFollowup).not.toHaveBeenCalled()
    expect(finalizeFollowupLogClaim).not.toHaveBeenCalled()
    expect(releaseFollowupLogClaim).not.toHaveBeenCalled()
    expect(result.guestsConflicted).toBe(1)
    expect(result.guestsDispatched).toBe(0)
  })
})

describe('processDueFollowups — dispatch refused (release the claim)', () => {
  it('releases the claim and counts the failure (dedup not burned)', async () => {
    vi.mocked(handleFollowup).mockResolvedValue({
      status: 'refused',
      reason: 'low_fidelity',
      attemptScores: [0.2, 0.3],
    })
    vi.mocked(releaseFollowupLogClaim).mockResolvedValue({
      ok: true,
      data: { deletedCount: 1 },
    })
    const result = await processDueFollowups(NOW)
    expect(finalizeFollowupLogClaim).not.toHaveBeenCalled()
    expect(releaseFollowupLogClaim).toHaveBeenCalledWith(['log-1'])
    expect(result.guestsDispatchFailed).toBe(1)
    expect(result.guestsDispatched).toBe(0)
  })
})

describe('processDueFollowups — post-persist failure keeps the claim (audit row)', () => {
  it("DOES NOT release on stage='send' (avoids duplicate dispatch next tick)", async () => {
    vi.mocked(handleFollowup).mockResolvedValue({
      status: 'failed',
      stage: 'send',
      error: 'sendblue: 500',
    })
    const result = await processDueFollowups(NOW)
    expect(finalizeFollowupLogClaim).not.toHaveBeenCalled()
    expect(releaseFollowupLogClaim).not.toHaveBeenCalled()
    expect(result.guestsDispatchFailed).toBe(1)
  })

  it("DOES NOT release on stage='persist' (row may have been written)", async () => {
    vi.mocked(handleFollowup).mockResolvedValue({
      status: 'failed',
      stage: 'persist',
      error: 'db unique violation',
    })
    const result = await processDueFollowups(NOW)
    expect(releaseFollowupLogClaim).not.toHaveBeenCalled()
    expect(result.guestsDispatchFailed).toBe(1)
  })

  it("DOES release on pre-persist stage failures (e.g., stage='generation')", async () => {
    vi.mocked(handleFollowup).mockResolvedValue({
      status: 'failed',
      stage: 'generation',
      error: 'ai error',
    })
    vi.mocked(releaseFollowupLogClaim).mockResolvedValue({
      ok: true,
      data: { deletedCount: 1 },
    })
    const result = await processDueFollowups(NOW)
    expect(releaseFollowupLogClaim).toHaveBeenCalledWith(['log-1'])
    expect(result.guestsDispatchFailed).toBe(1)
  })

  it('keeps the claim when handleFollowup throws unexpectedly (unknown side-effect state)', async () => {
    vi.mocked(handleFollowup).mockRejectedValue(new Error('boom'))
    const result = await processDueFollowups(NOW)
    expect(releaseFollowupLogClaim).not.toHaveBeenCalled()
    expect(result.guestsDispatchFailed).toBe(1)
  })
})

describe('processDueFollowups — gate suppression', () => {
  it('fires captureFollowupSuppressed without claiming or dispatching', async () => {
    // Force opt-out via the guest mock.
    vi.mocked(createAdminClient).mockImplementation(
      () =>
        makeSupabaseMock({
          venues: [
            {
              id: VENUE_ID,
              timezone: 'America/Los_Angeles',
              venue_configs: {
                followup_rules: null,
                messaging_cadence: { day_7: true },
              },
            },
          ],
          guests: [
            {
              id: GUEST_ID,
              opted_out_at: '2026-01-01T00:00:00Z',
              last_inbound_at: null,
              last_visit_at: new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
              phone_number: '+15551230000',
              instagram_scoped_id: null,
            },
          ],
        }) as unknown as ReturnType<typeof createAdminClient>,
    )
    const result = await processDueFollowups(NOW)
    expect(claimFollowupLogRows).not.toHaveBeenCalled()
    expect(handleFollowup).not.toHaveBeenCalled()
    expect(captureFollowupSuppressed).toHaveBeenCalledOnce()
    expect(result.guestsSuppressed).toBe(1)
    expect(result.suppressedBy.opted_out).toBe(1)
  })
})

describe('processDueFollowups — venue local-hour filter', () => {
  it("skips venues whose local hour doesn't match cron_hour_local", async () => {
    // Pin NOW to 3am Pacific — no venue should dispatch at this hour with
    // the default cron_hour_local=10.
    const nowEarly = new Date('2026-06-04T10:00:00Z') // 03:00 PT
    const result = await processDueFollowups(nowEarly)
    expect(handleFollowup).not.toHaveBeenCalled()
    expect(result.venuesScanned).toBe(1)
    expect(result.venuesDispatching).toBe(0)
    expect(result.guestsEvaluated).toBe(0)
  })
})


// TAC-469 PR B. Instagram has a 24-hour reply window that only the guest can
// reopen, so a SCHEDULED follow-up there is never a send: it is recorded as a
// task for a human. Rule 2 — outbound splits by ORIGIN, not by window state —
// so this holds whether or not the window happens to be open right now, and
// nothing here checks it.
describe('Instagram follow-ups are recorded, never sent (TAC-469 PR B)', () => {
  const instagramGuest = (overrides: Record<string, unknown> = {}) => ({
    venues: [
      {
        id: VENUE_ID,
        timezone: 'America/Los_Angeles',
        venue_configs: {
          followup_rules: null,
          messaging_cadence: { day_1: false, day_3: false, day_7: true, day_14: true },
        },
      },
    ],
    guests: [
      {
        id: GUEST_ID,
        opted_out_at: null,
        last_inbound_at: null,
        last_visit_at: new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        phone_number: null,
        instagram_scoped_id: '17841400000000001',
        ...overrides,
      },
    ],
  })

  const useGuest = (shape: ReturnType<typeof instagramGuest>) => {
    vi.mocked(createAdminClient).mockImplementation(
      () => makeSupabaseMock(shape) as unknown as ReturnType<typeof createAdminClient>,
    )
  }

  // The engine could not even SEE an Instagram guest before this: the scan
  // filtered `phone_number is not null`, so their follow-ups were silently
  // never considered. Asserted on the filter itself because a guest who is
  // never returned is indistinguishable from one with nothing due.
  it('scans guests reachable on either channel, not just those with a phone', async () => {
    useGuest(instagramGuest())
    await processDueFollowups(NOW)
    expect(capturedGuestOrFilter).toBe(
      'phone_number.not.is.null,instagram_scoped_id.not.is.null',
    )
    expect(capturedGuestSelect).toContain('instagram_scoped_id')
    expect(capturedGuestSelect).toContain('phone_number')
  })

  it('records a task and never calls handleFollowup', async () => {
    useGuest(instagramGuest())
    const result = await processDueFollowups(NOW)

    expect(handleFollowup).not.toHaveBeenCalled()
    expect(recordManualFollowupTask).toHaveBeenCalledWith(['log-1'], NOW)
    expect(result.guestsTasked).toBe(1)
    expect(result.guestsDispatched).toBe(0)
  })

  // The claim is KEPT. Releasing would burn nothing and the guest would be
  // re-detected tomorrow, and every morning after, for the same visit.
  it('keeps the claim, so the dedup burns exactly as a send would', async () => {
    useGuest(instagramGuest())
    await processDueFollowups(NOW)
    expect(releaseFollowupLogClaim).not.toHaveBeenCalled()
    expect(finalizeFollowupLogClaim).not.toHaveBeenCalled()
  })

  // Until TAC-486 builds the card surface this relay is the ONLY way anyone
  // learns the venue owed this guest a touch.
  it('fires the recorded-task event with the log rows TAC-486 reads', async () => {
    useGuest(instagramGuest())
    await processDueFollowups(NOW)
    expect(captureFollowupManualTaskRecorded).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: VENUE_ID,
        guestId: GUEST_ID,
        channel: 'instagram',
        followupLogIds: ['log-1'],
        reasons: ['post_visit_day_7'],
        primaryReason: 'post_visit_day_7',
      }),
    )
  })

  // A failed write leaves the claim in place rather than releasing it: the row
  // is the only durable record the touch was owed, and releasing would re-detect
  // tomorrow. It reads as an orphaned claim, which is the audit signal.
  it('leaves the claim in place when the task write fails', async () => {
    useGuest(instagramGuest())
    vi.mocked(recordManualFollowupTask).mockResolvedValue({
      ok: false,
      error: 'recordManualFollowupTask: boom',
    })
    const result = await processDueFollowups(NOW)

    expect(releaseFollowupLogClaim).not.toHaveBeenCalled()
    expect(captureFollowupManualTaskRecorded).not.toHaveBeenCalled()
    expect(result.guestsTasked).toBe(0)
    expect(result.guestsDispatchFailed).toBe(1)
  })

  // The positive half, and the one that would catch this change silently
  // swallowing SMS: an ordinary phone guest still dispatches, and is never
  // recorded as a task.
  it('leaves an SMS guest dispatching exactly as before', async () => {
    const result = await processDueFollowups(NOW)
    expect(handleFollowup).toHaveBeenCalledOnce()
    expect(recordManualFollowupTask).not.toHaveBeenCalled()
    expect(captureFollowupManualTaskRecorded).not.toHaveBeenCalled()
    expect(result.guestsTasked).toBe(0)
    expect(result.guestsDispatched).toBe(1)
  })

  // A guest with both identifiers resolves phone-first, because every proactive
  // send goes to a phone number today. No such guest exists on file; this pins
  // the choice so it is revisited deliberately rather than discovered.
  it('sends to a guest who has both identifiers, rather than recording a task', async () => {
    useGuest(instagramGuest({ phone_number: '+15551230000' }))
    const result = await processDueFollowups(NOW)
    expect(handleFollowup).toHaveBeenCalledOnce()
    expect(recordManualFollowupTask).not.toHaveBeenCalled()
    expect(result.guestsDispatched).toBe(1)
    expect(result.guestsTasked).toBe(0)
  })
})
