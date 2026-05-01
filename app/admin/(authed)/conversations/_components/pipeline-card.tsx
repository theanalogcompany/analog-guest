'use client'

import { useState } from 'react'
import { Card, Eyebrow } from '@/lib/ui'
import type { TraceStage } from '../lib/select-trace-stages'
import { StageDetail } from '../stage-detail'

// Pipeline card: one row per stage in canonical pipeline order, each with a
// duration-proportional bar. The dominator (longest stage, typically `send`)
// gets the clay bar; other stages get a muted stone bar. Bar width is
// `stage.duration / totalDuration` so the operator sees "where did the time
// go" at a glance.
//
// Each row is independently expandable. Multiple rows can be open at the
// same time (operator workflow involves comparing data across stages).
// Expanded row renders the per-stage <StageDetail> dispatcher (PR-3) below
// the row, in a clay-left-rule detail block.

// Display-rename map. Identifier stays underscore (matches agent-side spans
// + Langfuse traces); UI shows dot notation per the PR-2 decision. Only
// `context_build` needs the rename; other stage names already match.
const STAGE_DISPLAY_NAME: Record<string, string> = {
  context_build: 'context.build',
}

interface PipelineCardProps {
  stages: TraceStage[]
  /** Full URL to the trace in Langfuse Cloud. Pre-computed in TracePanel. */
  langfuseUrl: string | null
}

export function PipelineCard({ stages, langfuseUrl }: PipelineCardProps) {
  const rows = stages.map((stage) => ({
    stage,
    durationMs: computeLatencyMs(stage.observation),
  }))
  const totalMs = rows.reduce((acc, r) => acc + (r.durationMs ?? 0), 0)
  // Dominator = the row with the longest duration. Multiple stages tied at
  // the max would all highlight; in practice `send` dominates by an order
  // of magnitude due to human-feel sleep.
  const maxMs = rows.reduce((acc, r) => Math.max(acc, r.durationMs ?? 0), 0)

  return (
    <Card variant="trace" className="p-3 flex flex-col gap-3">
      <header className="flex items-baseline justify-between gap-3">
        <Eyebrow>Pipeline</Eyebrow>
        <span className="text-xs text-ink-soft tabular-nums">{formatDuration(totalMs)}</span>
      </header>
      <div className="flex flex-col gap-1.5">
        {rows.map(({ stage, durationMs }) => (
          <PipelineRow
            key={stage.observation.id}
            stage={stage}
            durationMs={durationMs}
            isDominator={
              durationMs !== null && durationMs > 0 && durationMs === maxMs
            }
            totalMs={totalMs}
            langfuseUrl={langfuseUrl}
          />
        ))}
      </div>
    </Card>
  )
}

interface PipelineRowProps {
  stage: TraceStage
  durationMs: number | null
  isDominator: boolean
  totalMs: number
  langfuseUrl: string | null
}

function PipelineRow({
  stage,
  durationMs,
  isDominator,
  totalMs,
  langfuseUrl,
}: PipelineRowProps) {
  const [open, setOpen] = useState(false)
  const widthPct =
    totalMs > 0 && durationMs !== null ? (durationMs / totalMs) * 100 : 0
  const displayName = STAGE_DISPLAY_NAME[stage.name] ?? stage.name
  const barColor = isDominator ? 'bg-clay' : 'bg-stone'

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        // Open state: subtle white wash background, slight font-weight bump
        // on label + duration, clay chevron + clay name text. The wash
        // (bg-white/35) is just enough to anchor "this row is the open
        // one" without competing with the bar's clay highlight.
        className={[
          'w-full flex items-center gap-3 text-left cursor-pointer rounded',
          'px-1.5 py-0.5 -mx-1.5 -my-0.5',  // Hit area expansion + bg padding without affecting layout
          open ? 'bg-white/35' : '',
        ].join(' ')}
        aria-expanded={open}
      >
        <span className={`text-xs w-3 shrink-0 ${open ? 'text-clay' : 'text-ink-faint'}`}>
          {open ? '▾' : '▸'}
        </span>
        <span
          className={[
            'text-sm w-[100px] shrink-0 truncate',
            open ? 'text-ink font-medium' : 'text-ink-soft',
          ].join(' ')}
        >
          {displayName}
        </span>
        <div className="flex-1 h-2 rounded-full bg-stone-light/60 relative overflow-hidden">
          <div
            className={`absolute inset-y-0 left-0 ${barColor}`}
            style={{ width: `${widthPct}%` }}
            aria-hidden
          />
        </div>
        <span
          className={[
            'text-xs tabular-nums w-[60px] text-right shrink-0',
            open ? 'text-ink font-medium' : 'text-ink-soft',
          ].join(' ')}
        >
          {durationMs !== null ? formatDuration(durationMs) : '—'}
        </span>
      </button>

      {open ? <StageDetail stage={stage} langfuseUrl={langfuseUrl} /> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------

function computeLatencyMs(obs: TraceStage['observation']): number | null {
  if (!obs.endTime || !obs.startTime) return null
  const start = new Date(obs.startTime).getTime()
  const end = new Date(obs.endTime).getTime()
  if (Number.isNaN(start) || Number.isNaN(end)) return null
  return Math.max(0, end - start)
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
