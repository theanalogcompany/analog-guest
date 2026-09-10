import { describe, expect, it } from 'vitest'
import { groupKnowledgeByTag } from './section-grouping'

const entry = (id: string, primaryTags: string[]) => ({ id, primaryTags })

describe('groupKnowledgeByTag', () => {
  it('groups history and philosophy into the_story', () => {
    const { bySection } = groupKnowledgeByTag([
      entry('a', ['history']),
      entry('b', ['philosophy']),
    ])
    expect(bySection.the_story.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('groups menu, recommendations, and sourcing into menu_knowledge', () => {
    const { bySection } = groupKnowledgeByTag([
      entry('a', ['menu']),
      entry('b', ['recommendations']),
      entry('c', ['sourcing']),
    ])
    expect(bySection.menu_knowledge.map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('groups a namespaced staff tag under the_team via the canonical prefix', () => {
    const { bySection } = groupKnowledgeByTag([entry('a', ['staff_phoebe'])])
    expect(bySection.the_team.map((e) => e.id)).toEqual(['a'])
  })

  it('groups space, policies, and logistics into room_rules_logistics', () => {
    const { bySection } = groupKnowledgeByTag([
      entry('a', ['space']),
      entry('b', ['policies']),
      entry('c', ['logistics']),
    ])
    expect(bySection.room_rules_logistics.map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('groups events into events_merch', () => {
    const { bySection } = groupKnowledgeByTag([entry('a', ['events'])])
    expect(bySection.events_merch.map((e) => e.id)).toEqual(['a'])
  })

  it('groups the other tag into its own named "other" section, visibly', () => {
    const { bySection, unclaimed } = groupKnowledgeByTag([entry('a', ['other'])])
    expect(bySection.other.map((e) => e.id)).toEqual(['a'])
    expect(unclaimed).toEqual([])
  })

  it('places a namespaced mechanic tag into unclaimed, not into "other"', () => {
    const { bySection, unclaimed } = groupKnowledgeByTag([
      entry('a', ['mechanic_custom_drink']),
    ])
    expect(bySection.other).toEqual([])
    expect(unclaimed.map((e) => e.id)).toEqual(['a'])
  })

  it('places an entry with zero primary tags into unclaimed', () => {
    const { unclaimed } = groupKnowledgeByTag([entry('a', [])])
    expect(unclaimed.map((e) => e.id)).toEqual(['a'])
  })

  it('places an entry with only non-canonical tags into unclaimed', () => {
    const { unclaimed } = groupKnowledgeByTag([entry('a', ['personality'])])
    expect(unclaimed.map((e) => e.id)).toEqual(['a'])
  })

  it('places a multi-tag entry once, under the first matching section', () => {
    const { bySection } = groupKnowledgeByTag([entry('a', ['sourcing', 'history'])])
    expect(bySection.menu_knowledge.map((e) => e.id)).toEqual(['a'])
    expect(bySection.the_story).toEqual([])
  })

  it('returns every section key even when empty', () => {
    const { bySection } = groupKnowledgeByTag([])
    expect(Object.keys(bySection).sort()).toEqual(
      [
        'events_merch',
        'menu_knowledge',
        'other',
        'room_rules_logistics',
        'the_story',
        'the_team',
      ].sort(),
    )
  })
})
