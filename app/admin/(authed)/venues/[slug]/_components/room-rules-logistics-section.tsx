import { KnowledgeEntryList, type KnowledgeEntryListRow } from './knowledge-entry-list'
import { SectionShell } from './section-shell'

export function RoomRulesLogisticsSection({
  venueId,
  entries,
}: {
  venueId: string
  entries: readonly KnowledgeEntryListRow[]
}) {
  return (
    <SectionShell title="The room, rules & logistics" subtitle="space, policies, logistics">
      <KnowledgeEntryList
        venueId={venueId}
        entries={entries}
        emptyMessage="No space, policy, or logistics detail captured yet."
        defaultPrimaryTag="space"
      />
    </SectionShell>
  )
}
