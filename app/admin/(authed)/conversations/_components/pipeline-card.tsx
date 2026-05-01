'use client'

import { useState } from 'react'
import { Eyebrow } from '@/lib/ui'
import type { TraceStage } from '../lib/select-trace-stages'
import { TraceStageCard } from './trace-stage-card'

// Pipeline card: one row per stage in canonical pipeline order, each with a
// duration-proportional bar. The dominator (longest stage, typically `send`)
// gets the clay bar; other stages get a muted stone bar. Bar width is
// `stage.duration / totalDuration` so the operator sees "where did the time
// go" at a glance.
//
// Each row is independently expandable. Multiple rows can be open at the
// same time (operator workflow involves comparing data across stages).
// Expanded row renders the existing `<TraceStageCard>` body in chromeless
// mode below the row — transitional state until PR-3 replaces it with a
// per-stage dispatcher.

// Display-rename map. Identifier stays underscore (matches agent-side spans
// + Langfuse traces); UI shows dot notation per the PR-2 decision. Only
// `context_build` needs the rename; other stage names already match.
const STAGE_DISPLAY_NAME: Record<string, string> = {
  context_build: 'context.build',
}

interface PipelineCardProps {
  stages: TraceStage[]
}

export function PipelineCard({ stages }: PipelineCardProps) {
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
    <section className="bg-parchment border border-stone-light/60 rounded-md p-3 flex flex-col gap-3">
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
          />
        ))}
      </div>
    </section>
  )
}

interface PipelineRowProps {
  stage: TraceStage
  durationMs: number | null
  isDominator: boolean
  totalMs: number
}

function PipelineRow({ stage, durationMs, isDominator, totalMs }: PipelineRowProps) {
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
        className="w-full flex items-center gap-3 text-left cursor-pointer"
        aria-expanded={open}
      >
        <span className="text-ink-faint text-xs w-3 shrink-0">
          {open ? '▼' : '▶'}
        </span>
        <span className="text-sm text-ink-soft w-[100px] shrink-0 truncate">
          {displayName}
        </span>
        <div className="flex-1 h-2 rounded-full bg-stone-light/60 relative overflow-hidden">
          <div
            className={`absolute inset-y-0 left-0 ${barColor}`}
            style={{ width: `${widthPct}%` }}
            aria-hidden
          />
        </div>
        <span className="text-xs text-ink-soft tabular-nums w-[60px] text-right shrink-0">
          {durationMs !== null ? formatDuration(durationMs) : '—'}
        </span>
      </button>

      {open ? (
        // Indent matches the chevron + name columns above so the expanded
        // body lines up with the bar's left edge. Subtle bg shift signals
        // "this is the open state" without competing with the row.
        <div className="pl-7 pr-1 pb-1">
          <TraceStageCard stage={stage} chromeless />
        </div>
      ) : null}
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
