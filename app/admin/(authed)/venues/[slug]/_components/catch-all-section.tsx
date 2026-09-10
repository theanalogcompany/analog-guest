import type { UnclaimedField } from '../../_lib/unclaimed-fields'
import { KnowledgeEntryList, type KnowledgeEntryListRow } from './knowledge-entry-list'
import { EmptySectionNote, SectionShell } from './section-shell'

// Structural complement of every named section above (TAC-343 plan review,
// "render from the data, not from my list"). Nothing here was placed by
// judgment — computeUnclaimedVenueInfoFields / groupKnowledgeByTag decide
// what lands here, not a hand-picked list of fields this component knows
// about. Per-row unclaimed mechanics columns render inline in
// MechanicsSection instead, next to the mechanic they belong to.
export function CatchAllSection({
  venueId,
  unclaimedVenueInfoFields,
  unclaimedKnowledgeEntries,
}: {
  venueId: string
  unclaimedVenueInfoFields: readonly UnclaimedField[]
  unclaimedKnowledgeEntries: readonly KnowledgeEntryListRow[]
}) {
  const hasAnything =
    unclaimedVenueInfoFields.length > 0 || unclaimedKnowledgeEntries.length > 0

  return (
    <SectionShell
      title="Unclaimed"
      subtitle="fields and knowledge entries no named section above accounts for"
    >
      {!hasAnything ? (
        <EmptySectionNote>Nothing unclaimed right now.</EmptySectionNote>
      ) : (
        <div className="flex flex-col gap-4">
          {unclaimedVenueInfoFields.length > 0 && (
            <div>
              <p className="mb-2 text-xs uppercase tracking-wide text-ink-faint">
                venue_info fields
              </p>
              <ul className="flex flex-col gap-1.5">
                {unclaimedVenueInfoFields.map((f) => (
                  <li key={f.key} className="text-sm">
                    <span className="font-mono text-xs text-ink-faint">{f.key}</span>{' '}
                    <span className="text-ink">
                      {typeof f.value === 'string' ? f.value : JSON.stringify(f.value)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {unclaimedKnowledgeEntries.length > 0 && (
            <div>
              <p className="mb-2 text-xs uppercase tracking-wide text-ink-faint">
                knowledge_corpus entries
              </p>
              <KnowledgeEntryList
                venueId={venueId}
                entries={unclaimedKnowledgeEntries}
                emptyMessage="None."
                defaultPrimaryTag="other"
                allowAdd={false}
              />
            </div>
          )}
        </div>
      )}
    </SectionShell>
  )
}
