import { KnowledgeEntryList, type KnowledgeEntryListRow } from './knowledge-entry-list'
import { SectionShell } from './section-shell'

export function EventsSection({ entries }: { entries: readonly KnowledgeEntryListRow[] }) {
  return (
    <SectionShell title="Events & merch" subtitle="events">
      <KnowledgeEntryList entries={entries} emptyMessage="No events or merch detail captured yet." />
    </SectionShell>
  )
}
