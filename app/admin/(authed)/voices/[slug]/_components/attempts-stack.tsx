'use client'

import { useMemo } from 'react'

// Vertical stack of regen attempts. Each card is selectable; the selected
// card carries a clay border and is the row the operator commits.
//
// Pure presentation — state lives in the parent (playground-shell). On
// commit the parent clears the stack; refresh discards everything (no DB
// persistence for attempts).

export interface PlaygroundAttempt {
  attemptId: string
  body: string
  voiceFidelity: number
  generatedAt: Date
}

interface AttemptsStackProps {
  attempts: ReadonlyArray<PlaygroundAttempt>
  selectedAttemptId: string | null
  onSelect: (attemptId: string) => void
}

function formatTime(when: Date): string {
  return when.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function AttemptsStack({
  attempts,
  selectedAttemptId,
  onSelect,
}: AttemptsStackProps) {
  const total = attempts.length

  const items = useMemo(() => {
    return attempts.map((a, idx) => ({
      ...a,
      number: idx + 1,
      isSelected: a.attemptId === selectedAttemptId,
    }))
  }, [attempts, selectedAttemptId])

  if (total === 0) return null

  return (
    <div className="flex flex-col gap-1.5">
      {items.map((a) => (
        <button
          key={a.attemptId}
          type="button"
          onClick={() => onSelect(a.attemptId)}
          className={`text-left bg-paper rounded-[4px] px-3.5 py-2.5 flex flex-col gap-1 transition-colors ${
            a.isSelected
              ? 'border border-clay shadow-[0_0_0_1px_var(--clay)] bg-clay-soft/[0.04]'
              : 'border border-stone-light/60 hover:border-stone-dark'
          }`}
        >
          <div className="flex items-baseline justify-between">
            <span
              className={`text-[9.5px] uppercase font-semibold tracking-eyebrow ${
                a.isSelected ? 'text-clay' : 'text-ink-faint'
              }`}
            >
              Attempt {a.number}
              {a.isSelected ? ' · selected' : ''}
            </span>
            <span className="text-[10.5px] text-ink-faint tabular-nums">
              {formatTime(a.generatedAt)} · {a.voiceFidelity.toFixed(2)}
            </span>
          </div>
          <div className="text-[13px] text-ink leading-snug">{a.body}</div>
        </button>
      ))}
    </div>
  )
}
