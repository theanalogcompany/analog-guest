import { beforeEach, describe, expect, it, vi } from 'vitest'
import { INBOUND_TURN_OUTCOMES, INBOUND_TURN_REASONS } from '@/lib/schemas/inbound-turn-outcome'

/**
 * TAC-523. The orchestrator file mocks this module wholesale, so this is where
 * the writer itself is exercised — against a fake that records what it was
 * asked to insert, not a mock that agrees with whatever it is handed.
 */

const insertMock = vi.fn()
const messageSelectMock = vi.fn()
const capturePostHogEventMock = vi.fn()
let adminClientThrows = false

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => {
    if (adminClientThrows) throw new Error('no service role key')
    return {
      from: (table: string) => ({
        insert: (row: unknown) => {
          insertMock(table, row)
          return insertMock.mock.results.at(-1)?.value ?? { error: null }
        },
        select: () => ({
          eq: () => ({ maybeSingle: () => messageSelectMock() }),
        }),
      }),
    }
  },
}))
vi.mock('./alerts', () => ({
  capturePostHogEvent: (...a: unknown[]) => capturePostHogEventMock(...a),
}))

import {
  insertInboundTurnOutcome,
  ledgerEntryFor,
  ledgerEntryForUnexpected,
  recordInboundTurnOutcome,
} from './record-inbound-turn-outcome'
import type { AgentResult } from './types'

const INBOUND_ID = '22222222-2222-4222-8222-222222222222'
const VENUE_ID = '00000000-0000-0000-0000-00000000000a'
const GUEST_ID = '11111111-1111-4111-8111-111111111111'

function insertedRow(): Record<string, unknown> {
  const call = insertMock.mock.calls.at(-1)
  expect(call?.[0], 'inserted into the wrong table').toBe('inbound_turn_outcomes')
  return call?.[1] as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  adminClientThrows = false
  insertMock.mockReturnValue({ error: null })
  messageSelectMock.mockResolvedValue({
    data: { venue_id: VENUE_ID, guest_id: GUEST_ID, channel: 'instagram' },
    error: null,
  })
})

describe('ledgerEntryFor — every AgentResult status maps to a ledger entry', () => {
  // A literal table, not one derived from the code under test: a derived
  // expectation would pass against any mapping at all.
  const CASES: Array<{ result: AgentResult; outcome: string; reason: string | null }> = [
    { result: { status: 'sent', outboundMessageId: 'o1' }, outcome: 'sent', reason: null },
    {
      result: { status: 'queued', outboundMessageId: 'c1', triggers: ['a'], primaryTrigger: 'a' },
      outcome: 'queued',
      reason: null,
    },
    { result: { status: 'skipped_duplicate' }, outcome: 'skipped_duplicate', reason: null },
    {
      result: { status: 'refused', reason: 'low_fidelity', attemptScores: [0.2] },
      outcome: 'refused',
      reason: 'low_fidelity',
    },
    {
      result: {
        status: 'dropped',
        reason: 'obligation_slot_taken',
        protectedDraftId: 'd1',
        triggers: [],
      },
      outcome: 'dropped',
      reason: 'obligation_slot_taken',
    },
    { result: { status: 'superseded', byMessageId: 'm1' }, outcome: 'superseded', reason: null },
    // TAC-526. Shares the 'superseded' OUTCOME with the case above and is told
    // apart by the reason, which is the whole point of the reason existing: a
    // bare 'superseded' is staff answering by hand in the Instagram app, this
    // is a burst the agent coalesced, and merging them makes both
    // unanswerable in SQL.
    //
    // The outcome-coverage test below could NOT have forced this case to
    // exist, because 'superseded' was already produced by its sibling — so a
    // typo in either literal shipped green, and two mutants proved it
    // ('coalesced_into_turn' misspelled, and the outcome flipped to 'failed',
    // which would have counted every coalesced message as a turn failure in
    // the denominator TAC-523 built the table to produce). Both die here now.
    {
      result: { status: 'coalesced', intoAgentRunId: 'run-a', intoMessageId: 'm2' },
      outcome: 'superseded',
      reason: 'coalesced_into_turn',
    },
    // TAC-397. A decision, not a failure — and the one outcome the ledger most
    // needs to tell apart, since a deliberate silence and a swallowed reply
    // are identical from the database without it.
    { result: { status: 'silenced' }, outcome: 'silenced', reason: null },
    {
      result: { status: 'failed', stage: 'corpus', error: 'thin' },
      outcome: 'failed',
      reason: 'corpus',
    },
    // TAC-529: the venue is paused or archived. `not_run` because the agent
    // was never invoked — the gate sits before context build — and this row
    // is what makes the guest's silence countable rather than
    // indistinguishable from a swallowed reply.
    {
      result: { status: 'venue_halted', venueStatus: 'paused' },
      outcome: 'not_run',
      reason: 'venue_paused',
    },
  ]

  it.each(CASES)('$outcome / $reason', ({ result, outcome, reason }) => {
    const entry = ledgerEntryFor(result)
    expect(entry.outcome).toBe(outcome)
    expect(entry.reason).toBe(reason)
  })

  /**
   * TAC-526. CASES is a literal table, so it can only ever check the members
   * someone remembered to add — and the outcome-coverage test below cannot
   * catch a missing one when its outcome is already produced by a sibling,
   * which is exactly how `coalesced` reached this file untested.
   *
   * This closes that by iterating the AgentResult union itself: every status
   * must appear in CASES. A new member fails here the moment the deriver's
   * total map forces someone to map it, rather than whenever a reader happens
   * to notice.
   */
  it('has a case for EVERY AgentResult status, not just the ones with a unique outcome', () => {
    const covered = new Set(CASES.map((c) => c.result.status))
    // Written out, not derived from CASES: a list built from the thing under
    // test agrees with it by construction.
    //
    // A TOTAL MAP, not an array with `satisfies readonly ...[]`. TAC-529
    // found that annotation checks only that each element IS a status; it
    // cannot check the list is COMPLETE, so the guard this block's docstring
    // describes did not exist. A tenth member (`venue_halted`) was added to
    // the union, mapped in LEDGER_DERIVERS, and walked straight past here
    // with every test green. `satisfies Record<…>` is exhaustiveness-checked,
    // so an eleventh fails `tsc` on this line instead.
    const EVERY_STATUS = {
      sent: true,
      queued: true,
      skipped_duplicate: true,
      refused: true,
      dropped: true,
      superseded: true,
      coalesced: true,
      silenced: true,
      venue_halted: true,
      failed: true,
    } as const satisfies Record<AgentResult['status'], true>
    const everyStatus = Object.keys(EVERY_STATUS) as AgentResult['status'][]
    expect([...everyStatus].filter((s) => !covered.has(s))).toEqual([])
  })

  it('covers every value in INBOUND_TURN_OUTCOMES', () => {
    // Every outcome must be produced by some case above, or the vocabulary
    // has a value nothing can ever write. This is what forced 'silenced' to
    // get a case when TAC-397 added it: the map would not compile, and then
    // this would not pass.
    //
    // TAC-529 EMPTIED THE EXCEPTION. 'not_run' used to be layer 1's alone —
    // no AgentResult existed for it — and this asserted exactly that. The
    // venue-status gate is an agent-layer decision taken before any stage
    // runs, so `venue_halted` now derives `not_run` and the list is fully
    // reachable. The assertion is an empty array rather than a deleted test:
    // a vocabulary value nothing can write is still worth catching, and that
    // is what this keeps checking.
    const produced = new Set(CASES.map((c) => c.outcome))
    const unreachable = INBOUND_TURN_OUTCOMES.filter((o) => !produced.has(o))
    expect(unreachable).toEqual([])
  })

  it('only ever produces reasons that are in the vocabulary', () => {
    for (const { result } of CASES) {
      const { reason } = ledgerEntryFor(result)
      if (reason !== null) expect(INBOUND_TURN_REASONS).toContain(reason)
    }
  })

  it('carries the outbound row id for sent and queued, and null otherwise', () => {
    expect(ledgerEntryFor({ status: 'sent', outboundMessageId: 'o1' }).outboundMessageId).toBe('o1')
    expect(
      ledgerEntryFor({
        status: 'queued',
        outboundMessageId: 'c1',
        triggers: [],
        primaryTrigger: 'x',
      }).outboundMessageId,
    ).toBe('c1')
    expect(ledgerEntryFor({ status: 'skipped_duplicate' }).outboundMessageId).toBeNull()
  })

  it('maps a followup-only stage to unexpected rather than violating the CHECK', () => {
    // venue_config_integrity is in AlertContext['stage'] but not in
    // INBOUND_TURN_REASONS. Passing it through would make the insert fail and
    // lose the whole record.
    const entry = ledgerEntryFor({
      status: 'failed',
      stage: 'venue_config_integrity' as AgentResult extends { stage: infer S } ? S : never,
      error: 'x',
    } as AgentResult)
    expect(entry.reason).toBe('unexpected')
    expect(entry.detail).toMatchObject({ stage: 'venue_config_integrity' })
  })

  it('truncates a long error rather than storing it whole', () => {
    const entry = ledgerEntryFor({ status: 'failed', stage: 'send', error: 'x'.repeat(500) })
    expect(String((entry.detail as { error: string }).error).length).toBeLessThanOrEqual(201)
  })

  it('ledgerEntryForUnexpected records the wrapper-caught throw', () => {
    const entry = ledgerEntryForUnexpected(new Error('boom'))
    expect(entry).toMatchObject({ outcome: 'failed', reason: 'unexpected' })
    expect(entry.detail).toMatchObject({ error: 'boom' })
  })
})

describe('recordInboundTurnOutcome — the row it writes', () => {
  it('resolves venue, guest and channel from the inbound row', async () => {
    await recordInboundTurnOutcome({
      inboundMessageId: INBOUND_ID,
      agentRunId: 'run-1',
      result: { status: 'sent', outboundMessageId: 'o1' },
    })
    expect(insertedRow()).toMatchObject({
      venue_id: VENUE_ID,
      guest_id: GUEST_ID,
      inbound_message_id: INBOUND_ID,
      outbound_message_id: 'o1',
      agent_run_id: 'run-1',
      channel: 'instagram',
      layer: 'agent',
      outcome: 'sent',
      reason: null,
    })
  })

  it('degrades an unrecognized stored channel to null instead of losing the row', async () => {
    // parseMessageChannel, not a pass-through: an unknown value would violate
    // the CHECK and take the whole record with it.
    messageSelectMock.mockResolvedValue({
      data: { venue_id: VENUE_ID, guest_id: GUEST_ID, channel: 'carrier-pigeon' },
      error: null,
    })
    await recordInboundTurnOutcome({
      inboundMessageId: INBOUND_ID,
      agentRunId: 'run-1',
      result: { status: 'skipped_duplicate' },
    })
    expect(insertedRow().channel).toBeNull()
    expect(insertMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the id as data when the inbound row is gone, so the FK cannot reject it', async () => {
    messageSelectMock.mockResolvedValue({ data: null, error: null })
    await recordInboundTurnOutcome({
      inboundMessageId: INBOUND_ID,
      agentRunId: 'run-1',
      result: { status: 'failed', stage: 'context_build', error: 'gone' },
    })
    const row = insertedRow()
    expect(row.inbound_message_id).toBeNull()
    expect(row.venue_id).toBeNull()
    expect(row.detail).toMatchObject({ missingInboundMessageId: INBOUND_ID })
  })

  it('tells a FAILED identity read from a genuinely absent row', async () => {
    // supabase-js returns a network failure as `{ error }` rather than
    // throwing (CLAUDE.md's own gotcha), so reading only `data` made a failed
    // read indistinguishable from a deleted message — and wrote
    // `missingInboundMessageId`, a false claim, into a durable record. The
    // correlated case is the expensive one: a blip that fails the agent turn
    // fails this read too, so the row for the incident was the one that lied.
    messageSelectMock.mockResolvedValue({
      data: null,
      error: { message: 'connection refused', code: '08006' },
    })
    await recordInboundTurnOutcome({
      inboundMessageId: INBOUND_ID,
      agentRunId: 'run-1',
      result: { status: 'failed', stage: 'context_build', error: 'blip' },
    })
    const detail = insertedRow().detail as Record<string, unknown>
    expect(detail.unverifiedInboundMessageId).toBe(INBOUND_ID)
    expect(detail.identityReadError).toBe('connection refused')
    expect(detail.missingInboundMessageId).toBeUndefined()
  })

  it('still writes the row when the identity read throws', async () => {
    messageSelectMock.mockRejectedValue(new Error('read timeout'))
    await recordInboundTurnOutcome({
      inboundMessageId: INBOUND_ID,
      agentRunId: 'run-1',
      result: { status: 'refused', reason: 'low_fidelity', attemptScores: [] },
    })
    expect(insertedRow()).toMatchObject({ outcome: 'refused', reason: 'low_fidelity' })
  })
})

describe('recordInboundTurnOutcome — never throws', () => {
  it('swallows an insert error and reports it to PostHog, not Slack', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    insertMock.mockReturnValue({ error: { message: 'relation does not exist', code: '42P01' } })

    await expect(
      recordInboundTurnOutcome({
        inboundMessageId: INBOUND_ID,
        agentRunId: 'run-1',
        result: { status: 'sent', outboundMessageId: 'o1' },
      }),
    ).resolves.toBeUndefined()

    expect(capturePostHogEventMock).toHaveBeenCalledWith(
      'inbound_turn_outcome_write_failed',
      expect.any(String),
      expect.objectContaining({ error: 'relation does not exist', code: '42P01' }),
    )
    err.mockRestore()
  })

  it('swallows a client that cannot even be constructed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    adminClientThrows = true
    await expect(
      recordInboundTurnOutcome({
        inboundMessageId: INBOUND_ID,
        agentRunId: 'run-1',
        result: { status: 'sent', outboundMessageId: 'o1' },
      }),
    ).resolves.toBeUndefined()
    expect(capturePostHogEventMock).toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('insertInboundTurnOutcome — the shared writer', () => {
  it('writes a webhook-layer row with no agent run', async () => {
    await insertInboundTurnOutcome({
      layer: 'webhook',
      entry: {
        outcome: 'not_run',
        reason: 'gate_shut',
        outboundMessageId: null,
        detail: { gate: 'INSTAGRAM_AGENT_REPLIES_ENABLED' },
      },
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      inboundMessageId: INBOUND_ID,
      channel: 'instagram',
      agentRunId: null,
    })
    expect(insertedRow()).toMatchObject({
      layer: 'webhook',
      outcome: 'not_run',
      reason: 'gate_shut',
      agent_run_id: null,
      channel: 'instagram',
    })
  })

  // The previous version of this test planted `guestPhoneLast4: '0123'` itself
  // and then asserted the row did not contain a full number it had never put
  // there — it could not fail, and `insertInboundTurnOutcome` had no redaction
  // at all. Code review caught it. These drive the real guard with a number
  // the CALLER supplies, which is the shape PR 2 will have.
  it('REDACTS a full phone number a caller puts in detail', async () => {
    await insertInboundTurnOutcome({
      layer: 'webhook',
      entry: {
        outcome: 'not_run',
        reason: 'venue_not_found',
        outboundMessageId: null,
        detail: { guestPhone: '+15555550123', guestPhoneLast4: '0123' },
      },
      venueId: null,
      guestId: null,
      inboundMessageId: null,
      channel: 'text',
      agentRunId: null,
    })
    const serialized = JSON.stringify(insertedRow())
    expect(serialized).not.toContain('+15555550123')
    expect(serialized).toContain('[redacted]')
    // The last four are deliberately KEPT: too short to match, and they are
    // the captureDraftDropped posture this repo already uses.
    expect(serialized).toContain('0123')
  })

  it('redacts a number nested inside detail, not just a top-level string', async () => {
    await insertInboundTurnOutcome({
      layer: 'webhook',
      entry: {
        outcome: 'not_run',
        reason: 'venue_not_found',
        outboundMessageId: null,
        detail: { payload: { from: '+1 (555) 555-0123' }, tried: ['15555550123'] },
      },
      venueId: null,
      guestId: null,
      inboundMessageId: null,
      channel: 'text',
      agentRunId: null,
    })
    const serialized = JSON.stringify(insertedRow())
    expect(serialized).not.toContain('555')
    expect(serialized).toContain('[redacted]')
  })

  it('does NOT eat a uuid in detail, which is digits and hyphens too', async () => {
    // The regression that caught the first draft of the redactor: an
    // all-numeric uuid matches PHONE_LIKE exactly, so `missingInboundMessageId`
    // came back '[redacted]'. A guard that destroys the ids is worse than the
    // leak — the ids are what the table is for.
    await insertInboundTurnOutcome({
      layer: 'agent',
      entry: {
        outcome: 'failed',
        reason: 'context_build',
        outboundMessageId: null,
        detail: { missingInboundMessageId: INBOUND_ID, note: `saw ${INBOUND_ID} go missing` },
      },
      venueId: null,
      guestId: null,
      inboundMessageId: null,
      channel: 'text',
      agentRunId: 'run-1',
    })
    const serialized = JSON.stringify(insertedRow())
    expect(serialized).toContain(INBOUND_ID)
    expect(serialized).not.toContain('[redacted]')
  })

  it('redacts a phone number sitting NEXT TO a uuid in the same string', async () => {
    await insertInboundTurnOutcome({
      layer: 'webhook',
      entry: {
        outcome: 'not_run',
        reason: 'venue_not_found',
        outboundMessageId: null,
        detail: { note: `guest +15555550123 for message ${INBOUND_ID}` },
      },
      venueId: null,
      guestId: null,
      inboundMessageId: null,
      channel: 'text',
      agentRunId: null,
    })
    const serialized = JSON.stringify(insertedRow())
    expect(serialized).not.toContain('+15555550123')
    expect(serialized).toContain('[redacted]')
    expect(serialized).toContain(INBOUND_ID)
  })

  it('leaves ordinary vocabulary and ids alone', async () => {
    // Over-redaction would make the table useless. A uuid has hyphens and
    // letters, so it never matches; neither does a trigger name.
    await insertInboundTurnOutcome({
      layer: 'agent',
      entry: {
        outcome: 'queued',
        reason: null,
        outboundMessageId: 'card-1',
        detail: { primaryTrigger: 'model_flagged', triggers: ['model_flagged'] },
      },
      venueId: VENUE_ID,
      guestId: GUEST_ID,
      inboundMessageId: INBOUND_ID,
      channel: 'text',
      agentRunId: 'run-1',
    })
    const serialized = JSON.stringify(insertedRow())
    expect(serialized).toContain('model_flagged')
    expect(serialized).toContain(GUEST_ID)
    expect(serialized).not.toContain('[redacted]')
  })
})
