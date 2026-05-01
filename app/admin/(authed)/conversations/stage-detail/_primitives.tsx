'use client'

import { useState } from 'react'

// Shared building blocks for stage detail components. Co-located in
// stage-detail/ since they're tightly coupled to the drill-down visual
// language (clay left rule, white wash, eyebrow sub-section toggles).
// Not surfaced from lib/ui/ — these are not reusable primitives outside
// the conversations trace surface.

// ---------------------------------------------------------------------------
// DetailBlock — the container with the 2px clay left rule that visually
// anchors the expanded row. Slightly stronger white wash than the row above
// it. Right-side rounding only since the left edge is the rule.

export function DetailBlock({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="border-l-2 border-clay bg-white/45 rounded-r px-[13px] py-[9px] my-1 ml-[14px] flex flex-col gap-2"
    >
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// HairlineDivider — 0.5px stone-light separator between sub-sections and
// before the trailing "Open in Langfuse Cloud" link.

export function HairlineDivider() {
  return <div className="h-px bg-stone-light/60" aria-hidden />
}

// ---------------------------------------------------------------------------
// KvList + KvRow — 2-col grid for label/value pairs. Label column ~150px;
// value column 1fr. Long values (UUIDs etc.) get truncated with ellipsis +
// a `title` for the full string on hover.

export function KvList({ children }: { children: React.ReactNode }) {
  return (
    <dl className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-1 text-sm">
      {children}
    </dl>
  )
}

interface KvRowProps {
  label: string
  /** Render as-is unless `truncate` is set — then wrap in a truncating span with title. */
  value: React.ReactNode
  /** Truncate the value with ellipsis; full string surfaces on hover via title. */
  truncate?: boolean
}

export function KvRow({ label, value, truncate = false }: KvRowProps) {
  return (
    <>
      <dt className="text-ink-faint font-medium">{label}</dt>
      <dd className="text-ink tabular-nums break-words min-w-0">
        {truncate ? (
          <span
            className="block truncate"
            title={typeof value === 'string' || typeof value === 'number' ? String(value) : undefined}
          >
            {value}
          </span>
        ) : (
          value
        )}
      </dd>
    </>
  )
}

// ---------------------------------------------------------------------------
// SubSection — clickable eyebrow header + indented content body. State is
// per-instance; multiple sub-sections can be open simultaneously.

interface SubSectionProps {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}

export function SubSection({ title, defaultOpen = true, children }: SubSectionProps) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-[11px] uppercase font-medium tracking-[var(--tracking-eyebrow)] cursor-pointer hover:text-clay transition-colors"
        aria-expanded={open}
      >
        <span className={open ? 'text-clay' : 'text-ink-faint'}>
          {open ? '▾' : '▸'}
        </span>
        <span className={open ? 'text-clay' : 'text-ink-faint'}>{title}</span>
      </button>
      {open ? <div className="pl-4 flex flex-col gap-2">{children}</div> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// LongText — preview ~200 chars + show-full toggle. Expanded state shows
// the full string in a scrollable monospace container. Inline (no modal)
// to preserve linear reading flow.

interface LongTextProps {
  text: string
  previewChars?: number
}

export function LongText({ text, previewChars = 200 }: LongTextProps) {
  const [expanded, setExpanded] = useState(false)
  if (text.length <= previewChars) {
    return (
      <pre className="font-fraunces-text text-sm whitespace-pre-wrap break-words bg-paper/70 border border-stone-light/60 rounded p-2">
        {text}
      </pre>
    )
  }
  if (!expanded) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-sm text-ink whitespace-pre-wrap break-words">
          {text.slice(0, previewChars)}…
        </span>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="self-start text-xs text-ink-soft hover:text-clay underline cursor-pointer"
        >
          show full ({text.length.toLocaleString()} chars)
        </button>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words bg-paper/70 border border-stone-light/60 rounded p-2 max-h-80 overflow-y-auto">
        {text}
      </pre>
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="self-start text-xs text-ink-soft hover:text-clay underline cursor-pointer"
      >
        show less
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers for safe span output extraction. Span outputs are typed as `any`
// (it's all jsonb on the wire); these centralize the unwrapping so per-stage
// components stay declarative.

export function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function readContent(output: unknown): Record<string, unknown> | null {
  const out = readRecord(output)
  if (!out) return null
  return readRecord(out.content)
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
