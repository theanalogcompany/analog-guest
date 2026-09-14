// Offline tests for listPendingQueue's row-normalization layer. The lateral
// join itself runs in Postgres (migration 018's list_operator_queue RPC) and
// is covered by the four-scenario manual UAT in the PR description. Here we
// verify the TypeScript glue: jsonb null → [], recognition state filter,
// pendingSinceMs computation, and short-circuit on empty allowlist.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { _REVIEW_REASON_KEYS_FOR_TESTS, listPendingQueue } from './queue'

const rpcMock = vi.fn()
const adminMock = vi.fn(() => ({ rpc: rpcMock }))

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => adminMock(),
}))

describe('listPendingQueue', () => {
  beforeEach(() => {
    rpcMock.mockReset()
    adminMock.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('short-circuits to empty drafts when the operator has no venue access', async () => {
    const result = await listPendingQueue([])
    expect(result).toEqual({ ok: true, drafts: [] })
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('passes allowedVenueIds through to the RPC verbatim', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null })
    await listPendingQueue(['venue-a', 'venue-b'])
    expect(rpcMock).toHaveBeenCalledWith('list_operator_queue', {
      venue_ids: ['venue-a', 'venue-b'],
    })
  })

  it('normalizes a jsonb null recent_context to an empty array', async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          draft_id: 'd1',
          venue_id: 'v1',
          venue_slug: 'mock-cafe',
          guest_id: 'g1',
          guest_display_name: 'Test',
          guest_phone: '+15555550001',
          guest_opted_out_at: null,
          draft_body: 'hello',
          category: 'reply',
          voice_fidelity: 0.85,
          review_reason: null,
          recognition_state: 'returning',
          created_at: '2026-05-12T20:00:00.000Z',
          langfuse_trace_id: null,
          recent_context: null, // ← jsonb_agg returned null (no prior messages)
        },
      ],
      error: null,
    })
    const result = await listPendingQueue(['v1'], Date.parse('2026-05-12T21:00:00.000Z'))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.drafts).toHaveLength(1)
      expect(result.drafts[0]!.recentContext).toEqual([])
    }
  })

  it('preserves recent_context entries with valid shape and drops malformed ones', async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          draft_id: 'd1',
          venue_id: 'v1',
          venue_slug: 'mock-cafe',
          guest_id: 'g1',
          guest_display_name: null,
          guest_phone: '+15555550002',
          guest_opted_out_at: null,
          draft_body: 'hello',
          category: null,
          voice_fidelity: null,
          review_reason: null,
          recognition_state: 'regular',
          created_at: '2026-05-12T20:00:00.000Z',
          langfuse_trace_id: null,
          recent_context: [
            // valid
            {
              id: 'ctx-1',
              direction: 'inbound',
              body: 'last text from guest',
              createdAt: '2026-05-12T19:55:00.000Z',
            },
            // valid (outbound)
            {
              id: 'ctx-2',
              direction: 'outbound',
              body: 'prior reply',
              createdAt: '2026-05-12T19:50:00.000Z',
            },
            // invalid direction — dropped
            {
              id: 'ctx-3',
              direction: 'sideways',
              body: 'oops',
              createdAt: '2026-05-12T19:45:00.000Z',
            },
            // missing field — dropped
            { id: 'ctx-4', direction: 'inbound', body: 'no createdAt' },
            // null entry — dropped
            null,
          ],
        },
      ],
      error: null,
    })
    const result = await listPendingQueue(['v1'])
    expect(result.ok).toBe(true)
    if (result.ok) {
      const ctx = result.drafts[0]!.recentContext
      expect(ctx).toHaveLength(2)
      expect(ctx.map((e) => e.id)).toEqual(['ctx-1', 'ctx-2'])
    }
  })

  it('normalizes unknown recognition_state values to null', async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          draft_id: 'd1',
          venue_id: 'v1',
          venue_slug: 'x',
          guest_id: 'g1',
          guest_display_name: null,
          guest_phone: '+15555550003',
          guest_opted_out_at: null,
          draft_body: 'hi',
          category: null,
          voice_fidelity: null,
          review_reason: null,
          recognition_state: 'super_regular', // not in the closed enum
          created_at: '2026-05-12T20:00:00.000Z',
          langfuse_trace_id: null,
          recent_context: null,
        },
      ],
      error: null,
    })
    const result = await listPendingQueue(['v1'])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.drafts[0]!.recognitionState).toBeNull()
    }
  })

  it('computes pendingSinceMs from created_at vs nowMs (clamped to 0 minimum)', async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          draft_id: 'd1',
          venue_id: 'v1',
          venue_slug: 'x',
          guest_id: 'g1',
          guest_display_name: null,
          guest_phone: '+15555550004',
          guest_opted_out_at: null,
          draft_body: 'hi',
          category: null,
          voice_fidelity: null,
          review_reason: null,
          recognition_state: null,
          created_at: '2026-05-12T20:00:00.000Z',
          langfuse_trace_id: null,
          recent_context: null,
        },
      ],
      error: null,
    })
    const now = Date.parse('2026-05-12T20:05:00.000Z')
    const result = await listPendingQueue(['v1'], now)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.drafts[0]!.pendingSinceMs).toBe(5 * 60 * 1000)
    }
  })

  it('returns ok: false with the error message on RPC failure', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'function does not exist' },
    })
    const result = await listPendingQueue(['v1'])
    expect(result).toEqual({ ok: false, error: 'function does not exist' })
  })

  describe('reviewReason normalization', () => {
    const baseRow = {
      draft_id: 'd1',
      venue_id: 'v1',
      venue_slug: 'x',
      guest_id: 'g1',
      guest_display_name: null,
      guest_phone: '+15555550005',
      guest_opted_out_at: null,
      draft_body: 'hi',
      category: null,
      voice_fidelity: null,
      recognition_state: null,
      created_at: '2026-05-12T20:00:00.000Z',
      langfuse_trace_id: null,
      recent_context: null,
    }

    // TAC-364: the COMPLETE copy table, transcribed VERBATIM from the ticket
    // description's table — not read back out of REVIEW_REASON_LABELS.
    //
    // These strings are cross-repo Contract surface: analog-operator renders
    // them as written. Per CLAUDE.md §Cross-repo contracts rule 5, an
    // assertion on contract surface comes from the Contract, never from the
    // implementation — a test written by reading the map can only ever confirm
    // that the map equals itself, which is exactly how TAC-310 certified a
    // live defect on every green run.
    //
    // All fifteen reachable values are here, and that completeness is the
    // acceptance criterion "every trigger in the copy table renders its own
    // sentence". `demo_bypass` and `crisis_safety_reply` are deliberately
    // absent: both land on review_state='auto_sent' and the RPC filters
    // review_state='pending', so neither can reach a card.
    const COPY_TABLE: ReadonlyArray<readonly [string, string]> = [
      // --- Obligation ---
      ['commitment_type_gated', 'This offers something free — your call.'],
      ['comp_regex_backstop', "This sounds like it's offering something on the house."],
      [
        'complaint_commitment_floor',
        'Someone complained and this promises to make it right.',
      ],
      ['mechanic_offer_backstop', "This may be offering a perk that isn't on."],
      // --- Something outside the draft needs you ---
      ['knowledge_gap', "A guest asked something I don't have an answer for."],
      ['knowledge_gap_backstop', "I wasn't sure this was true, so I didn't send it."],
      ['grounding_check_failed', "I couldn't finish checking this one."],
      ['hold_all_outbound', "You're holding everything here right now."],
      // The TAC-361 defect. Previously 'Complaint needs your call' — an
      // explicit entry, not a fallthrough — which reached the operator on a
      // welcome reply to "Hi Himanshu!" with no complaint anywhere in it.
      ['category_requires_approval', 'You chose to review these yourself.'],
      // --- The draft came out wrong ---
      ['model_flagged', 'Something felt off about this one.'],
      ['self_talk_detected', 'I was talking about myself instead of to the guest.'],
      ['fidelity_below_auto_send_floor', "This doesn't sound enough like you."],
      // TAC-364, new: the crash card's own reason. Until now it borrowed
      // knowledge_gap's, which claimed the guest had asked something
      // unanswerable when in fact the generator fell over.
      ['generation_failed', 'Something went wrong writing this one.'],
      // --- You're mid-thread with this guest ---
      ['previous_pending_held', 'Held behind an earlier message to this guest.'],
      [
        'operator_decline_initiated',
        "You passed on the last one — here's another go.",
      ],
      // Unrecognized values degrade to the fallback rather than borrowing
      // another trigger's sentence. `review_reason` has no CHECK constraint
      // and the write path is typed `string` end to end, so this is the only
      // thing standing between a stray value and a wrong explanation.
      ['gibberish_unknown_code', 'Needs review'],
    ]

    it.each(COPY_TABLE)('maps review_reason %s to %s', async (raw, expected) => {
      rpcMock.mockResolvedValue({
        data: [{ ...baseRow, review_reason: raw }],
        error: null,
      })
      const result = await listPendingQueue(['v1'])
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.drafts[0]!.reviewReason).toBe(expected)
      }
    })

    // TAC-364. The `it.each` above claims completeness, and until this guard
    // nothing enforced it: `tsc` forces copy to EXIST for a new trigger (the
    // map is total) but not for that copy to have been checked against the
    // Contract, and the table is hand-maintained. Same technique as TAC-348's
    // "universal rule classification completeness" guard, which exists because
    // the operator rail silently showed 14 of 21 rules for the same reason.
    it('covers every key in REVIEW_REASON_LABELS — no copy ships unchecked', () => {
      const covered = new Set(COPY_TABLE.map(([code]) => code))
      const missing = _REVIEW_REASON_KEYS_FOR_TESTS.filter((k) => !covered.has(k))
      expect(missing).toEqual([])
    })

    it('passes review_reason null through as null', async () => {
      rpcMock.mockResolvedValue({
        data: [{ ...baseRow, review_reason: null }],
        error: null,
      })
      const result = await listPendingQueue(['v1'])
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.drafts[0]!.reviewReason).toBeNull()
      }
    })
  })

  // TAC-364. The Contract's guarantee for all three is "always present, never
  // undefined — an empty array or empty string where there is nothing, so the
  // client never branches on presence." Every test below exists to pin one
  // half of that.
  describe('reviewReasonCode / reviewTriggers / ungroundedClaims', () => {
    const baseRow = {
      draft_id: 'd1',
      venue_id: 'v1',
      venue_slug: 'x',
      guest_id: 'g1',
      guest_display_name: null,
      guest_phone: '+15555550006',
      guest_opted_out_at: null,
      draft_body: 'hi',
      category: null,
      voice_fidelity: null,
      recognition_state: null,
      created_at: '2026-05-12T20:00:00.000Z',
      langfuse_trace_id: null,
      recent_context: null,
    }

    it('surfaces reviewReasonCode RAW, not normalized to the label', async () => {
      // The whole point of the field. Colour keys on this; if it carried the
      // label, a copy edit in REVIEW_REASON_LABELS would silently reclassify a
      // card — which is the defect that left analog-operator's queue-tone.ts
      // matching nothing at all.
      rpcMock.mockResolvedValue({
        data: [
          {
            ...baseRow,
            review_reason: 'commitment_type_gated',
            review_triggers: null,
            ungrounded_claims: null,
          },
        ],
        error: null,
      })
      const result = await listPendingQueue(['v1'])
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.drafts[0]!.reviewReasonCode).toBe('commitment_type_gated')
        expect(result.drafts[0]!.reviewReason).toBe(
          'This offers something free — your call.',
        )
      }
    })

    it("reviewReasonCode is '' — never null — when review_reason is null", async () => {
      rpcMock.mockResolvedValue({
        data: [
          { ...baseRow, review_reason: null, review_triggers: null, ungrounded_claims: null },
        ],
        error: null,
      })
      const result = await listPendingQueue(['v1'])
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.drafts[0]!.reviewReasonCode).toBe('')
      }
    })

    it('normalizes every review_triggers entry through the same label map', async () => {
      rpcMock.mockResolvedValue({
        data: [
          {
            ...baseRow,
            review_reason: 'commitment_type_gated',
            review_triggers: [
              'fidelity_below_auto_send_floor',
              'commitment_type_gated',
              'gibberish_unknown_code',
            ],
            ungrounded_claims: null,
          },
        ],
        error: null,
      })
      const result = await listPendingQueue(['v1'])
      expect(result.ok).toBe(true)
      if (result.ok) {
        // Order preserved: this is enumeration order from the gate — the order
        // the checks fired — and it is the only record of that. The primary is
        // in the middle here precisely to show it isn't re-sorted to the front.
        expect(result.drafts[0]!.reviewTriggers).toEqual([
          "This doesn't sound enough like you.",
          'This offers something free — your call.',
          'Needs review',
        ])
      }
    })

    it('maps a null review_triggers to [] so an old row renders as today', async () => {
      rpcMock.mockResolvedValue({
        data: [
          {
            ...baseRow,
            review_reason: 'model_flagged',
            review_triggers: null,
            ungrounded_claims: null,
          },
        ],
        error: null,
      })
      const result = await listPendingQueue(['v1'])
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.drafts[0]!.reviewTriggers).toEqual([])
        expect(result.drafts[0]!.reviewReason).toBe('Something felt off about this one.')
      }
    })

    it('passes ungrounded_claims through VERBATIM', async () => {
      // Deliberately not run through any label map or rewriter: these are the
      // verifier's quotations from the draft body, and the operator is being
      // shown exactly which sentence is suspect. Rewriting them defeats the
      // point of quoting.
      const claims = [
        'The wifi password is bloomsday.',
        'We roast a Panama Geisha every Tuesday.',
      ]
      rpcMock.mockResolvedValue({
        data: [
          {
            ...baseRow,
            review_reason: 'knowledge_gap_backstop',
            review_triggers: ['knowledge_gap_backstop'],
            ungrounded_claims: claims,
          },
        ],
        error: null,
      })
      const result = await listPendingQueue(['v1'])
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.drafts[0]!.ungroundedClaims).toEqual(claims)
      }
    })

    it('maps a null ungrounded_claims to []', async () => {
      rpcMock.mockResolvedValue({
        data: [
          {
            ...baseRow,
            review_reason: 'model_flagged',
            review_triggers: null,
            ungrounded_claims: null,
          },
        ],
        error: null,
      })
      const result = await listPendingQueue(['v1'])
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.drafts[0]!.ungroundedClaims).toEqual([])
      }
    })

    it('tolerates the columns being ABSENT (pre-039 RPC in local dev)', async () => {
      // Production can't reach this — migration 039 is Studio-applied before
      // the code that reads it merges — but a dev running new code against an
      // un-migrated database can, and a TypeError inside the queue read is a
      // bad way to find out.
      rpcMock.mockResolvedValue({
        data: [{ ...baseRow, review_reason: 'model_flagged' }],
        error: null,
      })
      const result = await listPendingQueue(['v1'])
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.drafts[0]!.reviewTriggers).toEqual([])
        expect(result.drafts[0]!.ungroundedClaims).toEqual([])
      }
    })
  })
})
