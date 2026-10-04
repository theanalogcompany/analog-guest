'use client'

import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

// Collapsible section chrome for the inspector rail. Local to the playground
// rather than SectionShell: the inspector stacks ten-plus sections in a
// 420px rail, so it needs a denser, collapsed-by-default treatment than the
// page-level card SectionShell provides.

export function InspectorSection({
  title,
  badge,
  defaultOpen = false,
  children,
}: {
  title: string
  /** Rendered on the header row, visible while collapsed (verdicts, scores). */
  badge?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-stone-light/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left cursor-pointer hover:bg-parchment/50"
        aria-expanded={open}
      >
        <ChevronRight
          className={`size-3.5 shrink-0 text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="text-xs font-medium uppercase tracking-wider text-ink-soft">
          {title}
        </span>
        {badge !== undefined && <span className="ml-auto">{badge}</span>}
      </button>
      {open && <div className="px-4 pb-4 pt-1">{children}</div>}
    </div>
  )
}

/** Monospace block for exact prompt text. Preserves whitespace verbatim. */
export function MonoBlock({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words rounded-[2px] border border-stone-light/60 bg-parchment/40 p-2 font-mono text-[11px] leading-[1.5] text-ink">
      {text.length > 0 ? text : '(empty)'}
    </pre>
  )
}

/** Small label: value row used across inspector sections. */
export function KeyValue({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex gap-2 text-xs leading-relaxed">
      <span className="shrink-0 text-ink-faint">{label}</span>
      <span className="min-w-0 break-words text-ink">{children}</span>
    </div>
  )
}
