import { describe, expect, it } from 'vitest'
// Relative import: vitest doesn't pick up Next's `@/*` path alias by default
// without a vitest.config.ts. Other tests in this repo use relative imports too.
import type { EligibleMechanic } from '../../recognition/eligibility'
import { type MenuItem, type VenueInfo, VenueInfoSchema } from '../../schemas'
import type { KnowledgeCorpusChunk, RecentMessage, RuntimeContext } from '../types'
import { knowledgeChunksToProse, runtimeToProse, venueInfoToProse } from './serializers'

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

// THE-228: per-category runtimeToProse rendering for the four new classifier
// categories. Each block asserts the fields that case is supposed to push.
describe('runtimeToProse — comp_complaint', () => {
  it('renders inboundMessage + lastVisitDate + daysSinceLastVisit', () => {
    const out = runtimeToProse(
      {
        inboundMessage: 'muffin was stale',
        lastVisitDate: '2026-04-30',
        daysSinceLastVisit: 2,
      },
      'comp_complaint',
      NOW,
    )
    expect(out).toContain('The guest just sent: "muffin was stale"')
    expect(out).toContain('Last visit: 2026-04-30')
    expect(out).toContain('Days since last visit: 2')
  })

  it('omits visit fields when not provided', () => {
    const out = runtimeToProse(
      { inboundMessage: 'waited too long' },
      'comp_complaint',
      NOW,
    )
    expect(out).toContain('The guest just sent: "waited too long"')
    expect(out).not.toContain('Last visit:')
    expect(out).not.toContain('Days since last visit:')
  })
})

describe('runtimeToProse — mechanic_request', () => {
  it('renders inboundMessage line only', () => {
    const out = runtimeToProse(
      { inboundMessage: 'can you hold the couch' },
      'mechanic_request',
      NOW,
    )
    expect(out).toContain('The guest just sent: "can you hold the couch"')
    // Mechanics list comes from the separate "## What this guest can access"
    // block — case must not duplicate it inline.
    expect(out).not.toContain('Last visit:')
    expect(out).not.toContain('Days since last visit:')
  })

  it('does not duplicate the eligibility block when mechanics are present', () => {
    const out = runtimeToProse(
      { inboundMessage: 'can i get the joey', mechanics: [] },
      'mechanic_request',
      NOW,
    )
    // The eligibility block IS rendered (by formatMechanicEligibility), but
    // the per-category case must not re-emit it. Asserting the block appears
    // exactly once.
    const matches = out.match(/## What this guest can access/g) ?? []
    expect(matches.length).toBe(1)
  })
})

describe('runtimeToProse — recommendation_request', () => {
  it('renders inboundMessage + daysSinceLastVisit when set', () => {
    const out = runtimeToProse(
      { inboundMessage: 'what\'s good here', daysSinceLastVisit: 14 },
      'recommendation_request',
      NOW,
    )
    expect(out).toContain('The guest just sent: "what\'s good here"')
    expect(out).toContain('Days since last visit: 14')
  })

  it('omits days-since field when not set', () => {
    const out = runtimeToProse(
      { inboundMessage: 'what should i try' },
      'recommendation_request',
      NOW,
    )
    expect(out).toContain('The guest just sent: "what should i try"')
    expect(out).not.toContain('Days since last visit:')
  })
})

describe('runtimeToProse — casual_chatter', () => {
  it('renders inboundMessage line only', () => {
    const out = runtimeToProse(
      {
        inboundMessage: 'love this couch',
        // These should NOT appear for casual_chatter even when set.
        lastVisitDate: '2026-04-30',
        daysSinceLastVisit: 2,
      },
      'casual_chatter',
      NOW,
    )
    expect(out).toContain('The guest just sent: "love this couch"')
    expect(out).not.toContain('Last visit:')
    expect(out).not.toContain('Days since last visit:')
  })
})

// THE-229: Last Visit block. Renders at block level (between mechanics and
// recent conversation), gated on category — welcome and opt_out skip it.
describe('runtimeToProse — ## Last visit block', () => {
  const visitedAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000) // 3 days ago

  it('renders the block with relative time and comma-joined items', () => {
    const out = runtimeToProse(
      {
        lastVisit: { items: ['cappuccino', 'blueberry muffin'], visitedAt },
        inboundMessage: 'hey',
      },
      'reply',
      NOW,
    )
    expect(out).toContain('## Last visit\n3 days ago: cappuccino, blueberry muffin')
  })

  it('renders "yesterday" for a 25-hour-old visit', () => {
    const yesterday = new Date(NOW.getTime() - 25 * 60 * 60 * 1000)
    const out = runtimeToProse(
      { lastVisit: { items: ['latte'], visitedAt: yesterday } },
      'reply',
      NOW,
    )
    expect(out).toContain('## Last visit\nyesterday: latte')
  })

  it('omits the block when lastVisit is undefined', () => {
    const out = runtimeToProse({ inboundMessage: 'hey' }, 'reply', NOW)
    expect(out).not.toContain('## Last visit')
  })

  it('omits the block for welcome', () => {
    const out = runtimeToProse(
      { lastVisit: { items: ['cappuccino'], visitedAt } },
      'welcome',
      NOW,
    )
    expect(out).not.toContain('## Last visit')
  })

  it('omits the block for opt_out', () => {
    const out = runtimeToProse(
      {
        lastVisit: { items: ['cappuccino'], visitedAt },
        inboundMessage: 'stop',
      },
      'opt_out',
      NOW,
    )
    expect(out).not.toContain('## Last visit')
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
    ] as const

    for (const cat of includedCategories) {
      const out = runtimeToProse(
        { lastVisit: { items: ['cappuccino'], visitedAt } },
        cat,
        NOW,
      )
      expect(out, `category ${cat} should render Last Visit block`).toContain(
        '## Last visit',
      )
    }
  })

  it('places the block after mechanics and before recent conversation', () => {
    const out = runtimeToProse(
      {
        today,
        mechanics: [],
        lastVisit: { items: ['cappuccino'], visitedAt },
        recentMessages: [recent({ body: 'hi', createdAt: new Date(NOW.getTime() - 60_000) })],
      },
      'reply',
      NOW,
    )
    const eligibilityIdx = out.indexOf('## What this guest can access')
    const lastVisitIdx = out.indexOf('## Last visit')
    const recentIdx = out.indexOf('## Recent conversation')
    expect(eligibilityIdx).toBeGreaterThanOrEqual(0)
    expect(lastVisitIdx).toBeGreaterThan(eligibilityIdx)
    expect(recentIdx).toBeGreaterThan(lastVisitIdx)
  })
})

// THE-232: Operator instruction block. Renders at the top of the prompt
// (above mechanics + last visit + recent conversation) when the operator's
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

  it('places the block above mechanics, last visit, and recent conversation', () => {
    const visitedAt = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000)
    const out = runtimeToProse(
      {
        today,
        operatorInstruction: 'follow up on their recent visit',
        mechanics: [],
        lastVisit: { items: ['cappuccino'], visitedAt },
        recentMessages: [recent({ body: 'hey', createdAt: new Date(NOW.getTime() - 60_000) })],
      },
      'manual',
      NOW,
    )
    const opIdx = out.indexOf('## Operator instruction')
    const eligibilityIdx = out.indexOf('## What this guest can access')
    const lastVisitIdx = out.indexOf('## Last visit')
    const recentIdx = out.indexOf('## Recent conversation')
    expect(opIdx).toBeGreaterThanOrEqual(0)
    expect(eligibilityIdx).toBeGreaterThan(opIdx)
    expect(lastVisitIdx).toBeGreaterThan(opIdx)
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

// THE-233: personal_history_question routes the inbound through the
// "just asked" framing (questions deserve question framing, not "just sent")
// and relies on the ## Last visit block above for the actual content.
describe('runtimeToProse — personal_history_question', () => {
  it('renders the inbound message under "just asked" framing', () => {
    const out = runtimeToProse(
      { inboundMessage: 'what did i get last time' },
      'personal_history_question',
      NOW,
    )
    expect(out).toContain('The guest just asked: "what did i get last time"')
    // Don't accidentally fall back to the "just sent" framing.
    expect(out).not.toContain('The guest just sent: "what did i get last time"')
  })

  it('renders the ## Last visit block when lastVisit is set (regression for shouldRenderLastVisit)', () => {
    const visitedAt = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000)
    const out = runtimeToProse(
      {
        inboundMessage: 'what did i get last time',
        lastVisit: { items: ['cappuccino', 'blueberry muffin'], visitedAt },
      },
      'personal_history_question',
      NOW,
    )
    expect(out).toContain('## Last visit')
    expect(out).toContain('2 days ago: cappuccino, blueberry muffin')
  })

  it('does not push dead lastVisitDate / daysSinceLastVisit lines', () => {
    // THE-229 finding: those lines are unpopulated dead code. New category
    // case must not propagate the bug.
    const out = runtimeToProse(
      {
        inboundMessage: 'what did i get last time',
        lastVisitDate: '2026-04-30',
        daysSinceLastVisit: 3,
      },
      'personal_history_question',
      NOW,
    )
    expect(out).not.toContain('Last visit: 2026-04-30')
    expect(out).not.toContain('Days since last visit:')
  })
})

describe('knowledgeChunksToProse', () => {
  const makeChunk = (overrides: Partial<KnowledgeCorpusChunk> = {}): KnowledgeCorpusChunk => ({
    id: 'k1',
    text: 'Our flagship blend is two Ethiopian coffees roasted by a friend.',
    sourceType: 'voicenote_transcript',
    tags: ['sourcing', 'ethiopia'],
    relevanceScore: 0.82,
    ...overrides,
  })

  it('returns empty string for empty chunks (composer skips block)', () => {
    expect(knowledgeChunksToProse([])).toBe('')
  })

  it('renders the section header and the canonical voice/content disclaimer', () => {
    const out = knowledgeChunksToProse([makeChunk()])
    expect(out).toContain('## Venue knowledge')
    expect(out).toContain('Facts about the venue you can ground replies in')
    expect(out).toContain("speak in the venue's voice")
  })

  it('renders tags as a bracketed comma-separated list above each quoted body', () => {
    const out = knowledgeChunksToProse([makeChunk()])
    expect(out).toContain('[sourcing, ethiopia]')
    expect(out).toContain('> Our flagship blend is two Ethiopian coffees roasted by a friend.')
  })

  it('separates multiple chunks with a blank line', () => {
    const out = knowledgeChunksToProse([
      makeChunk({ id: 'k1', tags: ['sourcing'], text: 'fact one' }),
      makeChunk({ id: 'k2', tags: ['staff_rayan'], text: 'fact two' }),
    ])
    expect(out).toMatch(/\[sourcing\]\n> fact one\n\n\[staff_rayan\]\n> fact two/)
  })

  it('falls back to sourceType in the bracket line when tags is empty', () => {
    // Defensive: knowledge entries should always have tags per the parser
    // boundary, but the runtime helper shouldn't break on an empty array.
    const out = knowledgeChunksToProse([makeChunk({ tags: [], sourceType: 'manual_entry' })])
    expect(out).toContain('[manual_entry]')
  })

  it('quotes multi-line chunks line by line', () => {
    const out = knowledgeChunksToProse([
      makeChunk({ text: 'first line\nsecond line', tags: ['ceremony'] }),
    ])
    expect(out).toContain('> first line\n> second line')
  })
})