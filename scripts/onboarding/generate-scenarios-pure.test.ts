import { describe, expect, it } from 'vitest'
import type { VenueInfo } from '@/lib/schemas/venue-info'
import {
  buildCoverableRows,
  buildVenueContentDigest,
  computeUncoveredRowIds,
  parseMissingInformationItems,
  validateTopicMapping,
} from './generate-scenarios-pure'
import type { KnowledgeCorpusRow, MechanicRow } from './load-venue-context'

const baseVenueInfo = (overrides: Partial<VenueInfo> = {}): VenueInfo => ({
  address: { line1: '123 Main St', city: 'Anytown', region: 'CA', postalCode: '90000' },
  contact: {},
  hours: {},
  menu: { highlights: [], items: [] },
  staff: [],
  currentContext: [],
  ...overrides,
})

describe('buildCoverableRows', () => {
  it('includes a processed knowledge row and excludes an unprocessed one', () => {
    const rows = buildCoverableRows({
      venueInfo: baseVenueInfo(),
      knowledgeRows: [
        { id: 'kc-1', content: 'sourcing story', primaryTags: ['sourcing'], isProcessed: true },
        { id: 'kc-2', content: 'not yet embedded', primaryTags: ['other'], isProcessed: false },
      ] satisfies KnowledgeCorpusRow[],
      mechanics: [],
    })
    expect(rows.map((r) => r.id)).toContain('knowledge:kc-1')
    expect(rows.map((r) => r.id)).not.toContain('knowledge:kc-2')
  })

  it('always includes address, omits hours/contact/amenities/staff when unset', () => {
    const rows = buildCoverableRows({ venueInfo: baseVenueInfo(), knowledgeRows: [], mechanics: [] })
    const ids = rows.map((r) => r.id)
    expect(ids).toContain('fact:address')
    expect(ids).not.toContain('fact:hours')
    expect(ids).not.toContain('fact:contact')
    expect(ids).not.toContain('fact:amenities')
    expect(ids).not.toContain('fact:staff')
  })

  it('includes one row per active currentContext entry, excluding expired ones', () => {
    const rows = buildCoverableRows({
      venueInfo: baseVenueInfo({
        currentContext: [
          { id: 'ctx-a', content: 'active note', source: 'text', addedAt: new Date() },
          {
            id: 'ctx-b',
            content: 'expired note',
            source: 'text',
            addedAt: new Date(),
            expiresAt: '2020-01-01T00:00:00Z',
          },
        ],
      }),
      knowledgeRows: [],
      mechanics: [],
    })
    expect(rows.map((r) => r.id)).toContain('fact:current_context:ctx-a')
    expect(rows.map((r) => r.id)).not.toContain('fact:current_context:ctx-b')
  })

  it('assigns unique slugs to menu items with duplicate names', () => {
    const rows = buildCoverableRows({
      venueInfo: baseVenueInfo({
        menu: {
          highlights: [],
          items: [
            { name: 'Olipop', category: 'drinks', price: 4, modifiers: [], dietary: [], isOffMenu: false },
            { name: 'Olipop', category: 'drinks', price: 5, modifiers: [], dietary: [], isOffMenu: false },
          ],
        },
      }),
      knowledgeRows: [],
      mechanics: [],
    })
    const menuIds = rows.filter((r) => r.id.startsWith('menu:')).map((r) => r.id)
    expect(new Set(menuIds).size).toBe(2)
  })

  it('includes only active mechanics', () => {
    const rows = buildCoverableRows({
      venueInfo: baseVenueInfo(),
      knowledgeRows: [],
      mechanics: [
        {
          id: 'm-1',
          name: 'Couch Hold',
          type: 'perk',
          minState: 'regular',
          requiresOperatorApproval: false,
          qualification: null,
          description: null,
          rewardDescription: 'a couch seat',
          isActive: true,
        },
        {
          id: 'm-2',
          name: 'Retired Perk',
          type: 'perk',
          minState: 'new',
          requiresOperatorApproval: false,
          qualification: null,
          description: null,
          rewardDescription: null,
          isActive: false,
        },
      ] satisfies MechanicRow[],
    })
    const ids = rows.map((r) => r.id)
    expect(ids).toContain('mechanic:m-1')
    expect(ids).not.toContain('mechanic:m-2')
  })
})

describe('buildVenueContentDigest', () => {
  it('renders one bullet per row content, no formatting beyond that', () => {
    const rows = [
      { id: 'a', label: 'x', content: 'open 9-5 weekdays' },
      { id: 'b', label: 'y', content: 'no delivery apps' },
    ]
    expect(buildVenueContentDigest(rows)).toBe('- open 9-5 weekdays\n- no delivery apps')
  })

  it('returns an empty string for no rows', () => {
    expect(buildVenueContentDigest([])).toBe('')
  })
})

describe('validateTopicMapping', () => {
  const validRowIds = new Set(['knowledge:kc-1', 'fact:address'])
  const validTopics = new Set(['story_and_sourcing', 'location'])

  it('accepts a row mapped to multiple topics', () => {
    const { valid } = validateTopicMapping(
      [{ rowId: 'knowledge:kc-1', topics: ['story_and_sourcing', 'location'] }],
      validRowIds,
      validTopics,
    )
    expect(valid).toEqual([{ rowId: 'knowledge:kc-1', topics: ['story_and_sourcing', 'location'] }])
  })

  it('throws on an unknown row id (hallucination)', () => {
    expect(() =>
      validateTopicMapping(
        [{ rowId: 'knowledge:does-not-exist', topics: ['story_and_sourcing'] }],
        validRowIds,
        validTopics,
      ),
    ).toThrow(/unknown row id/)
  })

  it('drops (does not throw on) an unknown topic reference, reporting it', () => {
    const { valid, droppedTopicRefs } = validateTopicMapping(
      [{ rowId: 'knowledge:kc-1', topics: ['made_up_topic'] }],
      validRowIds,
      validTopics,
    )
    expect(valid).toEqual([])
    expect(droppedTopicRefs).toEqual([{ rowId: 'knowledge:kc-1', unknownTopic: 'made_up_topic' }])
  })

  it('keeps the known topics on a row whose mapping mixes known and unknown topics', () => {
    const { valid, droppedTopicRefs } = validateTopicMapping(
      [{ rowId: 'knowledge:kc-1', topics: ['story_and_sourcing', 'made_up_topic'] }],
      validRowIds,
      validTopics,
    )
    expect(valid).toEqual([{ rowId: 'knowledge:kc-1', topics: ['story_and_sourcing'] }])
    expect(droppedTopicRefs).toEqual([{ rowId: 'knowledge:kc-1', unknownTopic: 'made_up_topic' }])
  })

  it('sends a row to unmappedRowIds when every one of its topic references is unknown', () => {
    const { unmappedRowIds } = validateTopicMapping(
      [{ rowId: 'knowledge:kc-1', topics: ['made_up_topic'] }],
      validRowIds,
      validTopics,
    )
    expect(unmappedRowIds.sort()).toEqual(['fact:address', 'knowledge:kc-1'])
  })

  it('sends a row with no mapping entry to unmappedRowIds', () => {
    const { unmappedRowIds } = validateTopicMapping([], validRowIds, validTopics)
    expect(unmappedRowIds.sort()).toEqual(['fact:address', 'knowledge:kc-1'])
  })

  it('does not send a mapped row to unmappedRowIds', () => {
    const { unmappedRowIds } = validateTopicMapping(
      [{ rowId: 'knowledge:kc-1', topics: ['story_and_sourcing'] }],
      validRowIds,
      validTopics,
    )
    expect(unmappedRowIds).toEqual(['fact:address'])
  })
})

describe('parseMissingInformationItems', () => {
  it('extracts bullet items under ### Missing information', () => {
    const md = `## Needs confirmation\n\n### Unsupported claims\n*(none flagged)*\n\n### Missing information\n- the exact opening date of the new patio\n- whether the venue offers gift cards\n\n### Dates requiring confirmation\n*(none)*\n`
    expect(parseMissingInformationItems(md)).toEqual([
      'the exact opening date of the new patio',
      'whether the venue offers gift cards',
    ])
  })

  it('returns [] when the subsection says *(none)*', () => {
    const md = `## Needs confirmation\n\n### Missing information\n*(none)*\n`
    expect(parseMissingInformationItems(md)).toEqual([])
  })

  it('returns [] when there is no Needs confirmation section at all', () => {
    expect(parseMissingInformationItems('# Just a venue spec\n\nsome content')).toEqual([])
  })

  it('returns [] when Needs confirmation exists but Missing information does not', () => {
    const md = `## Needs confirmation\n\n### Unsupported claims\n*(none flagged)*\n`
    expect(parseMissingInformationItems(md)).toEqual([])
  })
})

describe('computeUncoveredRowIds', () => {
  it('reports rows with no scenario referencing them', () => {
    const rows = [
      { id: 'a', label: 'a', content: 'a' },
      { id: 'b', label: 'b', content: 'b' },
    ]
    const used = new Set(['a'])
    expect(computeUncoveredRowIds(rows, used)).toEqual(['b'])
  })

  it('returns an empty array when everything is covered', () => {
    const rows = [{ id: 'a', label: 'a', content: 'a' }]
    expect(computeUncoveredRowIds(rows, new Set(['a']))).toEqual([])
  })
})
