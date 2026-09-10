import { KnowledgeEntryList, type KnowledgeEntryListRow } from './knowledge-entry-list'
import { SectionShell } from './section-shell'

export function TheStorySection({
  venueId,
  entries,
}: {
  venueId: string
  entries: readonly KnowledgeEntryListRow[]
}) {
  return (
    <SectionShell title="The story" subtitle="history, philosophy">
      <KnowledgeEntryList
        venueId={venueId}
        entries={entries}
        emptyMessage="No origin story or philosophy captured yet."
        defaultPrimaryTag="history"
      />
    </SectionShell>
  )
}
