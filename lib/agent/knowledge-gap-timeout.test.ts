import { beforeEach, describe, expect, it, vi } from 'vitest'

// The processor imports ./stages, which pulls in @/lib/rag → voyageai, whose
// ESM build trips vitest's directory-import resolver at module load. Same
// mock as lib/tunables/manifest.test.ts; see CLAUDE.md "Module split for
// testability". Must precede the import below.
vi.mock('voyageai', () => ({ VoyageAIClient: class {} }))

import {
  KNOWLEDGE_GAP_HOLDING_MESSAGE_ENABLED,
  processDueKnowledgeGaps,
} from './knowledge-gap-timeout'

// TAC-484: the mechanism is disabled by default (KNOWLEDGE_GAP_HOLDING_MESSAGE_ENABLED
// = false), so every test below that exercises the scan/claim/send path
// passes `true` explicitly — same shape as agent-gate.test.ts pinning
// INSTAGRAM_AGENT_REPLIES_ENABLED and exercising its shut behaviour through
// the parameter. The "disabled by default" describe block near the bottom of
// this file is what actually pins the production default.

// The processor is the piece that decides WHICH cards fire and WHETHER a
// second run can fire them again. Everything downstream of the claim
// (generation, send, card regen) is mocked out so these tests measure the
// scan predicate and the CAS, which is where the double-send risk lives.

const handleHoldingMessageMock = vi.fn()
vi.mock('./handle-holding-message', () => ({
  handleHoldingMessage: (...args: unknown[]) => handleHoldingMessageMock(...args),
}))

// The post-send card regen builds a full runtime context. Making it throw
// keeps these tests focused; the processor treats a regen failure as
// best-effort and carries on, which is asserted explicitly below.
vi.mock('./build-runtime-context', () => ({
  buildRuntimeContext: vi.fn(async () => {
    throw new Error('regen not under test')
  }),
}))
vi.mock('./schedule-and-send', () => ({ persistOrRegenQueuedDraft: vi.fn() }))
vi.mock('@/lib/observability', () => ({
  startAgentTrace: () => ({
    id: '',
    span: () => ({ end: vi.fn(), span: () => ({ end: vi.fn() }) }),
    update: vi.fn(),
    flushAsync: vi.fn(async () => {}),
    captureContent: false,
  }),
}))

/**
 * Rows the fake DB will return, and a log of the claim UPDATEs issued.
 *
 * `claimedIds` is the real subject of most assertions: the CAS is modelled
 * the way Postgres actually behaves — the first UPDATE matching
 * `pending_until IS NOT NULL` wins and clears the column, so a second
 * identical UPDATE matches zero rows.
 */
const db = {
  dueRows: [] as Array<Record<string, unknown>>,
  questions: new Map<string, { id: string; body: string; created_at: string; provider_message_id: string }>(),
  /** ids whose pending_until is currently non-null (i.e. claimable). */
  claimable: new Set<string>(),
  claimedIds: [] as string[],
  claimError: false,
}

// A vi.fn() wrapper so the "disabled by default" tests below can assert NO
// DB call was ever attempted, not merely that the summary came back empty.
const createAdminClientMock = vi.fn(() => ({
  from: () => makeQuery(),
}))
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => createAdminClientMock(),
}))

/**
 * Minimal chainable stand-in. Distinguishes the three shapes the processor
 * issues: the due-scan (select → … → limit, awaited), the claim
 * (update → … → maybeSingle) and the question read (select → eq(id) →
 * maybeSingle).
 */
function makeQuery() {
  let isUpdate = false
  let targetId: string | null = null

  const q: Record<string, unknown> = {}
  const chain = () => q

  q.select = chain
  q.not = chain
  q.lte = chain
  q.order = chain
  q.update = () => {
    isUpdate = true
    return q
  }
  q.eq = (col: string, val: unknown) => {
    if (col === 'id') targetId = String(val)
    return q
  }
  // Terminal for the due scan.
  q.limit = () => Promise.resolve({ data: db.dueRows, error: null })
  // Terminal for the claim and the question read.
  q.maybeSingle = () => {
    if (isUpdate) {
      if (db.claimError) return Promise.resolve({ data: null, error: { message: 'boom' } })
      if (targetId && db.claimable.has(targetId)) {
        // CAS won: clear the clock so a concurrent/second run can't re-win.
        db.claimable.delete(targetId)
        db.claimedIds.push(targetId)
        return Promise.resolve({ data: { id: targetId }, error: null })
      }
      // CAS lost: the row no longer matches `pending_until IS NOT NULL`.
      return Promise.resolve({ data: null, error: null })
    }
    const row = targetId ? db.questions.get(targetId) : undefined
    return Promise.resolve({ data: row ?? null, error: null })
  }
  return q
}

function seedCard(id: string, inboundId: string | null) {
  db.dueRows.push({
    id,
    venue_id: 'venue-1',
    guest_id: `guest-${id}`,
    reply_to_message_id: inboundId,
    category: 'new_question',
  })
  db.claimable.add(id)
  if (inboundId) {
    db.questions.set(inboundId, {
      id: inboundId,
      body: 'what grade is the matcha?',
      created_at: new Date('2026-08-07T12:00:00Z').toISOString(),
      provider_message_id: 'p1',
    })
  }
}

beforeEach(() => {
  db.dueRows = []
  db.questions = new Map()
  db.claimable = new Set()
  db.claimedIds = []
  db.claimError = false
  createAdminClientMock.mockClear()
  handleHoldingMessageMock.mockReset()
  handleHoldingMessageMock.mockResolvedValue({
    status: 'sent',
    outboundMessageId: 'out-1',
    usedFallback: false,
  })
})

describe('processDueKnowledgeGaps (TAC-308)', () => {
  it('claims a due card and sends one holding message', async () => {
    seedCard('card-1', 'inbound-1')
    const summary = await processDueKnowledgeGaps(new Date(), true)
    expect(summary.scanned).toBe(1)
    expect(summary.claimed).toBe(1)
    expect(summary.sent).toBe(1)
    expect(handleHoldingMessageMock).toHaveBeenCalledTimes(1)
  })

  it('passes the guest question through to the holding-message generation', async () => {
    seedCard('card-1', 'inbound-1')
    await processDueKnowledgeGaps(new Date(), true)
    expect(handleHoldingMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'venue-1',
        guestId: 'guest-card-1',
        pendingQuestion: expect.objectContaining({ question: 'what grade is the matcha?' }),
        // TAC-469: the card's own question row, for the Instagram reply check.
        questionMessageId: 'inbound-1',
      }),
    )
  })

  // THE acceptance criterion: "Holding message cannot double-fire (verified
  // by re-running the cron)." The claim clears pending_until, so the second
  // run's conditional UPDATE matches nothing.
  it('is a no-op on a second run — the holding message cannot double-fire', async () => {
    seedCard('card-1', 'inbound-1')
    await processDueKnowledgeGaps(new Date(), true)
    expect(handleHoldingMessageMock).toHaveBeenCalledTimes(1)

    // Second tick: the row is still returned by a stale scan, but the CAS
    // now loses because the clock was cleared by the first run.
    handleHoldingMessageMock.mockClear()
    const second = await processDueKnowledgeGaps(new Date(), true)
    expect(second.casLost).toBe(1)
    expect(second.claimed).toBe(0)
    expect(handleHoldingMessageMock).not.toHaveBeenCalled()
  })

  // Same guarantee against CONCURRENT runs rather than sequential ones:
  // overlapping GH Actions ticks must not both send.
  it('lets exactly one of two concurrent runs win the claim', async () => {
    seedCard('card-1', 'inbound-1')
    const [a, b] = await Promise.all([
      processDueKnowledgeGaps(new Date(), true),
      processDueKnowledgeGaps(new Date(), true),
    ])
    expect(a.claimed + b.claimed).toBe(1)
    expect(a.casLost + b.casLost).toBe(1)
    expect(handleHoldingMessageMock).toHaveBeenCalledTimes(1)
    expect(db.claimedIds).toEqual(['card-1'])
  })

  // An operator approving the draft flips review_state out of 'pending', so
  // the conditional UPDATE misses and the guest never gets a holding message
  // on top of a real answer. Modelled here as the row no longer being
  // claimable.
  it('does not send when an operator acted between the scan and the claim', async () => {
    seedCard('card-1', 'inbound-1')
    db.claimable.delete('card-1')
    const summary = await processDueKnowledgeGaps(new Date(), true)
    expect(summary.casLost).toBe(1)
    expect(handleHoldingMessageMock).not.toHaveBeenCalled()
  })

  // The eight legacy pending_review rows with no expiry are excluded by the
  // scan predicate itself, not by a carve-out — they simply never appear in
  // dueRows because the query filters `pending_until IS NOT NULL`.
  it('never touches cards the scan does not return', async () => {
    const summary = await processDueKnowledgeGaps(new Date(), true)
    expect(summary.scanned).toBe(0)
    expect(handleHoldingMessageMock).not.toHaveBeenCalled()
  })

  it('clears the clock and skips a card with no linked inbound', async () => {
    seedCard('card-1', null)
    const summary = await processDueKnowledgeGaps(new Date(), true)
    expect(summary.invalid).toBe(1)
    expect(handleHoldingMessageMock).not.toHaveBeenCalled()
    // Clock cleared, so it won't be rescanned every five minutes forever.
    expect(db.claimedIds).toEqual(['card-1'])
  })

  it('clears the clock and skips a card whose inbound is unreadable', async () => {
    seedCard('card-1', 'missing-inbound')
    db.questions.delete('missing-inbound')
    const summary = await processDueKnowledgeGaps(new Date(), true)
    expect(summary.invalid).toBe(1)
    expect(handleHoldingMessageMock).not.toHaveBeenCalled()
  })

  it('counts a fallback send separately from a generated one', async () => {
    seedCard('card-1', 'inbound-1')
    handleHoldingMessageMock.mockResolvedValue({
      status: 'sent',
      outboundMessageId: 'out-1',
      usedFallback: true,
    })
    const summary = await processDueKnowledgeGaps(new Date(), true)
    expect(summary.fallbackSent).toBe(1)
    expect(summary.sent).toBe(0)
  })

  it('counts a failed send and keeps processing the rest of the batch', async () => {
    seedCard('card-1', 'inbound-1')
    seedCard('card-2', 'inbound-2')
    db.questions.set('inbound-2', {
      id: 'inbound-2',
      body: 'do you do oat milk?',
      created_at: new Date().toISOString(),
      provider_message_id: 'p2',
    })
    handleHoldingMessageMock
      .mockResolvedValueOnce({ status: 'failed', stage: 'send', error: 'sendblue down' })
      .mockResolvedValueOnce({ status: 'sent', outboundMessageId: 'out-2', usedFallback: false })
    const summary = await processDueKnowledgeGaps(new Date(), true)
    expect(summary.errored).toBe(1)
    expect(summary.sent).toBe(1)
  })

  // TAC-309 removed the post-send card regen entirely; cards are blank now,
  // so there was no body left to keep in sync.
  it('sends without attempting any card regeneration', async () => {
    seedCard('card-1', 'inbound-1')
    const summary = await processDueKnowledgeGaps(new Date(), true)
    expect(summary.sent).toBe(1)
  })

  it('counts a claim DB error without sending', async () => {
    seedCard('card-1', 'inbound-1')
    db.claimError = true
    const summary = await processDueKnowledgeGaps(new Date(), true)
    expect(summary.errored).toBe(1)
    expect(handleHoldingMessageMock).not.toHaveBeenCalled()
  })
})

// TAC-484: the holding message is disabled. This is what actually pins the
// production default — every test above exercises the mechanism through the
// explicit `enabled: true` override, same as agent-gate.test.ts's shut-gate
// tests do for INSTAGRAM_AGENT_REPLIES_ENABLED.
describe('processDueKnowledgeGaps — disabled by default (TAC-484)', () => {
  it('is disabled', () => {
    expect(KNOWLEDGE_GAP_HOLDING_MESSAGE_ENABLED).toBe(false)
  })

  it('returns the all-zero summary and touches nothing, with no arguments', async () => {
    seedCard('card-1', 'inbound-1')
    const summary = await processDueKnowledgeGaps(new Date())
    expect(summary).toEqual({
      scanned: 0,
      claimed: 0,
      casLost: 0,
      sent: 0,
      fallbackSent: 0,
      suppressed: 0,
      errored: 0,
      invalid: 0,
    })
    expect(handleHoldingMessageMock).not.toHaveBeenCalled()
    // Not just "sent nothing" — never even reached the database. A due card
    // sitting in the fake DB is proof the scan itself never ran.
    expect(createAdminClientMock).not.toHaveBeenCalled()
    expect(db.claimedIds).toEqual([])
  })

  it('returns the same all-zero summary when explicitly passed false', async () => {
    seedCard('card-1', 'inbound-1')
    const summary = await processDueKnowledgeGaps(new Date(), false)
    expect(summary.scanned).toBe(0)
    expect(createAdminClientMock).not.toHaveBeenCalled()
  })
})
