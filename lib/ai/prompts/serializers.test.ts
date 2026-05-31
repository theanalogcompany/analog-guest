import { describe, expect, it } from 'vitest'
// Relative import: vitest doesn't pick up Next's `@/*` path alias by default
// without a vitest.config.ts. Other tests in this repo use relative imports too.
import type { EligibleMechanic } from '../../recognition/eligibility'
import {
  type ActiveCommitment,
  type BrandPersona,
  BrandPersonaSchema,
  type MenuItem,
  type VenueInfo,
  VenueInfoSchema,
} from '../../schemas'
import type { KnowledgeCorpusChunk, RecentMessage, RuntimeContext } from '../types'
import {
  knowledgeChunksToProse,
  personaToProse,
  runtimeToProse,
  venueInfoToProse,
} from './serializers'

function makeVenueInfo(overrides: Partial<VenueInfo> = {}): VenueInfo {
  // VenueInfoSchema.parse fills defaults (contact:{}, hours:{}, menu:{...},
  // staff:[], currentContext:[]). Only `address` is required.
  return VenueInfoSchema.parse({
    address: { line1: '1 Test St', city: 'Test', region: 'CA', postalCode: '94000' },
    ...overrides,
  })
}

const item = (overrides: Partial<MenuItem> = {}): MenuItem => ({
  name: 'Espresso',
  category: 'drinks-coffee',
  price: 2.0,
  modifiers: [],
  dietary: [],
  isOffMenu: false,
  ...overrides,
})

describe('venueInfoToProse — menu items', () => {
  it('renders items section with name and price', () => {
    const info = makeVenueInfo({
      menu: {
        highlights: [],
        items: [item({ name: 'Espresso', price: 1.75 })],
      },
    })
    const out = venueInfoToProse(info)
    expect(out).toContain('## Menu (structured)')
    expect(out).toContain('On-menu:')
    expect(out).toContain('- Espresso — $1.75')
  })

  it('splits on-menu vs off-menu sections', () => {
    const info = makeVenueInfo({
      menu: {
        highlights: [],
        items: [
          item({ name: 'Espresso', isOffMenu: false }),
          item({
            name: 'The Rachel',
            category: 'off-menu',
            price: undefined,
            priceNote: 'by request',
            isOffMenu: true,
          }),
        ],
      },
    })
    const out = venueInfoToProse(info)
    expect(out).toContain('On-menu:')
    expect(out).toContain('Off-menu (by request):')
    // priceNote replaces price when price is undefined.
    expect(out).toContain('- The Rachel — by request')
    // On-menu section comes before off-menu section.
    expect(out.indexOf('On-menu:')).toBeLessThan(out.indexOf('Off-menu (by request):'))
  })

  it('renders modifiers conditionally', () => {
    const info = makeVenueInfo({
      menu: {
        highlights: [],
        items: [
          item({ name: 'Espresso', modifiers: [] }),
          item({ name: 'Cappuccino', price: 2.25, modifiers: ['oat milk', 'almond milk'] }),
        ],
      },
    })
    const out = venueInfoToProse(info)
    // Empty modifiers — line ends after price (then newline or section break).
    expect(out).toMatch(/- Espresso — \$2\.00(?!\s*— modifiers)/)
    // Non-empty modifiers — joined with comma+space.
    expect(out).toContain('- Cappuccino — $2.25 — modifiers: oat milk, almond milk')
  })

  it('omits the entire structured menu section when items is empty', () => {
    const info = makeVenueInfo({
      menu: { highlights: ['One', 'Two'], items: [] },
    })
    const out = venueInfoToProse(info)
    expect(out).not.toContain('## Menu (structured)')
    expect(out).not.toContain('On-menu:')
    expect(out).not.toContain('Off-menu')
    // Highlights still render as before.
    expect(out).toContain('Menu highlights: One, Two')
  })
})

describe('venueInfoToProse — currentContext', () => {
  it('omits the Current context section when currentContext is empty', () => {
    const info = makeVenueInfo({ currentContext: [] })
    const out = venueInfoToProse(info)
    expect(out).not.toContain('## Current context')
  })
})

describe('venueInfoToProse — hours notes multiline fix', () => {
  it('nests multi-line notes as sub-bullets so they stay inside the Hours block', () => {
    const info = makeVenueInfo({
      hours: {
        monday: '7am–3pm',
        notes:
          'Annual closures: Christmas Day, July 4\nNotes: Gunther off Tuesdays — Maya covers',
      },
    })
    const out = venueInfoToProse(info)
    // Header + nested sub-bullets.
    expect(out).toContain('  - Notes:\n    - Annual closures: Christmas Day, July 4\n    - Notes: Gunther off Tuesdays — Maya covers')
    // The bug we're fixing: the second line should NOT escape the indentation
    // (used to render as `Notes: Gunther...` at column 0).
    expect(out).not.toMatch(/^Notes: Gunther/m)
  })
})

const today: NonNullable<RuntimeContext['today']> = {
  isoDate: '2026-04-29',
  dayOfWeek: 'Wednesday',
  venueLocalTime: '14:30',
  venueTimezone: 'America/New_York',
}

const NOW = new Date('2026-04-29T18:30:00Z') // matches today block (14:30 ET)

const recent = (overrides: Partial<RecentMessage> = {}): RecentMessage => ({
  direction: 'inbound',
  body: 'hi',
  createdAt: NOW,
  ...overrides,
})

describe('runtimeToProse — today block', () => {
  it('renders ## Right now at the top with date and venue-local time', () => {
    const out = runtimeToProse({ today }, 'reply', NOW)
    expect(out.startsWith('## Right now\n')).toBe(true)
    expect(out).toContain('- Date: Wednesday, 2026-04-29')
    expect(out).toContain('- Time at venue: 14:30 (America/New_York)')
  })

  it('renders today block before the inbound-message line', () => {
    const out = runtimeToProse(
      { today, inboundMessage: 'what time do you close?' },
      'reply',
      NOW,
    )
    expect(out.indexOf('## Right now')).toBeLessThan(
      out.indexOf('The guest just sent:'),
    )
  })

  it('omits today block when not provided', () => {
    const out = runtimeToProse({ inboundMessage: 'hi' }, 'reply', NOW)
    expect(out).not.toContain('## Right now')
  })
})

describe('runtimeToProse — recent conversation block', () => {
  it('renders chronological [speaker, delta] body lines', () => {
    const out = runtimeToProse(
      {
        recentMessages: [
          recent({ direction: 'inbound', body: 'hi', createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000) }),
          recent({ direction: 'outbound', body: 'hey.', createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000 + 60_000) }),
          recent({ direction: 'inbound', body: 'do you have oat milk?', createdAt: new Date(NOW.getTime() - 5 * 60 * 1000) }),
        ],
      },
      'reply',
      NOW,
    )
    expect(out).toContain('## Recent conversation')
    expect(out).toContain('[guest, 2 hours ago] hi')
    expect(out).toContain('[venue, 1 hour ago] hey.')
    expect(out).toContain('[guest, 5 minutes ago] do you have oat milk?')
  })

  it('renders time deltas at each threshold', () => {
    const out = runtimeToProse(
      {
        recentMessages: [
          recent({ body: 'now', createdAt: new Date(NOW.getTime() - 30_000) }), // 30s
          recent({ body: 'oneMin', createdAt: new Date(NOW.getTime() - 60_000) }), // 1 min
          recent({ body: 'manyMin', createdAt: new Date(NOW.getTime() - 30 * 60_000) }), // 30 min
          recent({ body: 'oneHr', createdAt: new Date(NOW.getTime() - 60 * 60_000) }), // 1 h
          recent({ body: 'manyHr', createdAt: new Date(NOW.getTime() - 5 * 60 * 60_000) }), // 5 h
          recent({ body: 'yesterday', createdAt: new Date(NOW.getTime() - 30 * 60 * 60_000) }), // 30 h
          recent({ body: 'multiDay', createdAt: new Date(NOW.getTime() - 5 * 24 * 60 * 60_000) }), // 5 d
        ],
      },
      'reply',
      NOW,
    )
    expect(out).toContain('] now')
    expect(out).toContain('[guest, just now] now')
    expect(out).toContain('[guest, 1 minute ago] oneMin')
    expect(out).toContain('[guest, 30 minutes ago] manyMin')
    expect(out).toContain('[guest, 1 hour ago] oneHr')
    expect(out).toContain('[guest, 5 hours ago] manyHr')
    expect(out).toContain('[guest, yesterday] yesterday')
    expect(out).toContain('[guest, 5 days ago] multiDay')
  })

  it('omits the block entirely when recentMessages is empty', () => {
    const out = runtimeToProse({ recentMessages: [] }, 'reply', NOW)
    expect(out).not.toContain('## Recent conversation')
  })

  it('omits the block when recentMessages is undefined', () => {
    const out = runtimeToProse({ inboundMessage: 'hi' }, 'reply', NOW)
    expect(out).not.toContain('## Recent conversation')
  })

  it('collapses newlines in body and truncates long bodies to 200 chars with ellipsis', () => {
    const longBody = 'a'.repeat(250)
    const out = runtimeToProse(
      {
        recentMessages: [
          recent({ body: 'line1\nline2\n  line3', createdAt: new Date(NOW.getTime() - 60_000) }),
          recent({ body: longBody, createdAt: new Date(NOW.getTime() - 120_000) }),
        ],
      },
      'reply',
      NOW,
    )
    expect(out).toContain('] line1 line2 line3')
    expect(out).toContain(`] ${'a'.repeat(200)}…`)
    expect(out).not.toContain('a'.repeat(201))
  })

  it('renders today before recent conversation', () => {
    const out = runtimeToProse(
      {
        today,
        recentMessages: [recent({ body: 'hi', createdAt: new Date(NOW.getTime() - 60_000) })],
      },
      'reply',
      NOW,
    )
    expect(out.indexOf('## Right now')).toBeLessThan(out.indexOf('## Recent conversation'))
  })
})

const mechanic = (overrides: Partial<EligibleMechanic> = {}): EligibleMechanic => ({
  id: 'm-1',
  type: 'perk',
  name: 'The Joey',
  description: null,
  qualification: null,
  rewardDescription: null,
  minState: null,
  requiresOperatorApproval: false,
  ...overrides,
})

describe('runtimeToProse — eligibility block (THE-170)', () => {
  it('renders the empty-list framing when mechanics is an empty array', () => {
    const out = runtimeToProse({ mechanics: [] }, 'reply', NOW)
    expect(out).toContain('## What this guest can access')
    expect(out).toContain('Do not offer perks of any kind.')
    expect(out).toContain("hasn't yet earned access to perks")
  })

  it('renders bullets with name + reward + qualification when mechanics has entries', () => {
    const out = runtimeToProse(
      {
        mechanics: [
          mechanic({
            name: 'The Joey',
            rewardDescription: 'free couch hold for 2 hours',
            qualification: 'regulars only',
          }),
        ],
      },
      'reply',
      NOW,
    )
    expect(out).toContain('## What this guest can access')
    expect(out).toContain('- The Joey — free couch hold for 2 hours (regulars only)')
  })

  it('renders bare name when reward and qualification are null', () => {
    const out = runtimeToProse(
      { mechanics: [mechanic({ name: 'Naked Mechanic' })] },
      'reply',
      NOW,
    )
    expect(out).toContain('- Naked Mechanic')
    expect(out).not.toContain('- Naked Mechanic —')
    expect(out).not.toContain('- Naked Mechanic (')
  })

  it('omits the eligibility block entirely when mechanics is undefined', () => {
    const out = runtimeToProse({ inboundMessage: 'hi' }, 'reply', NOW)
    expect(out).not.toContain('## What this guest can access')
  })

  it('renders eligibility block after Right now and before Recent conversation', () => {
    const out = runtimeToProse(
      {
        today,
        mechanics: [],
        recentMessages: [recent({ body: 'hi', createdAt: new Date(NOW.getTime() - 60_000) })],
      },
      'reply',
      NOW,
    )
    const rightNowIdx = out.indexOf('## Right now')
    const eligibilityIdx = out.indexOf('## What this guest can access')
    const recentIdx = out.indexOf('## Recent conversation')
    expect(rightNowIdx).toBeGreaterThanOrEqual(0)
    expect(eligibilityIdx).toBeGreaterThan(rightNowIdx)
    expect(recentIdx).toBeGreaterThan(eligibilityIdx)
  })
})

// TAC-234: runtimeToProse field-presence rendering replaces the per-category
// switch. Tests assert what each independent emitter renders given a runtime
// shape, regardless of which category it pairs with.

describe('runtimeToProse — inbound framing line (TAC-234)', () => {
  // One consistent line for any inbound-driven category. Carve-outs ("just
  // asked", "(opt-out request)") collapsed — category instructions in the
  // system prompt convey question vs statement intent already.
  const inboundCategories = [
    'reply',
    'new_question',
    'opt_out',
    'acknowledgment',
    'comp_complaint',
    'mechanic_request',
    'recommendation_request',
    'casual_chatter',
    'personal_history_question',
    'perk_inquiry',
    'event_question',
    'unknown',
  ] as const

  for (const cat of inboundCategories) {
    it(`renders the unified inbound line for ${cat}`, () => {
      const out = runtimeToProse({ inboundMessage: 'hey there' }, cat, NOW)
      expect(out).toContain('The guest just sent: "hey there"')
    })
  }

  it('omits the line when inboundMessage is undefined', () => {
    const out = runtimeToProse({}, 'follow_up', NOW)
    expect(out).not.toContain('The guest just sent:')
  })

  it('does NOT use the legacy "just asked" framing for question categories', () => {
    const out = runtimeToProse(
      { inboundMessage: 'whats good' },
      'new_question',
      NOW,
    )
    expect(out).not.toContain('The guest just asked:')
  })

  it('does NOT use the legacy "(opt-out request)" suffix', () => {
    const out = runtimeToProse({ inboundMessage: 'stop' }, 'opt_out', NOW)
    expect(out).not.toContain('(opt-out request)')
    expect(out).toContain('The guest just sent: "stop"')
  })
})

describe('runtimeToProse — perk_unlock outbound block (TAC-234)', () => {
  it('renders Perk / Why qualified / What offered when perkBeingUnlocked is set', () => {
    const out = runtimeToProse(
      {
        perkBeingUnlocked: {
          name: 'The Joey',
          qualification: '5+ visits in 30 days',
          rewardDescription: 'free drink on the house',
        },
      },
      'perk_unlock',
      NOW,
    )
    expect(out).toContain('Perk: The Joey')
    expect(out).toContain('Why they qualified: 5+ visits in 30 days')
    expect(out).toContain("What they're being offered: free drink on the house")
  })

  it('omits the block entirely when perkBeingUnlocked is undefined', () => {
    const out = runtimeToProse({}, 'perk_unlock', NOW)
    expect(out).not.toContain('Perk:')
    expect(out).not.toContain('Why they qualified:')
  })
})

describe('runtimeToProse — event_invite outbound block (TAC-234)', () => {
  it('renders Event / Description / Date when eventBeingInvited is set', () => {
    const out = runtimeToProse(
      {
        eventBeingInvited: {
          name: 'Open Mic',
          description: 'monthly community night',
          date: 'Saturday, May 9 at 8pm',
        },
      },
      'event_invite',
      NOW,
    )
    expect(out).toContain('Event: Open Mic')
    expect(out).toContain('Description: monthly community night')
    expect(out).toContain('Date: Saturday, May 9 at 8pm')
  })

  it('omits the block entirely when eventBeingInvited is undefined', () => {
    const out = runtimeToProse({}, 'event_invite', NOW)
    expect(out).not.toContain('Event:')
    expect(out).not.toContain('Description:')
  })
})

describe('runtimeToProse — guest relationship line (TAC-234)', () => {
  it('renders the line when recognition.state is set', () => {
    const out = runtimeToProse(
      { inboundMessage: 'hey', recognition: { state: 'regular' } },
      'reply',
      NOW,
    )
    expect(out).toContain('Guest relationship: regular')
  })

  it('renders all four state values', () => {
    for (const state of ['new', 'returning', 'regular', 'raving_fan'] as const) {
      const out = runtimeToProse(
        { inboundMessage: 'hi', recognition: { state } },
        'reply',
        NOW,
      )
      expect(out).toContain(`Guest relationship: ${state}`)
    }
  })

  it('omits the line when recognition is undefined', () => {
    const out = runtimeToProse({ inboundMessage: 'hi' }, 'reply', NOW)
    expect(out).not.toContain('Guest relationship:')
  })

  it('positions the line directly after the inbound framing line', () => {
    const out = runtimeToProse(
      { inboundMessage: 'hey', recognition: { state: 'raving_fan' } },
      'reply',
      NOW,
    )
    const inboundIdx = out.indexOf('The guest just sent: "hey"')
    const relIdx = out.indexOf('Guest relationship: raving_fan')
    expect(inboundIdx).toBeGreaterThanOrEqual(0)
    expect(relIdx).toBeGreaterThan(inboundIdx)
    // No other lines between them.
    const between = out.slice(inboundIdx, relIdx).split('\n').filter(Boolean)
    expect(between).toHaveLength(1)
  })

  it('also renders the line on outbound paths (no inbound framing to anchor to)', () => {
    // Mutual exclusion is invariant-by-orchestrator: outbound paths don't
    // populate inboundMessage. The serializer renders the recognition line
    // standalone in that case — locking current behavior so a future change
    // is observable. (TAC-243 will tighten the type system itself.)
    const out = runtimeToProse(
      {
        perkBeingUnlocked: {
          name: 'The Joey',
          qualification: '5 visits',
          rewardDescription: 'free drink',
        },
        recognition: { state: 'regular' },
      },
      'perk_unlock',
      NOW,
    )
    expect(out).toContain('Guest relationship: regular')
    expect(out).toContain('Perk: The Joey')
    expect(out).not.toContain('The guest just sent:')
  })
})

// TAC-234: ## Visit history block. Renders at block level (between mechanics
// and recent conversation), gated on category — welcome and opt_out skip it.
// Replaces THE-229's single-transaction ## Last visit block.
describe('runtimeToProse — ## Visit history block (TAC-234)', () => {
  const visitedAt3 = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000) // 3 days ago
  const visitedAt7 = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000) // 7 days ago
  const visitedAt30 = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000) // 30 days ago

  it('renders multiple visits as a bulleted, most-recent-first list', () => {
    const out = runtimeToProse(
      {
        recentVisits: [
          { items: ['latte'], visitedAt: visitedAt3 },
          { items: ['cappuccino', 'blueberry muffin'], visitedAt: visitedAt7 },
          { items: ['cortado'], visitedAt: visitedAt30 },
        ],
      },
      'reply',
      NOW,
    )
    expect(out).toContain('## Visit history')
    expect(out).toContain('- [3 days ago] latte')
    expect(out).toContain('- [7 days ago] cappuccino, blueberry muffin')
    expect(out).toContain('- [30 days ago] cortado')
    // Order check: most-recent-first.
    const i3 = out.indexOf('- [3 days ago]')
    const i7 = out.indexOf('- [7 days ago]')
    const i30 = out.indexOf('- [30 days ago]')
    expect(i3).toBeLessThan(i7)
    expect(i7).toBeLessThan(i30)
  })

  it('renders a single visit as one bullet (most common case at low traffic)', () => {
    const out = runtimeToProse(
      { recentVisits: [{ items: ['cappuccino'], visitedAt: visitedAt3 }] },
      'reply',
      NOW,
    )
    expect(out).toContain('## Visit history')
    expect(out).toContain('- [3 days ago] cappuccino')
  })

  it('renders the canonical pattern-recognition intro line', () => {
    const out = runtimeToProse(
      { recentVisits: [{ items: ['latte'], visitedAt: visitedAt3 }] },
      'reply',
      NOW,
    )
    expect(out).toContain(
      "Recent transactions, most recent first. Use this to recognize patterns and offer relevant suggestions — don't recite history back at the guest.",
    )
  })

  it('renders "yesterday" for a 25-hour-old visit', () => {
    const yesterday = new Date(NOW.getTime() - 25 * 60 * 60 * 1000)
    const out = runtimeToProse(
      { recentVisits: [{ items: ['latte'], visitedAt: yesterday }] },
      'reply',
      NOW,
    )
    expect(out).toContain('- [yesterday] latte')
  })

  it('omits the block when recentVisits is undefined', () => {
    const out = runtimeToProse({ inboundMessage: 'hey' }, 'reply', NOW)
    expect(out).not.toContain('## Visit history')
  })

  it('omits the block when recentVisits is an empty array (skip-on-empty parallels recent conversation)', () => {
    const out = runtimeToProse({ recentVisits: [] }, 'reply', NOW)
    expect(out).not.toContain('## Visit history')
  })

  it('omits the block for welcome', () => {
    const out = runtimeToProse(
      { recentVisits: [{ items: ['cappuccino'], visitedAt: visitedAt3 }] },
      'welcome',
      NOW,
    )
    expect(out).not.toContain('## Visit history')
  })

  it('omits the block for opt_out', () => {
    const out = runtimeToProse(
      {
        recentVisits: [{ items: ['cappuccino'], visitedAt: visitedAt3 }],
        inboundMessage: 'stop',
      },
      'opt_out',
      NOW,
    )
    expect(out).not.toContain('## Visit history')
  })

  it('renders the block for every other category', () => {
    const includedCategories = [
      'follow_up',
      'reply',
      'new_question',
      'perk_unlock',
      'event_invite',
      'manual',
      'acknowledgment',
      'comp_complaint',
      'mechanic_request',
      'recommendation_request',
      'casual_chatter',
      'personal_history_question',
      'perk_inquiry',
      'event_question',
      'unknown',
    ] as const

    for (const cat of includedCategories) {
      const out = runtimeToProse(
        { recentVisits: [{ items: ['cappuccino'], visitedAt: visitedAt3 }] },
        cat,
        NOW,
      )
      expect(out, `category ${cat} should render Visit history block`).toContain(
        '## Visit history',
      )
    }
  })

  it('places the block after mechanics and before recent conversation', () => {
    const out = runtimeToProse(
      {
        today,
        mechanics: [],
        recentVisits: [{ items: ['cappuccino'], visitedAt: visitedAt3 }],
        recentMessages: [recent({ body: 'hi', createdAt: new Date(NOW.getTime() - 60_000) })],
      },
      'reply',
      NOW,
    )
    const eligibilityIdx = out.indexOf('## What this guest can access')
    const visitHistoryIdx = out.indexOf('## Visit history')
    const recentIdx = out.indexOf('## Recent conversation')
    expect(eligibilityIdx).toBeGreaterThanOrEqual(0)
    expect(visitHistoryIdx).toBeGreaterThan(eligibilityIdx)
    expect(recentIdx).toBeGreaterThan(visitHistoryIdx)
  })
})

// THE-232: Operator instruction block. Renders at the top of the prompt
// (above mechanics + visit history + recent conversation) when the operator's
// note flowed through buildAiRuntime.
describe('runtimeToProse — ## Operator instruction block', () => {
  it('renders the block with the operator\'s note verbatim', () => {
    const out = runtimeToProse(
      { operatorInstruction: 'remind them about open mic this saturday' },
      'manual',
      NOW,
    )
    expect(out).toContain('## Operator instruction')
    expect(out).toContain(
      'The operator wants you to follow up with this guest about: remind them about open mic this saturday',
    )
    expect(out).toContain('Draft a message that addresses this directly, in the venue\'s voice.')
  })

  it('omits the block when operatorInstruction is undefined', () => {
    const out = runtimeToProse({ inboundMessage: 'hi' }, 'manual', NOW)
    expect(out).not.toContain('## Operator instruction')
  })

  it('omits the block when operatorInstruction is the empty string', () => {
    const out = runtimeToProse({ operatorInstruction: '' }, 'manual', NOW)
    expect(out).not.toContain('## Operator instruction')
  })

  it('places the block above mechanics, visit history, and recent conversation', () => {
    const visitedAt = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000)
    const out = runtimeToProse(
      {
        today,
        operatorInstruction: 'follow up on their recent visit',
        mechanics: [],
        recentVisits: [{ items: ['cappuccino'], visitedAt }],
        recentMessages: [recent({ body: 'hey', createdAt: new Date(NOW.getTime() - 60_000) })],
      },
      'manual',
      NOW,
    )
    const opIdx = out.indexOf('## Operator instruction')
    const eligibilityIdx = out.indexOf('## What this guest can access')
    const visitHistoryIdx = out.indexOf('## Visit history')
    const recentIdx = out.indexOf('## Recent conversation')
    expect(opIdx).toBeGreaterThanOrEqual(0)
    expect(eligibilityIdx).toBeGreaterThan(opIdx)
    expect(visitHistoryIdx).toBeGreaterThan(opIdx)
    expect(recentIdx).toBeGreaterThan(opIdx)
  })

  it('places the block after Right now (orientation stays first)', () => {
    const out = runtimeToProse(
      { today, operatorInstruction: 'check in on their recent visit' },
      'manual',
      NOW,
    )
    const rightNowIdx = out.indexOf('## Right now')
    const opIdx = out.indexOf('## Operator instruction')
    expect(rightNowIdx).toBeGreaterThanOrEqual(0)
    expect(opIdx).toBeGreaterThan(rightNowIdx)
  })
})

describe('knowledgeChunksToProse (TAC-242)', () => {
  const makeChunk = (overrides: Partial<KnowledgeCorpusChunk> = {}): KnowledgeCorpusChunk => ({
    id: 'k1',
    text: 'Our flagship blend is two Ethiopian coffees roasted by a friend.',
    sourceType: 'voicenote_transcript',
    primaryTags: ['sourcing'],
    secondaryTags: ['ethiopia', 'roaster'],
    relevanceScore: 0.82,
    ...overrides,
  })

  it('renders the no-match block with explicit framing when chunks is empty', () => {
    const out = knowledgeChunksToProse([])
    expect(out).toContain('## Venue knowledge')
    expect(out).toContain('No specific venue knowledge matched this query')
    expect(out).toContain('defer or admit you')
    expect(out).toContain('do not invent specifics')
  })

  it('renders the section header and the canonical voice/content disclaimer', () => {
    const out = knowledgeChunksToProse([makeChunk()])
    expect(out).toContain('## Venue knowledge')
    expect(out).toContain('Facts about the venue you can ground replies in')
    expect(out).toContain("speak in the venue's voice")
  })

  it('renders [primary: ...] and [secondary: ...] lines above each quoted body', () => {
    const out = knowledgeChunksToProse([makeChunk()])
    expect(out).toContain('[primary: sourcing]')
    expect(out).toContain('[secondary: ethiopia, roaster]')
    expect(out).toContain('> Our flagship blend is two Ethiopian coffees roasted by a friend.')
  })

  it('renders multiple primary tags comma-separated', () => {
    const out = knowledgeChunksToProse([
      makeChunk({ primaryTags: ['menu', 'staff_phoebe'], secondaryTags: ['seasonal'] }),
    ])
    expect(out).toContain('[primary: menu, staff_phoebe]')
    expect(out).toContain('[secondary: seasonal]')
  })

  it('omits the [secondary: ...] line entirely when secondaryTags is empty', () => {
    const out = knowledgeChunksToProse([
      makeChunk({ primaryTags: ['mechanic_perk_card'], secondaryTags: [] }),
    ])
    expect(out).toContain('[primary: mechanic_perk_card]')
    expect(out).not.toContain('[secondary:')
  })

  it('falls back to sourceType in the [primary: ...] line when primaryTags is empty', () => {
    // Defensive: schema-valid chunks should always have at least one primary
    // tag, but the runtime helper shouldn't break on an empty array.
    const out = knowledgeChunksToProse([
      makeChunk({ primaryTags: [], secondaryTags: [], sourceType: 'manual_entry' }),
    ])
    expect(out).toContain('[primary: manual_entry]')
  })

  it('separates multiple chunks with a blank line', () => {
    const out = knowledgeChunksToProse([
      makeChunk({ id: 'k1', primaryTags: ['sourcing'], secondaryTags: [], text: 'fact one' }),
      makeChunk({ id: 'k2', primaryTags: ['staff_rayan'], secondaryTags: [], text: 'fact two' }),
    ])
    expect(out).toMatch(/\[primary: sourcing\]\n> fact one\n\n\[primary: staff_rayan\]\n> fact two/)
  })

  it('quotes multi-line chunks line by line', () => {
    const out = knowledgeChunksToProse([
      makeChunk({
        text: 'first line\nsecond line',
        primaryTags: ['philosophy'],
        secondaryTags: [],
      }),
    ])
    expect(out).toContain('> first line\n> second line')
  })
})

// THE-236: voiceAntiPatterns reshape — serializer must read `.text` from
// each struct entry instead of rendering the entry directly. Legacy string
// entries are still accepted at the schema boundary and normalized to struct
// shape before reaching this code path.
describe('personaToProse — voice anti-patterns', () => {
  function makePersona(overrides: Partial<BrandPersona> = {}): BrandPersona {
    return BrandPersonaSchema.parse({
      tone: 'warm and direct',
      formality: 'casual',
      speakerFraming: 'venue',
      emojiPolicy: 'never',
      lengthGuide: 'short — 1-2 sentences',
      ...overrides,
    })
  }

  it('renders the anti-patterns block from struct entries', () => {
    const persona = makePersona({
      voiceAntiPatterns: [
        { text: 'no marketing flourishes', source: 'manual' },
        {
          text: 'no closing acknowledgments',
          source: 'auto',
          addedAt: '2026-05-08T12:00:00.000Z',
        },
      ],
    })
    const out = personaToProse(persona)
    expect(out).toContain('## Anti-patterns (what NOT to sound like)')
    expect(out).toContain('- no marketing flourishes')
    expect(out).toContain('- no closing acknowledgments')
    // Metadata stays in storage; the prompt sees text only.
    expect(out).not.toMatch(/source|addedAt|manual|auto/)
  })

  it('renders the same block from legacy string entries normalized at parse time', () => {
    const persona = makePersona({
      voiceAntiPatterns: ['no marketing flourishes'] as unknown as BrandPersona['voiceAntiPatterns'],
    })
    expect(personaToProse(persona)).toContain('- no marketing flourishes')
  })

  it('omits the block entirely when voiceAntiPatterns is empty', () => {
    const out = personaToProse(makePersona({ voiceAntiPatterns: [] }))
    expect(out).not.toContain('## Anti-patterns')
  })
})

// PR-C: `## Critique to incorporate` block fires only when the regen path
// passes runtime.critiqueToIncorporate. Production agent runs never set
// this. The block sits above `## Right now` so the model treats it as the
// dominant signal.
describe('runtimeToProse — critique block', () => {
  it('renders the critique block above the Right now block', () => {
    const out = runtimeToProse(
      {
        critiqueToIncorporate: 'too eager — drop the exclamation',
        today: {
          isoDate: '2026-05-08',
          dayOfWeek: 'Friday',
          venueLocalTime: '10:00',
          venueTimezone: 'America/Los_Angeles',
        },
      },
      'reply',
    )
    expect(out).toContain('## Critique to incorporate')
    expect(out).toContain('too eager — drop the exclamation')
    const critiqueIdx = out.indexOf('## Critique to incorporate')
    const rightNowIdx = out.indexOf('## Right now')
    expect(critiqueIdx).toBeGreaterThanOrEqual(0)
    expect(rightNowIdx).toBeGreaterThan(critiqueIdx)
  })

  it('omits the block when critiqueToIncorporate is undefined', () => {
    const out = runtimeToProse(
      {
        today: {
          isoDate: '2026-05-08',
          dayOfWeek: 'Friday',
          venueLocalTime: '10:00',
          venueTimezone: 'America/Los_Angeles',
        },
      },
      'reply',
    )
    expect(out).not.toContain('## Critique to incorporate')
  })
})

describe('runtimeToProse — ## Guest context block (TAC-296)', () => {
  const today = {
    isoDate: '2026-05-08',
    dayOfWeek: 'Friday',
    venueLocalTime: '10:00',
    venueTimezone: 'America/Los_Angeles',
  }

  it('omits the block entirely when guestContext is undefined', () => {
    const out = runtimeToProse({ today }, 'reply')
    expect(out).not.toContain('## Guest context')
  })

  it('omits the block entirely when guestContext is empty (no captured data)', () => {
    const out = runtimeToProse({ today, guestContext: {} }, 'reply')
    expect(out).not.toContain('## Guest context')
  })

  it('renders structured details when guest_details is populated', () => {
    const out = runtimeToProse(
      {
        today,
        guestContext: {
          guest_details: {
            first_name: 'Sarah',
            pronouns: 'she/her',
            home_base: 'Bernal Heights, SF',
          },
        },
      },
      'reply',
    )
    expect(out).toContain('## Guest context')
    expect(out).toContain('First name: Sarah')
    expect(out).toContain('Pronouns: she/her')
    expect(out).toContain('Home base: Bernal Heights, SF')
  })

  it('renders preferences as bulleted lines', () => {
    const out = runtimeToProse(
      {
        today,
        guestContext: { preferences: { dietary: ['vegan'], favorites: ['oat latte'] } },
      },
      'reply',
    )
    expect(out).toContain('Dietary: vegan')
    expect(out).toContain('Favorites: oat latte')
  })

  it('renders life_context entries as bullets without echoing timestamps', () => {
    const out = runtimeToProse(
      {
        today,
        guestContext: {
          life_context: [
            { note: 'in Tokyo until the 30th', captured_at: '2026-04-15T10:00:00Z', expires_at: '2026-05-30T00:00:00Z' },
          ],
        },
      },
      'reply',
    )
    expect(out).toContain('Life context (time-bound):')
    expect(out).toContain('- in Tokyo until the 30th')
    expect(out).not.toContain('2026-04-15')
  })

  it('renders observations as bullets in stored order', () => {
    const out = runtimeToProse(
      {
        today,
        guestContext: {
          observations: [
            { note: 'mentioned she runs', captured_at: '2026-04-20T08:00:00Z' },
            { note: 'has a dog named Hank', captured_at: '2026-04-22T08:00:00Z' },
          ],
        },
      },
      'reply',
    )
    expect(out).toContain('Observations:')
    expect(out).toContain('- mentioned she runs')
    expect(out).toContain('- has a dog named Hank')
  })

  it('sits between Visit history and Recent conversation in the assembled prompt', () => {
    const out = runtimeToProse(
      {
        today,
        recentVisits: [{ items: ['cappuccino'], visitedAt: new Date('2026-05-01T10:00:00Z') }],
        guestContext: { guest_details: { first_name: 'Sarah' } },
        recentMessages: [
          { direction: 'inbound', body: 'hi', createdAt: new Date('2026-05-07T10:00:00Z') },
        ],
      },
      'reply',
      new Date('2026-05-08T10:00:00Z'),
    )
    const visitIdx = out.indexOf('## Visit history')
    const guestCtxIdx = out.indexOf('## Guest context')
    const recentIdx = out.indexOf('## Recent conversation')
    expect(visitIdx).toBeGreaterThanOrEqual(0)
    expect(guestCtxIdx).toBeGreaterThan(visitIdx)
    expect(recentIdx).toBeGreaterThan(guestCtxIdx)
  })

  it('renders the framing intro instructing the model to use context for recognition', () => {
    const out = runtimeToProse(
      {
        today,
        guestContext: { guest_details: { first_name: 'Sarah' } },
      },
      'reply',
    )
    expect(out).toContain('Things the guest has shared across past conversations')
    expect(out).toContain('do not introduce facts the guest hasn')
  })

  it('renders for the welcome category (guest context is useful for first-contact NFC-tap from known phone)', () => {
    const out = runtimeToProse(
      {
        today,
        guestContext: { preferences: { dietary: ['vegan'] } },
      },
      'welcome',
    )
    expect(out).toContain('## Guest context')
    expect(out).toContain('Dietary: vegan')
  })

  it('truncates observations to 5 floor when the rendered block would exceed the char budget', () => {
    // 15 observations of ~200 chars each ≈ 3000 chars total, well over the
    // 2000-char (~500-token) budget. The fallback should trim to the last 5.
    const longNote = 'mentioned she runs marathons and competes in trail-running events held in northern california during the spring season every year'
    const observations = Array.from({ length: 15 }, (_, i) => ({
      note: `${longNote} (entry ${i})`,
      captured_at: `2026-04-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }))
    const out = runtimeToProse(
      {
        today,
        guestContext: { observations },
      },
      'reply',
    )
    expect(out).toContain('## Guest context')
    // After fallback: last 5 observations only (entries 10..14).
    expect(out).toContain('(entry 14)')
    expect(out).toContain('(entry 10)')
    expect(out).not.toContain('(entry 0)')
    expect(out).not.toContain('(entry 9)')
  })

  it('drops oldest life_context entries when observations-floor truncation still exceeds the budget', () => {
    // Pre-truncated observations (5, already at floor) + many long life_context
    // entries. The serializer should drop oldest life_context entries from the
    // front until under budget.
    const longNote = 'mentioned she runs marathons and competes in trail-running events held in northern california during the spring season every year'
    const observations = Array.from({ length: 5 }, (_, i) => ({
      note: `${longNote} (obs ${i})`,
      captured_at: `2026-04-${String(i + 10).padStart(2, '0')}T00:00:00Z`,
    }))
    const life_context = Array.from({ length: 10 }, (_, i) => ({
      note: `${longNote} (life ${i})`,
      captured_at: `2026-03-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }))
    const out = runtimeToProse(
      {
        today,
        guestContext: { observations, life_context },
      },
      'reply',
    )
    expect(out).toContain('## Guest context')
    // Newest life_context entries survive; oldest were dropped.
    expect(out).toContain('(life 9)')
    expect(out).not.toContain('(life 0)')
  })
})

describe('runtimeToProse — ## Active commitments block (TAC-297)', () => {
  function commitment(overrides: Partial<ActiveCommitment> = {}): ActiveCommitment {
    return {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      type: 'comp',
      description: 'oat latte',
      code: '7K2P',
      status: 'open',
      expected_arrival: null,
      arrival_signal: null,
      created_at: '2026-04-29T11:00:00Z',
      ...overrides,
    }
  }

  it('omits the block entirely when activeCommitments is empty', () => {
    const out = runtimeToProse({ activeCommitments: [] }, 'reply', NOW)
    expect(out).not.toContain('## Active commitments')
  })

  it('omits the block when activeCommitments is undefined', () => {
    const out = runtimeToProse({}, 'reply', NOW)
    expect(out).not.toContain('## Active commitments')
  })

  it('renders comp with id, code, and status (TAC-302: id leads, code/status follow)', () => {
    const out = runtimeToProse(
      { activeCommitments: [commitment()] },
      'reply',
      NOW,
    )
    expect(out).toContain('## Active commitments')
    expect(out).toContain(
      '- [comp] oat latte (id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa, code: 7K2P, status: open) — promised',
    )
    // Regression for the leading-comma bug — the rendering must never produce
    // an empty leading element.
    expect(out).not.toMatch(/\(, /)
  })

  it('renders the id even when code is absent (recommendation, no verification chip)', () => {
    const out = runtimeToProse(
      {
        activeCommitments: [
          commitment({ type: 'recommendation', description: 'the duck', code: null }),
        ],
      },
      'reply',
      NOW,
    )
    expect(out).toContain(
      '- [recommendation] the duck (id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa, status: open) — promised',
    )
    // The reported MAJOR bug rendered this as `(, status: open)`.
    expect(out).not.toContain('(, status: open)')
  })

  it('intro explains the id is internal and never surfaced to the guest (TAC-302)', () => {
    const out = runtimeToProse(
      { activeCommitments: [commitment()] },
      'reply',
      NOW,
    )
    expect(out).toContain('copy that value verbatim into arrivalCapture.referencesCommitmentId')
    expect(out).toContain('never read it aloud, never include it in your reply to the guest')
  })

  it('surfaces status=pending_ack so the model knows arrival was already signaled', () => {
    const out = runtimeToProse(
      {
        activeCommitments: [
          commitment({ status: 'pending_ack', arrival_signal: 'imminent' }),
        ],
      },
      'reply',
      NOW,
    )
    expect(out).toContain('status: pending_ack')
  })

  it('renders between Guest context and Recent conversation when both present', () => {
    const out = runtimeToProse(
      {
        guestContext: { guest_details: { first_name: 'Jaipal' } },
        activeCommitments: [commitment()],
        recentMessages: [
          {
            direction: 'inbound' as const,
            body: 'hello',
            createdAt: new Date('2026-04-29T11:30:00Z'),
          },
        ],
      },
      'reply',
      NOW,
    )
    const guestIdx = out.indexOf('## Guest context')
    const activeIdx = out.indexOf('## Active commitments')
    const recentIdx = out.indexOf('## Recent conversation')
    expect(guestIdx).toBeGreaterThanOrEqual(0)
    expect(activeIdx).toBeGreaterThan(guestIdx)
    expect(recentIdx).toBeGreaterThan(activeIdx)
  })
})