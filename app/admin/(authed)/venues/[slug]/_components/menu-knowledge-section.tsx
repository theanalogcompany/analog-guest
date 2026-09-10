import { KnowledgeEntryList, type KnowledgeEntryListRow } from './knowledge-entry-list'
import { SectionShell } from './section-shell'

// Distinct from MenuRosterSection (venue_info.menu.items — the technical,
// one-row-per-item list). This is what the owner said ABOUT those items —
// prose, not a table. Deliberately not merged (§2).
export function MenuKnowledgeSection({
  entries,
}: {
  entries: readonly KnowledgeEntryListRow[]
}) {
  return (
    <SectionShell title="Menu knowledge" subtitle="menu, recommendations, sourcing">
      <KnowledgeEntryList
        entries={entries}
        emptyMessage="No menu commentary, recommendations, or sourcing detail captured yet."
      />
    </SectionShell>
  )
}
