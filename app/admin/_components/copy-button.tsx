'use client'

import { useEffect, useRef, useState } from 'react'
import { Copy } from 'lucide-react'

// The one copy-to-clipboard control for admin. There was no clipboard helper
// anywhere in this app before it, and it is needed by both the inspector's
// prompt blocks and the playground's chat bubbles - two hand-rolled copies
// would drift on the failure path first, which is the half nobody tests.
//
// Text, not a checkmark, for the copied state: app/admin/CLAUDE.md rules out
// checkmarks and routes status through <StatusDot>.

const RESET_MS = 1500

export function CopyButton({
  text,
  className = '',
  label = 'Copy to clipboard',
}: {
  text: string
  /** Positioning and any surface tweak. Chrome and sizing live here. */
  className?: string
  label?: string
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Without this, the reset fires after the pane swaps turns and sets state
  // on an unmounted button.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )

  const copy = async (): Promise<void> => {
    // navigator.clipboard is undefined outside a secure context. localhost
    // and the https admin host both qualify, so this is the "opened over
    // plain http" path - it must SAY so rather than no-op, because a button
    // that silently does nothing reads as a broken page.
    try {
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch {
      setState('failed')
    }
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), RESET_MS)
  }

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          // The bubble call site nests this beside a button that selects the
          // turn; without this, copying would also re-select it.
          e.stopPropagation()
          void copy()
        }}
        className={`flex cursor-pointer items-center gap-1 rounded-[2px] border border-stone-light/60 bg-paper px-1.5 py-0.5 font-mono text-[10px] text-ink-faint transition-opacity hover:text-ink ${className}`}
        aria-label={label}
      >
        {state === 'idle' ? (
          <Copy className="size-3" aria-hidden />
        ) : (
          <span>{state === 'copied' ? 'copied' : 'copy failed'}</span>
        )}
      </button>
      <span aria-live="polite" className="sr-only">
        {state === 'copied'
          ? 'Copied to clipboard'
          : state === 'failed'
            ? 'Copy failed'
            : ''}
      </span>
    </>
  )
}
