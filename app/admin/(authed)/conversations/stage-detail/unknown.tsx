'use client'

import type { TraceStage } from '../lib/select-trace-stages'
import { KvList, KvRow, SubSection, readRecord } from './_primitives'

// Fallback for stages whose name doesn't match any known per-stage component.
// Renders all primitive output fields as KVs and packs the rest under a
// CAPTURED CONTENT toggle. Used both for truly unknown stages (forward-compat
// for new stage names) and for the "Other" bucket on TracePanel.

export function UnknownStageDetail({ stage }: { stage: TraceStage }) {
  const output = readRecord(stage.observation.output)
  const headlineFields: Array<[string, unknown]> = []
  let nested: Record<string, unknown> | null = null
  if (output) {
    for (const [k, v] of Object.entries(output)) {
      if (k === 'content') {
        const c = readRecord(v)
        if (c) nested = c
        continue
      }
      if (isPrimitive(v)) {
        headlineFields.push([k, v])
      } else {
        if (!nested) nested = {}
        nested[k] = v
      }
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      {headlineFields.length > 0 ? (
        <KvList>
          {headlineFields.map(([k, v]) => (
            <KvRow key={k} label={k} value={formatScalar(v)} />
          ))}
        </KvList>
      ) : null}

      {nested && Object.keys(nested).length > 0 ? (
        <SubSection title="Captured content" defaultOpen>
          <pre className="font-mono text-xs whitespace-pre-wrap break-words bg-paper/70 border border-stone-light/60 rounded p-2 max-h-80 overflow-y-auto">
            {JSON.stringify(nested, null, 2)}
          </pre>
        </SubSection>
      ) : null}
    </div>
  )
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
