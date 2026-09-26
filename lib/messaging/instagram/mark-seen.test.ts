// TAC-540: Seen fires for a live venue, and for nothing else this module
// decides.
//
// The exclusions the AGENT GATE owns (echo, read, bare scan, redelivery,
// titleless postback, shut gate) are tested where they are decided — in the
// webhook route's own tests, because this module is only ever called when the
// route already resolved `run`. What is tested HERE is the one exclusion the
// handoff cannot give us, the paused venue, plus the failure directions.
//
// Every assertion is on whether the Graph call HAPPENED, never on the return
// value alone: an outcome object saying `venue_halted` while the POST went out
// anyway is exactly the shape of the bug this file exists to prevent.

import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/analytics/posthog', () => ({
  captureInstagramSenderActionFailed: vi.fn(async () => undefined),
}))

import { captureInstagramSenderActionFailed } from '@/lib/analytics/posthog'
import { markInboundSeen, type MarkSeenDeps } from './mark-seen'
import { createInstagramDbFake, type FakeRow } from './testing/db-fake'

const VENUE_ID = 'venue-1'
const GUEST_ID = 'guest-1'
const ACCOUNT_ID = '17841400000000001'
const IGSID = '1000000000000001'
const TOKEN = 'IGAAtesttoken-value'
const TARGET = { venueId: VENUE_ID, guestId: GUEST_ID }

function venueRow(status: string | null): FakeRow {
  return { id: VENUE_ID, instagram_account_id: ACCOUNT_ID, status }
}

/** A send target that resolves, and records which venue and guest it was asked about. */
function stubDeps(over: Partial<MarkSeenDeps> = {}) {
  const loadTarget = vi.fn(async () => ({
    ok: true as const,
    target: { accountId: ACCOUNT_ID, recipientId: IGSID, token: TOKEN, tokenSource: 'env' as const },
  }))
  const sendAction = vi.fn(async () => ({ ok: true as const }))
  return { deps: { loadTarget, sendAction, ...over }, loadTarget, sendAction }
}

function dbWith(venue: FakeRow) {
  const fake = createInstagramDbFake({ venues: [venue], guests: [], messages: [] })
  return { supabase: fake.client, fake }
}

describe('a live venue', () => {
  it.each([['pending'], ['active'], [null]])(
    'marks seen at a venue whose status is %s',
    async (status) => {
      const { supabase } = dbWith(venueRow(status))
      const { deps, loadTarget, sendAction } = stubDeps()

      expect(await markInboundSeen(supabase, TARGET, deps)).toEqual({ status: 'sent' })
      // WHICH venue and guest, not merely that something was asked. A stub
      // that ignored its arguments would let the call site pass the wrong id
      // and still pass this test — the mutant token-stub.ts documents.
      expect(loadTarget).toHaveBeenCalledWith({ venueId: VENUE_ID, guestId: GUEST_ID })
      expect(sendAction).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        recipientId: IGSID,
        token: TOKEN,
      })
    },
  )

  /**
   * `pending` is migration 001's default and what the live pilot venue
   * carries, so an allow-list on `active` would switch Seen off at the only
   * venue that has guests. TAC-529 pays for this lesson at the reply level;
   * the case above covers it, and this pins the deny-list shape itself.
   */
  it('does not mark seen at a paused venue', async () => {
    const { supabase } = dbWith(venueRow('paused'))
    const { deps, loadTarget, sendAction } = stubDeps()

    expect(await markInboundSeen(supabase, TARGET, deps)).toEqual({
      status: 'venue_halted',
      venueStatus: 'paused',
    })
    expect(loadTarget).not.toHaveBeenCalled()
    expect(sendAction).not.toHaveBeenCalled()
  })

  it('does not mark seen at an archived venue', async () => {
    const { supabase } = dbWith(venueRow('archived'))
    const { deps, sendAction } = stubDeps()

    expect(await markInboundSeen(supabase, TARGET, deps)).toEqual({
      status: 'venue_halted',
      venueStatus: 'archived',
    })
    expect(sendAction).not.toHaveBeenCalled()
  })
})

describe('the failure directions', () => {
  /**
   * THE ONE THAT INVERTS isVenueProcessingHalted'S OWN DEFAULT. That helper
   * treats an unreadable status as "carry on", because there the decision is
   * whether to REPLY and silence is the worse failure. Here the only cost of
   * skipping is a missing tick, and the cost of getting it wrong is telling a
   * guest at a switched-off venue that somebody is reading.
   *
   * Fails if the read error is folded into the `?? null` that feeds the
   * shared predicate, which is the tidy a future reader is likeliest to make.
   */
  it('does NOT mark seen when the venue status cannot be read', async () => {
    const { supabase, fake } = dbWith(venueRow('active'))
    fake.failNext('venues', 'select', { message: 'connection reset' })
    const { deps, loadTarget, sendAction } = stubDeps()

    expect(await markInboundSeen(supabase, TARGET, deps)).toEqual({
      status: 'venue_status_unreadable',
    })
    expect(loadTarget).not.toHaveBeenCalled()
    expect(sendAction).not.toHaveBeenCalled()
  })

  it.each([
    ['guest_has_no_instagram_id'],
    ['venue_has_no_instagram_account'],
    ['token_missing'],
    ['token_unreadable'],
    ['lookup_failed'],
  ])('does not send when the send target is unresolvable (%s)', async (problem) => {
    const { supabase } = dbWith(venueRow('active'))
    const { deps, sendAction } = stubDeps({
      loadTarget: vi.fn(async () => ({ ok: false as const, problem: problem as never })),
    })

    expect(await markInboundSeen(supabase, TARGET, deps)).toEqual({
      status: 'no_send_target',
      problem,
    })
    expect(sendAction).not.toHaveBeenCalled()
  })

  it('captures a failed send, and returns rather than throwing', async () => {
    const { supabase } = dbWith(venueRow('active'))
    const { deps } = stubDeps({
      sendAction: vi.fn(async () => ({ ok: false as const, kind: 'token_rejected' as const, failure: null as never })),
    })

    expect(await markInboundSeen(supabase, TARGET, deps)).toEqual({
      status: 'send_failed',
      kind: 'token_rejected',
    })
    expect(captureInstagramSenderActionFailed).toHaveBeenCalledWith({
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      action: 'mark_seen',
      kind: 'token_rejected',
    })
  })

  /**
   * It runs inside `waitUntil`, where an escaping rejection is an unhandled
   * one. Both halves are asserted — that it resolves, and to WHAT — because a
   * catch that swallowed and returned undefined would also "not throw".
   */
  it('never throws, even when a dep does', async () => {
    const { supabase } = dbWith(venueRow('active'))
    const { deps } = stubDeps({
      loadTarget: vi.fn(async () => {
        throw new Error('socket hang up')
      }),
    })

    expect(await markInboundSeen(supabase, TARGET, deps)).toEqual({
      status: 'send_failed',
      kind: 'unexpected_throw',
    })
  })
})

describe('what reaches a log line', () => {
  /**
   * The scoped ID and the token are the two values this module holds that
   * must never be logged. Asserted over EVERY console call rather than one,
   * so a leak in the skip path is caught as well as one in the failure path.
   */
  it('never writes the scoped ID or the token to the console', async () => {
    const logged: unknown[] = []
    const spies = (['log', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(...args)
      }),
    )
    try {
      const { supabase } = dbWith(venueRow('active'))
      const { deps } = stubDeps({
        sendAction: vi.fn(async () => ({ ok: false as const, kind: 'rate_limited' as const, failure: null as never })),
      })
      await markInboundSeen(supabase, TARGET, deps)

      const rendered = JSON.stringify(logged)
      expect(rendered).not.toContain(IGSID)
      expect(rendered).not.toContain(TOKEN)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})
