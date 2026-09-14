import { EmptySectionNote, SectionShell } from '@/app/admin/_components/section-shell'
import { HairlineRow, StatusDot } from '@/lib/ui'
import type { VenueCommitmentRow, VenueCommitments } from '../../../_lib/load-venue-commitments'
import { CLOSED_COMMITMENTS_LIMIT } from '../../../_lib/load-venue-commitments'
import {
  classifyKind,
  formatAge,
  formatExpiry,
  isEscalated,
  isUntimed,
  sortForDisplay,
} from '../../_lib/commitment-display'

// TAC-381: what this venue owes, across all its guests. Read-only — nothing
// here redeems, cancels or dismisses anything.

function TypeTag({ row }: { row: VenueCommitmentRow }) {
  const obligation = classifyKind(row) === 'obligation'
  // An obligation is money or product owed; a recommendation is a suggestion.
  // The two must never read alike (§2), so they differ in weight and colour,
  // not just in the word.
  const tone = obligation
    ? 'bg-clay-soft/60 text-clay-deep font-medium'
    : 'bg-stone-light/40 text-ink-soft'
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ${tone}`}>
      {row.type}
    </span>
  )
}

function CommitmentRowView({
  row,
  now,
  last,
}: {
  row: VenueCommitmentRow
  now: Date
  last: boolean
}) {
  // Narrowed on the field rather than through isEscalated(), which returns a
  // plain boolean and leaves escalatedAt as string | null — the alternative
  // was an `as string` cast at the render site, which is the kind of thing
  // that stops being true the moment the predicate changes.
  const escalatedAt = row.escalatedAt
  const escalated = isEscalated(row)
  return (
    <HairlineRow
      last={last}
      className={`flex flex-col gap-1.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6 ${
        escalated ? 'border-l-2 border-l-destructive pl-3' : ''
      }`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <TypeTag row={row} />
          <span className="text-sm text-ink">{row.description}</span>
          {row.code && <code className="text-xs text-ink-soft">{row.code}</code>}
        </span>
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-ink-faint">
          <span>{row.guestLabel}</span>
          <span>·</span>
          <span>{row.status}</span>
          {escalatedAt !== null && (
            <>
              <span>·</span>
              <span className="font-medium text-destructive">
                escalated {formatAge(escalatedAt, now)}
              </span>
            </>
          )}
        </span>
        {/* The case the ticket was filed about. Stated outright rather than
            left for the reader to infer from two blank cells. */}
        {isUntimed(row) && (
          <span className="text-xs text-ink-faint italic">
            No arrival signal — cannot reach the arrival cron or the operator heads-up queue.
          </span>
        )}
      </div>
      <div className="flex shrink-0 flex-col gap-1 text-xs text-ink-faint tabular-nums sm:items-end">
        <span>promised {formatAge(row.createdAt, now)}</span>
        <span>{formatExpiry(row, now)}</span>
      </div>
    </HairlineRow>
  )
}

export function CommitmentsSection({
  commitments,
  now,
}: {
  commitments: VenueCommitments
  now: Date
}) {
  const open = sortForDisplay(commitments.open)
  const closed = commitments.closed

  return (
    <SectionShell
      title="Open commitments"
      subtitle="Every promise this venue still owes, across all its guests. Read-only."
    >
      {open.length === 0 ? (
        <EmptySectionNote>
          {/* Never assert the venue owes nothing off a read that did not run.
              The ordinary empty state is a claim about money owed; the
              degraded one refuses to make it. Same posture the sibling
              intentions loader documents, applied to the half where being
              wrong is more expensive. */}
          {commitments.openDegraded
            ? 'Could not load commitments — a read failed, so this is not a claim that nothing is open.'
            : 'Nothing open. This venue owes no guest anything.'}
        </EmptySectionNote>
      ) : (
        <div className="flex flex-col">
          {commitments.openDegraded && (
            <p className="mb-2 flex items-center gap-2 text-xs text-ink-soft">
              <StatusDot tone="neutral" label="degraded" />
              A read failed. This list under-reports — treat it as a floor, not a total.
            </p>
          )}
          {open.map((row, i) => (
            <CommitmentRowView
              key={row.id}
              row={row}
              now={now}
              last={i === open.length - 1}
            />
          ))}
        </div>
      )}

      {commitments.closedDegraded && (
        <p className="mt-6 flex items-center gap-2 border-t border-stone-light/60 pt-4 text-xs text-ink-soft">
          <StatusDot tone="neutral" label="degraded" />
          Could not load closed commitments.
        </p>
      )}

      {closed.length > 0 && (
        <div className="mt-6 border-t border-stone-light/60 pt-4">
          <p className="mb-2 text-xs text-ink-faint">
            {/* Secondary and separated, per §2. Shown at all because TAC-341
                gave these rows a way to leave 'open' on their own: an
                open-only page would stop showing a comp at the exact moment
                it expired unclaimed. */}
            Recently closed ·{' '}
            {commitments.closedHasMore
              ? `the ${CLOSED_COMMITMENTS_LIMIT} most recent, older ones exist and are not listed`
              : `${closed.length} total`}
          </p>
          <div className="flex flex-col opacity-60">
            {closed.map((row, i) => (
              <HairlineRow
                key={row.id}
                last={i === closed.length - 1}
                className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
              >
                <span className="min-w-0 text-sm text-ink-soft">
                  {row.type} · {row.description}
                </span>
                <span className="shrink-0 text-xs text-ink-faint tabular-nums">
                  {row.status} · {row.guestLabel}
                </span>
              </HairlineRow>
            ))}
          </div>
        </div>
      )}
    </SectionShell>
  )
}
