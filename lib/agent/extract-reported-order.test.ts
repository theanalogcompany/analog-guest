import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItem } from '@/lib/schemas'
import type { RuntimeContext } from './types'

const extractReportedOrderAiMock = vi.fn()
vi.mock('@/lib/ai', () => ({
  extractReportedOrder: (...a: unknown[]) => extractReportedOrderAiMock(...a),
}))

interface SupabaseMockState {
  existingTxn: { id: string } | null
  existingTxnError: { message: string } | null
  guestRow: { created_at: string; first_contacted_at: string | null } | null
  guestRowError: { message: string } | null
  insertedRow: { id: string } | null
  insertError: { message: string; code?: string } | null
  insertPayload: Record<string, unknown> | null
}

function newSupabaseState(overrides: Partial<SupabaseMockState> = {}): SupabaseMockState {
  return {
    existingTxn: null,
    existingTxnError: null,
    guestRow: { created_at: new Date().toISOString(), first_contacted_at: new Date().toISOString() },
    guestRowError: null,
    insertedRow: { id: 'tx-new' },
    insertError: null,
    insertPayload: null,
    ...overrides,
  }
}

function makeSupabaseMock(state: SupabaseMockState) {
  return {
    from: (table: string) => {
      if (table === 'transactions') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({
                      data: state.existingTxn,
                      error: state.existingTxnError,
                    }),
                  }),
                }),
              }),
            }),
          }),
          insert: (payload: Record<string, unknown>) => {
            state.insertPayload = payload
            return {
              select: () => ({
                single: async () => ({ data: state.insertedRow, error: state.insertError }),
              }),
            }
          },
        }
      }
      if (table === 'guests') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: state.guestRow, error: state.guestRowError }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table in test mock: ${table}`)
    },
  }
}

let currentState = newSupabaseState()
vi.mock('@/lib/db/admin', () => ({
  createAdminClient: () => makeSupabaseMock(currentState),
}))

// Import after mocks so the module under test picks them up.
import { bodyMentionsMenuItem, extractReportedOrder, resolveReportedItems } from './extract-reported-order'

function makeMenuItem(overrides: Partial<MenuItem> & { name: string }): MenuItem {
  return {
    category: 'drinks',
    modifiers: [],
    dietary: [],
    isOffMenu: false,
    price: 5,
    ...overrides,
  }
}

function makeCtx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    agentRunId: 'run-1',
    venue: {
      id: 'venue-1',
      venueInfo: { menu: { items: [makeMenuItem({ name: 'Cortado', price: 5 })] } },
    } as RuntimeContext['venue'],
    guest: { id: 'guest-1', firstName: 'Sam' } as RuntimeContext['guest'],
    currentMessage: { id: 'inbound-1', body: 'i got a cortado', providerMessageId: 'p1' } as RuntimeContext['currentMessage'],
    followupTrigger: null,
    recentMessages: [],
    recognition: {} as RuntimeContext['recognition'],
    mechanics: [],
    recentVisits: [],
    activeCommitments: [],
    pendingQuestion: null,
    corpus: null,
    knowledgeCorpus: null,
    classification: { category: 'reply' } as RuntimeContext['classification'],
    trace: { id: '' } as RuntimeContext['trace'],
    ...overrides,
  }
}

beforeEach(() => {
  currentState = newSupabaseState()
  extractReportedOrderAiMock.mockReset()
})

describe('bodyMentionsMenuItem (pure prefilter)', () => {
  const menu = [{ name: 'Cortado' }, { name: 'Croissant' }]

  it('matches a menu item named inside a longer sentence', () => {
    expect(bodyMentionsMenuItem('i got an oat cortado and a croissant', menu)).toBe(true)
  })

  it('is case- and whitespace-insensitive', () => {
    expect(bodyMentionsMenuItem('  CORTADO  ', menu)).toBe(true)
  })

  it('returns false when no menu item is named', () => {
    expect(bodyMentionsMenuItem('are you open today?', menu)).toBe(false)
  })

  it('returns false for an empty menu', () => {
    expect(bodyMentionsMenuItem('i got a cortado', [])).toBe(false)
  })

  it('returns false for an empty body', () => {
    expect(bodyMentionsMenuItem('', menu)).toBe(false)
  })
})

describe('resolveReportedItems (pure resolution)', () => {
  const menu = [
    makeMenuItem({ name: 'Cortado', price: 5 }),
    makeMenuItem({ name: 'Croissant', price: 4.5 }),
    makeMenuItem({ name: 'Seasonal special', price: undefined, priceNote: 'ask staff' }),
  ]

  it('resolves a single extracted item to its menu price', () => {
    const resolved = resolveReportedItems([{ name: 'Cortado', quantity: 1 }], menu)
    expect(resolved).toEqual([{ name: 'Cortado', quantity: 1, unitPriceCents: 500 }])
  })

  it('resolves multiple extracted items', () => {
    const resolved = resolveReportedItems(
      [
        { name: 'Cortado', quantity: 2 },
        { name: 'Croissant', quantity: 1 },
      ],
      menu,
    )
    expect(resolved).toEqual([
      { name: 'Cortado', quantity: 2, unitPriceCents: 500 },
      { name: 'Croissant', quantity: 1, unitPriceCents: 450 },
    ])
  })

  it('drops a name that does not resolve to any menu item (alias/near-miss)', () => {
    const resolved = resolveReportedItems([{ name: 'Oat Cortado Deluxe', quantity: 1 }], menu)
    expect(resolved).toEqual([])
  })

  it('returns an empty array for an empty extraction', () => {
    expect(resolveReportedItems([], menu)).toEqual([])
  })

  it('returns an empty array against an empty menu', () => {
    expect(resolveReportedItems([{ name: 'Cortado', quantity: 1 }], [])).toEqual([])
  })

  it('resolves a menu item with no price to a null unitPriceCents', () => {
    const resolved = resolveReportedItems([{ name: 'Seasonal special', quantity: 1 }], menu)
    expect(resolved).toEqual([{ name: 'Seasonal special', quantity: 1, unitPriceCents: null }])
  })

  it('defaults a non-positive or non-finite quantity to 1 (post-LLM validation, THE-157)', () => {
    const resolved = resolveReportedItems(
      [
        { name: 'Cortado', quantity: 0 },
        { name: 'Croissant', quantity: Number.NaN },
      ],
      menu,
    )
    expect(resolved[0]?.quantity).toBe(1)
    expect(resolved[1]?.quantity).toBe(1)
  })

  it('clamps an unreasonably large reported quantity rather than writing it unbounded', () => {
    const resolved = resolveReportedItems([{ name: 'Cortado', quantity: 500 }], menu)
    expect(resolved[0]?.quantity).toBe(20)
  })

  it('resolves a name that maps to two menu rows with DIFFERENT prices at the HIGHER price (e.g. size variants sharing one name)', () => {
    const sizedMenu = [
      makeMenuItem({ name: 'Latte', size: '12oz', price: 4 }),
      makeMenuItem({ name: 'Latte', size: '16oz', price: 5 }),
    ]
    const resolved = resolveReportedItems([{ name: 'Latte', quantity: 1 }], sizedMenu)
    expect(resolved).toEqual([{ name: 'Latte', quantity: 1, unitPriceCents: 500 }])
  })

  it('excludes an unpriced row from the max when resolving a duplicated name with a mix of priced/unpriced rows', () => {
    const mixedMenu = [
      makeMenuItem({ name: 'Latte', size: '12oz', price: 4 }),
      makeMenuItem({ name: 'Latte', size: 'seasonal', price: undefined, priceNote: 'ask staff' }),
    ]
    const resolved = resolveReportedItems([{ name: 'Latte', quantity: 1 }], mixedMenu)
    expect(resolved).toEqual([{ name: 'Latte', quantity: 1, unitPriceCents: 400 }])
  })

  it('resolves a duplicated name with no priced rows at all to a null unitPriceCents', () => {
    const unpricedMenu = [
      makeMenuItem({ name: 'Latte', size: 'small', price: undefined, priceNote: 'ask staff' }),
      makeMenuItem({ name: 'Latte', size: 'large', price: undefined, priceNote: 'ask staff' }),
    ]
    const resolved = resolveReportedItems([{ name: 'Latte', quantity: 1 }], unpricedMenu)
    expect(resolved).toEqual([{ name: 'Latte', quantity: 1, unitPriceCents: null }])
  })

  it('resolves a name that appears twice with the SAME price (duplicate data, not conflicting)', () => {
    const duplicateMenu = [
      makeMenuItem({ name: 'Cortado', price: 5 }),
      makeMenuItem({ name: 'Cortado', price: 5 }),
    ]
    const resolved = resolveReportedItems([{ name: 'Cortado', quantity: 1 }], duplicateMenu)
    expect(resolved).toEqual([{ name: 'Cortado', quantity: 1, unitPriceCents: 500 }])
  })
})

describe('extractReportedOrder (orchestration gate)', () => {
  it('returns no_menu_item_mentioned without any DB or AI call', async () => {
    const ctx = makeCtx({
      currentMessage: { id: 'm1', body: 'are you open today?', providerMessageId: 'p1' } as RuntimeContext['currentMessage'],
    })
    const outcome = await extractReportedOrder(ctx)
    expect(outcome).toEqual({ kind: 'no_menu_item_mentioned' })
    expect(extractReportedOrderAiMock).not.toHaveBeenCalled()
  })

  it('returns already_reported when a guest_reported transaction already exists', async () => {
    currentState = newSupabaseState({ existingTxn: { id: 'tx-old' } })
    const outcome = await extractReportedOrder(makeCtx())
    expect(outcome).toEqual({ kind: 'already_reported' })
    expect(extractReportedOrderAiMock).not.toHaveBeenCalled()
  })

  it('returns window_expired more than 7 days after guest creation', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    currentState = newSupabaseState({
      guestRow: { created_at: eightDaysAgo, first_contacted_at: eightDaysAgo },
    })
    const outcome = await extractReportedOrder(makeCtx())
    expect(outcome).toEqual({ kind: 'window_expired' })
    expect(extractReportedOrderAiMock).not.toHaveBeenCalled()
  })

  it('returns no_items_resolved when the model reports no items', async () => {
    extractReportedOrderAiMock.mockResolvedValue({ ok: true, data: { items: [], promptVersion: 'v1' } })
    const outcome = await extractReportedOrder(makeCtx())
    expect(outcome).toEqual({ kind: 'no_items_resolved' })
  })

  it('returns no_items_resolved when the model returns items that resolve to nothing', async () => {
    extractReportedOrderAiMock.mockResolvedValue({
      ok: true,
      data: { items: [{ name: 'Not On The Menu', quantity: 1 }], promptVersion: 'v1' },
    })
    const outcome = await extractReportedOrder(makeCtx())
    expect(outcome).toEqual({ kind: 'no_items_resolved' })
  })

  it('records a transaction with a priced amount on the happy path', async () => {
    extractReportedOrderAiMock.mockResolvedValue({
      ok: true,
      data: { items: [{ name: 'Cortado', quantity: 1 }], promptVersion: 'v1' },
    })
    const outcome = await extractReportedOrder(makeCtx())
    expect(outcome).toEqual({
      kind: 'recorded',
      transactionId: 'tx-new',
      amountCents: 500,
      itemCount: 1,
    })
    expect(currentState.insertPayload).toMatchObject({
      source: 'guest_reported',
      amount_cents: 500,
      item_count: 1,
      guest_id: 'guest-1',
      venue_id: 'venue-1',
      external_id: null,
      matched_at: null,
      match_method: null,
    })
    const rawData = currentState.insertPayload?.raw_data as { line_items: unknown[] }
    expect(rawData.line_items).toEqual([{ name: 'Cortado', quantity: 1, unit_price_cents: 500 }])
  })

  it('records amount_cents: null when any resolved item has no venue price', async () => {
    const ctx = makeCtx({
      venue: {
        id: 'venue-1',
        venueInfo: {
          menu: {
            items: [
              makeMenuItem({ name: 'Cortado', price: 5 }),
              makeMenuItem({ name: 'Seasonal special', price: undefined, priceNote: 'ask staff' }),
            ],
          },
        },
      } as RuntimeContext['venue'],
      currentMessage: {
        id: 'm1',
        body: 'i got a cortado and the seasonal special',
        providerMessageId: 'p1',
      } as RuntimeContext['currentMessage'],
    })
    extractReportedOrderAiMock.mockResolvedValue({
      ok: true,
      data: {
        items: [
          { name: 'Cortado', quantity: 1 },
          { name: 'Seasonal special', quantity: 1 },
        ],
        promptVersion: 'v1',
      },
    })
    const outcome = await extractReportedOrder(ctx)
    expect(outcome).toMatchObject({ kind: 'recorded', amountCents: null, itemCount: 2 })
    const rawData = currentState.insertPayload?.raw_data as { line_items: Record<string, unknown>[] }
    // Unpriced line item omits unit_price_cents entirely rather than writing
    // a fabricated 0 — parseTicket renders a blank price cell for it.
    expect(rawData.line_items.find((l) => l.name === 'Seasonal special')).toEqual({
      name: 'Seasonal special',
      quantity: 1,
    })
  })

  it('uses the guest first_contacted_at as occurred_at, not now', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    currentState = newSupabaseState({
      guestRow: { created_at: threeDaysAgo, first_contacted_at: threeDaysAgo },
    })
    extractReportedOrderAiMock.mockResolvedValue({
      ok: true,
      data: { items: [{ name: 'Cortado', quantity: 1 }], promptVersion: 'v1' },
    })
    await extractReportedOrder(makeCtx())
    expect(currentState.insertPayload?.occurred_at).toBe(threeDaysAgo)
  })

  it('returns failed when the existing-transaction lookup errors', async () => {
    currentState = newSupabaseState({ existingTxnError: { message: 'db down' } })
    const outcome = await extractReportedOrder(makeCtx())
    expect(outcome).toEqual({ kind: 'failed', error: 'db down' })
  })

  it('returns failed when the AI call fails', async () => {
    extractReportedOrderAiMock.mockResolvedValue({ ok: false, error: 'anthropic down' })
    const outcome = await extractReportedOrder(makeCtx())
    expect(outcome).toEqual({ kind: 'failed', error: 'anthropic down' })
  })

  it('treats a 23505 unique-violation on insert the same as already_reported', async () => {
    currentState = newSupabaseState({ insertError: { message: 'duplicate key', code: '23505' } })
    extractReportedOrderAiMock.mockResolvedValue({
      ok: true,
      data: { items: [{ name: 'Cortado', quantity: 1 }], promptVersion: 'v1' },
    })
    const outcome = await extractReportedOrder(makeCtx())
    expect(outcome).toEqual({ kind: 'already_reported' })
  })

  it('never throws — a synchronous failure in ctx access is caught', async () => {
    const brokenCtx = { currentMessage: null } as unknown as RuntimeContext
    await expect(extractReportedOrder(brokenCtx)).resolves.toEqual({
      kind: 'no_menu_item_mentioned',
    })
  })
})
