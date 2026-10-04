'use client'

import type { TurnTrace } from '@/lib/relationship/run-turn'
import { KeyValue } from './inspector-section'

// Policy gate panel: the dispatch verdict, which policies forced it, and the
// raw per-policy probabilities (unthresholded - semantic-check.ts records
// them precisely so threshold tuning can be a query, and this panel is where
// a human reads them).

const VERDICT_STYLE: Record<'send' | 'queue' | 'block', string> = {
  send: 'bg-[#16A34A]',
  queue: 'bg-[#CA8A04]',
  block: 'bg-[#DC2626]',
}

export function VerdictBadge({
  verdict,
}: {
  verdict: 'send' | 'queue' | 'block'
}) {
  return (
    <span
      className={`inline-flex items-center rounded-[2px] px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-white ${VERDICT_STYLE[verdict]}`}
    >
      {verdict}
    </span>
  )
}

export function GateSection({
  gate,
  semantic,
}: {
  gate: TurnTrace['gate']
  semantic: TurnTrace['semantic']
}) {
  if (gate === null) {
    return (
      <p className="text-xs italic text-ink-faint">
        The gate did not run (generation failed upstream).
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <VerdictBadge verdict={gate.verdict} />
        {gate.semanticCheckError !== undefined && (
          <span className="text-[11px] text-destructive">
            semantic check unavailable
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-ink-faint">
          Matched policies
        </span>
        {gate.matched.length === 0 ? (
          <p className="text-xs italic text-ink-faint">none</p>
        ) : (
          gate.matched.map((m) => <PolicyHit key={m.policyKey} hit={m} />)
        )}
      </div>

      {gate.notifications.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-ink-faint">
            Notify-only hits
          </span>
          {gate.notifications.map((m) => (
            <PolicyHit key={m.policyKey} hit={m} />
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-ink-faint">
          Raw semantic probabilities
        </span>
        {semantic === null ? (
          <p className="text-xs italic text-ink-faint">check did not run</p>
        ) : semantic.ok ? (
          Object.entries(semantic.probabilities).length === 0 ? (
            <p className="text-xs italic text-ink-faint">
              no semantic policies in the set
            </p>
          ) : (
            Object.entries(semantic.probabilities).map(([key, p]) => (
              <KeyValue key={key} label={key}>
                <span className="tabular-nums">{p.toFixed(3)}</span>
              </KeyValue>
            ))
          )
        ) : (
          <p className="text-xs text-destructive">
            {semantic.error} ({semantic.errorCode})
          </p>
        )}
      </div>
    </div>
  )
}

function PolicyHit({
  hit,
}: {
  hit: {
    policyKey: string
    label: string
    then: 'queue' | 'block' | 'notify'
    probability?: number
    checkUnavailable?: boolean
  }
}) {
  return (
    <div className="text-xs text-ink">
      {hit.label}{' '}
      <span className="text-ink-faint">
        ({hit.policyKey} · {hit.then}
        {hit.probability !== undefined && (
          <span className="tabular-nums">
            {' '}
            · p={hit.probability.toFixed(3)}
          </span>
        )}
        {hit.checkUnavailable === true &&
          ' · matched by fail-closed, not a judgment'}
        )
      </span>
    </div>
  )
}
