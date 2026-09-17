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
  delivery: 'delivered',
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

  // TAC-301. The motivating incident is a confirmation sent five hours after
  // close ("omw can you have my usual ready?" → "Got it, see you soon"), and
  // no approval trigger keys on time, so this line is the only guard.
  describe('open/closed status line', () => {
    it('states OPEN and the closing time when the venue is open', () => {
      const out = runtimeToProse(
        { today: { ...today, openState: { state: 'open', closesAt: '3:00 PM' } } },
        'reply',
        NOW,
      )
      expect(out).toContain('- Status: OPEN right now, closes at 3:00 PM.')
    })

    it('states CLOSED, names the next opening, and forbids confirming anything now', () => {
      const out = runtimeToProse(
        {
          today: {
            ...today,
            openState: { state: 'closed', opensAt: { day: 'tomorrow', time: '7:00 AM' } },
          },
        },
        'reply',
        NOW,
      )
      expect(out).toContain('- Status: CLOSED right now.')
      expect(out).toContain('Next open tomorrow at 7:00 AM.')
      // The instruction half is load-bearing, not decoration: a bare fact is
      // something the venue persona can talk past, and the failure being fixed
      // is specifically a confirmation.
      expect(out).toContain('do not confirm anything for right now')
      // SCOPED to the present moment, deliberately. An unscoped "do not tell
      // the guest to come by" would contradict comp-complaint's own designed
      // remedy ("asking them to come back and have another one on us"), which
      // is an ordinary thing to say at 8pm about a drink from that morning.
      expect(out).toContain('come by now')
      expect(out).not.toContain('Do not tell the guest to come by,')
      // Both facts precede the instruction: the next opening shouldn't sit on
      // the far side of a prohibition.
      expect(out.indexOf('Next open')).toBeLessThan(out.indexOf('Do not tell'))
    })

    it('states CLOSED with no opening claim when the next opening is unknown', () => {
      const out = runtimeToProse(
        { today: { ...today, openState: { state: 'closed', opensAt: null } } },
        'reply',
        NOW,
      )
      expect(out).toContain('- Status: CLOSED right now.')
      expect(out).not.toContain('Next open')
    })

    // The safe direction. Unparseable hours must leave the block exactly as it
    // was pre-TAC-301 rather than guess — a wrong "closed" fires on every turn
    // at that venue, where the bug being fixed needs a specific phrasing.
    it('renders no status line at all when the open state is unknown', () => {
      const out = runtimeToProse(
        { today: { ...today, openState: { state: 'unknown' } } },
        'reply',
        NOW,
      )
      expect(out).toContain('## Right now')
      expect(out).not.toContain('- Status:')
    })

    it('renders no status line when openState is absent entirely', () => {
      const out = runtimeToProse({ today }, 'reply', NOW)
      expect(out).toContain('## Right now')
      expect(out).not.toContain('- Status:')
    })

    it('keeps the status line inside the Right now block, after the clock', () => {
      const out = runtimeToProse(
        {
          today: { ...today, openState: { state: 'open', closesAt: '3:00 PM' } },
          inboundMessage: 'omw can you have my usual ready?',
        },
        'reply',
        NOW,
      )
      expect(out.indexOf('- Time at venue:')).toBeLessThan(out.indexOf('- Status:'))
      expect(out.indexOf('- Status:')).toBeLessThan(out.indexOf('The guest just sent:'))
    })
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

describe('runtimeToProse — unsent history (TAC-394)', () => {
  const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000)
  const DRAFT =
    "Really sorry to hear that. Come back in and the next one's on us. Give me a heads up when you're heading over"
  const NOTE = 'Lines marked NOT SENT or NEVER SENT never reached the guest. They have not read them.'

  // The 2026-09-14 sequence, as the regenerating model saw it at 16:31.
  const incident = (draftDelivery: RecentMessage['delivery']): RecentMessage[] => [
    recent({ direction: 'inbound', body: 'the cortado i got this morning was cold and bad', createdAt: minutesAgo(5) }),
    recent({ direction: 'outbound', body: DRAFT, createdAt: minutesAgo(4), delivery: draftDelivery }),
  ]
  const render = (messages: RecentMessage[]) =>
    runtimeToProse(
      { inboundMessage: 'what time do you open on sundaus', recentMessages: messages },
      'new_question',
      NOW,
    )
  const historyBlock = (out: string) =>
    out.slice(out.indexOf('## Recent conversation'), out.indexOf('\n\nThe guest just sent:'))

  it('renders history with nothing unsent exactly as before', () => {
    const out = render(incident('delivered'))
    // Exact, not toContain: anything appended to the block must fail this.
    expect(historyBlock(out)).toBe(
      '## Recent conversation\n' +
        '[guest, 5 minutes ago] the cortado i got this morning was cold and bad\n' +
        `[venue, 4 minutes ago] ${DRAFT}`,
    )
    expect(out).not.toContain('NOT SENT')
    expect(out).not.toContain('NEVER SENT')
    expect(out).not.toContain('never reached the guest')
  })

  // Literal markers, never read back out of historyDeliveryMarker: a table
  // built from the function would pass whatever it returns. Exact equality on
  // the whole block pins the marker and the one note as ALL that is added. The
  // 2026-09-14 ruling removed an instruction that followed the note (the reply
  // takes the pending draft's place, so offer a pending comp again), and this
  // fails if anything is appended there again, however it is worded.
  it.each([
    ['awaiting_review', 'NOT SENT: waiting for the venue to approve it'],
    ['skipped_by_operator', 'NOT SENT: the venue decided not to send it'],
    ['never_sent', 'NEVER SENT: it failed to send'],
  ] as const)('marks a %s line "%s" and adds only the note', (delivery, marker) => {
    expect(historyBlock(render(incident(delivery)))).toBe(
      '## Recent conversation\n' +
        '[guest, 5 minutes ago] the cortado i got this morning was cold and bad\n' +
        `[venue, 4 minutes ago, ${marker}] ${DRAFT}\n\n` +
        NOTE,
    )
  })

  // v1.50.0 first exempted pending lines from the cap, because the removed
  // instruction asked the model to carry a pending offer forward. With nothing
  // asking that, an exemption has no reason to exist.
  it.each(['delivered', 'awaiting_review', 'skipped_by_operator', 'never_sent'] as const)(
    'truncates a %s line at 200 characters',
    (delivery) => {
      const long = 'a'.repeat(250)
      const out = render([recent({ direction: 'outbound', body: long, createdAt: minutesAgo(4), delivery })])
      expect(out).toContain(`${'a'.repeat(200)}…`)
      expect(out).not.toContain('a'.repeat(201))
    },
  )

  it('states the note once however many lines are unsent', () => {
    const out = render([
      recent({ direction: 'outbound', body: 'a failed send', createdAt: minutesAgo(120), delivery: 'never_sent' }),
      recent({ direction: 'outbound', body: 'an older skipped draft', createdAt: minutesAgo(90), delivery: 'skipped_by_operator' }),
      ...incident('awaiting_review'),
    ])
    expect(out.split('never reached the guest').length - 1).toBe(1)
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
    // v1.23.0: the empty-list instruction now names comps / remakes /
    // replacements explicitly. "Do not offer perks" alone did not bind on
    // 2026-08-07 — the model classified a remake as "not a perk, just good
    // hospitality" and offered it with this block rendered in its prompt.
    expect(out).toContain('Do not offer comps, remakes, replacements, or discounts either.')
  })

  // v1.24.0 THE CRUX. Comp-forward language is permissible ONLY on a turn
  // already certain to reach an operator. willBeReviewed is knowable at
  // prompt-assembly time because classification runs ~90 lines before
  // generation, and category routing depends on nothing the model says.
  describe('empty-mechanics block is conditioned on willBeReviewed (v1.24.0)', () => {
    it('invites a proposal when a human will approve the draft first', () => {
      const out = runtimeToProse({ mechanics: [], willBeReviewed: true }, 'reply', NOW)
      expect(out).toContain('approves it before the guest ever sees it')
      expect(out).toContain('come back for another on us')
      // The model must know it is proposing, not authorizing.
      expect(out).toContain('let the venue decide')
    })

    it('keeps the v1.23.0 denial VERBATIM when nothing will review it', () => {
      // The auto-send path must not be relaxed by one word. This is what
      // stops v1.24.0 from reopening the 2026-08-07 unauthorized-comp path.
      const out = runtimeToProse({ mechanics: [], willBeReviewed: false }, 'reply', NOW)
      expect(out).toContain('Do not offer perks of any kind.')
      expect(out).toContain('Do not offer comps, remakes, replacements, or discounts either.')
      expect(out).not.toContain('come back for another on us')
    })

    it('defaults to the denial when willBeReviewed is absent', () => {
      // Fail toward the restrictive branch: an unset flag must never be read
      // as permission to offer something.
      const out = runtimeToProse({ mechanics: [] }, 'reply', NOW)
      expect(out).toContain('Do not offer comps, remakes, replacements, or discounts either.')
    })
  })

  // Product principle, not style. CLAUDE.md forbids earn/loyalty vocabulary
  // outright: guests are recognized, not enrolled. This string sat in the
  // live prompt on every new-guest turn.
  it('uses recognition framing, never earn/loyalty vocabulary', () => {
    const out = runtimeToProse({ mechanics: [] }, 'reply', NOW)
    expect(out).not.toMatch(/\bearn(ed|s|ing)?\b/i)
    expect(out).toContain('to be recognized with')
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

describe('runtimeToProse — ## What you\'re hoping to get to block (TAC-324)', () => {
  it('omits the block entirely when openIntentions is undefined', () => {
    const out = runtimeToProse({ mechanics: [] }, 'reply', NOW)
    expect(out).not.toContain("What you're hoping to get to")
  })

  it('omits the block entirely when openIntentions is an empty array', () => {
    const out = runtimeToProse({ mechanics: [], openIntentions: [] }, 'reply', NOW)
    expect(out).not.toContain("What you're hoping to get to")
  })

  it('renders one line per open intention, verbatim', () => {
    const out = runtimeToProse(
      {
        mechanics: [],
        openIntentions: [
          "You haven't heard what this guest ordered yet.",
          "You haven't told them to save your number.",
        ],
      },
      'reply',
      NOW,
    )
    expect(out).toContain("## What you're hoping to get to")
    expect(out).toContain("You haven't heard what this guest ordered yet.")
    expect(out).toContain("You haven't told them to save your number.")
  })

  // The non-steering paragraph is load-bearing in the same way the
  // empty-mechanics framing is (per the ticket's own framing) — asserted
  // verbatim so a future edit that trims it for brevity fails loudly.
  it('carries the non-steering paragraph verbatim', () => {
    const out = runtimeToProse(
      { mechanics: [], openIntentions: ["You haven't heard what this guest ordered yet."] },
      'reply',
      NOW,
    )
    expect(out).toContain(
      "These are things you'd like to get to, not a checklist to work through.\nIf more than one would fit, take the one listed first, and only that one.",
    )
  })

  // TAC-380: several lines can render at once, in priority order, and this is
  // the one sentence that tells the model the order means something.
  it('tells the model to take the first-listed intention when more than one fits (TAC-380)', () => {
    const out = runtimeToProse(
      { mechanics: [], openIntentions: ['alpha intention line', 'beta intention line'] },
      'reply',
      NOW,
    )
    expect(out).toContain('If more than one would fit, take the one listed first, and only that one.')
    expect(out.indexOf('alpha intention line')).toBeLessThan(out.indexOf('beta intention line'))
  })

  // TAC-330: the "answering Sana's own question" exception, appended after
  // the TAC-324 paragraph above (which stays byte-identical — asserted by
  // the previous test still passing unmodified). Turn two of the first-touch
  // arc: Sana's opener asks about newness, the guest answers, and the
  // original symmetric wording gave the model no way to treat that reply
  // differently from the guest raising a brand-new topic of their own.
  describe('answering-Sana\'s-own-question exception (TAC-330)', () => {
    const openIntentions = ["You haven't heard what this guest ordered yet."]

    it('distinguishes a reply to Sana\'s own question from the guest\'s own topic', () => {
      const out = runtimeToProse({ mechanics: [], openIntentions }, 'reply', NOW)
      // TAC-436 condensed this to a bullet. The condition is unchanged: what
      // Sana asked about, not merely that she asked.
      expect(out).toContain(
        '- Your own last message asked them something about themselves and this\n  reply answers it.',
      )
      expect(out).toContain("You asked, so following it up isn't a pivot.")
    })

    // Plan-review caught that "your last message was a question" is too
    // broad — Sana ends messages with questions constantly. The condition is
    // tied to the CONTENT of the question (about the guest themselves), not
    // merely its presence, so an unrelated closer ("you heading in soon?")
    // doesn't qualify. This is prose, not code, so the test can only assert
    // the narrowing language is present — actual model behavior on the
    // parking-shaped case is a UAT gate (ticket §9), not a unit test.
    it('scopes the exception to what Sana asked, not merely that she asked something', () => {
      const out = runtimeToProse({ mechanics: [], openIntentions }, 'reply', NOW)
      expect(out).toContain('something about themselves')
      expect(out).not.toContain('your last message was a question and this is their reply')
    })

    it('asserts the exception is consumed on the very next reply regardless of content', () => {
      const out = runtimeToProse({ mechanics: [], openIntentions }, 'reply', NOW)
      expect(out).toContain('covers this one reply only, whatever they say back.')
      // And it never becomes something to return to.
      expect(out).toContain('never\nraise one twice.')
    })

    // TAC-436 carries this as the general rule rather than an aside on the
    // exception: whatever the guest raised is still the reply's job, and the
    // ask rides on the end of it or not at all.
    it('asserts an ask never changes what the reply is about', () => {
      const out = runtimeToProse({ mechanics: [], openIntentions }, 'reply', NOW)
      expect(out).toContain('Asking never changes what the reply is about. Whatever they raised is')
      expect(out).toContain('still the job, and the question goes at the end, in one short line, or\nnot at all.')
    })

    // Plan-review: "license" is spec vocabulary describing the mechanism,
    // not language that belongs in Sana's own prompt.
    it('does not use "license" — reads as guidance, not a specification', () => {
      const out = runtimeToProse({ mechanics: [], openIntentions }, 'reply', NOW)
      expect(out.toLowerCase()).not.toContain('license')
    })
  })

  it('renders after ## What this guest can access and before ## Follow-up context', () => {
    const out = runtimeToProse(
      {
        mechanics: [],
        openIntentions: ["You haven't told them to save your number."],
        followup: { reasons: ['cold_lapsed'], daysSinceLastVisit: 30 },
      },
      'follow_up',
      NOW,
    )
    const eligibilityIdx = out.indexOf('## What this guest can access')
    const intentionsIdx = out.indexOf("## What you're hoping to get to")
    const followupIdx = out.indexOf('## Follow-up context')
    expect(eligibilityIdx).toBeGreaterThanOrEqual(0)
    expect(intentionsIdx).toBeGreaterThan(eligibilityIdx)
    expect(followupIdx).toBeGreaterThan(intentionsIdx)
  })
})

// TAC-329: the first-touch opener paragraph. Fixes the one turn TAC-324's
// non-steering paragraph couldn't open on — a bare "Hi Sana!" produced the
// identical reply "Hey, what's up?" across four UAT runs, because "only
// raise one if the conversation opens a natural door" is correct restraint
// but a bare greeting doesn't open a door by any plain reading. The opener
// leads the block (not appended) so reading order is "this turn's job, then
// the longer-term things not to push."
describe("runtimeToProse — ## What you're hoping to get to first-touch opener (TAC-329)", () => {
  const openIntentions = ["You haven't heard what this guest ordered yet."]

  it('renders the opener before the intention lines when firstTouchAfterQrScan is true', () => {
    const out = runtimeToProse(
      { mechanics: [], openIntentions, firstTouchAfterQrScan: true },
      'reply',
      NOW,
    )
    const headerIdx = out.indexOf("## What you're hoping to get to")
    const openerIdx = out.indexOf('sent right after they scanned your sign')
    const intentionLineIdx = out.indexOf("You haven't heard what this guest ordered yet.")
    expect(headerIdx).toBeGreaterThanOrEqual(0)
    expect(openerIdx).toBeGreaterThan(headerIdx)
    expect(intentionLineIdx).toBeGreaterThan(openerIdx)
  })

  // Carries the never-texted-vs-never-visited distinction from the ticket's
  // own framing (created_via: 'qr_scan' means never-texted, not
  // never-visited) so the question reads as genuinely open rather than
  // hollow against a `Guest relationship: new` line that only reflects
  // absence of signals, not absence of history. Also asserts the opener does
  // NOT license physical-presence framing — that phrasing was in an earlier
  // draft and was deliberately cut because it re-introduced exactly what the
  // R1 rationale reword removes.
  it('carries the never-texted-vs-never-visited framing and asks one question', () => {
    const out = runtimeToProse(
      { mechanics: [], openIntentions, firstTouchAfterQrScan: true },
      'reply',
      NOW,
    )
    expect(out).toContain(
      "You know they've been in — you don't know whether they've been coming for years or walked in today, because scanning is the first time they've texted you, not the first time they've visited.",
    )
    expect(out).toContain('thank them for coming in')
    expect(out).toContain("ask whether it's their first time")
    expect(out).toContain('one question, then let their answer lead')
    expect(out).not.toContain('walking up for the first time')
    expect(out).not.toContain('someone present')
  })

  // The gate (firstTouchAfterQrScan) is content-blind — it fires on ANY
  // qr_scan guest's true first message, not just a bare greeting. A real
  // question deserves an answer, not a scripted first-time question stapled
  // on top, so the paragraph defers the question (not the greeting) whenever
  // the guest's own message already asks something.
  it('defers the first-time question to a real question in the guest\'s own message', () => {
    const out = runtimeToProse(
      { mechanics: [], openIntentions, firstTouchAfterQrScan: true },
      'reply',
      NOW,
    )
    expect(out).toContain("If their message doesn't ask you anything")
    expect(out).toContain('If they did ask something, answer that instead')
  })

  it('renders byte-identical to the pre-opener shape when firstTouchAfterQrScan is false', () => {
    const withFlagFalse = runtimeToProse(
      { mechanics: [], openIntentions, firstTouchAfterQrScan: false },
      'reply',
      NOW,
    )
    const withFlagUndefined = runtimeToProse({ mechanics: [], openIntentions }, 'reply', NOW)
    expect(withFlagFalse).toBe(withFlagUndefined)
    expect(withFlagFalse).not.toContain('scanned your sign')
  })

  it('omits the opener when firstTouchAfterQrScan is undefined', () => {
    const out = runtimeToProse({ mechanics: [], openIntentions }, 'reply', NOW)
    expect(out).not.toContain('scanned your sign')
  })

  // The specific edge case the AC names: a DB read failure for
  // guest_intention_prompts fails closed and can empty openIntentions even on
  // a true first-touch turn. The whole block — opener included — must stay
  // omitted, not render an opener with nothing under it.
  it('omits the block entirely when openIntentions is empty even though firstTouchAfterQrScan is true', () => {
    const out = runtimeToProse(
      { mechanics: [], openIntentions: [], firstTouchAfterQrScan: true },
      'reply',
      NOW,
    )
    expect(out).not.toContain("What you're hoping to get to")
    expect(out).not.toContain('scanned your sign')
  })

  it('still carries the non-steering paragraph verbatim after the opener', () => {
    const out = runtimeToProse(
      { mechanics: [], openIntentions, firstTouchAfterQrScan: true },
      'reply',
      NOW,
    )
    expect(out).toContain(
      "These are things you'd like to get to, not a checklist to work through.\nIf more than one would fit, take the one listed first, and only that one.",
    )
  })
})

// TAC-328: a qr_scan guest's very first message can itself be an opt-out.
// build-runtime-context.ts's gating on created_via/expiry/prompted-keys has
// no access to the classified category (classification runs after
// context_build), so the earliest the block can be suppressed for opt_out is
// here, at render time — mirroring shouldRenderVisitHistory's placement for
// the same category. Both the baseline two-line shape and the TAC-329
// opener (the more directive of the two payloads) must be fully suppressed,
// not just the header — a stray intention line surviving under a missing
// header would still be a compliance exposure.
// TAC-436 ruling 1. The block used to license the ask only in a situation that
// could not arise: its one worked permission required Sana to have already
// asked something about the guest, and nothing licensed that first ask. Since
// TAC-380 shipped, zero intentions had ever been raised.
describe("runtimeToProse — ## What you're hoping to get to openings (TAC-436)", () => {
  const openIntentions = ["You don't know this guest's name yet."]
  const render = (category: Parameters<typeof runtimeToProse>[1] = 'reply') =>
    runtimeToProse({ mechanics: [], openIntentions }, category, NOW)

  // THE CANARY. This exact sentence fired on nine of the sixteen traced turns
  // and is the deadlock. A future edit restoring it for brevity or symmetry
  // reverts the whole ticket, silently, with every other test here still green.
  it('no longer tells the model to let these wait whenever the guest asked something', () => {
    const out = render()
    expect(out).not.toContain('asks about something else, answer that and let these wait')
    expect(out).not.toContain('Only raise one if the conversation opens a natural door')
  })

  // Ruling 1c: named positively, not defined by negation.
  it('names each of the four openings', () => {
    const out = render()
    expect(out).toContain('A natural opening is ordinary and small. Any of these is one:')
    expect(out).toContain("- You've answered what they asked and the reply feels finished.")
    expect(out).toContain("- They've said something about themselves, however small,")
    expect(out).toContain("- There's nothing they need from you in the message.")
    expect(out).toContain('- Your own last message asked them something about themselves')
  })

  // Ruling 1b: answer, then ask one small thing. The worked example is the part
  // the model actually generalizes from, so it is pinned whole.
  it('shows answering and then asking in one reply', () => {
    expect(render()).toContain(
      '  short question on the end is fine: "we\'re open till 3 on Sundays.\n  you nearby?"',
    )
  })

  // The example must not model an emoji: this block renders immediately before
  // the per-message emoji call, and a 'none' directive would then contradict a
  // worked example three lines above it.
  it('carries no emoji in the worked example', () => {
    const out = render()
    const start = out.indexOf('A natural opening is ordinary')
    const end = out.indexOf('Not an opening:')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(out.slice(start, end)).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  // R3 bans em dashes in output and the regen loop pays for each one that
  // survives, so the block must not model them either. The replaced text had two.
  it('carries no em dash', () => {
    const out = render()
    const start = out.indexOf("These are things you'd like to get to")
    const end = out.indexOf('If nothing fits, let it wait.')
    expect(start).toBeGreaterThan(-1)
    expect(out.slice(start, end)).not.toContain('\u2014')
  })

  // NEW restraint, and the prose half of the comp_complaint gate below.
  it('rules out an apology or bad-news turn as an opening', () => {
    expect(render()).toContain(
      "Not an opening: a message carrying an apology, bad news, or something\nthey're unhappy about. Leave those alone entirely.",
    )
  })

  // Every restraint that survived. A rewrite that drops one of these is not the
  // ruling; it is a wider licence than was approved.
  it('keeps the surviving restraints', () => {
    const out = render()
    expect(out).toContain('not a checklist to work through')
    expect(out).toContain('take the one listed first, and only that one')
    expect(out).toContain('Never steer the conversation toward one of these')
    expect(out).toContain('never\nraise one twice')
    expect(out).toContain('If nothing fits, let it wait. There will be other conversations.')
  })
})

// TAC-436: the STRUCTURAL half of ruling 1's apology carve-out. The block
// renders LAST in the user prompt and COMP_COMPLAINT_INSTRUCTIONS lives in the
// SYSTEM prompt, so on proximity the block wins — the same failure class
// TAC-314/329/330/338 each paid for. The prose line is a second line of
// defence; this is the one that cannot be talked past.
describe("runtimeToProse — ## What you're hoping to get to comp_complaint suppression (TAC-436)", () => {
  const openIntentions = [
    "You don't know this guest's name yet.",
    "You don't know whether this guest lives or works nearby.",
  ]

  it('omits the block entirely for comp_complaint', () => {
    const out = runtimeToProse({ mechanics: [], openIntentions }, 'comp_complaint', NOW)
    expect(out).not.toContain("What you're hoping to get to")
    expect(out).not.toContain("You don't know this guest's name yet.")
    expect(out).not.toContain("You don't know whether this guest lives or works nearby.")
  })

  // The sharper case, mirroring the opt_out pair: a fresh scan whose first
  // message is the complaint would otherwise carry the more directive opener.
  it('omits it for comp_complaint even when firstTouchAfterQrScan is true', () => {
    const out = runtimeToProse(
      { mechanics: [], openIntentions, firstTouchAfterQrScan: true },
      'comp_complaint',
      NOW,
    )
    expect(out).not.toContain("What you're hoping to get to")
    expect(out).not.toContain('scanned your sign')
  })

  it('still renders the block for an ordinary reply with the same inputs', () => {
    const out = runtimeToProse({ mechanics: [], openIntentions }, 'reply', NOW)
    expect(out).toContain("## What you're hoping to get to")
  })
})

describe("runtimeToProse — ## What you're hoping to get to opt_out suppression (TAC-328)", () => {
  const openIntentions = [
    "You haven't heard what this guest ordered yet.",
    "You haven't told them to save your number.",
  ]

  it('omits the block entirely for opt_out', () => {
    const out = runtimeToProse({ mechanics: [], openIntentions }, 'opt_out', NOW)
    expect(out).not.toContain("What you're hoping to get to")
    expect(out).not.toContain("You haven't heard what this guest ordered yet.")
    expect(out).not.toContain("You haven't told them to save your number.")
  })

  // The sharper case: a fresh qr_scan guest's literal first message is the
  // opt-out itself, so firstTouchAfterQrScan is also true and the block
  // would otherwise carry the more directive opener ("thank them for coming
  // in and ask whether it's their first time") rather than just the two
  // soft state lines.
  it('omits the block entirely for opt_out even when firstTouchAfterQrScan is true', () => {
    const out = runtimeToProse(
      { mechanics: [], openIntentions, firstTouchAfterQrScan: true },
      'opt_out',
      NOW,
    )
    expect(out).not.toContain("What you're hoping to get to")
    expect(out).not.toContain('scanned your sign')
    expect(out).not.toContain("ask whether it's their first time")
  })

  it('still renders the block for a non-opt_out category with the same inputs', () => {
    const out = runtimeToProse(
      { mechanics: [], openIntentions, firstTouchAfterQrScan: true },
      'reply',
      NOW,
    )
    expect(out).toContain("## What you're hoping to get to")
    expect(out).toContain('scanned your sign')
  })
})

describe('runtimeToProse — R1 carve-out signal line (TAC-324)', () => {
  it('renders the first-touch-after-qr-scan line immediately after the inbound framing line', () => {
    const out = runtimeToProse(
      { inboundMessage: 'hi', firstTouchAfterQrScan: true },
      'welcome',
      NOW,
    )
    expect(out).toContain(
      "This is the guest's first message, sent after they scanned your venue's QR sign.",
    )
    const inboundIdx = out.indexOf('The guest just sent:')
    const signalIdx = out.indexOf("This is the guest's first message")
    expect(signalIdx).toBeGreaterThan(inboundIdx)
  })

  it('omits the line when firstTouchAfterQrScan is false', () => {
    const out = runtimeToProse({ inboundMessage: 'hi', firstTouchAfterQrScan: false }, 'welcome', NOW)
    expect(out).not.toContain("This is the guest's first message")
  })

  it('omits the line when firstTouchAfterQrScan is undefined', () => {
    const out = runtimeToProse({ inboundMessage: 'hi' }, 'welcome', NOW)
    expect(out).not.toContain("This is the guest's first message")
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

  // TAC-358 canary. `## Venue knowledge` renders AFTER SYSTEM_TEMPLATE
  // (compose-prompt.ts), the most-proximate-wins slot CLAUDE.md names as the
  // recurring failure class (TAC-314 / 329 / 330 / 338). An unconditional
  // "say you don't know" here would outrank `# Knowledge gaps`, which requires
  // a best-attempt ANSWER plus knowledgeGap=true when the venue knows the fact
  // and the model wasn't handed it — suppressing the card, the pending_until
  // clock and the holding message, silently. The populated branch must route
  // to that block rather than issue its own verdict.
  it('never tells the model to say it does not know — that call belongs to # Knowledge gaps', () => {
    const populated = knowledgeChunksToProse([makeChunk()])
    expect(populated).not.toMatch(/say (that )?you (do not|don't) know/i)
    expect(populated).toContain('# Knowledge gaps')
    // The empty branch may admit ignorance — it has no chunks to route around,
    // and its wording is TAC-242's and predates this rule.
    const empty = knowledgeChunksToProse([])
    expect(empty).toContain('No specific venue knowledge matched')
  })

  it('keeps the other grounding sources alive when no chunk answers the guest', () => {
    // Without this the populated branch reads as "these chunks or nothing",
    // and venue_info / menu / runtime blocks answer plenty on their own.
    const out = knowledgeChunksToProse([makeChunk()])
    expect(out).toMatch(/structured facts|the menu|runtime context/)
  })

  it('renders the section header and the canonical voice/content disclaimer', () => {
    const out = knowledgeChunksToProse([makeChunk()])
    expect(out).toContain('## Venue knowledge')
    // TAC-358: the header no longer calls these facts. Assert the reframing
    // that matters — presence is not evidence of relevance — rather than the
    // whole sentence, so ordinary rewording doesn't fail this.
    expect(out).toContain('Resemblance is not relevance')
    expect(out).not.toContain('Facts about the venue you can ground replies in')
    // It must ROUTE the no-match case, not rule on it.
    expect(out).toContain('# Knowledge gaps')
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

// TAC-338: the named_person branch previously read "texting on the venue's
// behalf as that named person" — third-party framing that let the model
// refer to venue staff as an outsider would (observed: "tell them Sana said
// to try the cortado"). Only named_person had zero coverage before this;
// venue/owner are untouched by the fix and stay unbackfilled per scope.
describe('personaToProse — speaker framing (TAC-338)', () => {
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

  it('named_person: states staff identity as first person, not "on the venue\'s behalf"', () => {
    const persona = makePersona({ speakerFraming: 'named_person', speakerName: 'Sana' })
    const out = personaToProse(persona)
    expect(out).toContain('You are Sana, staff at the venue, texting as yourself.')
    expect(out).toContain('You ARE that person')
    expect(out).not.toMatch(/on the venue's behalf/)
  })

  // TAC-348: real iMessage/SMS threads don't carry signatures. named_person
  // previously told the model to sign every message, which at least one
  // venue needed a manual anti-pattern rule to undo.
  it('named_person: does not instruct signing messages', () => {
    const persona = makePersona({ speakerFraming: 'named_person', speakerName: 'Sana' })
    const out = personaToProse(persona)
    expect(out).not.toContain('Sign messages')
    expect(out).toContain('Do not sign messages with your name.')
  })

  it('named_person: falls back to "[name missing]" when speakerName is absent', () => {
    // speakerName is schema-required whenever speakerFraming is
    // 'named_person' (BrandPersonaSchema's .refine), so this exercises the
    // serializer's own defensive fallback directly rather than going through
    // a persona shape the schema would reject.
    const persona = makePersona({ speakerFraming: 'named_person', speakerName: 'Sana' })
    const out = personaToProse({ ...persona, speakerName: undefined })
    expect(out).toContain('You are [name missing], staff at the venue')
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
          { direction: 'inbound', body: 'hi', createdAt: new Date('2026-05-07T10:00:00Z'), delivery: 'delivered' },
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
            createdAt: new Date('2026-04-29T11:30:00Z'), delivery: 'delivered',
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

// TAC-244: ## Follow-up context block. Renders immediately BEFORE
// ## Visit history on outbound runs whose followupTrigger maps to a
// renderable FollowupReason (post_visit_day_* or cold_lapsed).
describe('runtimeToProse — ## Follow-up context block (TAC-244)', () => {
  const visitedAt7 = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000)
  const visitedAt60 = new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000)

  it('renders the block when followup is present with a single reason', () => {
    const out = runtimeToProse(
      {
        followup: {
          reasons: ['post_visit_day_7'],
          daysSinceLastVisit: 7,
          anchorVisit: { visitedAt: visitedAt7, items: ['espresso', 'croissant'] },
        },
      },
      'follow_up',
      NOW,
    )
    expect(out).toContain('## Follow-up context')
    expect(out).toContain('Reasons: post-visit day 7')
    expect(out).toContain('Days since last visit: 7')
    expect(out).toContain('Last visit anchor: 7 days ago — espresso, croissant')
    // Single-reason: no weaving rider.
    expect(out).not.toContain('Multiple reasons apply')
  })

  it('omits the block when followup is undefined (inbound-path invariant)', () => {
    const out = runtimeToProse({ inboundMessage: 'hey' }, 'reply', NOW)
    expect(out).not.toContain('## Follow-up context')
  })

  it('renders the operator-picked Draft A weaving rider when multiple reasons apply', () => {
    const out = runtimeToProse(
      {
        followup: {
          reasons: ['post_visit_day_7', 'cold_lapsed'],
          daysSinceLastVisit: 7,
          anchorVisit: { visitedAt: visitedAt7, items: ['latte'] },
        },
      },
      'follow_up',
      NOW,
    )
    expect(out).toContain('Reasons: post-visit day 7, cold lapsed (re-engagement)')
    expect(out).toContain(
      "Multiple reasons apply. Write the single text a thoughtful owner would actually send — touch what's genuinely worth mentioning, lead with one and fold in the other, drop one if it doesn't fit.",
    )
  })

  it('omits the items suffix on the anchor line for cold_lapsed (date-only minimal anchor)', () => {
    const out = runtimeToProse(
      {
        followup: {
          reasons: ['cold_lapsed'],
          daysSinceLastVisit: 60,
          anchorVisit: { visitedAt: visitedAt60 }, // no items
        },
      },
      'follow_up',
      NOW,
    )
    expect(out).toContain('Last visit anchor: 60 days ago')
    expect(out).not.toMatch(/Last visit anchor: 60 days ago —/)
  })

  it('omits the days-since + anchor lines when anchorVisit is undefined (defensive fallback)', () => {
    const out = runtimeToProse(
      {
        followup: {
          reasons: ['cold_lapsed'],
          daysSinceLastVisit: 0,
        },
      },
      'follow_up',
      NOW,
    )
    expect(out).toContain('## Follow-up context')
    expect(out).toContain('Reasons: cold lapsed (re-engagement)')
    // Without an anchor, neither the days-since line nor the last-visit-anchor
    // line renders — the reason itself still carries useful framing.
    expect(out).not.toContain('Days since last visit:')
    expect(out).not.toContain('Last visit anchor:')
  })

  it('coexists with ## Visit history (intent-then-evidence: follow-up before visit history)', () => {
    const out = runtimeToProse(
      {
        followup: {
          reasons: ['post_visit_day_7'],
          daysSinceLastVisit: 7,
          anchorVisit: { visitedAt: visitedAt7, items: ['espresso'] },
        },
        recentVisits: [{ items: ['espresso'], visitedAt: visitedAt7 }],
      },
      'follow_up',
      NOW,
    )
    const followupIdx = out.indexOf('## Follow-up context')
    const visitHistoryIdx = out.indexOf('## Visit history')
    expect(followupIdx).toBeGreaterThanOrEqual(0)
    expect(visitHistoryIdx).toBeGreaterThan(followupIdx)
  })

  it('coexists with ## Perk being unlocked (both render; intentional outbound multi-block)', () => {
    const out = runtimeToProse(
      {
        followup: {
          reasons: ['cold_lapsed'],
          daysSinceLastVisit: 60,
          anchorVisit: { visitedAt: visitedAt60 },
        },
        perkBeingUnlocked: {
          name: 'Free cortado',
          qualification: 'first-time visitor returning',
          rewardDescription: 'a cortado on us next time you stop in',
        },
      },
      'follow_up',
      NOW,
    )
    expect(out).toContain('## Follow-up context')
    expect(out).toContain('Perk: Free cortado')
  })

  it('coexists with ## Event being invited (both render)', () => {
    const out = runtimeToProse(
      {
        followup: {
          reasons: ['post_visit_day_3'],
          daysSinceLastVisit: 3,
          anchorVisit: {
            visitedAt: new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000),
            items: ['cappuccino'],
          },
        },
        eventBeingInvited: {
          name: 'Open mic',
          description: 'Local poets read short pieces on the back patio.',
          date: 'Saturday 8pm',
        },
      },
      'follow_up',
      NOW,
    )
    expect(out).toContain('## Follow-up context')
    expect(out).toContain('Event: Open mic')
  })

  it('renders for follow_up category (the natural caller — handle-followup populates the trigger)', () => {
    const out = runtimeToProse(
      {
        followup: {
          reasons: ['post_visit_day_7'],
          daysSinceLastVisit: 7,
          anchorVisit: { visitedAt: visitedAt7, items: ['latte'] },
        },
      },
      'follow_up',
      NOW,
    )
    expect(out).toContain('## Follow-up context')
  })

  it('emits a stable prose snapshot for a representative post_visit_day_7 context', () => {
    const out = runtimeToProse(
      {
        followup: {
          reasons: ['post_visit_day_7'],
          daysSinceLastVisit: 7,
          anchorVisit: { visitedAt: visitedAt7, items: ['espresso', 'croissant'] },
        },
      },
      'follow_up',
      NOW,
    )
    expect(out).toContain(
      [
        '## Follow-up context',
        'This message is an unprompted check-in from the venue — the venue is reaching out, not replying to a message the guest just sent. Use this to inform tone and what to reference.',
        'Reasons: post-visit day 7',
        'Days since last visit: 7',
        'Last visit anchor: 7 days ago — espresso, croissant',
      ].join('\n'),
    )
  })
})
// ---------------------------------------------------------------------------
// TAC-308: ## Unanswered question
// ---------------------------------------------------------------------------

describe('runtimeToProse — ## Unanswered question (TAC-308)', () => {
  const NOW_308 = new Date('2026-08-07T12:30:00Z')
  const ASKED = new Date('2026-08-07T12:00:00Z')

  it('omits the block entirely when nothing is outstanding', () => {
    const out = runtimeToProse({ inboundMessage: 'hi' }, 'reply', NOW_308)
    expect(out).not.toContain('## Unanswered question')
  })

  it('renders the question verbatim so the model does not re-derive it', () => {
    const out = runtimeToProse(
      {
        inboundMessage: 'you there?',
        pendingQuestion: {
          question: 'what grade is the matcha?',
          askedAt: ASKED,
          mode: 'outstanding',
        },
      },
      'reply',
      NOW_308,
    )
    expect(out).toContain('## Unanswered question')
    expect(out).toContain('"what grade is the matcha?"')
  })

  // The three modes must not contradict each other. An earlier two-boolean
  // shape had the block forbidding "I'm checking on it" on the very turn
  // whose job was to say exactly that.
  it('outstanding: forbids promising, dating, or claiming to be checking', () => {
    const out = runtimeToProse(
      {
        pendingQuestion: { question: 'q', askedAt: ASKED, mode: 'outstanding' },
      },
      'reply',
      NOW_308,
    )
    expect(out).toContain('has not been told anything about it yet')
    expect(out).toContain("don't say you're checking on it")
  })

  it('acknowledged: stops the agent repeating that we are looking into it', () => {
    const out = runtimeToProse(
      {
        pendingQuestion: { question: 'q', askedAt: ASKED, mode: 'acknowledged' },
      },
      'reply',
      NOW_308,
    )
    expect(out).toContain('already been told the venue is looking into it')
    expect(out).toContain("don't add a time")
  })

  it('writing_holding: asks for the holding note and bans a deadline or an answer', () => {
    const out = runtimeToProse(
      {
        pendingQuestion: { question: 'q', askedAt: ASKED, mode: 'writing_holding' },
      },
      'manual',
      NOW_308,
    )
    expect(out).toContain('This message is the holding note')
    expect(out).toContain('Do not attempt the answer')
    expect(out).toContain('do not name a time or a day')
  })

  // Placement is load-bearing: the block sits next to the history the model
  // would otherwise mine for an earlier "let me find out" to imitate.
  it('sits immediately before ## Recent conversation', () => {
    const out = runtimeToProse(
      {
        pendingQuestion: { question: 'q', askedAt: ASKED, mode: 'outstanding' },
        recentMessages: [
          { direction: 'inbound', body: 'hello', createdAt: ASKED } as RecentMessage,
        ],
      },
      'reply',
      NOW_308,
    )
    expect(out.indexOf('## Unanswered question')).toBeLessThan(
      out.indexOf('## Recent conversation'),
    )
  })

  it('renders no em or en dashes (R3 self-consistency)', () => {
    for (const mode of ['outstanding', 'acknowledged', 'writing_holding'] as const) {
      const out = runtimeToProse(
        { pendingQuestion: { question: 'q', askedAt: ASKED, mode } },
        'reply',
        NOW_308,
      )
      const block = out.slice(out.indexOf('## Unanswered question'))
      expect(block).not.toMatch(/[—–]/)
    }
  })
})

// TAC-313 UAT fix #3. Persona list entries are operator-authored free text and
// routinely carry paragraphs, sometimes their own nested list. Splicing them in
// raw silently corrupted both: a carve-out in paragraph 2 trailed as loose
// document-level prose under the rule in paragraph 1, and an entry's inner
// bullets were emitted as siblings of the anti-patterns themselves.
describe('personaToProse — multi-line persona entries keep their structure (TAC-313)', () => {
  // Local fixture: the one in the anti-patterns describe above is block-scoped.
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

  const multiParagraph = [
    'For questions outside the venue domain, acknowledge briefly ("not my world").',
    '',
    'Nearby places are a separate case. Name them with confidence.',
    '',
    'When nothing is documented, the hedge is correct.',
  ].join('\n')

  it('indents continuation paragraphs under their own bullet', () => {
    const out = personaToProse(
      makePersona({
        voiceAntiPatterns: [{ text: multiParagraph, source: 'manual' }],
      }),
    )
    expect(out).toContain('- For questions outside the venue domain')
    expect(out).toContain('  Nearby places are a separate case. Name them with confidence.')
    expect(out).toContain('  When nothing is documented, the hedge is correct.')
  })

  it('never leaves a continuation paragraph flush-left', () => {
    // The actual defect: flush-left text reads as document-level prose rather
    // than as part of the rule above it, so the carve-out lost to its own ¶1.
    const out = personaToProse(
      makePersona({
        voiceAntiPatterns: [{ text: multiParagraph, source: 'manual' }],
      }),
    )
    expect(out).not.toContain('\nNearby places are a separate case')
  })

  it('keeps blank lines genuinely blank so paragraph breaks survive', () => {
    const out = personaToProse(
      makePersona({
        voiceAntiPatterns: [{ text: multiParagraph, source: 'manual' }],
      }),
    )
    expect(out).not.toMatch(/[ \t]+\n/)
  })

  it('nests an entry’s own bullet list instead of re-parenting it', () => {
    // Before the fix these four rendered at the same level as the anti-patterns
    // themselves, so "One pick, nothing after it" read as a top-level rule
    // sitting beside "Don't use em dashes."
    const withList = [
      'Menu recommendations cap at two items. Rotate between these shapes:',
      '',
      '- One pick, nothing after it.',
      '- Two picks stated flat, no framing.',
    ].join('\n')
    const out = personaToProse(
      makePersona({
        voiceAntiPatterns: [
          { text: withList, source: 'manual' },
          { text: 'Do not use em dashes.', source: 'manual' },
        ],
      }),
    )
    expect(out).toContain('  - One pick, nothing after it.')
    expect(out).toContain('  - Two picks stated flat, no framing.')
    expect(out).not.toContain('\n- One pick, nothing after it.')
    // The genuinely top-level sibling is still top-level.
    expect(out).toContain('\n- Do not use em dashes.')
  })

  it('renders single-line entries byte-identically to before the fix', () => {
    // Regression guard on applying the helper to all four persona list fields:
    // for the overwhelming majority of entries nothing may change at all.
    const out = personaToProse(
      makePersona({
        signaturePhrases: ['see you soon'],
        bannedTopics: ['politics'],
        voiceAntiPatterns: [{ text: 'no marketing flourishes', source: 'manual' }],
        voiceTouchstones: ['dry, warm, unhurried'],
      }),
    )
    expect(out).toContain('- see you soon')
    expect(out).toContain('- politics')
    expect(out).toContain('- no marketing flourishes')
    expect(out).toContain('- dry, warm, unhurried')
    expect(out).not.toMatch(/\n {2}\S/)
  })
})

// TAC-301 part 2/3. The venue-capability block. Before this, Le Mil's
// "walk-in only, ordering at the counter only" reached the prompt as one
// indented sub-bullet under Amenities and the agent confirmed a pickup anyway.
describe("venueInfoToProse — what this venue does and doesn't offer", () => {
  const base = makeVenueInfo()

  it('renders explicit negatives for services marked false', () => {
    const out = venueInfoToProse({
      ...base,
      services: {
        aheadOrdering: false,
        holds: false,
        reservations: false,
        delivery: false,
        alsoOffers: [],
        alsoDoesNotOffer: [],
      },
    })
    expect(out).toContain("## What this venue does and doesn't offer")
    expect(out).toContain('- Ordering ahead: NOT available')
    expect(out).toContain('- Holding or setting items aside: NOT available')
    expect(out).toContain('- Reservations: NOT available')
    expect(out).toContain('- Delivery: NOT available')
  })

  it('renders positives for services marked true, so a venue that DOES hold is not denied', () => {
    const out = venueInfoToProse({
      ...base,
      services: { holds: true, alsoOffers: [], alsoDoesNotOffer: [] },
    })
    expect(out).toContain('- Holding or setting items aside: available')
    expect(out).not.toContain('Holding or setting items aside: NOT available')
  })

  // THE LOAD-BEARING CASE. Absence means nobody said. Rendering it as a
  // negative would have the agent deny real services at every venue nobody has
  // configured — more frequent, and worse, than the bug being fixed.
  it('renders NOTHING for a service nobody has stated either way', () => {
    const out = venueInfoToProse({
      ...base,
      services: { holds: false, alsoOffers: [], alsoDoesNotOffer: [] },
    })
    expect(out).toContain('- Holding or setting items aside: NOT available')
    for (const absent of ['Ordering ahead', 'Reservations', 'Delivery', 'Catering']) {
      expect(out).not.toContain(absent)
    }
  })

  it('omits the whole section when services is absent', () => {
    expect(venueInfoToProse(base)).not.toContain("## What this venue does and doesn't offer")
  })

  it('omits the whole section when every field is unstated', () => {
    const out = venueInfoToProse({
      ...base,
      services: { alsoOffers: [], alsoDoesNotOffer: [] },
    })
    expect(out).not.toContain("## What this venue does and doesn't offer")
  })

  it('carries free-form entries the closed list does not model', () => {
    const out = venueInfoToProse({
      ...base,
      services: {
        alsoOffers: ['Wholesale beans by the bag'],
        alsoDoesNotOffer: ['Private events'],
      },
    })
    expect(out).toContain('- Wholesale beans by the bag: available')
    expect(out).toContain('- Private events: NOT available')
  })

  // Deliberately weaker than formatMechanicEligibility's completeness claim —
  // that list is generated from a full table, this one is hand-curated.
  it('states a don\'t-invent default without claiming the list is exhaustive', () => {
    const out = venueInfoToProse({
      ...base,
      services: { holds: false, alsoOffers: [], alsoDoesNotOffer: [] },
    })
    // Absence must read as ABSENCE. An earlier wording ("not listed is
    // unknown, not available") re-read every unstated service as a denial the
    // moment a venue filled in one field, which is the failure the three-state
    // design exists to prevent, just narrowed to partially-configured venues.
    expect(out).toContain('has not been stated either way')
    expect(out).toContain('do not tell the guest it is unavailable')
    expect(out).not.toContain('complete set')
  })

  it('renders as its own section, not a sub-bullet of Amenities', () => {
    const out = venueInfoToProse({
      ...base,
      amenities: { wifi: true },
      services: { holds: false, alsoOffers: [], alsoDoesNotOffer: [] },
    })
    expect(out).toContain("\n## What this venue does and doesn't offer")
    expect(out.indexOf('- Amenities:')).toBeLessThan(
      out.indexOf("## What this venue does and doesn't offer"),
    )
  })
})

// ---------------------------------------------------------------------------
// Emoji cadence (TAC-362)
// ---------------------------------------------------------------------------

describe('emoji cadence — persona standing statement (TAC-362)', () => {
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

  // The two untouched entries, pinned VERBATIM. Both measured 0 emoji across
  // 240 live responses, so their exact strings are proven behaviour — these
  // assertions exist to make a well-meaning reword of a working path fail
  // loudly rather than silently change two venues.
  it('never keeps its exact prohibition, unchanged', () => {
    expect(personaToProse(makePersona({ emojiPolicy: 'never' }))).toContain(
      '## Emojis\nnever — Do not use emoji.',
    )
  })

  it('sparingly keeps its exact wording, unchanged', () => {
    expect(personaToProse(makePersona({ emojiPolicy: 'sparingly' }))).toContain(
      '## Emojis\nsparingly — You may use one emoji occasionally — only when it genuinely fits the tone. Default to none.',
    )
  })

  // The actual fix. "Use them where they feel natural" was a STANDING
  // licence: identical on every turn, and a model with no memory of last
  // turn takes it every time — 10 of 11 responses at Le Mil's.
  it('frequent no longer carries a standing licence to use emoji', () => {
    const out = personaToProse(makePersona({ emojiPolicy: 'frequent' }))
    expect(out).not.toContain('Use them where they feel natural')
    expect(out).not.toContain('do not stuff them')
  })

  it('frequent defers the per-message call and refuses to imply a rate', () => {
    const out = personaToProse(makePersona({ emojiPolicy: 'frequent' }))
    expect(out).toContain('decided per message')
    expect(out).toContain('Do not read a general rate into this line.')
  })

  // The persona line forward-references the per-message block, and that block
  // is suppressed on opt_out/comp_complaint and absent whenever the runtime
  // field isn't set. So the sentence has to carry its own default rather than
  // pointing at an instruction that may not be there.
  it('frequent states a default for when no per-message block renders', () => {
    expect(personaToProse(makePersona({ emojiPolicy: 'frequent' }))).toContain(
      'if no such instruction appears, do not use one',
    )
  })
})

describe('emoji cadence — per-message block (TAC-362)', () => {
  it("renders a flat prohibition for 'none'", () => {
    const out = runtimeToProse({ emojiDirective: 'none' }, 'reply', NOW)
    expect(out).toContain('## Emoji for this message')
    expect(out).toContain('No emoji in this message.')
  })

  // 'allowed' must read as permission, never a mandate. "Use an emoji here"
  // would restore the determinism this ticket exists to remove, just at a
  // lower rate — and the model declining sometimes is what keeps the
  // permitted branch from becoming its own pattern.
  it("renders permission, not a mandate, for 'allowed'", () => {
    const out = runtimeToProse({ emojiDirective: 'allowed' }, 'reply', NOW)
    expect(out).toContain('## Emoji for this message')
    expect(out).toContain('An emoji is welcome in this message if one genuinely fits.')
    expect(out).toContain('At most one')
  })

  it('renders no block at all when the directive is absent', () => {
    expect(runtimeToProse({ inboundMessage: 'hi' }, 'reply', NOW)).not.toContain(
      '## Emoji for this message',
    )
  })

  // Position is the point: most-proximate-wins is the failure class behind
  // TAC-301/314/329/330/338, so the per-message call has to be the LAST
  // thing read before the generate instruction — after the inbound, after
  // recent conversation, after everything.
  it('renders as the last block, after recent conversation and ahead of the generate line', () => {
    const out = runtimeToProse(
      {
        emojiDirective: 'none',
        inboundMessage: 'what time do you close?',
        guestName: 'Sam',
        recentMessages: [
          { direction: 'inbound', body: 'hey', createdAt: new Date(NOW.getTime() - 60_000), delivery: 'delivered' },
        ],
      },
      'reply',
      NOW,
    )
    expect(out.indexOf('## Emoji for this message')).toBeGreaterThan(
      out.indexOf('## Recent conversation'),
    )
    expect(out.indexOf('## Emoji for this message')).toBeLessThan(
      out.indexOf('Generate the message now.'),
    )
  })

  // MAJOR from code review: this block lands LAST in the user prompt while a
  // category instruction lives in the SYSTEM prompt, so on proximity the
  // block wins. An opt-out confirmation is a compliance surface and must
  // never carry "an emoji is welcome here" — at a `frequent` venue that would
  // have fired on ~75% of opt-outs.
  it('never renders on an opt_out turn, on either branch', () => {
    for (const directive of ['none', 'allowed'] as const) {
      expect(runtimeToProse({ emojiDirective: directive }, 'opt_out', NOW)).not.toContain(
        '## Emoji for this message',
      )
    }
  })

  it('never renders on a comp_complaint turn, on either branch', () => {
    for (const directive of ['none', 'allowed'] as const) {
      expect(runtimeToProse({ emojiDirective: directive }, 'comp_complaint', NOW)).not.toContain(
        '## Emoji for this message',
      )
    }
  })

  // The gate has to be narrow, not a silent kill switch — a version that
  // suppressed everywhere would pass both assertions above and remove the
  // whole feature.
  it('still renders on the ordinary categories', () => {
    for (const category of ['reply', 'new_question', 'recommendation_request', 'casual_chatter', 'follow_up'] as const) {
      expect(runtimeToProse({ emojiDirective: 'allowed' }, category, NOW)).toContain(
        '## Emoji for this message',
      )
    }
  })

  it('the two branches are actually different text', () => {
    const none = runtimeToProse({ emojiDirective: 'none' }, 'reply', NOW)
    const allowed = runtimeToProse({ emojiDirective: 'allowed' }, 'reply', NOW)
    expect(none).not.toEqual(allowed)
  })
})
