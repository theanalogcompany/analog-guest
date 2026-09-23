// TAC-394, option F: two pending slots per guest.
//
// What this file pins, and why each needs a test rather than a reviewer:
//
//   - THE RULING'S TEST. "Preserves the obligation" means the same commitment,
//     not the same type. Comp A pending and comp B arriving is the only case
//     that separates the two readings; every other obligation case gives the
//     same answer under both, so a suite without it would certify the wrong
//     reading.
//   - The read. `loadPendingRowsBySlot` runs against an in-memory table that
//     returns rows in INSERTION order unless asked to order them. Inserting the
//     other slot's card first catches a read that forgot its SLOT. Only the
//     two-rows-in-one-slot test catches one that forgot its ORDER, because
//     partitioning rows by slot does not depend on their order.
//   - The SQL/TypeScript mirror. Migration 041's index predicates cannot import
//     OBLIGATION_SLOT_TYPES, so this file reads the migration and compares.
//   - The source guard. Every per-guest single-row pending read in the repo goes
//     through this module or orders explicitly. The guard is tested against
//     other spellings of the same read, so it cannot pass only because it was
//     written against one spelling.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createPendingRowsFake } from './testing/pending-rows-fake'

const captureInvariantBrokenMock = vi.fn()
const mockAdmin: { client: unknown } = { client: null }

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => mockAdmin.client,
}))
vi.mock('@/lib/analytics/posthog', () => ({
  capturePendingSlotInvariantBroken: (...args: unknown[]) => captureInvariantBrokenMock(...args),
}))

import { OBLIGATION_TYPES } from '@/lib/guests/commitment-expiry'
import {
  commitmentIdentityOf,
  decideSlotAction,
  draftCommitmentIdentity,
  EMPTY_PENDING_ROWS,
  isSameCommitment,
  loadPendingRowsBySlot,
  OBLIGATION_SLOT_TYPES,
  otherSlotOccupant,
  partitionPendingRows,
  pendingSlotOf,
  resolveDraftCarrier,
  resolveDraftCarrierIdentity,
  type PendingRowsBySlot,
  type PendingSlotRow,
} from './pending-slots'

const VENUE = 'venue-1'
const GUEST = 'guest-1'
const REPO_ROOT = resolve(__dirname, '../..')

const compA = {
  type: 'comp',
  description: 'a free cortado on your next visit',
  code: '7K2P',
  expiresAt: null,
}
const compB = { type: 'comp', description: 'a free croissant', code: 'Q4X9', expiresAt: null }

function pendingRow(over: Partial<PendingSlotRow> & { id: string }): PendingSlotRow {
  return {
    body: 'a draft',
    pending_until: null,
    review_reason: 'model_flagged',
    pending_commitment: null,
    created_at: '2026-09-14T16:26:34.000Z',
    ...over,
  }
}

function rowsOf(...rows: PendingSlotRow[]): PendingRowsBySlot {
  return partitionPendingRows(rows).rows
}

function identity(c: typeof compA) {
  return { type: c.type, description: c.description, code: c.code }
}

beforeEach(() => {
  captureInvariantBrokenMock.mockReset()
  mockAdmin.client = null
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// The slot
// ---------------------------------------------------------------------------

describe('pendingSlotOf', () => {
  it.each([
    ['comp', 'obligation'],
    ['hold', 'obligation'],
    ['discount', 'obligation'],
    ['recommendation', 'conversation'],
  ])('puts a %s carrier in the %s slot', (type, slot) => {
    expect(pendingSlotOf({ type, description: 'x', code: null, expiresAt: null })).toBe(slot)
  })

  // Each of these is what `coalesce(pending_commitment->>'type', '')` makes
  // something other than an obligation type.
  it.each([
    ['no carrier', null],
    ['an absent carrier', undefined],
    ['a carrier with no type', { description: 'a free cortado' }],
    ['a non-string type', { type: 7 }],
    ['an array', ['comp']],
    ['a bare string', 'comp'],
    ['a differently-cased type', { type: 'Comp' }],
  ])('puts %s in the conversation slot', (_label, carrier) => {
    expect(pendingSlotOf(carrier)).toBe('conversation')
  })

  // The index reads only the type, so a carrier with a malformed description
  // still sits in the obligation slot there. This must agree.
  it('reads the raw type even when the rest of the carrier is malformed', () => {
    expect(pendingSlotOf({ type: 'comp' })).toBe('obligation')
  })
})

// ---------------------------------------------------------------------------
// The commitment
// ---------------------------------------------------------------------------

describe('isSameCommitment ("the same commitment", ruled 2026-09-14)', () => {
  it('is the same type and the same TAC-318 dedup key', () => {
    expect(
      isSameCommitment(identity(compA), {
        type: 'comp',
        description: '  A Free Cortado on your next visit  ',
      }),
    ).toBe(true)
  })

  it('is NOT a comp for a different item', () => {
    expect(isSameCommitment(identity(compA), identity(compB))).toBe(false)
  })

  it('is NOT a different type for the same item', () => {
    expect(isSameCommitment(identity(compA), { ...identity(compA), type: 'hold' })).toBe(false)
  })

  it('ignores the verification code', () => {
    const recoded = { ...identity(compA), code: 'ZZ99' }
    expect(isSameCommitment(identity(compA), recoded)).toBe(true)
  })

  it('is never the same as nothing', () => {
    expect(isSameCommitment(identity(compA), null)).toBe(false)
    expect(isSameCommitment(null, identity(compA))).toBe(false)
    expect(isSameCommitment(null, null)).toBe(false)
  })
})

describe('draftCommitmentIdentity', () => {
  it('reads the emission the draft will persist, trimmed', () => {
    expect(
      draftCommitmentIdentity({ type: 'comp', description: '  a free croissant ', code: 'Q4X9' }, false),
    ).toEqual({ type: 'comp', description: 'a free croissant', code: 'Q4X9' })
  })

  // A blanked body nulls the carrier (TAC-309), which is how a draft gives up
  // its obligation.
  it('is null when the body is blanked', () => {
    expect(draftCommitmentIdentity({ type: 'comp', description: 'a free croissant' }, true)).toBeNull()
  })

  it('is null for the no-op emission', () => {
    expect(draftCommitmentIdentity({}, false)).toBeNull()
    expect(draftCommitmentIdentity({ type: 'comp', description: '   ' }, false)).toBeNull()
  })

  it('never mints a code (a minted code would never match the one written)', () => {
    expect(draftCommitmentIdentity({ type: 'comp', description: 'a free croissant' }, false)?.code).toBeNull()
  })
})

describe('commitmentIdentityOf (stored carriers)', () => {
  it('reads a well-formed carrier', () => {
    expect(commitmentIdentityOf(compA)).toEqual(identity(compA))
  })

  it.each([
    ['null', null],
    ['no description', { type: 'comp', code: '7K2P' }],
    ['a blank description', { type: 'comp', description: ' ' }],
    ['a non-string type', { type: 1, description: 'x' }],
    ['an array', [compA]],
  ])('is null for %s', (_label, raw) => {
    expect(commitmentIdentityOf(raw)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

describe('loadPendingRowsBySlot', () => {
  it('returns BOTH slots when the conversation card was inserted first', async () => {
    const fake = createPendingRowsFake('041')
    fake.seed({
      id: 'card-conv',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      review_reason: 'category_requires_approval',
    })
    fake.seed({
      id: 'card-a',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      review_reason: 'commitment_type_gated',
      pending_commitment: compA,
    })
    mockAdmin.client = fake.client

    const rows = await loadPendingRowsBySlot(VENUE, GUEST)

    expect(rows?.obligation?.id).toBe('card-a')
    expect(rows?.conversation?.id).toBe('card-conv')
    // The carrier is selected, or the obligation card would be unreadable.
    expect(rows?.obligation?.pending_commitment).toEqual(compA)
  })

  it('returns the comp card when it is the only pending card', async () => {
    const fake = createPendingRowsFake('041')
    fake.seed({ id: 'sent-1', venue_id: VENUE, guest_id: GUEST, review_state: 'auto_sent' })
    fake.seed({
      id: 'card-a',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      pending_commitment: compA,
    })
    mockAdmin.client = fake.client

    expect(await loadPendingRowsBySlot(VENUE, GUEST)).toEqual({
      obligation: expect.objectContaining({ id: 'card-a' }),
      conversation: null,
    })
  })

  it('ignores other guests, other venues, inbound rows and rows that are not pending', async () => {
    const fake = createPendingRowsFake('none')
    fake.seed({ id: 'other-guest', venue_id: VENUE, guest_id: 'guest-2', review_state: 'pending' })
    fake.seed({ id: 'other-venue', venue_id: 'venue-2', guest_id: GUEST, review_state: 'pending' })
    fake.seed({ id: 'inbound', venue_id: VENUE, guest_id: GUEST, direction: 'inbound', review_state: 'pending' })
    fake.seed({ id: 'approved', venue_id: VENUE, guest_id: GUEST, review_state: 'approved' })
    mockAdmin.client = fake.client

    expect(await loadPendingRowsBySlot(VENUE, GUEST)).toEqual(EMPTY_PENDING_ROWS)
  })

  // Unreachable with migration 041 live, and the one signal that the indexes
  // are gone. The OLDEST card is kept, which needs the read to order: the newer
  // row is inserted first here, so a read that relied on insertion order would
  // keep the wrong one.
  it('keeps the OLDEST card when a slot holds two, and reports the rest loudly', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fake = createPendingRowsFake('none')
    fake.seed({
      id: 'newer',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      created_at: '2026-09-14T17:00:00.000Z',
    })
    fake.seed({
      id: 'older',
      venue_id: VENUE,
      guest_id: GUEST,
      review_state: 'pending',
      created_at: '2026-09-14T16:00:00.000Z',
    })
    mockAdmin.client = fake.client

    const rows = await loadPendingRowsBySlot(VENUE, GUEST)

    expect(rows?.conversation?.id).toBe('older')
    expect(errorSpy).toHaveBeenCalled()
    // The Slack-relayed capture, not a PostHog-only event: this is the one
    // signal that migration 041's indexes are gone.
    expect(captureInvariantBrokenMock).toHaveBeenCalledWith({
      venueId: VENUE,
      guestId: GUEST,
      keptObligationId: null,
      keptConversationId: 'older',
      extraIds: ['newer'],
    })
  })

  it('fails OPEN (null) when the read returns an error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: async () => ({ data: null, error: { message: 'connection reset' } }),
    }
    mockAdmin.client = { from: () => chain }
    expect(await loadPendingRowsBySlot(VENUE, GUEST)).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('fails OPEN (null) when the read throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockAdmin.client = {
      from: () => {
        throw new Error('client init failed')
      },
    }
    expect(await loadPendingRowsBySlot(VENUE, GUEST)).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('a failed event capture never costs the read its result', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    captureInvariantBrokenMock.mockRejectedValue(new Error('posthog down'))
    const fake = createPendingRowsFake('none')
    fake.seed({ id: 'a', venue_id: VENUE, guest_id: GUEST, review_state: 'pending' })
    fake.seed({ id: 'b', venue_id: VENUE, guest_id: GUEST, review_state: 'pending' })
    mockAdmin.client = fake.client
    expect((await loadPendingRowsBySlot(VENUE, GUEST))?.conversation?.id).toBe('a')
  })
})

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

describe('decideSlotAction', () => {
  const compCardA = pendingRow({ id: 'card-a', review_reason: 'commitment_type_gated', pending_commitment: compA })
  const conversationCard = pendingRow({ id: 'card-conv', review_reason: 'category_requires_approval' })
  const gapCard = pendingRow({
    id: 'gap-card',
    body: '',
    review_reason: 'knowledge_gap',
    pending_until: '2026-09-14T16:36:34.000Z',
  })
  const base = { isGapTurn: false, checkDidNotComplete: false, callerPolicy: 'regen' as const }

  // THE RULING'S TEST (TAC-394 plan v2 §6, test 2). It fails under the
  // same-type reading of "preserves the obligation", which would regenerate
  // comp A into comp B and lose it: the 2026-09-14 incident with a second comp
  // in place of the hours answer.
  it('comp A pending, replacement carries comp B: the existing card wins', () => {
    expect(
      decideSlotAction({
        ...base,
        rows: rowsOf(compCardA),
        draftCommitment: identity(compB),
      }),
    ).toEqual({
      action: 'drop',
      slot: 'obligation',
      reason: 'obligation_slot_taken',
      protectedDraftId: 'card-a',
    })
  })

  // Controls for the case above. Each gives the same answer under both
  // readings, which is why none of them could have caught the wrong one.
  it('control: comp A re-emitted, differing only in case and whitespace, regenerates card A', () => {
    expect(
      decideSlotAction({
        ...base,
        rows: rowsOf(compCardA),
        draftCommitment: { type: 'comp', description: '  A Free Cortado on your next visit ', code: 'ZZ99' },
      }),
    ).toEqual({ action: 'regen', slot: 'obligation', draftId: 'card-a' })
  })

  it('control: a hold for the same item is dropped', () => {
    expect(
      decideSlotAction({
        ...base,
        rows: rowsOf(compCardA),
        draftCommitment: { ...identity(compA), type: 'hold' },
      }),
    ).toMatchObject({ action: 'drop', reason: 'obligation_slot_taken' })
  })

  it('control: a blanked comp B draft gives up its obligation and inserts into the conversation slot', () => {
    expect(
      decideSlotAction({
        ...base,
        rows: rowsOf(compCardA),
        draftCommitment: draftCommitmentIdentity({ type: 'comp', description: 'a free croissant' }, true),
      }),
    ).toEqual({ action: 'insert', slot: 'conversation' })
  })

  it('inserts an obligation card when the obligation slot is empty, even with a conversation card pending', () => {
    expect(
      decideSlotAction({ ...base, rows: rowsOf(conversationCard), draftCommitment: identity(compB) }),
    ).toEqual({ action: 'insert', slot: 'obligation' })
  })

  it('regenerates the conversation card for a conversation draft, never the comp card listed first', () => {
    expect(
      decideSlotAction({ ...base, rows: rowsOf(compCardA, conversationCard), draftCommitment: null }),
    ).toEqual({ action: 'regen', slot: 'conversation', draftId: 'card-conv' })
  })

  it('an obligation card with an unreadable carrier keeps its slot', () => {
    expect(
      decideSlotAction({
        ...base,
        rows: rowsOf(pendingRow({ id: 'broken', pending_commitment: { type: 'comp' } })),
        draftCommitment: identity(compB),
      }),
    ).toMatchObject({ action: 'drop', reason: 'obligation_slot_taken', protectedDraftId: 'broken' })
  })

  describe("'regen' (the gate's callers)", () => {
    it('TAC-308: protects a knowledge-gap card from a turn that is not a gap turn', () => {
      expect(decideSlotAction({ ...base, rows: rowsOf(gapCard), draftCommitment: null })).toEqual({
        action: 'drop',
        slot: 'conversation',
        reason: 'knowledge_gap_card_protected',
        protectedDraftId: 'gap-card',
      })
    })

    it('TAC-308: regenerates a knowledge-gap card on a gap turn', () => {
      expect(
        decideSlotAction({ ...base, isGapTurn: true, rows: rowsOf(gapCard), draftCommitment: null }),
      ).toEqual({ action: 'regen', slot: 'conversation', draftId: 'gap-card' })
    })

    it('TAC-367: regenerates a knowledge-gap card when only the grounding check truncated', () => {
      expect(
        decideSlotAction({ ...base, checkDidNotComplete: true, rows: rowsOf(gapCard), draftCommitment: null }),
      ).toEqual({ action: 'regen', slot: 'conversation', draftId: 'gap-card' })
    })

    it('TAC-264: regenerates an ordinary card in place', () => {
      expect(decideSlotAction({ ...base, rows: rowsOf(conversationCard), draftCommitment: null })).toEqual({
        action: 'regen',
        slot: 'conversation',
        draftId: 'card-conv',
      })
    })
  })

  describe("'never_regen' (manual followups)", () => {
    it('refuses an occupied conversation slot', () => {
      expect(
        decideSlotAction({
          ...base,
          callerPolicy: 'never_regen',
          rows: rowsOf(conversationCard),
          draftCommitment: null,
        }),
      ).toEqual({
        action: 'drop',
        slot: 'conversation',
        reason: 'slot_occupied',
        protectedDraftId: 'card-conv',
      })
    })

    it('refuses even the SAME commitment in the obligation slot', () => {
      expect(
        decideSlotAction({
          ...base,
          callerPolicy: 'never_regen',
          rows: rowsOf(compCardA),
          draftCommitment: identity(compA),
        }),
      ).toMatchObject({ action: 'drop', reason: 'slot_occupied' })
    })

    it('inserts into an empty slot', () => {
      expect(
        decideSlotAction({ ...base, callerPolicy: 'never_regen', rows: rowsOf(compCardA), draftCommitment: null }),
      ).toEqual({ action: 'insert', slot: 'conversation' })
    })
  })

  describe("'regen_always' (the operator decline)", () => {
    it('regenerates the conversation card, never the comp card', () => {
      expect(
        decideSlotAction({
          ...base,
          callerPolicy: 'regen_always',
          rows: rowsOf(compCardA, gapCard),
          draftCommitment: null,
        }),
      ).toEqual({ action: 'regen', slot: 'conversation', draftId: 'gap-card' })
    })

    // No path overwrites one obligation with another, the decline included.
    it('still drops a different obligation', () => {
      expect(
        decideSlotAction({
          ...base,
          callerPolicy: 'regen_always',
          rows: rowsOf(compCardA),
          draftCommitment: identity(compB),
        }),
      ).toMatchObject({ action: 'drop', reason: 'obligation_slot_taken' })
    })
  })

  describe("'regen_gap_card_only' (the generation-failure card)", () => {
    it('updates a knowledge-gap card', () => {
      expect(
        decideSlotAction({
          ...base,
          callerPolicy: 'regen_gap_card_only',
          rows: rowsOf(gapCard),
          draftCommitment: null,
        }),
      ).toEqual({ action: 'regen', slot: 'conversation', draftId: 'gap-card' })
    })

    it('never overwrites an ordinary card', () => {
      expect(
        decideSlotAction({
          ...base,
          callerPolicy: 'regen_gap_card_only',
          rows: rowsOf(conversationCard),
          draftCommitment: null,
        }),
      ).toMatchObject({ action: 'drop', reason: 'slot_occupied', protectedDraftId: 'card-conv' })
    })
  })
})

describe('otherSlotOccupant', () => {
  it('is the card in the slot the draft does not land in', () => {
    const rows = rowsOf(
      pendingRow({ id: 'card-a', pending_commitment: compA }),
      pendingRow({ id: 'card-conv' }),
    )
    expect(otherSlotOccupant(rows, null)?.id).toBe('card-a')
    expect(otherSlotOccupant(rows, identity(compB))?.id).toBe('card-conv')
    expect(otherSlotOccupant(EMPTY_PENDING_ROWS, null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The SQL
// ---------------------------------------------------------------------------

function readSql(file: string): string {
  const raw = readFileSync(join(REPO_ROOT, 'db/migrations', file), 'utf8')
  // Statements only. Both migrations quote SQL in their headers (the rollback,
  // the checks), and those comments must not satisfy an assertion about what
  // the migration actually runs.
  return raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

describe('migration 041 mirrors pendingSlotOf (TAC-394, superseded by 054)', () => {
  const sql = readSql('041_two_pending_slots_per_guest.sql')

  it('derives OBLIGATION_SLOT_TYPES from OBLIGATION_TYPES', () => {
    expect([...OBLIGATION_SLOT_TYPES]).toEqual([...OBLIGATION_TYPES].sort())
  })

  it('lists exactly OBLIGATION_SLOT_TYPES in both index predicates, one `in` and one `not in`', () => {
    const predicates = [
      ...sql.matchAll(/coalesce\(pending_commitment->>'type', ''\)\s+(not\s+)?in\s+\(([^)]*)\)/g),
    ]
    expect(predicates).toHaveLength(2)
    expect(predicates.map((m) => Boolean(m[1]))).toEqual([false, true])
    for (const m of predicates) {
      const types = m[2]!
        .split(',')
        .map((t) => t.trim().replace(/^'|'$/g, ''))
        .sort()
      expect(types).toEqual([...OBLIGATION_SLOT_TYPES])
    }
  })

  it('keys both indexes on pending rows per venue and guest', () => {
    expect(
      sql.match(/on messages \(venue_id, guest_id\)\s+where review_state = 'pending'/g),
    ).toHaveLength(2)
  })

  // The ruling's first requirement: with 020 live, the new code's second
  // insert would hit it. Both new indexes must exist before 020 goes, in one
  // transaction, so the table is never unguarded.
  it('creates both indexes, then drops 020, inside one transaction', () => {
    const begin = sql.indexOf('begin;')
    const createObligation = sql.indexOf(
      'create unique index idx_messages_one_pending_obligation_per_guest',
    )
    const createConversation = sql.indexOf(
      'create unique index idx_messages_one_pending_conversation_per_guest',
    )
    const drop = sql.indexOf('drop index idx_messages_one_pending_per_guest;')
    const commit = sql.indexOf('commit;')
    for (const position of [begin, createObligation, createConversation, drop, commit]) {
      expect(position).toBeGreaterThanOrEqual(0)
    }
    expect(begin).toBeLessThan(createObligation)
    expect(createObligation).toBeLessThan(drop)
    expect(createConversation).toBeLessThan(drop)
    expect(drop).toBeLessThan(commit)
    expect(sql).not.toMatch(/concurrently/i)
  })
})

describe('migration 042: list_operator_queue (TAC-394)', () => {
  const sql = readSql('042_operator_queue_other_pending.sql')

  it('drops and recreates the function inside one transaction', () => {
    const begin = sql.indexOf('begin;')
    const drop = sql.indexOf('drop function if exists public.list_operator_queue(uuid[]);')
    const create = sql.indexOf('create function public.list_operator_queue(')
    const commit = sql.indexOf('commit;')
    expect(begin).toBeGreaterThanOrEqual(0)
    expect(begin).toBeLessThan(drop)
    expect(drop).toBeLessThan(create)
    expect(create).toBeLessThan(commit)
  })

  it('returns other_pending_for_guest as an integer', () => {
    expect(sql).toMatch(/other_pending_for_guest integer\s*\n\)/)
    expect(sql).toContain('other.other_pending_for_guest')
  })

  it('counts the OTHER pending cards for the same venue and guest', () => {
    const lateral = sql.slice(sql.indexOf('as other_pending_for_guest'), sql.indexOf(') other on true'))
    expect(lateral).toContain('o.venue_id = m.venue_id')
    expect(lateral).toContain('o.guest_id = m.guest_id')
    expect(lateral).toContain("o.review_state = 'pending'")
    expect(lateral).toContain('o.id <> m.id')
  })

  // Contract: recentContext no longer includes pending drafts.
  it('excludes every pending row from recent_context, not only the card itself', () => {
    const ctx = sql.slice(sql.indexOf('jsonb_agg('), sql.indexOf(') ctx on true'))
    expect(ctx).toContain("and review_state is distinct from 'pending'")
    expect(ctx).toContain('and id <> m.id')
  })

describe('migration 054 mirrors the per-inbound conversation slot (TAC-397)', () => {
  const sql = readSql('054_conversation_cards_per_reply.sql')

  // The type list lives in SQL and in OBLIGATION_TYPES, and the SQL cannot
  // import the constant. 041's block above pins its own copy; this pins 054's,
  // which is the one that is LIVE. Without this, adding a fourth obligation
  // type would keep 041's test green (its file is frozen) while 054's index
  // silently disagreed with pendingSlotOf.
  it('lists exactly OBLIGATION_SLOT_TYPES in the conversation predicate, as `not in`', () => {
    const predicates = [
      ...sql.matchAll(/coalesce\(pending_commitment->>'type', ''\)\s+(not\s+)?in\s+\(([^)]*)\)/g),
    ]
    expect(predicates).toHaveLength(1)
    expect(Boolean(predicates[0]![1])).toBe(true)
    const types = predicates[0]![2]!
      .split(',')
      .map((t) => t.trim().replace(/^'|'$/g, ''))
      .sort()
    expect(types).toEqual([...OBLIGATION_SLOT_TYPES])
  })

  // THE load-bearing line of this migration. NULLs are distinct in a unique
  // index, so a bare `reply_to_message_id` would give proactive conversation
  // cards (manual followups, the decline, the crash card) NO uniqueness at
  // all — protection migration 041 provides today. Folding NULL onto a fixed
  // sentinel is what keeps "at most one proactive conversation card per
  // guest" true. Pinned as one contiguous expression rather than as separate
  // substrings: the parts are individually unremarkable and only mean
  // something together.
  it('keys the conversation index on venue, guest and the inbound, folding NULL onto a sentinel', () => {
    expect(sql).toMatch(
      /on messages \(\s*venue_id,\s*guest_id,\s*coalesce\(reply_to_message_id, '00000000-0000-0000-0000-000000000000'::uuid\)\s*\)\s*where review_state = 'pending'/,
    )
  })

  it('creates the new conversation index before dropping 041’s, in one transaction', () => {
    const begin = sql.indexOf('begin;')
    const create = sql.indexOf(
      'create unique index idx_messages_one_pending_conversation_per_guest_reply',
    )
    const drop = sql.indexOf('drop index idx_messages_one_pending_conversation_per_guest;')
    const commit = sql.indexOf('commit;')
    for (const position of [begin, create, drop, commit]) {
      expect(position).toBeGreaterThanOrEqual(0)
    }
    expect(begin).toBeLessThan(create)
    expect(create).toBeLessThan(drop)
    expect(drop).toBeLessThan(commit)
    expect(sql).not.toMatch(/concurrently/i)
  })

  // TAC-394's obligation protection is explicitly out of scope. A migration
  // that touched it would be changing what this ticket said it would not.
  it('leaves the obligation index alone', () => {
    expect(sql).not.toContain('idx_messages_one_pending_obligation_per_guest')
  })

  it('adds both replaced-draft columns, nullable and with no default', () => {
    expect(sql).toMatch(
      /alter table messages\s+add column replaced_draft_body text,\s+add column replaced_draft_at timestamptz;/,
    )
    expect(sql).not.toMatch(/replaced_draft_\w+[^;]*\bdefault\b/)
    expect(sql).not.toMatch(/replaced_draft_\w+[^;]*not null/i)
  })

  // Adding a return column is a signature change; `create or replace` refuses
  // it (migration 039's rule). One transaction so no reader sees it missing.
  it('drops and recreates list_operator_queue inside one transaction', () => {
    const begin = sql.indexOf('begin;')
    const drop = sql.indexOf('drop function if exists public.list_operator_queue(uuid[]);')
    const create = sql.indexOf('create function public.list_operator_queue(')
    const commit = sql.indexOf('commit;')
    for (const position of [begin, drop, create, commit]) {
      expect(position).toBeGreaterThanOrEqual(0)
    }
    expect(begin).toBeLessThan(drop)
    expect(drop).toBeLessThan(create)
    expect(create).toBeLessThan(commit)
    expect(sql).not.toMatch(/create or replace function public\.list_operator_queue/)
  })

  it('returns and selects both replaced-draft columns', () => {
    expect(sql).toMatch(/replaced_draft_body text,\s*\n\s*replaced_draft_at timestamptz\s*\n\)/)
    expect(sql).toContain('m.replaced_draft_body')
    expect(sql).toContain('m.replaced_draft_at')
  })
})
})

// ---------------------------------------------------------------------------
// The source guard
// ---------------------------------------------------------------------------

const MESSAGES_FROM = /\.from\(\s*['"`]messages['"`]\s*\)/g
const PENDING_FILTER =
  /review_state['"`]?\s*[,:]\s*['"`]pending['"`]|['"`]review_state['"`]\s*,\s*['"`]eq['"`]\s*,\s*['"`]pending['"`]|review_state\.eq\.pending|['"`]review_state['"`]\s*,\s*\[[^\]]*['"`]pending['"`][^\]]*\]/
const GUEST_FILTER = /guest_id/
const SINGLE_ROW = /\.maybeSingle\(|\.single\(|\.limit\(\s*1\s*\)|\.range\(\s*0\s*,\s*0\s*\)/

/**
 * The text of the query chain starting at `.from(`, up to where the chain ends:
 * a newline at bracket depth 0 whose next code line does not continue with `.`,
 * or a closing bracket that belongs to an enclosing call.
 */
function chainAt(source: string, start: number): string {
  let depth = 0
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      if (depth < 0) return source.slice(start, i)
    } else if (ch === '\n' && depth === 0) {
      let j = i + 1
      for (;;) {
        const lineEnd = source.indexOf('\n', j)
        const line = source.slice(j, lineEnd === -1 ? undefined : lineEnd).trim()
        if ((line === '' || line.startsWith('//')) && lineEnd !== -1) {
          j = lineEnd + 1
          continue
        }
        if (!line.startsWith('.')) return source.slice(start, i)
        break
      }
    }
  }
  return source.slice(start)
}

/** Every query chain in `source` that reads ONE pending row for a guest. */
function perGuestSingleRowPendingReads(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(MESSAGES_FROM)) {
    const chain = chainAt(source, match.index!)
    if (PENDING_FILTER.test(chain) && GUEST_FILTER.test(chain) && SINGLE_ROW.test(chain)) {
      found.push(chain)
    }
  }
  return found
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

describe('source guard: every per-guest single-row pending read names its order (TAC-394)', () => {
  // Before TAC-394 there were three such reads, all `.limit(1).maybeSingle()`
  // with no ORDER BY. With two pending rows per guest each could be handed
  // either card. The only one left is findPendingQuestion, which cannot be tied
  // to a slot (a gap card can sit in either) and orders explicitly instead.
  // Everything else goes through loadPendingRowsBySlot, which reads both slots.
  const ALLOWED = 'lib/agent/pending-question.ts'

  const hits = ['lib', 'app', 'scripts'].flatMap((root) =>
    sourceFiles(join(REPO_ROOT, root)).flatMap((file) =>
      perGuestSingleRowPendingReads(readFileSync(file, 'utf8')).map((chain) => ({
        file: relative(REPO_ROOT, file),
        chain,
      })),
    ),
  )

  it('finds no such read outside pending-question.ts', () => {
    expect(hits.filter((h) => h.file !== ALLOWED).map((h) => h.file)).toEqual([])
  })

  // Guards the guard: the scan has to find the one real read it is supposed to
  // allow, or it is scanning nothing.
  it('does find findPendingQuestion, and that read orders by created_at', () => {
    const allowed = hits.filter((h) => h.file === ALLOWED)
    expect(allowed).toHaveLength(1)
    expect(allowed[0]!.chain).toContain(".order('created_at', { ascending: true })")
  })

  it.each([
    [
      'the pre-TAC-394 shape',
      `supabase.from('messages').select('id').eq('venue_id', v).eq('guest_id', g).eq('direction', 'outbound').eq('review_state', 'pending').limit(1).maybeSingle()`,
    ],
    [
      'double quotes across lines, ending in single()',
      `const { data } = await supabase\n  .from("messages")\n  // a comment inside the chain\n  .select("id")\n  .eq("guest_id", guestId)\n  .eq("review_state", "pending")\n  .single()`,
    ],
    [
      'a match() object',
      `supabase.from('messages').select('id').match({ venue_id: v, guest_id: g, review_state: 'pending' }).maybeSingle()`,
    ],
    [
      'filter() triples',
      `supabase.from('messages').select('id').filter('guest_id', 'eq', g).filter('review_state', 'eq', 'pending').limit(1)`,
    ],
    [
      'an or() leg',
      `supabase.from('messages').select('id').eq('guest_id', g).or('review_state.eq.pending,pending_until.not.is.null').limit( 1 )`,
    ],
    [
      'an in() list ending in range(0, 0)',
      `supabase.from('messages').select('id').eq('guest_id', g).in('review_state', ['pending']).range(0, 0)`,
    ],
    [
      'an in() list with more than one state',
      `supabase.from('messages').select('id').eq('guest_id', g).in('review_state', ['approved', 'pending', 'edited']).maybeSingle()`,
    ],
  ])('detects a per-guest single-row pending read written as %s', (_label, source) => {
    expect(perGuestSingleRowPendingReads(source)).toHaveLength(1)
  })

  it.each([
    [
      'a read keyed on the message id',
      `supabase.from('messages').select('id').eq('id', messageId).eq('review_state', 'pending').maybeSingle()`,
    ],
    [
      'a multi-row read',
      `supabase.from('messages').select('id').eq('guest_id', g).eq('review_state', 'pending').order('created_at', { ascending: true }).limit(3)`,
    ],
    [
      'a multi-row range',
      `supabase.from('messages').select('id').eq('guest_id', g).in('review_state', ['pending']).order('created_at', { ascending: true }).range(0, 9)`,
    ],
    [
      'two separate statements',
      `const a = await supabase.from('messages').select('id').eq('guest_id', g).eq('review_state', 'pending').limit(3)\nconst b = await supabase.from('guests').select('id').maybeSingle()`,
    ],
  ])('ignores %s', (_label, source) => {
    expect(perGuestSingleRowPendingReads(source)).toEqual([])
  })
})


describe('resolveDraftCarrier / resolveDraftCarrierIdentity (TAC-401)', () => {
  const promised = {
    type: 'comp' as const,
    description: 'a replacement cortado',
    code: 'A1B2',
    expiresAt: null,
  }

  it('uses the check carrier when generation emitted nothing actionable', () => {
    expect(resolveDraftCarrier({}, promised, false)).toEqual(promised)
    expect(resolveDraftCarrierIdentity({}, promised, false)).toEqual({
      type: 'comp',
      description: 'a replacement cortado',
      code: 'A1B2',
    })
  })

  // RULING 3 AS NARROWED (2026-09-21). This test asserted the OPPOSITE until
  // that narrowing and is reversed rather than deleted, because the old
  // behaviour is exactly what the ruling overturned: a recommendation is an
  // INTENTION, not an obligation (TAC-380), so it must never be the reason a
  // comp the venue now owes goes untracked. Keeping it caught the promise and
  // then recorded a drink suggestion for it.
  it('replaces a recommendation generation carried with the obligation the check found', () => {
    const emission = { type: 'recommendation' as const, description: 'the cortado' }

    const carrier = resolveDraftCarrier(emission, promised, false)
    expect(carrier?.type).toBe('comp')
    expect(carrier?.description).toBe('a replacement cortado')

    const identity = resolveDraftCarrierIdentity(emission, promised, false)
    expect(identity?.type).toBe('comp')
    expect(identity?.description).toBe('a replacement cortado')
  })

  // The half of the ruling that did NOT move. The model's own structured comp
  // is a better record of what it promised than a second reading of its prose,
  // and in production the stage skips on isCommitmentTypeGated so `promised`
  // is null here anyway — this pins the function itself, where both are
  // supplied.
  it('never mints a second obligation when generation already carried one', () => {
    const emission = { type: 'comp' as const, description: 'oat latte' }
    const carrier = resolveDraftCarrier(emission, promised, false)
    expect(carrier?.type).toBe('comp')
    expect(carrier?.description).toBe('oat latte')
    expect(resolveDraftCarrierIdentity(emission, promised, false)?.description).toBe('oat latte')

    const hold = { type: 'hold' as const, description: 'a bag of the Budan' }
    expect(resolveDraftCarrier(hold, promised, false)?.description).toBe('a bag of the Budan')
  })

  // A recommendation with nothing to replace it stays. Dropping it would lose
  // a record for no gain.
  it('keeps a recommendation when the check named nothing usable', () => {
    const emission = { type: 'recommendation' as const, description: 'the cortado' }
    expect(resolveDraftCarrier(emission, null, false)?.type).toBe('recommendation')
    expect(resolveDraftCarrierIdentity(emission, null, false)?.type).toBe('recommendation')
  })

  // TAC-309 unchanged: a blank card carries no commitment, and a promise the
  // operator cannot see must not be bindable by approving.
  it('nulls everything when the body is blanked, check carrier included', () => {
    expect(resolveDraftCarrier({}, promised, true)).toBeNull()
    expect(resolveDraftCarrierIdentity({}, promised, true)).toBeNull()
    expect(
      resolveDraftCarrier({ type: 'comp', description: 'oat latte' }, promised, true),
    ).toBeNull()
  })

  it('is null when neither side supplies a commitment', () => {
    expect(resolveDraftCarrier({}, null, false)).toBeNull()
    expect(resolveDraftCarrierIdentity({}, null, false)).toBeNull()
  })

  // The anti-drift guard. The two functions apply the same precedence and are
  // edited separately; nothing but this notices when one of them stops
  // agreeing with the other.
  it('the identity always describes the carrier the same inputs produce', () => {
    const cases: Array<[Parameters<typeof resolveDraftCarrier>[0], typeof promised | null, boolean]> = [
      [{}, promised, false],
      [{}, null, false],
      [{ type: 'recommendation', description: 'the cortado' }, promised, false],
      [{ type: 'comp', description: 'oat latte' }, promised, false],
      [{ type: 'comp', description: 'oat latte' }, null, false],
      [{}, promised, true],
      [{ type: 'hold', description: 'a bag of the Budan' }, promised, false],
      // A partial emission is not actionable, so the check carrier wins.
      [{ type: 'comp' }, promised, false],
      [{ description: 'oat latte' }, promised, false],
    ]
    for (const [emission, p, blank] of cases) {
      const carrier = resolveDraftCarrier(emission, p, blank)
      const identity = resolveDraftCarrierIdentity(emission, p, blank)
      if (carrier === null) {
        expect(identity).toBeNull()
        continue
      }
      expect(identity).not.toBeNull()
      expect(identity?.type).toBe(carrier.type)
      expect(identity?.description).toBe(carrier.description)
    }
  })

  // The identity must NOT mint a code: a minted one never reaches the database
  // and would show up in the drop alert as if the guest had been given it.
  it('mints no verification code in the identity path', () => {
    const emission = { type: 'comp' as const, description: 'oat latte' }
    expect(resolveDraftCarrierIdentity(emission, null, false)?.code).toBeNull()
    // The carrier path DOES mint one, which is the asymmetry the two
    // functions exist to keep.
    expect(resolveDraftCarrier(emission, null, false)?.code).toMatch(/^[A-Z0-9]{4}$/)
  })

  // A promised carrier already carries its code, minted once in the stage.
  it('reads the promised code rather than regenerating it', () => {
    expect(resolveDraftCarrier({}, promised, false)?.code).toBe('A1B2')
    expect(resolveDraftCarrierIdentity({}, promised, false)?.code).toBe('A1B2')
  })
})
