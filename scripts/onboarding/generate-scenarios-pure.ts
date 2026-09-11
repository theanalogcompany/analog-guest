import { filterActiveContext, type VenueInfo } from '@/lib/schemas/venue-info'
import type { KnowledgeCorpusRow, MechanicRow } from './load-venue-context'

/**
 * TAC-347 Stage 1 (redesign). Pure helpers shared across the generation
 * modules: the flattened "coverable row" list every source (knowledge,
 * structured facts, menu items, mechanics) reduces to for topic-mapping and
 * coverage checking, plus the topic-mapping validation the plan review
 * asked for explicitly (reject unknown ids, allow multi-topic mapping,
 * unmapped rows go to backfill).
 */

export interface CoverableRow {
  id: string
  label: string
  content: string
}

/**
 * Condensed text form of every coverable row, for prompts that need to
 * judge something AGAINST the venue's real data rather than write about one
 * specific row — e.g. whether an edge case's expected_route is 'send'
 * (the venue documents this) or 'queue' (it doesn't, so a confident answer
 * would be invented), or whether an unanswerable probe accidentally mixes
 * in a fact the venue actually does document. Deliberately just id+content,
 * no formatting beyond one row per line — this is a reference the model
 * reads, not a rendered block a guest would see.
 */
export function buildVenueContentDigest(rows: readonly CoverableRow[]): string {
  return rows.map((r) => `- ${r.content}`).join('\n')
}

function formatAddress(address: VenueInfo['address']): string {
  const line2 = address.line2 ? `, ${address.line2}` : ''
  return `${address.line1}${line2}, ${address.city}, ${address.region} ${address.postalCode}`
}

/**
 * Every DB-backed thing the coverage guarantee applies to, flattened into
 * one list with a stable id and enough content for a generation prompt to
 * write specifically about it. Menu items use a normalized-name+index slug
 * since MenuItemSchema has no stable id (same approach the earlier Stage 1
 * build used).
 */
export function buildCoverableRows(ctx: {
  venueInfo: VenueInfo
  knowledgeRows: readonly KnowledgeCorpusRow[]
  mechanics: readonly MechanicRow[]
}): CoverableRow[] {
  const rows: CoverableRow[] = []

  for (const k of ctx.knowledgeRows) {
    if (!k.isProcessed) continue
    rows.push({ id: `knowledge:${k.id}`, label: k.primaryTags[0] ?? 'other', content: k.content })
  }

  const hoursEntries = Object.entries(ctx.venueInfo.hours).filter(([, v]) => v)
  if (hoursEntries.length > 0) {
    rows.push({
      id: 'fact:hours',
      label: 'hours',
      content: hoursEntries.map(([d, v]) => `${d}: ${v}`).join('; '),
    })
  }
  rows.push({ id: 'fact:address', label: 'address', content: formatAddress(ctx.venueInfo.address) })
  const contactParts: string[] = []
  if (ctx.venueInfo.contact.publicPhone) contactParts.push(`phone: ${ctx.venueInfo.contact.publicPhone}`)
  if (ctx.venueInfo.contact.publicEmail) contactParts.push(`email: ${ctx.venueInfo.contact.publicEmail}`)
  if (ctx.venueInfo.contact.website) contactParts.push(`website: ${ctx.venueInfo.contact.website}`)
  if (contactParts.length > 0) {
    rows.push({ id: 'fact:contact', label: 'contact', content: contactParts.join('; ') })
  }
  if (ctx.venueInfo.amenities) {
    const a = ctx.venueInfo.amenities
    const parts: string[] = []
    if (a.wifi !== undefined) parts.push(`wifi: ${a.wifi ? 'yes' : 'no'}`)
    if (a.petFriendly !== undefined) parts.push(`pet friendly: ${a.petFriendly ? 'yes' : 'no'}`)
    if (a.parking) parts.push(`parking: ${a.parking}`)
    if (a.seating) parts.push(`seating: ${a.seating}`)
    if (a.notes) parts.push(a.notes)
    if (parts.length > 0) rows.push({ id: 'fact:amenities', label: 'amenities', content: parts.join('; ') })
  }
  if (ctx.venueInfo.staff.length > 0) {
    rows.push({ id: 'fact:staff', label: 'staff', content: `Staff: ${ctx.venueInfo.staff.join(', ')}` })
  }
  for (const entry of filterActiveContext(ctx.venueInfo.currentContext, new Date())) {
    rows.push({ id: `fact:current_context:${entry.id}`, label: 'current context', content: entry.content })
  }

  const usedSlugs = new Set<string>()
  ctx.venueInfo.menu.items.forEach((item, i) => {
    const base = item.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || `item_${i}`
    let slug = base
    let n = 2
    while (usedSlugs.has(slug)) {
      slug = `${base}_${n}`
      n += 1
    }
    usedSlugs.add(slug)
    const price = item.price !== undefined ? `$${item.price.toFixed(2)}` : (item.priceNote ?? 'price on request')
    const parts = [`price: ${price}`]
    if (item.dietary.length > 0) parts.push(`dietary: ${item.dietary.join(', ')}`)
    if (item.modifiers.length > 0) parts.push(`modifiers: ${item.modifiers.join(', ')}`)
    if (item.isOffMenu) parts.push('off-menu')
    if (item.description) parts.push(item.description)
    rows.push({ id: `menu:${slug}`, label: `menu: ${item.name}`, content: parts.join('; ') })
  })

  for (const m of ctx.mechanics) {
    if (!m.isActive) continue
    const parts = [`min state: ${m.minState}`]
    if (m.rewardDescription) parts.push(m.rewardDescription)
    else if (m.description) parts.push(m.description)
    if (m.requiresOperatorApproval) parts.push('requires operator approval')
    rows.push({ id: `mechanic:${m.id}`, label: `mechanic: ${m.name}`, content: parts.join('; ') })
  }

  return rows
}

export interface TopicMappingEntry {
  rowId: string
  topics: string[]
}

export interface ValidatedTopicMapping {
  valid: TopicMappingEntry[]
  unmappedRowIds: string[]
  droppedTopicRefs: Array<{ rowId: string; unknownTopic: string }>
}

/**
 * Reject unknown row ids (hallucination against a real DB primary key —
 * must not propagate, mirrors the existing validateMechanicsCategoriesAreReal
 * fail-closed pattern in extract-test-scenarios.ts). Allow a row to map to
 * multiple topics. Any coverable row the model didn't mention at all goes to
 * `unmappedRowIds` for the backfill pass, rather than being silently dropped
 * or treated as an error.
 *
 * An unknown TOPIC name is handled more leniently than an unknown row id —
 * that's a self-consistency slip WITHIN one model response (the mapping
 * referenced a topic slug the same response's own `topics` list didn't
 * define), not a hallucination against real data, and hard-failing an
 * entire multi-minute generation run over one mismatched slug is worse than
 * dropping that one topic reference and logging it. If a row's every topic
 * reference turns out unknown, it falls through to `unmappedRowIds` and
 * gets a targeted backfill scenario like any other uncovered row — no
 * coverage is silently lost, it's just generated through a different path.
 */
export function validateTopicMapping(
  mapping: readonly TopicMappingEntry[],
  validRowIds: ReadonlySet<string>,
  validTopics: ReadonlySet<string>,
): ValidatedTopicMapping {
  const seen = new Set<string>()
  const valid: TopicMappingEntry[] = []
  const droppedTopicRefs: Array<{ rowId: string; unknownTopic: string }> = []

  for (const entry of mapping) {
    if (!validRowIds.has(entry.rowId)) {
      throw new Error(
        `validateTopicMapping: unknown row id "${entry.rowId}" in topic mapping — likely a hallucinated id, not a real coverable row`,
      )
    }
    const knownTopics = entry.topics.filter((t) => {
      if (validTopics.has(t)) return true
      droppedTopicRefs.push({ rowId: entry.rowId, unknownTopic: t })
      return false
    })
    if (knownTopics.length > 0) {
      valid.push({ rowId: entry.rowId, topics: knownTopics })
      seen.add(entry.rowId)
    }
  }

  const unmappedRowIds = Array.from(validRowIds).filter((id) => !seen.has(id))
  return { valid, unmappedRowIds, droppedTopicRefs }
}

/** Which coverable rows have zero scenarios referencing them, for the coverage report / backfill trigger. */
export function computeUncoveredRowIds(
  coverableRows: readonly CoverableRow[],
  sourceRowIdsUsed: ReadonlySet<string>,
): string[] {
  return coverableRows.filter((r) => !sourceRowIdsUsed.has(r.id)).map((r) => r.id)
}

/**
 * Extract the `### Missing information` bullet items from a 06-file's
 * appended `## Needs confirmation` section (verify.ts's
 * formatNeedsConfirmationSection is the writer of this exact shape — see
 * that file for the literal markdown produced). Returns [] when the section
 * or subsection isn't present (pre-TAC-346 06-files with no verification
 * pass appended) or is explicitly empty (`*(none)*`).
 */
export function parseMissingInformationItems(specMarkdown: string): string[] {
  const needsConfirmationIdx = specMarkdown.indexOf('## Needs confirmation')
  if (needsConfirmationIdx === -1) return []
  const section = specMarkdown.slice(needsConfirmationIdx)

  const subsectionIdx = section.indexOf('### Missing information')
  if (subsectionIdx === -1) return []
  const afterHeader = section.slice(subsectionIdx + '### Missing information'.length)

  const nextH3Idx = afterHeader.search(/\n###\s/)
  const body = nextH3Idx === -1 ? afterHeader : afterHeader.slice(0, nextH3Idx)

  const items: string[] = []
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('- ')) continue
    const text = trimmed.slice(2).trim()
    if (text === '*(none)*' || text.length === 0) continue
    items.push(text)
  }
  return items
}
