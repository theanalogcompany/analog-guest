import { KnowledgeEntryList, type KnowledgeEntryListRow } from './knowledge-entry-list'
import { SectionShell } from './section-shell'

export function RoomRulesLogisticsSection({
  entries,
}: {
  entries: readonly KnowledgeEntryListRow[]
}) {
  return (
    <SectionShell title="The room, rules & logistics" subtitle="space, policies, logistics">
      <KnowledgeEntryList
        entries={entries}
        emptyMessage="No space, policy, or logistics detail captured yet."
      />
    </SectionShell>
  )
}
