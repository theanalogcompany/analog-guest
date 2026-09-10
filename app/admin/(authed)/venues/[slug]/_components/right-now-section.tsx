import type { VenueContextNote } from '@/lib/schemas'
import { StatusDot } from '@/lib/ui'
import { partitionCurrentContext } from '../../_lib/expiry-queue'
import { EmptySectionNote, SectionShell } from './section-shell'

function ContextRow({ entry, badge }: { entry: VenueContextNote; badge?: string }) {
  return (
    <li className="flex items-start justify-between gap-3 border-b border-stone-light/40 py-2 last:border-b-0">
      <span className="text-sm text-ink">{entry.content}</span>
      <span className="shrink-0 text-xs text-ink-faint">
        {badge ?? (entry.expiresAt ? `until ${new Date(entry.expiresAt).toLocaleDateString()}` : 'permanent')}
      </span>
    </li>
  )
}

// currentContext is NOT tagged and NOT sectioned (§2) — one flat list.
// Stage A is read-only: the expiry queue is visible here but Drop/Promote
// actions land in Stage D.
export function RightNowSection({
  currentContext,
  now,
}: {
  currentContext: readonly VenueContextNote[]
  now: Date
}) {
  const { active, expired, malformed } = partitionCurrentContext(currentContext, now)

  return (
    <SectionShell title="Right now" subtitle="currentContext">
      {active.length === 0 ? (
        <EmptySectionNote>Nothing time-bound on file right now.</EmptySectionNote>
      ) : (
        <ul className="flex flex-col">
          {active.map((entry) => (
            <ContextRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}

      {(expired.length > 0 || malformed.length > 0) && (
        <div className="mt-4 border-t border-stone-light/60 pt-4">
          <div className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-faint">
            <StatusDot tone="neutral" label="needs a decision" />
            Expiry queue · drop or promote lands in Stage D
          </div>
          <ul className="flex flex-col">
            {expired.map((entry) => (
              <ContextRow key={entry.id} entry={entry} badge="expired" />
            ))}
            {malformed.map((entry) => (
              <ContextRow key={entry.id} entry={entry} badge="malformed date" />
            ))}
          </ul>
        </div>
      )}
    </SectionShell>
  )
}
