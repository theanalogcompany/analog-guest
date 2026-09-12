import type { ReadinessReport } from '../../_lib/readiness'
import { StatusDot } from '@/lib/ui'
import { SectionShell } from './section-shell'

function ThresholdRow({
  label,
  count,
  threshold,
  met,
  extra,
}: {
  label: string
  count: number
  threshold: number
  met: boolean
  extra?: string
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-stone-light/40 py-2 last:border-b-0">
      <span className="flex items-center gap-2 text-sm text-ink">
        <StatusDot tone={met ? 'good' : 'neutral'} label={met ? 'met' : 'below threshold'} />
        {label}
      </span>
      <span className="text-xs tabular-nums text-ink-faint">
        {count} / {threshold}
        {extra ? ` · ${extra}` : ''}
      </span>
    </div>
  )
}

export function ReadinessPanel({ readiness }: { readiness: ReadinessReport }) {
  const { voiceCorpus, knowledge, mechanics, currentContext, brandPersona, approvalPolicy } =
    readiness
  const unpopulatedPersonaFields = brandPersona.fields.filter((f) => !f.populated)

  return (
    <SectionShell title="Readiness" subtitle="derived live — nothing here is stored">
      <div className="flex flex-col gap-4">
        <div>
          <ThresholdRow label="Voice corpus candidates" count={voiceCorpus.count} threshold={voiceCorpus.threshold} met={voiceCorpus.met} />
          <ThresholdRow
            label="Knowledge chunks"
            count={knowledge.processedCount}
            threshold={knowledge.threshold}
            met={knowledge.met}
            extra={knowledge.unprocessedCount > 0 ? `${knowledge.unprocessedCount} not retrievable` : undefined}
          />
          <ThresholdRow
            label="currentContext entries with a date"
            count={currentContext.datedCount}
            threshold={currentContext.threshold}
            met={currentContext.met}
          />
        </div>

        {knowledge.byPrimaryTag.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs uppercase tracking-wide text-ink-faint">
              Knowledge by tag
            </p>
            <div className="flex flex-wrap gap-1.5">
              {knowledge.byPrimaryTag.map(({ tag, count }) => (
                <span
                  key={tag}
                  className="rounded-[2px] bg-highlight px-1.5 py-0.5 text-xs text-ink-soft"
                >
                  {tag} · {count}
                </span>
              ))}
            </div>
          </div>
        )}

        <div>
          <p className="mb-1.5 text-xs uppercase tracking-wide text-ink-faint">
            Mechanics · {mechanics.activeCount} active
            {mechanics.inactiveCount > 0 ? `, ${mechanics.inactiveCount} inactive` : ''}
          </p>
          {mechanics.issues.length === 0 && mechanics.manualInviteWithoutApproval.length === 0 ? (
            <p className="text-sm text-ink-soft">Every active mechanic is fully parameterized.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm text-clay">
              {mechanics.issues.map((issue) => (
                <li key={issue.id} className="flex items-center gap-1.5">
                  <StatusDot tone="bad" label="missing params" />
                  {issue.name}: missing {issue.missingFields.join(', ')}
                </li>
              ))}
              {mechanics.manualInviteWithoutApproval.map((w) => (
                <li key={w.id} className="flex items-center gap-1.5">
                  <StatusDot tone="bad" label="manual_invite gap" />
                  {w.name}: manual_invite without requires_operator_approval
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <p className="mb-1.5 text-xs uppercase tracking-wide text-ink-faint">brand_persona</p>
          {unpopulatedPersonaFields.length === 0 ? (
            <p className="text-sm text-ink-soft">Every field is populated.</p>
          ) : (
            <p className="text-sm text-ink-soft">
              Empty: {unpopulatedPersonaFields.map((f) => f.field).join(', ')}
              {' — edit on '}
              <span className="text-clay">Voices</span>.
            </p>
          )}
        </div>

        <div>
          <p className="mb-1.5 text-xs uppercase tracking-wide text-ink-faint">
            approval_policy
          </p>
          <p className="text-sm text-ink-soft">
            Default: {approvalPolicy.default}
            {Object.entries(approvalPolicy.perCategory).length > 0 && (
              <>
                {' · '}
                {Object.entries(approvalPolicy.perCategory)
                  .map(([category, disposition]) => `${category}: ${disposition}`)
                  .join(', ')}
              </>
            )}
          </p>
          <p className="mt-1 text-xs text-ink-faint">
            Effective policy, code defaults included. Edit in the Approval policy section.
          </p>
        </div>
      </div>
    </SectionShell>
  )
}
