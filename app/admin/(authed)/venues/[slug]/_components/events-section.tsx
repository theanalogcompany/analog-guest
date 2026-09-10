import { KnowledgeEntryList, type KnowledgeEntryListRow } from './knowledge-entry-list'
import { SectionShell } from './section-shell'

export function EventsSection({
  venueId,
  entries,
}: {
  venueId: string
  entries: readonly KnowledgeEntryListRow[]
}) {
  return (
    <SectionShell title="Events & merch" subtitle="events">
      <KnowledgeEntryList
        venueId={venueId}
        entries={entries}
        emptyMessage="No events or merch detail captured yet."
        defaultPrimaryTag="events"
      />
    </SectionShell>
  )
}
