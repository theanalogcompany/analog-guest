import { KnowledgeEntryList, type KnowledgeEntryListRow } from './knowledge-entry-list'
import { SectionShell } from './section-shell'

export function TheStorySection({ entries }: { entries: readonly KnowledgeEntryListRow[] }) {
  return (
    <SectionShell title="The story" subtitle="history, philosophy">
      <KnowledgeEntryList
        entries={entries}
        emptyMessage="No origin story or philosophy captured yet."
      />
    </SectionShell>
  )
}
