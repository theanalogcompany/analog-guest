// Canonical primary tags for knowledge_corpus entries (TAC-242, v1.12.0).
//
// Closed enum. Used at the parse boundary (fail-loud on non-canonical) and
// for retrieval routing (category → primary tag preference). Adding a new
// primary tag is intentionally a code change so the canonical set stays
// a deliberate design decision, not extraction-time drift.
//
// Namespacing convention:
//   - 'staff' is valid (un-namespaced)
//   - 'staff_phoebe' is valid (matches the `staff` prefix)
//   - 'mechanic_perk_card' is valid (matches the `mechanic` prefix)
//   - 'personality' is NOT valid (no canonical match)
//
// Secondary tags carry no validation — Sonnet flags them per chunk for
// descriptive context. They render in the prompt for grounding but don't
// affect routing.

export const KNOWLEDGE_PRIMARY_TAGS = [
  'sourcing',
  'staff',
  'mechanic',
  'menu',
  'philosophy',
  'recommendations',
  'events',
  'history',
  'space',
  'policies',
  'logistics',
  'other',
] as const

export type KnowledgePrimaryTag = (typeof KNOWLEDGE_PRIMARY_TAGS)[number]

/**
 * Validate a tag string against the canonical set, allowing the
 * `<canonical>_<suffix>` namespacing pattern. Returns the matched canonical
 * prefix, or null if invalid.
 *
 *   isCanonicalPrimaryTag('staff')              → 'staff'
 *   isCanonicalPrimaryTag('staff_phoebe')       → 'staff'
 *   isCanonicalPrimaryTag('mechanic_perk_card') → 'mechanic'
 *   isCanonicalPrimaryTag('personality')        → null
 *   isCanonicalPrimaryTag('_staff')             → null
 *   isCanonicalPrimaryTag('')                   → null
 */
export function isCanonicalPrimaryTag(tag: string): KnowledgePrimaryTag | null {
  if (KNOWLEDGE_PRIMARY_TAGS.includes(tag as KnowledgePrimaryTag)) {
    return tag as KnowledgePrimaryTag
  }
  const underscoreIdx = tag.indexOf('_')
  if (underscoreIdx > 0) {
    const prefix = tag.slice(0, underscoreIdx)
    if (KNOWLEDGE_PRIMARY_TAGS.includes(prefix as KnowledgePrimaryTag)) {
      return prefix as KnowledgePrimaryTag
    }
  }
  return null
}
