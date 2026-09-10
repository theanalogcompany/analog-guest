import { KnowledgeEntryList, type KnowledgeEntryListRow } from './knowledge-entry-list'
import { SectionShell } from './section-shell'

// Distinct from MenuRosterSection (venue_info.menu.items — the technical,
// one-row-per-item list). This is what the owner said ABOUT those items —
// prose, not a table. Deliberately not merged (§2).
export function MenuKnowledgeSection({
  venueId,
  entries,
}: {
  venueId: string
  entries: readonly KnowledgeEntryListRow[]
}) {
  return (
    <SectionShell title="Menu knowledge" subtitle="menu, recommendations, sourcing">
      <KnowledgeEntryList
        venueId={venueId}
        entries={entries}
        emptyMessage="No menu commentary, recommendations, or sourcing detail captured yet."
        defaultPrimaryTag="menu"
      />
    </SectionShell>
  )
}
