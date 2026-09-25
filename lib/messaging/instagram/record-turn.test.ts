import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * TAC-523: the adapter between an Instagram delivery the agent never saw and
 * the ledger. The INSERT itself is covered in
 * lib/agent/record-inbound-turn-outcome.test.ts; what matters here is the
 * mapping — which identity columns a given outcome can honestly fill, and that
 * nothing guest-written reaches `detail`.
 */

const insertMock = vi.fn()
vi.mock('@/lib/agent/record-inbound-turn-outcome', () => ({
  insertInboundTurnOutcome: (...a: unknown[]) => insertMock(...a),
}))

import { recordInstagramTurnNotRun } from './record-turn'
import type { InstagramEventOutcome } from './handle-events'

function written(): Record<string, unknown> {
  return insertMock.mock.calls.at(-1)?.[0] as Record<string, unknown>
}

const persisted: InstagramEventOutcome = {
  status: 'persisted',
  kind: 'message',
  hadPriorConversation: null,
  venueId: 'venue-1',
  guestId: 'guest-1',
  messageId: 'msg-1',
  guestCreated: true,
  hasReferral: true,
  referralSource: 'SHORTLINK',
  hasProviderSentAt: true,
  titlelessPostback: false,
  guestCreatedVia: 'qr_scan',
}

beforeEach(() => {
  vi.clearAllMocks()
  insertMock.mockResolvedValue(undefined)
})

describe('recordInstagramTurnNotRun', () => {
  it('writes a webhook-layer not_run row on the Instagram channel', async () => {
    await recordInstagramTurnNotRun(persisted, 'gate_shut')
    expect(written()).toMatchObject({
      layer: 'webhook',
      channel: 'instagram',
      // No agent ran, so there is no run to correlate with. Null rather than a
      // fabricated id, which would look like a run that never happened.
      agentRunId: null,
      entry: { outcome: 'not_run', reason: 'gate_shut', outboundMessageId: null },
    })
  })

  it('fills every identity column from a persisted outcome', async () => {
    await recordInstagramTurnNotRun(persisted, 'gate_shut')
    expect(written()).toMatchObject({
      venueId: 'venue-1',
      guestId: 'guest-1',
      inboundMessageId: 'msg-1',
    })
  })

  it('leaves identity null for a skipped outcome, which is the case that has none', async () => {
    // venue_not_found is precisely "we could not resolve who this belongs to".
    // A row that required a venue could not describe it — which is why all
    // three columns are nullable in migration 055.
    await recordInstagramTurnNotRun(
      { status: 'skipped', kind: 'message', reason: 'venue_not_found', venueId: null },
      'event_not_persisted',
    )
    expect(written()).toMatchObject({
      venueId: null,
      guestId: null,
      inboundMessageId: null,
      entry: { detail: { kind: 'message', skippedReason: 'venue_not_found' } },
    })
  })

  it('carries the venue for unknown_guest, where it IS known', async () => {
    // MAJOR from code review: `skipped` and `failed` used to write venueId
    // null unconditionally. But only `venue_not_found` genuinely lacks one —
    // every later stage has it in scope. A message_insert storm at a venue was
    // therefore invisible to `where venue_id = ...`, the headline read on this
    // table, which is the most important population it holds.
    await recordInstagramTurnNotRun(
      { status: 'skipped', kind: 'message', reason: 'unknown_guest', venueId: 'venue-1' },
      'event_not_persisted',
    )
    expect(written()).toMatchObject({ venueId: 'venue-1' })
  })

  it('carries the venue for a failed save, which is the population that matters most', async () => {
    await recordInstagramTurnNotRun(
      { status: 'failed', kind: 'message', stage: 'message_insert', error: 'x', code: '08006', venueId: 'venue-1' },
      'event_not_persisted',
    )
    expect(written()).toMatchObject({ venueId: 'venue-1' })
  })

  it('records a guest message Meta could not render', async () => {
    // message_unsupported: a voice note or sticker. Saved nowhere, answered by
    // nothing, and before this counted as not-a-turn — under-reporting the
    // denominator in the one case where the guest got silence.
    await recordInstagramTurnNotRun(
      { status: 'unhandled', reason: 'message_unsupported', fields: [] },
      'message_unrenderable',
    )
    expect(written()).toMatchObject({
      venueId: null,
      entry: { outcome: 'not_run', reason: 'message_unrenderable', detail: { reason: 'message_unsupported' } },
    })
  })

  it('records the failure stage and PostgREST code for a failed save', async () => {
    await recordInstagramTurnNotRun(
      { status: 'failed', kind: 'postback', stage: 'message_insert', error: 'boom', code: '23505', venueId: 'venue-1' },
      'event_not_persisted',
    )
    expect(written()).toMatchObject({
      entry: { detail: { kind: 'postback', stage: 'message_insert', code: '23505' } },
    })
  })

  it('never carries the error TEXT into the row', async () => {
    // logInstagramOutcome's rule, applied here: the code and the stage are
    // vocabulary, the message can quote the failing row's values.
    await recordInstagramTurnNotRun(
      {
        status: 'failed',
        kind: 'message',
        stage: 'message_insert',
        error: 'duplicate key: body=(is rayan working tomorrow)',
        code: '23505',
        venueId: 'venue-1',
      },
      'event_not_persisted',
    )
    expect(JSON.stringify(written())).not.toContain('rayan')
  })

  it('carries no guest-written content from a persisted outcome either', async () => {
    await recordInstagramTurnNotRun(persisted, 'titleless_postback')
    const serialized = JSON.stringify(written())
    // The scoped id never appears in an outcome, but the referral ref and the
    // handle are the fields most likely to be added later by someone widening
    // `detail`; this pins the current, deliberate set.
    expect(Object.keys((written().entry as { detail: object }).detail).sort()).toEqual([
      'guestCreated',
      'kind',
    ])
    expect(serialized).not.toContain('SHORTLINK')
  })
})
