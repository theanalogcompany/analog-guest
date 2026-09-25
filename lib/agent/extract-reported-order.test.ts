import { beforeEach, describe, expect, it, vi } from 'vitest'
import { venueLocalInstant } from '@/lib/guests/commitment-expiry'
import type { MenuItem } from '@/lib/schemas'
import type { RuntimeContext } from './types'

const extractReportedOrderAiMock = vi.fn()
vi.mock('@/lib/ai', () => ({
  extractReportedOrder: (...a: unknown[]) => extractReportedOrderAiMock(...a),
}))

interface SupabaseMockState {
  existingTxn: { id: string } | null
  existingTxnError: { message: string } | null
  guestRow: {
    created_at: string
    first_contacted_at: string | null
    last_visit_at?: string | null
    last_visit_precision?: string | null
  } | null
  guestRowError: { message: string } | null
  insertedRow: { id: string } | null
  insertError: { message: string; code?: string } | null
  insertPayload: Record<string, unknown> | null
  // TAC-325: the ongoing-capture same-local-day merge lookup.
  recentOngoing: { id: string; occurred_at: string; raw_data: unknown }[] | null
  recentOngoingError: { message: string } | null
  ongoingLookupFilters: [string, unknown][] | null
  enrollmentGateFilters: [string, unknown][] | null
  // TAC-325: the ongoing-capture merge UPDATE.
  updatePayload: Record<string, unknown> | null
  updateTargetId: string | null
  updateError: { message: string } | null
  // TAC-377: the guests.last_visit_at advance.
  guestUpdatePayload: Record<string, unknown> | null
  guestUpdateFilter: string | null
  guestUpdateError: { message: string } | null
}

function newSupabaseState(overrides: Partial<SupabaseMockState> = {}): SupabaseMockState {
  return {
    existingTxn: null,
    existingTxnError: null,
    guestRow: {
      created_at: new Date().toISOString(),
      first_contacted_at: new Date().toISOString(),
      last_visit_at: null,
      last_visit_precision: null,
    },
    guestRowError: null,
    insertedRow: { id: 'tx-new' },
    insertError: null,
    insertPayload: null,
    recentOngoing: [],
    recentOngoingError: null,
    ongoingLookupFilters: null,
    enrollmentGateFilters: null,
    updatePayload: null,
    updateTargetId: null,
    updateError: null,
    guestUpdatePayload: null,
    guestUpdateFilter: null,
    guestUpdateError: null,
    ...overrides,
  }
}

function makeSupabaseMock(state: SupabaseMockState) {
  return {
    from: (table: string) => {
      if (table === 'transactions') {
        return {
          // Both the enrollment-gate lookup (`.limit().maybeSingle()`) and
          // the TAC-325 ongoing-merge lookup (`.order().limit()`) go through
          // this one chain — they diverge only in which terminal method they
          // call, so both can be served by the same builder. `.eq()` calls
          // are captured so a test can assert exactly which `source` value a
          // given query filtered on (TAC-325's "never reads the enrollment
          // row" guard).
          select: () => {
            const filters: [string, unknown][] = []
            const chain = {
              eq: (col: string, val: unknown) => {
                filters.push([col, val])
                return chain
              },
              limit: () => ({
                maybeSingle: async () => {
                  state.enrollmentGateFilters = filters
                  return { data: state.existingTxn, error: state.existingTxnError }
                },
              }),
              order: () => ({
                limit: async () => {
                  state.ongoingLookupFilters = filters
                  return { data: state.recentOngoing, error: state.recentOngoingError }
                },
              }),
            }
            return chain
          },
          insert: (payload: Record<string, unknown>) => {
            state.insertPayload = payload
            return {
              select: () => ({
                single: async () => ({ data: state.insertedRow, error: state.insertError }),
              }),
            }
          },
          update: (payload: Record<string, unknown>) => {
            state.updatePayload = payload
            return {
              eq: async (_col: string, id: string) => {
                state.updateTargetId = id
                return { error: state.updateError }
              },
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
          update: (payload: Record<string, unknown>) => {
            state.guestUpdatePayload = payload
            return {
              eq: () => ({
                or: async (filter: string) => {
                  state.guestUpdateFilter = filter
                  return { error: state.guestUpdateError }
                },
              }),
            }
          },
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

// TAC-377 time fixtures. Le Mil's runs 07:00-15:00 America/Los_Angeles.
// 2026-06-04 is a Thursday; 17:00Z is 10:00 PDT (open) and 04:00Z is 21:00
// PDT the previous evening (shut).
const OPEN_HOURS = {
  monday: '7:00 AM – 3:00 PM',
  tuesday: '7:00 AM – 3:00 PM',
  wednesday: '7:00 AM – 3:00 PM',
  thursday: '7:00 AM – 3:00 PM',
  friday: '7:00 AM – 3:00 PM',
  saturday: '7:00 AM – 3:00 PM',
  sunday: '7:00 AM – 3:00 PM',
}
const DURING_SERVICE = new Date('2026-06-04T17:00:00Z')
const AFTER_CLOSE = new Date('2026-06-05T04:00:00Z')

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
      // TAC-377: hours + timezone are now dereferenced by
      // resolveVisitPrecision on every recorded order. Backfilled in the
      // fixture rather than making the source defensive against a shape its
      // own type forbids — buildRuntimeContext safeParses venue_info and
      // throws on failure, and `hours` carries a .default({}). Same call as
      // the stages.test.ts makeCtx backfills (TAC-301, TAC-362).
      // OPEN_HOURS below is 07:00-15:00 every day, matching Le Mil's.
      timezone: 'America/Los_Angeles',
      venueInfo: {
        menu: { items: [makeMenuItem({ name: 'Cortado', price: 5 })] },
        hours: OPEN_HOURS,
      },
    } as RuntimeContext['venue'],
    // TAC-423: createdVia and createdAt are backfilled rather than left to the
    // partial cast, because reportsTodaysScanVisit now dereferences both. A
    // fixture that leaves them undefined reads as "not a scan guest" and the
    // scan-day branch is unreachable while every test stays green, which is
    // this repo's signature failure. 'manual' keeps every pre-existing test on
    // the unchanged branch, which is what it was already exercising.
    guest: {
      id: 'guest-1',
      firstName: 'Sam',
      createdVia: 'manual',
      createdAt: new Date('2026-06-04T15:00:00Z'),
    } as RuntimeContext['guest'],
    currentMessage: {
      id: 'inbound-1',
      body: 'i got a cortado',
      providerMessageId: 'p1',
      receivedAt: DURING_SERVICE,
      channel: 'text',
    } as RuntimeContext['currentMessage'],
    followupTrigger: null,
    scanArrival: null,
    conversationChannel: 'text',
    recentMessages: [],
    recognition: {} as RuntimeContext['recognition'],
    mechanics: [],
    recentVisits: [],
    activeCommitments: [],
    openIntentions: [],
    intentionDerivation: { newlyEligible: [], brakeEngaged: false },
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
    // TAC-469 pre-flight. Le Mil's first message arrives two ways: the
    // Sendblue QR sign's prefilled text (venue_info.qrEnrollmentMessage), and,
    // on Instagram, the title of the icebreaker the guest tapped, which lives
    // in Meta's settings and nowhere in this repo. Both are checked here
    // against the live menu (read 2026-09-19). The icebreaker title is the one
    // Jaipal configured ({"question": "Hi Le Mil's!", "payload":
    // "ICEBREAKER_HELLO"}); read the LIVE titles from Meta before lifting the
    // Instagram agent gate and update this if they differ. Titles stay
    // greetings (ruled 2026-09-19): a question would suppress the opener's
    // ask every time. Update this entry whenever the menu or either string
    // changes: nothing errors when it goes stale.
    ...[
      { slug: 'le-mils-coffee', qrEnrollmentMessage: 'Hi Himanshu!' },
      { slug: 'le-mils-coffee (Instagram icebreaker)', qrEnrollmentMessage: "Hi Le Mil's!" },
    ].map((entry) => ({
      ...entry,
      menuItemNames: [
        'Pour Over', 'Espresso', 'Cortado', 'Americano', 'Cappuccino', 'Latte',
        'SoFi', 'Almost Latte', 'Spiced Cold Brew', 'Blossom Tonic',
        'Pink Panther', 'Gulab Jamun Cake', 'Rose Pistachio Barfi',
        'Mango Cardamom Barfi', 'Mango Lassi', 'Flat White',
      ],
    })),
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

  // TAC-325 REVERSES this. Pre-TAC-325, an existing guest_reported row
  // permanently stopped extraction for that guest with no AI call at all.
  // It now falls through to ongoing capture instead — enrollment's gate
  // still runs (still zero AI calls when it PASSES both checks and enrolls),
  // but failing gate 2 alone no longer terminates the run.
  it('falls through to ongoing capture when a guest_reported transaction already exists', async () => {
    currentState = newSupabaseState({ existingTxn: { id: 'tx-old' } })
    extractReportedOrderAiMock.mockResolvedValue({
      ok: true,
      data: {
        items: [{ name: 'Cortado', quantity: 1 }],
        reportTiming: 'present',
        occurredOnDate: '',
        continuesRecentVisit: true,
        promptVersion: 'v1',
      },
    })
    const outcome = await extractReportedOrder(makeCtx())
    expect(extractReportedOrderAiMock).toHaveBeenCalled()
    expect(outcome).toMatchObject({ kind: 'recorded_ongoing', amountCents: 500, itemCount: 1 })
    expect(currentState.insertPayload).toMatchObject({ source: 'guest_reported_ongoing' })
  })

  // TAC-325 REVERSES this. Pre-TAC-325, more than 7 days past guests.created_at
  // permanently stopped extraction with no AI call. It now falls through to
  // ongoing capture — the enrollment window still gates enrollment itself,
  // not order capture generally.
  it('falls through to ongoing capture more than 7 days after guest creation', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    currentState = newSupabaseState({
      guestRow: { created_at: eightDaysAgo, first_contacted_at: eightDaysAgo },
    })
    extractReportedOrderAiMock.mockResolvedValue({
      ok: true,
      data: {
        items: [{ name: 'Cortado', quantity: 1 }],
        reportTiming: 'present',
        occurredOnDate: '',
        continuesRecentVisit: true,
        promptVersion: 'v1',
      },
    })
    const outcome = await extractReportedOrder(makeCtx())
    expect(extractReportedOrderAiMock).toHaveBeenCalled()
    expect(outcome).toMatchObject({ kind: 'recorded_ongoing', amountCents: 500, itemCount: 1 })
  })

  it('returns no_items_resolved when the model reports no items', async () => {
    extractReportedOrderAiMock.mockResolvedValue({ ok: true, data: { items: [], reportTiming: 'present', promptVersion: 'v1' } })
    const outcome = await extractReportedOrder(makeCtx())
    expect(outcome).toEqual({ kind: 'no_items_resolved' })
  })

  it('returns no_items_resolved when the model returns items that resolve to nothing', async () => {
    extractReportedOrderAiMock.mockResolvedValue({
      ok: true,
      data: { items: [{ name: 'Not On The Menu', quantity: 1 }], reportTiming: 'present', promptVersion: 'v1' },
    })
    const outcome = await extractReportedOrder(makeCtx())
    expect(outcome).toEqual({ kind: 'no_items_resolved' })
  })

  it('records a transaction with a priced amount on the happy path', async () => {
    extractReportedOrderAiMock.mockResolvedValue({
      ok: true,
      data: { items: [{ name: 'Cortado', quantity: 1 }], reportTiming: 'present', promptVersion: 'v1' },
    })
    const outcome = await extractReportedOrder(makeCtx())
    expect(outcome).toEqual({
      kind: 'recorded',
      transactionId: 'tx-new',
      amountCents: 500,
      itemCount: 1,
      precision: 'pinned',
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
        timezone: 'America/Los_Angeles',
        id: 'venue-1',
        venueInfo: {
          hours: OPEN_HOURS,
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
        receivedAt: DURING_SERVICE,
      } as RuntimeContext['currentMessage'],
    })
    extractReportedOrderAiMock.mockResolvedValue({
      ok: true,
      data: {
        items: [
          { name: 'Cortado', quantity: 1 },
          { name: 'Seasonal special', quantity: 1 },
        ],
        reportTiming: 'present', promptVersion: 'v1',
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

  // TAC-377 REVERSES this. It previously asserted occurred_at came from the
  // guest's first_contacted_at — sound when the row had no way to express
  // how confident it was, and wrong once it did: a guest who enrolled three
  // days ago and reports a visit today had that visit dated three days back.
  // The uncertainty now lives in `precision` instead of in the timestamp.
  it('uses the inbound message timestamp as occurred_at, not the guest first_contacted_at', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    currentState = newSupabaseState({
      guestRow: { created_at: threeDaysAgo, first_contacted_at: threeDaysAgo },
    })
    extractReportedOrderAiMock.mockResolvedValue({
      ok: true,
      data: { items: [{ name: 'Cortado', quantity: 1 }], reportTiming: 'present', promptVersion: 'v1' },
    })
    await extractReportedOrder(makeCtx())
    expect(currentState.insertPayload?.occurred_at).toBe(DURING_SERVICE.toISOString())
    expect(currentState.insertPayload?.occurred_at).not.toBe(threeDaysAgo)
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
      data: { items: [{ name: 'Cortado', quantity: 1 }], reportTiming: 'present', promptVersion: 'v1' },
    })
    const outcome = await extractReportedOrder(makeCtx())
    expect(outcome).toEqual({ kind: 'already_reported' })
  })

  // ------------------------------------------------------------------
  // TAC-377: visit-time precision + the guests.last_visit_at advance.
  // ------------------------------------------------------------------

  describe('visit precision and last_visit_at (TAC-377, widened by TAC-325)', () => {
    const mockOrder = (reportTiming: 'present') =>
      extractReportedOrderAiMock.mockResolvedValue({
        ok: true,
        data: {
          items: [{ name: 'Cortado', quantity: 1 }],
          reportTiming,
          occurredOnDate: '',
          continuesRecentVisit: true,
          promptVersion: 'v1',
        },
      })

    const mockSpecificPastDay = (occurredOnDate: string) =>
      extractReportedOrderAiMock.mockResolvedValue({
        ok: true,
        data: {
          items: [{ name: 'Cortado', quantity: 1 }],
          reportTiming: 'specific_past_day',
          occurredOnDate,
          continuesRecentVisit: true,
          promptVersion: 'v1',
        },
      })

    it('pins a present-tense report sent while the venue is open', async () => {
      mockOrder('present')
      const outcome = await extractReportedOrder(makeCtx())
      expect(outcome).toMatchObject({ kind: 'recorded', precision: 'pinned' })
      expect(currentState.insertPayload?.occurred_at_precision).toBe('pinned')
    })

    it('does NOT pin a present-tense report sent after the venue has closed', async () => {
      mockOrder('present')
      const outcome = await extractReportedOrder(
        makeCtx({
          currentMessage: {
            id: 'm1',
            body: 'i got a cortado',
            providerMessageId: 'p1',
            receivedAt: AFTER_CLOSE,
          } as RuntimeContext['currentMessage'],
        }),
      )
      expect(outcome).toMatchObject({ kind: 'recorded', precision: 'approximate' })
      expect(currentState.insertPayload?.occurred_at_precision).toBe('approximate')
    })

    // TAC-325: 'specific_past_day' is ALWAYS approximate, whatever the
    // venue's open/closed state — a resolved calendar day is still not a
    // claim that this was the live moment.
    it('does NOT pin a specific-past-day report, even during open hours', async () => {
      mockSpecificPastDay('2026-06-03')
      const outcome = await extractReportedOrder(makeCtx())
      expect(outcome).toMatchObject({ kind: 'recorded', precision: 'approximate' })
    })

    // The safe direction, and the one a future "tidy" is most likely to
    // invert: hours we cannot read are not a closure. parse-venue-spec.ts
    // silently drops rows whose label isn't in DAY_KEY_MAP ("Sat & Sun"),
    // so unreadable hours are a live case, and reading them as shut would
    // permanently suppress post_visit_* for every visit reported then.
    it('pins when the venue hours are unreadable (unknown is not a closure)', async () => {
      mockOrder('present')
      const outcome = await extractReportedOrder(
        makeCtx({
          venue: {
            id: 'venue-1',
            timezone: 'America/Los_Angeles',
            venueInfo: {
              hours: {},
              menu: { items: [makeMenuItem({ name: 'Cortado', price: 5 })] },
            },
          } as RuntimeContext['venue'],
        }),
      )
      expect(outcome).toMatchObject({ kind: 'recorded', precision: 'pinned' })
    })

    it('pins when the venue timezone is unusable (same safe direction)', async () => {
      mockOrder('present')
      const outcome = await extractReportedOrder(
        makeCtx({
          venue: {
            id: 'venue-1',
            timezone: 'Not/AZone',
            venueInfo: {
              hours: OPEN_HOURS,
              menu: { items: [makeMenuItem({ name: 'Cortado', price: 5 })] },
            },
          } as RuntimeContext['venue'],
        }),
      )
      expect(outcome).toMatchObject({ kind: 'recorded', precision: 'pinned' })
    })

    it('advances guests.last_visit_at to the inbound timestamp, with its precision', async () => {
      mockOrder('present')
      await extractReportedOrder(makeCtx())
      expect(currentState.guestUpdatePayload).toEqual({
        last_visit_at: DURING_SERVICE.toISOString(),
        last_visit_precision: 'pinned',
      })
    })

    it('writes last_visit_at for an approximate visit too — the profile is honest either way', async () => {
      mockSpecificPastDay('2026-06-03')
      await extractReportedOrder(makeCtx())
      const expected = venueLocalInstant('America/Los_Angeles', 2026, 6, 3, 12 * 60)
      expect(currentState.guestUpdatePayload).toMatchObject({
        last_visit_at: expected?.toISOString(),
        last_visit_precision: 'approximate',
      })
    })

    it('guards the advance so a fresher last_visit_at is never walked backwards', async () => {
      mockOrder('present')
      await extractReportedOrder(makeCtx())
      expect(currentState.guestUpdateFilter).toBe(
        `last_visit_at.is.null,last_visit_at.lt.${DURING_SERVICE.toISOString()}`,
      )
    })

    // The transaction is the durable record of the visit and is already
    // written by this point; last_visit_at is a derived cache. Failing the
    // whole extraction over it would turn a recorded visit into a `failed`
    // outcome for nothing.
    it('still reports recorded when the last_visit_at update fails', async () => {
      currentState = newSupabaseState({ guestUpdateError: { message: 'guests table down' } })
      mockOrder('present')
      const outcome = await extractReportedOrder(makeCtx())
      expect(outcome).toMatchObject({ kind: 'recorded', transactionId: 'tx-new' })
    })

    it('does not touch guests.last_visit_at when nothing was recorded', async () => {
      extractReportedOrderAiMock.mockResolvedValue({
        ok: true,
        data: { items: [], reportTiming: 'present', promptVersion: 'v1' },
      })
      const outcome = await extractReportedOrder(makeCtx())
      expect(outcome).toEqual({ kind: 'no_items_resolved' })
      expect(currentState.guestUpdatePayload).toBeNull()
    })
  })

  // ------------------------------------------------------------------
  // TAC-325: ongoing order capture. Reached whenever enrollment gate 2
  // (zero existing guest_reported rows) or gate 3 (within 7 days) fails —
  // see the two "falls through" tests above for the fallthrough itself.
  // ------------------------------------------------------------------

  describe('ongoing order capture (TAC-325)', () => {
    const menuCtx = () =>
      makeCtx({
        venue: {
          id: 'venue-1',
          timezone: 'America/Los_Angeles',
          venueInfo: {
            hours: OPEN_HOURS,
            menu: {
              items: [
                makeMenuItem({ name: 'Cortado', price: 5 }),
                makeMenuItem({ name: 'Croissant', price: 4.5 }),
              ],
            },
          },
        } as RuntimeContext['venue'],
        currentMessage: {
          id: 'm2',
          body: 'i also got a matcha, i mean a cortado',
          providerMessageId: 'p2',
          receivedAt: DURING_SERVICE,
        } as RuntimeContext['currentMessage'],
      })

    function ineligibleForEnrollment(overrides: Partial<SupabaseMockState> = {}) {
      currentState = newSupabaseState({ existingTxn: { id: 'tx-enrolled' }, ...overrides })
    }

    function mockCortadoOrder(overrides: Record<string, unknown> = {}) {
      extractReportedOrderAiMock.mockResolvedValue({
        ok: true,
        data: {
          items: [{ name: 'Cortado', quantity: 1 }],
          reportTiming: 'present',
          occurredOnDate: '',
          continuesRecentVisit: true,
          promptVersion: 'v1',
          ...overrides,
        },
      })
    }

    it('inserts a new guest_reported_ongoing row when no same-day row exists', async () => {
      ineligibleForEnrollment({ recentOngoing: [] })
      mockCortadoOrder()
      const outcome = await extractReportedOrder(menuCtx())
      expect(outcome).toMatchObject({ kind: 'recorded_ongoing', amountCents: 500, itemCount: 1 })
      expect(currentState.insertPayload).toMatchObject({ source: 'guest_reported_ongoing' })
    })

    it('merges new items into the same-local-day row when one exists', async () => {
      ineligibleForEnrollment({
        recentOngoing: [
          {
            id: 'tx-ongoing-1',
            occurred_at: DURING_SERVICE.toISOString(),
            raw_data: {
              pos_provider: 'guest_reported',
              amount_source: 'menu_estimate',
              line_items: [{ name: 'Croissant', quantity: 1, unit_price_cents: 450 }],
            },
          },
        ],
      })
      mockCortadoOrder()
      const outcome = await extractReportedOrder(menuCtx())
      expect(outcome).toEqual({
        kind: 'merged_ongoing',
        transactionId: 'tx-ongoing-1',
        amountCents: 950,
        itemCount: 2,
        addedItemCount: 1,
      })
      expect(currentState.updateTargetId).toBe('tx-ongoing-1')
      expect(currentState.updatePayload).toMatchObject({ item_count: 2, amount_cents: 950 })
      const rawData = currentState.updatePayload?.raw_data as { line_items: unknown[] }
      expect(rawData.line_items).toEqual([
        { name: 'Croissant', quantity: 1, unit_price_cents: 450 },
        { name: 'Cortado', quantity: 1, unit_price_cents: 500 },
      ])
      // Nothing new is inserted when a report merges into an existing row.
      expect(currentState.insertPayload).toBeNull()
    })

    it('writes nothing when every reported item is already on the same-day row', async () => {
      ineligibleForEnrollment({
        recentOngoing: [
          {
            id: 'tx-ongoing-1',
            occurred_at: DURING_SERVICE.toISOString(),
            raw_data: {
              pos_provider: 'guest_reported',
              amount_source: 'menu_estimate',
              line_items: [{ name: 'Cortado', quantity: 1, unit_price_cents: 500 }],
            },
          },
        ],
      })
      mockCortadoOrder()
      const outcome = await extractReportedOrder(menuCtx())
      expect(outcome).toEqual({ kind: 'no_new_items_ongoing' })
      expect(currentState.updatePayload).toBeNull()
    })

    // TAC-325 ruling 6c: a genuinely vague past reference writes NOTHING —
    // regardless of whether items were extracted, and on either path
    // (enrollment or ongoing). The important thing here is that the message
    // never becomes a false "today" record just because items resolved.
    it('a vague past report writes nothing, even with items resolved', async () => {
      ineligibleForEnrollment()
      mockCortadoOrder({ reportTiming: 'vague_past' })
      const outcome = await extractReportedOrder(menuCtx())
      expect(outcome).toEqual({ kind: 'vague_past_report' })
      expect(currentState.insertPayload).toBeNull()
      expect(currentState.updatePayload).toBeNull()
    })

    it('continuesRecentVisit: false inserts a new row instead of merging, even on a same-day match', async () => {
      ineligibleForEnrollment({
        recentOngoing: [
          {
            id: 'tx-ongoing-1',
            occurred_at: DURING_SERVICE.toISOString(),
            raw_data: {
              pos_provider: 'guest_reported',
              amount_source: 'menu_estimate',
              line_items: [{ name: 'Croissant', quantity: 1, unit_price_cents: 450 }],
            },
          },
        ],
      })
      mockCortadoOrder({ continuesRecentVisit: false })
      const outcome = await extractReportedOrder(menuCtx())
      expect(outcome).toMatchObject({ kind: 'recorded_ongoing' })
      expect(currentState.updatePayload).toBeNull()
      expect(currentState.insertPayload).toMatchObject({ source: 'guest_reported_ongoing' })
    })

    it('resolves a specific past day in a different DST regime (PST) to the correct UTC instant', async () => {
      ineligibleForEnrollment()
      mockCortadoOrder({ reportTiming: 'specific_past_day', occurredOnDate: '2026-01-15' })
      const outcome = await extractReportedOrder(menuCtx())
      const expected = venueLocalInstant('America/Los_Angeles', 2026, 1, 15, 12 * 60)
      expect(outcome).toMatchObject({ kind: 'recorded_ongoing', precision: 'approximate' })
      expect(currentState.insertPayload?.occurred_at).toBe(expected?.toISOString())
    })

    it('falls back to the message timestamp when the model returns a malformed occurredOnDate', async () => {
      ineligibleForEnrollment()
      mockCortadoOrder({ reportTiming: 'specific_past_day', occurredOnDate: 'not-a-date' })
      const outcome = await extractReportedOrder(menuCtx())
      expect(outcome).toMatchObject({ kind: 'recorded_ongoing', precision: 'approximate' })
      expect(currentState.insertPayload?.occurred_at).toBe(DURING_SERVICE.toISOString())
    })

    // ------------------------------------------------------------------
    // TAC-423, ruled 2026-09-22: a scanning guest's SAME-DAY report is a
    // receipt whatever tense they used.
    //
    // The extractor's own prompt reads a report carrying no timing cue as one
    // about today, which resolves to venue-local NOON and is recorded
    // approximate — and an approximate visit blocks detectPostVisitReason
    // outright. "the blossom tonic" is exactly the answer the opener's
    // question gets, so the common case was silently losing the followup
    // ladder. The sign is at the pickup counter, so a guest enrolled by
    // scanning it today was demonstrably there today.
    //
    // Jaipal's two named cases first, then the three boundaries that stop the
    // rule widening past them.
    const scanGuest = (createdAt: Date) =>
      ({
        id: 'guest-1',
        firstName: 'Sam',
        createdVia: 'qr_scan',
        createdAt,
      }) as RuntimeContext['guest']

    // Case 1 of 2: scan turn, no timing cue, becomes precise.
    it('records a scan-day report with no timing cue as pinned at the message time', async () => {
      ineligibleForEnrollment()
      // 09:00 PDT the same venue-local day as DURING_SERVICE (10:00 PDT).
      const ctx = { ...menuCtx(), guest: scanGuest(new Date('2026-06-04T16:00:00Z')) }
      mockCortadoOrder({ reportTiming: 'specific_past_day', occurredOnDate: '2026-06-04' })
      const outcome = await extractReportedOrder(ctx)
      expect(outcome).toMatchObject({ kind: 'recorded_ongoing', precision: 'pinned' })
      expect(currentState.insertPayload?.occurred_at).toBe(DURING_SERVICE.toISOString())
    })

    // Case 2 of 2: an ordinary turn is untouched. Same report, same day, same
    // everything except how the guest was created.
    it('leaves an ordinary guest\'s no-cue report loose at venue-local noon', async () => {
      ineligibleForEnrollment()
      mockCortadoOrder({ reportTiming: 'specific_past_day', occurredOnDate: '2026-06-04' })
      const outcome = await extractReportedOrder(menuCtx())
      const noon = venueLocalInstant('America/Los_Angeles', 2026, 6, 4, 12 * 60)
      expect(outcome).toMatchObject({ kind: 'recorded_ongoing', precision: 'approximate' })
      expect(currentState.insertPayload?.occurred_at).toBe(noon?.toISOString())
    })

    // Boundary: scanned, but on an earlier day. This is a returning guest
    // talking, and the visit they name is not the one the scan witnessed.
    it('leaves a scan guest enrolled on an earlier day loose at venue-local noon', async () => {
      ineligibleForEnrollment()
      const ctx = { ...menuCtx(), guest: scanGuest(new Date('2026-06-01T16:00:00Z')) }
      mockCortadoOrder({ reportTiming: 'specific_past_day', occurredOnDate: '2026-06-04' })
      const outcome = await extractReportedOrder(ctx)
      const noon = venueLocalInstant('America/Los_Angeles', 2026, 6, 4, 12 * 60)
      expect(outcome).toMatchObject({ kind: 'recorded_ongoing', precision: 'approximate' })
      expect(currentState.insertPayload?.occurred_at).toBe(noon?.toISOString())
    })

    // Boundary: scanned today, but telling us about yesterday. The report's own
    // day is what the guest said, and it is not this visit.
    it('leaves a scan-day guest\'s report about ANOTHER day loose at that day\'s noon', async () => {
      ineligibleForEnrollment()
      const ctx = { ...menuCtx(), guest: scanGuest(new Date('2026-06-04T16:00:00Z')) }
      mockCortadoOrder({ reportTiming: 'specific_past_day', occurredOnDate: '2026-06-03' })
      const outcome = await extractReportedOrder(ctx)
      const noon = venueLocalInstant('America/Los_Angeles', 2026, 6, 3, 12 * 60)
      expect(outcome).toMatchObject({ kind: 'recorded_ongoing', precision: 'approximate' })
      expect(currentState.insertPayload?.occurred_at).toBe(noon?.toISOString())
    })

    // Boundary: precision is RESOLVED, never asserted. A scan-day report
    // arriving while the venue reads closed stays approximate, exactly as a
    // guest writing "just grabbed a cortado" at that hour would. One rule for
    // what pinned means, not two.
    it('does not pin a scan-day report that arrives while the venue is closed', async () => {
      ineligibleForEnrollment()
      const ctx = {
        ...menuCtx(),
        guest: scanGuest(new Date('2026-06-04T16:00:00Z')),
        currentMessage: {
          id: 'm2',
          body: 'i also got a cortado',
          providerMessageId: 'p2',
          receivedAt: AFTER_CLOSE,
        } as RuntimeContext['currentMessage'],
      }
      mockCortadoOrder({ reportTiming: 'specific_past_day', occurredOnDate: '2026-06-04' })
      const outcome = await extractReportedOrder(ctx)
      expect(outcome).toMatchObject({ kind: 'recorded_ongoing', precision: 'approximate' })
      expect(currentState.insertPayload?.occurred_at).toBe(AFTER_CLOSE.toISOString())
    })

    it('still advances last_visit_at when the new report is a different local day than a pinned last visit', async () => {
      ineligibleForEnrollment({
        guestRow: {
          created_at: new Date().toISOString(),
          first_contacted_at: null,
          last_visit_at: '2026-06-01T17:00:00.000Z',
          last_visit_precision: 'pinned',
        },
      })
      mockCortadoOrder()
      await extractReportedOrder(menuCtx())
      expect(currentState.guestUpdatePayload).toEqual({
        last_visit_at: DURING_SERVICE.toISOString(),
        last_visit_precision: 'pinned',
      })
    })

    // TAC-325 ruling 7: never let an approximate write displace a pinned
    // read of the SAME visit.
    it('does not downgrade a pinned last_visit_at when a same-local-day approximate report arrives', async () => {
      ineligibleForEnrollment({
        guestRow: {
          created_at: new Date().toISOString(),
          first_contacted_at: null,
          last_visit_at: DURING_SERVICE.toISOString(),
          last_visit_precision: 'pinned',
        },
      })
      mockCortadoOrder({ reportTiming: 'specific_past_day', occurredOnDate: '2026-06-04' })
      await extractReportedOrder(menuCtx())
      expect(currentState.guestUpdatePayload).toBeNull()
    })

    it('only ever reads guest_reported_ongoing rows for the merge lookup, never the enrollment row', async () => {
      ineligibleForEnrollment({ recentOngoing: [] })
      mockCortadoOrder()
      await extractReportedOrder(menuCtx())
      expect(currentState.ongoingLookupFilters).toContainEqual(['source', 'guest_reported_ongoing'])
      expect(currentState.ongoingLookupFilters).not.toContainEqual(['source', 'guest_reported'])
    })
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
          timezone: 'America/Los_Angeles',
          id: 'venue-1',
          venueInfo: {
            hours: OPEN_HOURS,
            menu: {
              items: [
                makeMenuItem({ name: 'Gibraltar / Cortado', price: 5 }),
                makeMenuItem({ name: 'Almond Croissant', price: 4.5 }),
              ],
            },
          },
        } as RuntimeContext['venue'],
        currentMessage: {
          id: 'm1',
          body,
          providerMessageId: 'p1',
          receivedAt: DURING_SERVICE,
        } as RuntimeContext['currentMessage'],
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
          reportTiming: 'present', promptVersion: 'v1',
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
        data: { items: [{ name: 'Gibraltar / Cortado', quantity: 1 }], reportTiming: 'present', promptVersion: 'v1' },
      })
      const outcome = await extractReportedOrder(realMenuCtx('the oat cortado was great today'))
      expect(outcome).toMatchObject({ kind: 'recorded', amountCents: 500 })
    })

    it('drops a model-returned name that is not verbatim on the supplied menu list', async () => {
      extractReportedOrderAiMock.mockResolvedValue({
        ok: true,
        // Hallucinated / non-canonical — not present in realMenuCtx's menu.
        data: { items: [{ name: 'Oat Cortado', quantity: 1 }], reportTiming: 'present', promptVersion: 'v1' },
      })
      const outcome = await extractReportedOrder(realMenuCtx('i got an oat cortado'))
      expect(outcome).toEqual({ kind: 'no_items_resolved' })
    })

    it('prices at the highest match when the canonicalized name has menu duplicates with different prices', async () => {
      const ctx = makeCtx({
        venue: {
          timezone: 'America/Los_Angeles',
          id: 'venue-1',
          venueInfo: {
            hours: OPEN_HOURS,
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
          receivedAt: DURING_SERVICE,
        } as RuntimeContext['currentMessage'],
      })
      extractReportedOrderAiMock.mockResolvedValue({
        ok: true,
        data: { items: [{ name: 'Gibraltar / Cortado', quantity: 1 }], reportTiming: 'present', promptVersion: 'v1' },
      })
      const outcome = await extractReportedOrder(ctx)
      expect(outcome).toMatchObject({ kind: 'recorded', amountCents: 600 })
    })
  })
})
