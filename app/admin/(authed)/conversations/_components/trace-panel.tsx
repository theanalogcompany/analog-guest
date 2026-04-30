'use client'

import { Eyebrow } from '@/lib/ui'
import type { ApiTraceWithFullDetails } from '@/lib/observability'
import { selectTraceStages } from '../lib/select-trace-stages'
import { TraceStageCard } from './trace-stage-card'

// Renders a single trace as a top-down linear stage stack: root header,
// then context_build → classify → retrieve → generate → send (with attempts
// nested), then any unrecognized stages under "Other". The shape is fixed
// because the agent pipeline is fixed; tracing UIs that try to be generic
// across arbitrary code (Langfuse Cloud's UI included) do worse on this
// shape than something tailored.

interface TracePanelProps {
  trace: ApiTraceWithFullDetails | null
  loading: boolean
  langfuseTraceId: string | null
}

export function TracePanel({ trace, loading, langfuseTraceId }: TracePanelProps) {
  if (loading) {
    return (
      <PanelChrome>
        <div className="text-sm text-ink-soft">Loading trace…</div>
      </PanelChrome>
    )
  }
  if (!langfuseTraceId) {
    return (
      <PanelChrome>
        <div className="text-sm text-ink-soft">
          No trace recorded for this message. The message either pre-dates trace
          instrumentation or the venue runs with content capture disabled.
        </div>
      </PanelChrome>
    )
  }
  if (!trace) {
    return (
      <PanelChrome>
        <div className="text-sm text-ink-soft">
          Trace ID set on this message but Langfuse returned no trace. Could be a
          fetch failure, or the trace hasn&apos;t flushed yet.
        </div>
      </PanelChrome>
    )
  }

  const { rootName, stages, other } = selectTraceStages(trace)
  const subtitle = `${stages.length} stage${stages.length === 1 ? '' : 's'} · ${formatLatency(trace.latency)}`

  return (
    <PanelChrome>
      {/* Compact header: Eyebrow + Fraunces rootName + metadata on one
          baseline-aligned row. SectionHeader (Fraunces text-3xl + hairline
          border + pb-4) was too dominant for a side panel and ate ~3rem of
          vertical space we'd rather hand to stage cards. */}
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3 min-w-0">
          <Eyebrow>Trace</Eyebrow>
          <span
            className="font-fraunces text-base text-ink leading-tight truncate"
            style={{ fontVariationSettings: 'var(--fraunces)' }}
          >
            {rootName}
          </span>
        </div>
        <span className="text-xs text-ink-soft tabular-nums whitespace-nowrap">
          {subtitle}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {stages.map((stage) => (
          <TraceStageCard key={stage.observation.id} stage={stage} />
        ))}
        {other.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Eyebrow>Other</Eyebrow>
            {other.map((obs) => (
              <TraceStageCard
                key={obs.id}
                stage={{ name: obs.name ?? '(unnamed)', observation: obs }}
                defaultOpen={false}
              />
            ))}
          </div>
        ) : null}
      </div>

      {trace.htmlPath ? (
        <a
          href={`https://us.cloud.langfuse.com${trace.htmlPath}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-ink-soft hover:text-clay underline self-start"
        >
          Open in Langfuse Cloud ↗
        </a>
      ) : null}
    </PanelChrome>
  )
}

function PanelChrome({ children }: { children: React.ReactNode }) {
  return (
    <aside className="w-full flex flex-col gap-3 p-4 bg-paper/50 border-l border-stone-light/60 overflow-y-auto">
      {children}
    </aside>
  )
}

function formatLatency(seconds: number | undefined): string {
  if (seconds === undefined || Number.isNaN(seconds)) return '—'
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`
  return `${seconds.toFixed(2)}s`
}
