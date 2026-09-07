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
    openIntentions: [],
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

  // Regression: the original whole-name substring match required the guest
  // to type "gibraltar / cortado" verbatim, which killed the feature for the
  // 47 of 69 real Mock Sextant menu items that are multi-word or
  // slash-separated. Confirmed live in UAT — this exact message wrote no
  // transaction pre-fix.
  it('matches on a single significant word from a multi-word, slash-separated menu name', () => {
    const realMenu = [{ name: 'Gibraltar / Cortado' }, { name: 'Almond Croissant' }]
    expect(bodyMentionsMenuItem('i got an oat cortado and a croissant', realMenu)).toBe(true)
  })

  it('matches a multi-word menu name on just one of its words', () => {
    const realMenu = [{ name: 'Wild Wonder Peach Ginger' }]
    expect(bodyMentionsMenuItem('grabbed a ginger drink', realMenu)).toBe(true)
  })

  it('does not match on a stopword shared between the body and a menu name', () => {
    // "and" alone must never trigger — it's dropped as a stopword-grade
    // token, not treated as a distinctive word of "Bacon and Eggs".
    const realMenu = [{ name: 'Bacon and Eggs' }]
    expect(bodyMentionsMenuItem('you and me should hang out', realMenu)).toBe(false)
  })

  it('does not match on an alphanumeric menu word split into fragments', () => {
    // "v60" must stay one token, not split into "v" + "60" (which would be
    // dropped by the length-3 floor and/or false-positive on stray digits).
    const realMenu = [{ name: 'Hario V60 Dripper' }]
    expect(bodyMentionsMenuItem('i got a v60 pour over', realMenu)).toBe(true)
    expect(bodyMentionsMenuItem('table 60 please', realMenu)).toBe(false)
  })

  // Second review round found this: a menu name stored in PLURAL form is a
  // real, common bakery-case pattern ("Croissants", "Bagels", "Scones") and
  // was silently unmatchable against the natural singular guest phrasing —
  // the same failure family as the multi-word bug above, just triggered by
  // pluralization instead. The reverse direction (singular menu name,
  // plural guest phrasing) already worked via plain substring containment.
  it('matches a plural menu name against singular guest phrasing', () => {
    const realMenu = [{ name: 'Croissants' }]
    expect(bodyMentionsMenuItem('i got a croissant this morning', realMenu)).toBe(true)
  })

  it('matches an "-es" plural menu name against singular guest phrasing', () => {
    const realMenu = [{ name: 'Sandwiches' }]
    expect(bodyMentionsMenuItem('i got the turkey sandwich', realMenu)).toBe(true)
  })

  it('still matches singular menu name against plural guest phrasing (unaffected, pre-existing)', () => {
    const realMenu = [{ name: 'Croissant' }]
    expect(bodyMentionsMenuItem('i got two croissants', realMenu)).toBe(true)
  })

  // Second review round also found this: the split regex treats any
  // non-ASCII character as a separator, so an un-normalized accented name
  // fragments into pieces that all die at the length floor, leaving the
  // item permanently unmatchable by ANY phrasing. Independent
  // cafes/bakeries routinely carry accented names.
  it('matches an accented menu name against unaccented guest phrasing', () => {
    const realMenu = [{ name: 'Crème Brûlée' }]
    expect(bodyMentionsMenuItem('i got the creme brulee', realMenu)).toBe(true)
  })

  it('matches an accented menu name against accented guest phrasing', () => {
    const realMenu = [{ name: 'Piña Colada' }]
    expect(bodyMentionsMenuItem('had a piña colada', realMenu)).toBe(true)
  })

  it('does not leave a short accented name with zero significant words', () => {
    // "Piña" alone, unaccented-and-unfixed, splits into ["pi", "a"] — both
    // under the length floor, zero significant words, permanently
    // unmatchable. With diacritic stripping it becomes "pina" (4 chars),
    // matchable.
    const realMenu = [{ name: 'Piña' }]
    expect(bodyMentionsMenuItem('i got a pina colada', realMenu)).toBe(true)
  })

  // TAC-326: live production bug, surfaced via TAC-324 UAT. A menu-derived
  // significant word was a strict prefix of an unrelated, longer word in the
  // guest's message, and plain substring containment had no way to tell the
  // difference. Fixed by boundary-checking (bodyContainsWord) rather than
  // raw .includes().
  it('does not match a menu word that is a strict prefix of an unrelated word (Sana / San Pellegrino)', () => {
    // The exact production case: guest ad1bb542-37d3-4579-b543-358222fa8d60
    // greeted the venue's own persona by name on their first message.
    const realMenu = [{ name: 'San Pellegrino' }]
    expect(bodyMentionsMenuItem('Hi Sana!', realMenu)).toBe(false)
  })

  it('does not match a menu word that is a strict prefix of an unrelated word (nice / Hibiscus Ice Tea)', () => {
    // The more realistic recurring trigger — "nice" is ordinary guest chat,
    // unlike a venue-specific persona name. Same mechanism, same live menu.
    const realMenu = [{ name: 'Hibiscus Ice Tea' }]
    expect(bodyMentionsMenuItem('sounds nice, thanks', realMenu)).toBe(false)
  })

  it('still matches a genuine mention of San Pellegrino (sanity check on the fix)', () => {
    const realMenu = [{ name: 'San Pellegrino' }]
    expect(bodyMentionsMenuItem('can i get a san pellegrino', realMenu)).toBe(true)
  })

  it('still matches a genuine mention of ice (sanity check on the fix)', () => {
    const realMenu = [{ name: 'Hibiscus Ice Tea' }]
    expect(bodyMentionsMenuItem('can i get extra ice', realMenu)).toBe(true)
  })

  // Code review (TAC-326): hyphen and apostrophe were claimed in the code
  // comment / CLAUDE.md as already-covered boundary characters, but that was
  // reasoned through manually, not actually asserted here. Closing the gap
  // rather than softening the claim to match — these are the two boundary
  // characters most likely to regress if `bodyContainsWord`'s character
  // class is ever touched.
  it('matches a hyphenated mention without the hyphen breaking the boundary check', () => {
    const realMenu = [{ name: 'Carrot-Orange Juice' }]
    expect(bodyMentionsMenuItem('i got a carrot-orange juice', realMenu)).toBe(true)
  })

  it('matches a possessive-suffixed mention without the apostrophe breaking the boundary check', () => {
    const realMenu = [{ name: 'Latte' }]
    expect(bodyMentionsMenuItem("the latte's great today", realMenu)).toBe(true)
  })
})

// TAC-326: the QR prefilled body is not an ordinary organic message — it's a
// static, per-venue-configured string guaranteed to be the guest's literal
// first-ever inbound, every time, for every guest at that venue. Unlike an
// incidental collision on some later turn (turn-scoped, recovers on the next
// non-colliding turn), a prefilled-body collision fires deterministically on
// the one turn the whole first-touch-intentions mechanism exists to serve,
// with no later turn to recover on. This guard is the cheap version: a pure
// unit test over a hardcoded snapshot of each venue's live
// qrEnrollmentMessage + menu, not a live DB query (this repo's tests don't
// hit external services) and not a seed-time validation (the elegant
// version — a check inside scripts/onboarding/seed-supabase.ts or
// scripts/seed-venue.ts that runs automatically whenever a venue's config is
// (re-)seeded — deferred as a follow-up).
//
// STALENESS RISK, accepted deliberately: if a venue's qrEnrollmentMessage or
// menu changes in Studio without this table being updated to match, a new
// collision could go uncaught. Revisit if that risk bites in practice.
describe('QR prefilled-body collision guard (TAC-326)', () => {
  // Snapshot captured directly from the live venues/venue_configs tables at
  // ticket time. Full real menu, not a trimmed subset — a partial menu would
  // not faithfully reproduce the actual collision check for this venue.
  const knownVenueConfigs: { slug: string; qrEnrollmentMessage: string; menuItemNames: string[] }[] = [
    {
      slug: 'mock-sextant-coffee-roasters',
      qrEnrollmentMessage: 'Hi Sana!',
      menuItemNames: [
        'Red Eye', 'Au Lait', 'Pour Over', 'Traveler Coffee', 'Espresso',
        'Americano', 'Macchiato', 'Gibraltar / Cortado', 'Cappuccino',
        'Flat White', 'Latte', 'Mocha', 'Frosty Gandhi', 'Golden Latte',
        'English Breakfast Tea', 'Turmeric Ginger Tea', 'Jasmine Green Tea',
        'Mystic Mint Tea', 'Chamomile Tea', 'Spicy Chai Tea', 'London Fog Tea',
        'Chai Latte', 'Matcha Latte', 'Iced Strawberry Matcha',
        'Hibiscus Ice Tea', 'Hot Chocolate', 'Steamed Milk',
        'Almond Croissant', 'Connoisseur- Colombia', 'Windsor - Whole Beans',
        'WALIA IBEX - Whole Beans', 'TopoChico', 'Olipop',
        'Vive Immunity boost', 'San Pellegrino',
        'Wild Wonder Organic Peach Ginger Prebiotic & Probiotic Drink',
        'Fresh Orange Juice', 'Mixed Greens Juice', 'Beet Juice',
        'Carrot-Orange Juice', 'Beanie', 'T-shirt', 'Tote Bag',
        'HARIO V60 COFFEE PAPER FILTER', 'HARIO V60 Dripper', 'HARIO V60 DRIPPER',
        'Hario V60 Range server', 'OXO Brew', 'Might Small Glass Carafe',
        'Wired Wonka',
      ],
    },
  ]

  for (const venue of knownVenueConfigs) {
    it(`${venue.slug}'s QR prefilled body does not collide with its own menu`, () => {
      const menu = venue.menuItemNames.map((name) => ({ name }))
      expect(bodyMentionsMenuItem(venue.qrEnrollmentMessage, menu)).toBe(false)
    })
  }

  // Proves the guard has teeth — not green only because nothing collides
  // today. This is a genuine, unambiguous match (not a boundary-violation
  // bug like Sana/San Pellegrino, which the fix above now correctly clears)
  // — a prefilled greeting that literally names a menu item, which is
  // exactly the class of config error this guard exists to catch.
  it('fires on a deliberately colliding prefilled body (guard has teeth)', () => {
    expect(
      bodyMentionsMenuItem('Welcome! Enjoy a free cortado on us.', [{ name: 'Cortado' }]),
    ).toBe(true)
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

  it('resolves the model returning the full multi-word, slash-separated canonical name verbatim', () => {
    const realMenu = [makeMenuItem({ name: 'Gibraltar / Cortado', price: 5 })]
    const resolved = resolveReportedItems([{ name: 'Gibraltar / Cortado', quantity: 1 }], realMenu)
    expect(resolved).toEqual([{ name: 'Gibraltar / Cortado', quantity: 1, unitPriceCents: 500 }])
  })

  it('drops a bare fragment the model did NOT canonicalize (resolver never fuzzy-maps on its own)', () => {
    // If the model returned "cortado" instead of the full canonical
    // "Gibraltar / Cortado", the resolver must NOT try to guess — that's
    // exactly the fuzzy-matching the ticket rules out. The extractor prompt
    // is what's responsible for returning the verbatim name.
    const realMenu = [makeMenuItem({ name: 'Gibraltar / Cortado', price: 5 })]
    const resolved = resolveReportedItems([{ name: 'cortado', quantity: 1 }], realMenu)
    expect(resolved).toEqual([])
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

  describe('end-to-end against a real multi-word menu (UAT regression)', () => {
    const realMenuCtx = (body: string) =>
      makeCtx({
        venue: {
          id: 'venue-1',
          venueInfo: {
            menu: {
              items: [
                makeMenuItem({ name: 'Gibraltar / Cortado', price: 5 }),
                makeMenuItem({ name: 'Almond Croissant', price: 4.5 }),
              ],
            },
          },
        } as RuntimeContext['venue'],
        currentMessage: { id: 'm1', body, providerMessageId: 'p1' } as RuntimeContext['currentMessage'],
      })

    it('records an order for a bare fragment of a multi-word item once the model canonicalizes it', async () => {
      // The exact production failure: guest says "cortado", menu item is
      // "Gibraltar / Cortado". Pre-fix, the prefilter never let this reach
      // the model at all.
      extractReportedOrderAiMock.mockResolvedValue({
        ok: true,
        data: {
          items: [
            { name: 'Gibraltar / Cortado', quantity: 1 },
            { name: 'Almond Croissant', quantity: 1 },
          ],
          promptVersion: 'v1',
        },
      })
      const outcome = await extractReportedOrder(
        realMenuCtx('i got an oat cortado and a croissant'),
      )
      expect(extractReportedOrderAiMock).toHaveBeenCalled()
      expect(outcome).toMatchObject({ kind: 'recorded', amountCents: 500 + 450, itemCount: 2 })
    })

    it('records an order for a modifier-prefixed fragment ("oat cortado")', async () => {
      extractReportedOrderAiMock.mockResolvedValue({
        ok: true,
        data: { items: [{ name: 'Gibraltar / Cortado', quantity: 1 }], promptVersion: 'v1' },
      })
      const outcome = await extractReportedOrder(realMenuCtx('the oat cortado was great today'))
      expect(outcome).toMatchObject({ kind: 'recorded', amountCents: 500 })
    })

    it('drops a model-returned name that is not verbatim on the supplied menu list', async () => {
      extractReportedOrderAiMock.mockResolvedValue({
        ok: true,
        // Hallucinated / non-canonical — not present in realMenuCtx's menu.
        data: { items: [{ name: 'Oat Cortado', quantity: 1 }], promptVersion: 'v1' },
      })
      const outcome = await extractReportedOrder(realMenuCtx('i got an oat cortado'))
      expect(outcome).toEqual({ kind: 'no_items_resolved' })
    })

    it('prices at the highest match when the canonicalized name has menu duplicates with different prices', async () => {
      const ctx = makeCtx({
        venue: {
          id: 'venue-1',
          venueInfo: {
            menu: {
              items: [
                makeMenuItem({ name: 'Gibraltar / Cortado', size: '8oz', price: 5 }),
                makeMenuItem({ name: 'Gibraltar / Cortado', size: '12oz', price: 6 }),
              ],
            },
          },
        } as RuntimeContext['venue'],
        currentMessage: {
          id: 'm1',
          body: 'i got a cortado',
          providerMessageId: 'p1',
        } as RuntimeContext['currentMessage'],
      })
      extractReportedOrderAiMock.mockResolvedValue({
        ok: true,
        data: { items: [{ name: 'Gibraltar / Cortado', quantity: 1 }], promptVersion: 'v1' },
      })
      const outcome = await extractReportedOrder(ctx)
      expect(outcome).toMatchObject({ kind: 'recorded', amountCents: 600 })
    })
  })
})
