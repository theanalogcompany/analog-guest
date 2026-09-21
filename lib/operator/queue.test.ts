import { INSTAGRAM_SEND_FAILED_REVIEW_REASON } from '@/lib/agent/dispatch-instagram-reply'
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

  // TAC-467. The Contract types guestPhoneFallback as a string, and
  // analog-operator parses `drafts` all-or-nothing with
  // `guestPhoneFallback: z.string()`: one null fails the parse, and every
  // operator who can see that venue gets an error instead of a queue. A
  // guest who came in on Instagram has no phone, so the projection must
  // send ''. The
  // generated RPC types say `string`, which is why this needs a test rather
  // than a compiler.
  it('sends an empty string, never null, for a guest with no phone, and keeps every other draft', async () => {
    const row = {
      venue_id: 'v1',
      venue_slug: 'mock-cafe',
      guest_display_name: null,
      guest_opted_out_at: null,
      draft_body: 'hello',
      category: 'reply',
      voice_fidelity: 0.8,
      review_reason: null,
      recognition_state: 'new',
      created_at: '2026-05-12T20:00:00.000Z',
      langfuse_trace_id: null,
      recent_context: null,
    }
    rpcMock.mockResolvedValue({
      data: [
        { ...row, draft_id: 'd1', guest_id: 'g1', guest_phone: null },
        { ...row, draft_id: 'd2', guest_id: 'g2', guest_phone: '+15555550009' },
      ],
      error: null,
    })
    const result = await listPendingQueue(['v1'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.drafts).toHaveLength(2)
    expect(result.drafts[0]!.guestPhoneFallback).toBe('')
    expect(result.drafts[1]!.guestPhoneFallback).toBe('+15555550009')
    for (const d of result.drafts) expect(typeof d.guestPhoneFallback).toBe('string')
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
    // All seventeen reachable values are here, and that completeness is the
    // acceptance criterion "every trigger in the copy table renders its own
    // sentence". `demo_bypass` and `crisis_safety_reply` are deliberately
    // absent: both land on review_state='auto_sent' and the RPC filters
    // review_state='pending', so neither can reach a card.
    const COPY_TABLE: ReadonlyArray<readonly [string, string]> = [
      // --- Obligation ---
      ['commitment_type_gated', 'This offers something free. Your call.'],
      ['comp_regex_backstop', "This sounds like it's offering something on the house."],
      [
        'complaint_commitment_floor',
        'Someone complained and this promises to make it right.',
      ],
      ['mechanic_offer_backstop', "This may be offering a perk that isn't on."],
      // TAC-401: transcribed from the approved plan on the ticket ([PLAN],
      // section 5) and the ruling comment that confirmed it, never read back
      // out of REVIEW_REASON_LABELS.
      ['prose_promise_backstop', 'This sounds like a promise to the guest. Your call.'],
      // --- Something outside the draft needs you ---
      ['knowledge_gap', "A guest asked something I don't have an answer for."],
      ['knowledge_gap_backstop', "I wasn't sure this was true, so I didn't send it."],
      ['grounding_check_failed', "I couldn't finish checking this one."],
      // TAC-401: the sibling of the line above, and deliberately a separate
      // sentence from prose_promise_backstop's — nothing was caught here.
      ['prose_promise_check_failed', "I couldn't check this one for a promise."],
      ['hold_all_outbound', "You're holding everything here right now."],
      // The TAC-361 defect. Previously 'Complaint needs your call' — an
      // explicit entry, not a fallthrough — which reached the operator on a
      // welcome reply to "Hi Himanshu!" with no complaint anywhere in it.
      ['category_requires_approval', 'You chose to review these yourself.'],
      // --- The draft came out wrong ---
      ['model_flagged', 'Something felt off about this one.'],
      ['self_talk_detected', 'I was talking about myself instead of to the guest.'],
      ['unverified_url', "Has a link we couldn't verify. Check it before sending."],
      ['fidelity_below_auto_send_floor', "This doesn't sound enough like you."],
      // TAC-364, new: the crash card's own reason. Until now it borrowed
      // knowledge_gap's, which claimed the guest had asked something
      // unanswerable when in fact the generator fell over.
      ['generation_failed', 'Something went wrong writing this one.'],
      // TAC-469: the copy is transcribed from the approved plan on the ticket
      // ([PLAN], section 6), never read back out of REVIEW_REASON_LABELS; the
      // KEY is imported, so renaming the constant without moving the copy
      // fails here instead of shipping a card that falls back to
      // 'Needs review' and loses the only line telling the operator the send
      // may have gone through.
      [INSTAGRAM_SEND_FAILED_REVIEW_REASON, "This reply didn't send on Instagram. Check the thread before sending it again."],
      // --- You're mid-thread with this guest ---
      ['previous_pending_held', 'Held behind an earlier message to this guest.'],
      [
        'operator_decline_initiated',
        "You passed on the last one, so here's another go.",
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
    // TAC-364, ruled 2026-09-14: NO card-facing string contains an em dash.
    // These are read fast on a phone mid-shift, and an em dash is a pause the
    // reader has to parse. Asserted over the WHOLE label map, not the two
    // strings that happened to carry one, so the next trigger added cannot
    // reintroduce it: any new key reaches this loop automatically through
    // _REVIEW_REASON_KEYS_FOR_TESTS. Goes through the real projection rather
    // than reading the map directly, so it checks exactly what the client
    // receives, on both card-facing fields (the primary label and the
    // secondary labels) and on the fallback. The code point is written as an
    // escape so this file's own prose can't satisfy or break the assertion.
    it('no card-facing label contains an em dash, including the fallback', async () => {
      const EM_DASH = /\u2014/
      const codes = [..._REVIEW_REASON_KEYS_FOR_TESTS, 'gibberish_unknown_code']
      for (const code of codes) {
        rpcMock.mockResolvedValueOnce({
          data: [{ ...baseRow, review_reason: code, review_triggers: [code] }],
          error: null,
        })
        const result = await listPendingQueue(['v1'])
        expect(result.ok).toBe(true)
        if (!result.ok) continue
        const draft = result.drafts[0]!
        expect({ code, label: draft.reviewReason }).not.toEqual(
          expect.objectContaining({ label: expect.stringMatching(EM_DASH) }),
        )
        for (const label of draft.reviewTriggerLabels) {
          expect({ code, label }).not.toEqual(
            expect.objectContaining({ label: expect.stringMatching(EM_DASH) }),
          )
        }
      }
      // Guards the guard: if the key export ever came back empty, the loop
      // above would pass vacuously on the fallback alone.
      expect(_REVIEW_REASON_KEYS_FOR_TESTS.length).toBeGreaterThan(0)
    })

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
          'This offers something free. Your call.',
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

    it('surfaces reviewTriggers as RAW CODES, unmodified', async () => {
      // Codes, not prose (TAC-364 ruling 1). The client subtracts
      // `reviewReasonCode` from this array to get the secondaries, and that
      // subtraction is only well defined because both sides are codes — the
      // first spec shipped prose here and would have made it impossible.
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
          'fidelity_below_auto_send_floor',
          'commitment_type_gated',
          'gibberish_unknown_code',
        ])
      }
    })

    it('surfaces reviewTriggerLabels index-aligned with the codes', async () => {
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
        const d = result.drafts[0]!
        expect(d.reviewTriggerLabels).toEqual([
          "This doesn't sound enough like you.",
          'This offers something free. Your call.',
          // Unrecognized code still renders something rather than leaking a
          // raw identifier at an operator.
          'Needs review',
        ])
        // The alignment invariant the Contract promises, asserted as PAIRS so
        // a re-sort of either array fails. A `forEach` comparing
        // `reviewTriggerLabels[i]` to itself would be a tautology, and a bare
        // length check passes any permutation.
        expect(d.reviewTriggers.map((code, i) => [code, d.reviewTriggerLabels[i]])).toEqual([
          ['fidelity_below_auto_send_floor', "This doesn't sound enough like you."],
          ['commitment_type_gated', 'This offers something free. Your call.'],
          ['gibberish_unknown_code', 'Needs review'],
        ])
      }
    })

    it('keeps the primary IN reviewTriggers — the server never dedupes', async () => {
      // Ruling 2. This field means "everything that fired"; a set that
      // silently omitted a member because it won the priority sort would be
      // worse to reason about than a duplicate. The client renders secondaries
      // as reviewTriggers minus reviewReasonCode.
      rpcMock.mockResolvedValue({
        data: [
          {
            ...baseRow,
            review_reason: 'commitment_type_gated',
            review_triggers: ['fidelity_below_auto_send_floor', 'commitment_type_gated'],
            ungrounded_claims: null,
          },
        ],
        error: null,
      })
      const result = await listPendingQueue(['v1'])
      expect(result.ok).toBe(true)
      if (result.ok) {
        const d = result.drafts[0]!
        expect(d.reviewTriggers).toContain(d.reviewReasonCode)
        // And the subtraction the client is expected to perform works.
        expect(d.reviewTriggers.filter((t) => t !== d.reviewReasonCode)).toEqual([
          'fidelity_below_auto_send_floor',
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
        expect(result.drafts[0]!.reviewTriggerLabels).toEqual([])
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
        expect(result.drafts[0]!.reviewTriggerLabels).toEqual([])
        expect(result.drafts[0]!.ungroundedClaims).toEqual([])
      }
    })

    it('collapses the column NULL-vs-[] split at the wire, deliberately', async () => {
      // The COLUMN distinguishes "the check never ran" (NULL) from "it ran and
      // found nothing" ([]) — that is TAC-364 ruling 3 and it is asserted at
      // the gate and persist layers. The WIRE does not: both are `[]`, because
      // neither produces a UI element and the Contract's
      // never-branch-on-presence guarantee is worth more to the client than a
      // distinction it would never act on. Pinned so the collapse reads as a
      // decision rather than as the distinction having been lost.
      const rows = [null, []].map((claims) => ({
        ...baseRow,
        review_reason: 'model_flagged',
        review_triggers: null,
        ungrounded_claims: claims,
      }))
      rpcMock.mockResolvedValue({ data: rows, error: null })
      const result = await listPendingQueue(['v1'])
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.drafts[0]!.ungroundedClaims).toEqual([])
        expect(result.drafts[1]!.ungroundedClaims).toEqual([])
      }
    })
  })
  // TAC-394. Contract (TAC-394 description, `## Contract`): "QueueDraft gains
  // otherPendingDraftsForGuest: number. The count of OTHER pending drafts for
  // the same guest at the same venue. Always present, 0 when there are none,
  // never undefined."
  describe('otherPendingDraftsForGuest (TAC-394)', () => {
    const baseRow = {
      draft_id: 'd1',
      venue_id: 'v1',
      venue_slug: 'x',
      guest_id: '18694d6a-6a80-470e-b334-acea7be1ed95',
      guest_display_name: null,
      guest_phone: '+15555550007',
      guest_opted_out_at: null,
      draft_body: 'hi',
      category: null,
      voice_fidelity: null,
      review_reason: null,
      review_triggers: null,
      ungrounded_claims: null,
      recognition_state: null,
      created_at: '2026-09-14T16:26:34.000Z',
      langfuse_trace_id: null,
      recent_context: null,
    }

    // Transcribed from the Contract's example: one guest, a comp card and a
    // conversation card, each reporting 1.
    it('carries the count on both of a guest\'s cards', async () => {
      rpcMock.mockResolvedValue({
        data: [
          {
            ...baseRow,
            draft_id: '11111111-1111-4111-8111-111111111111',
            review_reason: 'commitment_type_gated',
            other_pending_for_guest: 1,
          },
          {
            ...baseRow,
            draft_id: '22222222-2222-4222-8222-222222222222',
            review_reason: 'category_requires_approval',
            other_pending_for_guest: 1,
          },
        ],
        error: null,
      })
      const result = await listPendingQueue(['v1'])
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.drafts.map((d) => [d.messageId, d.otherPendingDraftsForGuest])).toEqual([
        ['11111111-1111-4111-8111-111111111111', 1],
        ['22222222-2222-4222-8222-222222222222', 1],
      ])
    })

    it('is 0 when the guest has no other card', async () => {
      rpcMock.mockResolvedValue({ data: [{ ...baseRow, other_pending_for_guest: 0 }], error: null })
      const result = await listPendingQueue(['v1'])
      expect(result.ok && result.drafts[0]!.otherPendingDraftsForGuest).toBe(0)
    })

    // Always present, never undefined, even against a function that predates
    // migration 042 and omits the column.
    it('is 0, never undefined, when the RPC omits the column', async () => {
      rpcMock.mockResolvedValue({ data: [{ ...baseRow }], error: null })
      const result = await listPendingQueue(['v1'])
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.drafts[0]).toHaveProperty('otherPendingDraftsForGuest', 0)
    })

    it('is 0 when the column is null', async () => {
      rpcMock.mockResolvedValue({
        data: [{ ...baseRow, other_pending_for_guest: null }],
        error: null,
      })
      const result = await listPendingQueue(['v1'])
      expect(result.ok && result.drafts[0]!.otherPendingDraftsForGuest).toBe(0)
    })
  })
})
