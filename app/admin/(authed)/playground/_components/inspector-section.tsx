'use client'

import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { CopyButton } from '@/app/admin/_components/copy-button'

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

/**
 * Monospace block for exact prompt text. Preserves whitespace verbatim, and
 * carries a copy button because reading a composed block is only half of what
 * anyone does with it - the other half is pasting it somewhere to diff.
 *
 * A BUTTON, not a click-anywhere block. Clicking the `<pre>` itself would
 * fight text selection, and selecting one paragraph out of a 17,000-character
 * venue block is worth keeping.
 *
 * Copies `text`, never the '(empty)' placeholder, and the button is hidden
 * outright when there is nothing to copy - a copy button that puts the string
 * "(empty)" on the clipboard is worse than no button.
 */
export function MonoBlock({ text }: { text: string }) {
  return (
    <div className="group relative">
      <pre className="whitespace-pre-wrap break-words rounded-[2px] border border-stone-light/60 bg-parchment/40 p-2 pr-14 font-mono text-[11px] leading-[1.5] text-ink">
        {text.length > 0 ? text : '(empty)'}
      </pre>
      {/* Hidden when there is nothing to copy: a button that puts the literal
          string "(empty)" on the clipboard is worse than no button. Focusable
          always and revealed on focus as well as hover, because a control that
          exists only on hover is unreachable by keyboard. */}
      {text.length > 0 && (
        <CopyButton
          text={text}
          className="absolute right-1 top-1 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
        />
      )}
    </div>
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
