import { isCanonicalPrimaryTag, type KnowledgePrimaryTag } from '@/lib/schemas'

// Groups knowledge_corpus entries into the venue page's §2 sections by
// primary tag (TAC-343). A chunk carries no memory of which onboarding
// section produced it — tags are all we have, so grouping is tag-driven,
// not onboarding-section-driven (per the ticket's own "sections group by
// primary tag, not by onboarding section number" rule).
//
// Deliberately a CLOSED map, not `Record<KnowledgePrimaryTag, Section>`
// covering every canonical tag: the §2 table, read literally, does not name
// a section for the 'mechanic' primary tag (the ticket's "Mechanics"
// section is the `mechanics` DB table, not knowledge_corpus rows tagged
// `mechanic`/`mechanic_*`). Rather than guess a home for it, entries tagged
// 'mechanic' fall through to `null` here and get grouped into the
// structural "unclaimed knowledge tags" bucket by groupKnowledgeByTag below
// — distinct from the 'other' tag's own named section. See the ticket's
// "render from the data, not from my list" instruction.

export const KNOWLEDGE_SECTIONS = [
  'the_story',
  'menu_knowledge',
  'the_team',
  'room_rules_logistics',
  'events_merch',
  'other',
] as const

export type KnowledgeSection = (typeof KNOWLEDGE_SECTIONS)[number]

const TAG_TO_SECTION: Partial<Record<KnowledgePrimaryTag, KnowledgeSection>> = {
  history: 'the_story',
  philosophy: 'the_story',
  menu: 'menu_knowledge',
  recommendations: 'menu_knowledge',
  sourcing: 'menu_knowledge',
  staff: 'the_team',
  space: 'room_rules_logistics',
  policies: 'room_rules_logistics',
  logistics: 'room_rules_logistics',
  events: 'events_merch',
  other: 'other',
  // 'mechanic' intentionally omitted — see module comment.
}

export interface KnowledgeEntryForGrouping {
  id: string
  primaryTags: string[]
}

export interface GroupedKnowledge<T extends KnowledgeEntryForGrouping> {
  bySection: Record<KnowledgeSection, T[]>
  /** Entries whose primary tags matched no section — surfaced, never dropped. */
  unclaimed: T[]
}

/**
 * Group entries by their first primary tag that resolves to a known section
 * (via isCanonicalPrimaryTag's namespacing — `staff_phoebe` groups under
 * `staff`'s section same as bare `staff`). An entry with multiple primary
 * tags spanning different sections is placed once, under the first match —
 * ticket doesn't ask for multi-section rendering of one entry, and picking
 * the first keeps every entry visible exactly once rather than duplicated
 * or arbitrarily last-write-wins.
 *
 * An entry with zero primary tags, or whose tags are all non-canonical
 * (schema violation — isCanonicalPrimaryTag is meant to be enforced at
 * write time, but this reads what's actually in the DB, not what should be
 * there), lands in `unclaimed` rather than being silently skipped.
 */
export function groupKnowledgeByTag<T extends KnowledgeEntryForGrouping>(
  entries: readonly T[],
): GroupedKnowledge<T> {
  const bySection = Object.fromEntries(
    KNOWLEDGE_SECTIONS.map((s) => [s, [] as T[]]),
  ) as Record<KnowledgeSection, T[]>
  const unclaimed: T[] = []

  for (const entry of entries) {
    let placed = false
    for (const tag of entry.primaryTags) {
      const canonical = isCanonicalPrimaryTag(tag)
      if (canonical === null) continue
      const section = TAG_TO_SECTION[canonical]
      if (section === undefined) continue
      bySection[section].push(entry)
      placed = true
      break
    }
    if (!placed) unclaimed.push(entry)
  }

  return { bySection, unclaimed }
}
