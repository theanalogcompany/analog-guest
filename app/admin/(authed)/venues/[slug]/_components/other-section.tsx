import { KnowledgeEntryList, type KnowledgeEntryListRow } from './knowledge-entry-list'
import { SectionShell } from './section-shell'

// The 'other' primary tag's own named section — distinct from the
// structural catch-all in catch-all-section.tsx, which is for entries no
// section (including this one) claims at all.
export function OtherSection({ entries }: { entries: readonly KnowledgeEntryListRow[] }) {
  return (
    <SectionShell title="Other" subtitle="other">
      <KnowledgeEntryList entries={entries} emptyMessage="Nothing tagged 'other' yet." />
    </SectionShell>
  )
}
