import type { VenueDetailMechanicRow } from '../../../_lib/load-venue-detail'
import { findMissingMechanicFields, parseMechanicTriggerType } from '../../_lib/mechanic-fields'
import { StatusDot } from '@/lib/ui'
import { EmptySectionNote, SectionShell } from './section-shell'

interface UnclaimedForMechanic {
  id: string
  name: string
  columns: string[]
}

export function MechanicsSection({
  mechanics,
  unclaimedColumnsPerRow,
}: {
  mechanics: readonly VenueDetailMechanicRow[]
  unclaimedColumnsPerRow: readonly UnclaimedForMechanic[]
}) {
  if (mechanics.length === 0) {
    return (
      <SectionShell title="Mechanics">
        <EmptySectionNote>No mechanics configured yet.</EmptySectionNote>
      </SectionShell>
    )
  }

  return (
    <SectionShell title="Mechanics">
      <ul className="flex flex-col gap-4">
        {mechanics.map((m) => {
          const missing = findMissingMechanicFields(m)
          const triggerType = parseMechanicTriggerType(m.trigger)
          // Deactivated mechanics are excluded from every Readiness check —
          // a missing param or a manual_invite gap on a mechanic nobody can
          // hit anymore is not a gap. Mirrored here so the inline warning
          // agrees with the Readiness panel.
          const showGapWarning =
            m.isActive &&
            (missing.length > 0 ||
              (triggerType === 'manual_invite' && !m.requiresOperatorApproval))
          const unclaimed =
            unclaimedColumnsPerRow.find((u) => u.id === m.id)?.columns ?? []

          return (
            <li
              key={m.id}
              className="border-b border-stone-light/40 pb-4 last:border-b-0 last:pb-0"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium text-ink">
                  {m.name}
                  {!m.isActive && (
                    <span className="ml-2 text-[10px] uppercase tracking-wide text-ink-faint">
                      inactive
                      {m.deactivatedAt
                        ? ` · ${new Date(m.deactivatedAt).toLocaleDateString()}`
                        : ''}
                    </span>
                  )}
                </span>
                <span className="text-xs text-ink-faint">{m.type}</span>
              </div>
              {m.description && <p className="mt-1 text-sm text-ink-soft">{m.description}</p>}
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <div>
                  <dt className="text-ink-faint">Qualification</dt>
                  <dd className="text-ink">{m.qualification ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-ink-faint">Reward</dt>
                  <dd className="text-ink">{m.rewardDescription ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-ink-faint">Min state</dt>
                  <dd className="text-ink">{m.minState}</dd>
                </div>
                <div>
                  <dt className="text-ink-faint">Redemption policy</dt>
                  <dd className="text-ink">
                    {m.redemptionPolicy}
                    {m.redemptionWindowDays !== null ? ` · ${m.redemptionWindowDays}d` : ''}
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-faint">Requires approval</dt>
                  <dd className="text-ink">{m.requiresOperatorApproval ? 'Yes' : 'No'}</dd>
                </div>
                <div>
                  <dt className="text-ink-faint italic">Trigger (not yet read by the agent)</dt>
                  <dd className="text-ink">{triggerType ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-ink-faint italic">
                    Expiration rule (not yet read by the agent)
                  </dt>
                  <dd className="text-ink">{m.expirationRule ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-ink-faint italic">Redemption (not editable)</dt>
                  <dd className="text-ink-faint">{JSON.stringify(m.redemption)}</dd>
                </div>
              </dl>
              {showGapWarning && (
                <div className="mt-2 flex items-center gap-1.5 text-xs text-clay">
                  <StatusDot tone="bad" label="readiness gap" />
                  {[
                    missing.length > 0 ? `missing: ${missing.join(', ')}` : null,
                    triggerType === 'manual_invite' && !m.requiresOperatorApproval
                      ? 'manual_invite without requires_operator_approval'
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              )}
              {unclaimed.length > 0 && (
                <p className="mt-2 text-xs text-ink-faint">
                  Unclaimed columns: {unclaimed.join(', ')}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </SectionShell>
  )
}
