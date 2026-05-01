'use client'

import { useState } from 'react'
import { Card, Eyebrow } from '@/lib/ui'
import type { TraceObservation, TraceStage } from '../lib/select-trace-stages'

// One stage card in the linear span stack. Two levels of disclosure:
//   1. Click the card header → toggle the whole card open/closed
//   2. When open: each "content block" inside has its own collapse toggle
//
// Stage cards display whatever output / metadata the agent actually wrote.
// The Langfuse observation `output` field carries either THE-200's
// metadata-only shape (counts, scores, IDs) or THE-216's expanded shape
// (where output.content is folded in). We show metadata flat and content
// nested behind sub-toggles so the surface stays scannable.

interface TraceStageCardProps {
  stage: TraceStage
  defaultOpen?: boolean
  /**
   * Skip the outer Card chrome and the toggle button; render only the body
   * (always open). Used by `<PipelineCard>` (PR-2) when the pipeline row
   * owns the toggle and the row itself sits inside its own card. PR-3 will
   * replace this whole component with a per-stage dispatcher.
   */
  chromeless?: boolean
}

export function TraceStageCard({
  stage,
  defaultOpen = true,
  chromeless = false,
}: TraceStageCardProps) {
  const [open, setOpen] = useState(defaultOpen)
  const { observation, attempts } = stage
  const isError = observation.level === 'ERROR'
  const isWarning = observation.level === 'WARNING'
  const latencyMs = computeLatencyMs(observation)

  const { headlineFields, content } = splitOutput(observation.output)

  const body =
    observation.statusMessage ||
    headlineFields.length > 0 ||
    content !== undefined ||
    (observation.input !== undefined && observation.input !== null) ||
    (attempts && attempts.length > 0) ? (
      <div
        className={
          chromeless
            ? 'flex flex-col gap-2.5'
            : 'px-3 pb-3 flex flex-col gap-2.5 border-t border-stone-light/60 pt-2.5'
        }
      >
        {observation.statusMessage ? (
          <div className="text-sm text-clay whitespace-pre-wrap">
            {observation.statusMessage}
          </div>
        ) : null}

        {headlineFields.length > 0 ? <KeyValueList entries={headlineFields} /> : null}

        {content !== undefined ? (
          <CollapsibleBlock heading="Captured content">
            <ContentRender value={content} />
          </CollapsibleBlock>
        ) : null}

        {observation.input !== undefined && observation.input !== null ? (
          <CollapsibleBlock heading="Input" defaultOpen={false}>
            <ContentRender value={observation.input} />
          </CollapsibleBlock>
        ) : null}

        {attempts && attempts.length > 0 ? (
          <CollapsibleBlock heading={`Attempts (${attempts.length})`}>
            <div className="flex flex-col gap-2">
              {attempts.map((a, i) => (
                <AttemptCard key={a.id} attempt={a} index={i + 1} />
              ))}
            </div>
          </CollapsibleBlock>
        ) : null}
      </div>
    ) : null

  if (chromeless) return body

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left cursor-pointer"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-ink-soft text-xs">{open ? '▼' : '▶'}</span>
          <Eyebrow>{stage.name}</Eyebrow>
          {isError ? (
            <span className="text-xs px-2 py-0.5 rounded bg-clay/15 text-clay font-medium">
              ERROR
            </span>
          ) : null}
          {isWarning ? (
            <span className="text-xs px-2 py-0.5 rounded bg-stone-light text-ink font-medium">
              WARNING
            </span>
          ) : null}
        </div>
        {latencyMs !== null ? (
          <span className="text-xs tabular-nums text-ink-soft">{latencyMs}ms</span>
        ) : null}
      </button>

      {open ? body : null}
    </Card>
  )
}

function AttemptCard({ attempt, index }: { attempt: TraceObservation; index: number }) {
  const { headlineFields, content } = splitOutput(attempt.output)
  const isError = attempt.level === 'ERROR'
  return (
    <div className="border border-stone-light/60 rounded p-3 flex flex-col gap-2 bg-paper/50">
      <div className="flex items-center justify-between">
        <Eyebrow>Attempt {index}</Eyebrow>
        {isError ? (
          <span className="text-xs px-2 py-0.5 rounded bg-clay/15 text-clay">ERROR</span>
        ) : null}
      </div>
      {headlineFields.length > 0 ? <KeyValueList entries={headlineFields} /> : null}
      {content !== undefined ? <ContentRender value={content} /> : null}
    </div>
  )
}

function CollapsibleBlock({
  heading,
  defaultOpen = true,
  children,
}: {
  heading: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-xs text-ink-soft uppercase tracking-wider cursor-pointer hover:text-ink"
        aria-expanded={open}
      >
        <span>{open ? '▼' : '▶'}</span>
        <span>{heading}</span>
      </button>
      {open ? <div className="pl-4">{children}</div> : null}
    </div>
  )
}

function KeyValueList({ entries }: { entries: Array<[string, unknown]> }) {
  return (
    <dl className="text-sm grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-soft font-medium">{k}</dt>
          <dd className="text-ink tabular-nums break-words">{formatScalar(v)}</dd>
        </div>
      ))}
    </dl>
  )
}

function ContentRender({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <div className="text-sm text-ink-soft italic">(empty)</div>
  }
  if (typeof value === 'string') {
    return (
      <pre className="text-sm font-fraunces-text bg-paper/70 border border-stone-light/60 rounded p-2 whitespace-pre-wrap break-words">
        {value}
      </pre>
    )
  }
  // Render arrays of objects as a series of grouped sub-blocks (e.g. corpus chunks)
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <div className="text-sm text-ink-soft italic">(empty list)</div>
    }
    return (
      <div className="flex flex-col gap-2">
        {value.map((item, i) => (
          <div key={i} className="border border-stone-light/40 rounded p-2 bg-paper/40">
            <ContentRender value={item} />
          </div>
        ))}
      </div>
    )
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return (
      <dl className="text-sm grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        {entries.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-soft font-medium">{k}</dt>
            <dd className="text-ink tabular-nums break-words">
              {isPrimitive(v) ? formatScalar(v) : <ContentRender value={v} />}
            </dd>
          </div>
        ))}
      </dl>
    )
  }
  return <div className="text-sm">{formatScalar(value)}</div>
}

function isPrimitive(v: unknown): boolean {
  return v === null || v === undefined || typeof v !== 'object'
}

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

// Split an observation's `output` into:
//   - headlineFields: scalar key/value pairs to show flat as the always-visible summary
//   - content: the heavy "content" sub-object (THE-216) shown in a collapsible block
function splitOutput(output: unknown): {
  headlineFields: Array<[string, unknown]>
  content: unknown
} {
  if (output === null || output === undefined || typeof output !== 'object' || Array.isArray(output)) {
    return { headlineFields: [], content: output ?? undefined }
  }
  const headlineFields: Array<[string, unknown]> = []
  let content: unknown
  for (const [k, v] of Object.entries(output as Record<string, unknown>)) {
    if (k === 'content') {
      content = v
      continue
    }
    if (isPrimitive(v) || (Array.isArray(v) && v.every(isPrimitive))) {
      headlineFields.push([k, v])
    } else {
      // Nested objects without a dedicated 'content' key — pack into the
      // content block so the headline stays scannable.
      if (content === undefined) content = {}
      ;(content as Record<string, unknown>)[k] = v
    }
  }
  return { headlineFields, content }
}

function computeLatencyMs(obs: TraceObservation): number | null {
  if (!obs.endTime || !obs.startTime) return null
  const start = new Date(obs.startTime).getTime()
  const end = new Date(obs.endTime).getTime()
  if (Number.isNaN(start) || Number.isNaN(end)) return null
  return Math.max(0, end - start)
}
