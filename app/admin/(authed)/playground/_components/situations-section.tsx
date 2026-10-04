'use client'

import type { TurnTrace } from '@/lib/relationship/run-turn'
import { KeyValue } from './inspector-section'

// Situations panel: the inbound detection that feeds the gate's
// situation-scoped policies (lib/policy/detect-situations.ts). Runs
// alongside generation, so it sits between the brief and the gate in the
// inspector's pipeline order. Detected keys render highlighted; the raw
// unthresholded probabilities render for every situation, because threshold
// tuning reads recorded numbers, not re-inference (the semantic-check rule).
//
// Detection FAILS OPEN to no situations (that module's header): the error
// state here says so, because "no situations detected" and "detection did
// not run" must not read the same.

export function SituationsBadge({
  situations,
}: {
  situations: TurnTrace['situations']
}) {
  if (situations === null)
    return <span className="text-[11px] text-ink-faint">not run</span>
  if (!situations.ok)
    return <span className="text-[11px] text-destructive">failed open</span>
  if (situations.detected.length === 0)
    return <span className="text-[11px] text-ink-faint">none</span>
  return (
    <span className="flex gap-1">
      {situations.detected.map((key) => (
        <DetectedPill key={key} label={key} />
      ))}
    </span>
  )
}

function DetectedPill({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-[2px] bg-clay-soft/50 px-1.5 py-0.5 text-[11px] font-medium text-clay-deep">
      {label}
    </span>
  )
}

export function SituationsSection({
  situations,
}: {
  situations: TurnTrace['situations']
}) {
  // Unlike gate/judge/assessor, detection runs alongside generation and is
  // on the trace even when generation fails - null only on a trace shape
  // this build has not seen.
  if (situations === null) {
    return (
      <p className="text-xs italic text-ink-faint">Detection did not run.</p>
    )
  }

  if (!situations.ok) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-xs text-destructive">
          {situations.error} ({situations.errorCode})
        </p>
        <p className="text-xs italic text-ink-faint">
          Fails open: the gate saw no situations this turn, so situation-scoped
          policies did not fire.
        </p>
        <KeyValue label="duration">
          <span className="tabular-nums">{situations.durationMs}ms</span>
        </KeyValue>
      </div>
    )
  }

  const detected = new Set<string>(situations.detected)
  return (
    <div className="flex flex-col gap-2">
      {situations.detected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {situations.detected.map((key) => (
            <DetectedPill key={key} label={key} />
          ))}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-ink-faint">
          Raw probabilities
        </span>
        {Object.entries(situations.probabilities).map(([key, p]) => (
          <KeyValue key={key} label={key}>
            <span className="tabular-nums">{p.toFixed(3)}</span>
            {detected.has(key) && (
              <span className="text-clay-deep"> · detected</span>
            )}
          </KeyValue>
        ))}
      </div>
      <KeyValue label="duration">
        <span className="tabular-nums">{situations.durationMs}ms</span>
      </KeyValue>
      <KeyValue label="version">{situations.version}</KeyValue>
    </div>
  )
}
