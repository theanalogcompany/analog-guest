import { KnowledgeEntryList, type KnowledgeEntryListRow } from './knowledge-entry-list'
import { EmptySectionNote, SectionShell } from './section-shell'

// Staff depth lives in chunks, not venue_info (§2: "do not widen
// venue_info.staff to carry notes"). This section renders the thin roster
// and the staff_[name] chunks together, but they stay two separate stores.
export function TeamSection({
  venueId,
  staff,
  entries,
}: {
  venueId: string
  staff: readonly string[]
  entries: readonly KnowledgeEntryListRow[]
}) {
  return (
    <SectionShell title="The team" subtitle="staff roster, staff_[name] chunks">
      <div className="flex flex-col gap-4">
        {staff.length === 0 ? (
          <EmptySectionNote>No staff on the roster yet.</EmptySectionNote>
        ) : (
          <div className="flex flex-wrap gap-2">
            {staff.map((name) => (
              <span
                key={name}
                className="rounded-[2px] bg-highlight px-2 py-1 text-sm text-ink"
              >
                {name}
              </span>
            ))}
          </div>
        )}
        <KnowledgeEntryList
          venueId={venueId}
          entries={entries}
          emptyMessage="No per-person knowledge chunks captured yet."
          defaultPrimaryTag="staff"
        />
      </div>
    </SectionShell>
  )
}
