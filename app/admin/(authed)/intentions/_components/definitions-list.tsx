import type { ReactNode } from 'react'
import { INTENTION_DEFINITIONS } from '@/lib/agent/intentions/definitions'
import { Eyebrow } from '@/lib/ui'
import { formatArmsOn, formatExpiryWindow, formatGate } from '../_lib/definition-display'

// TAC-379. Renders INTENTION_DEFINITIONS directly — never a copy. A hardcoded
// duplicate of `promptLine` here would misreport what the model actually
// reads, which is the one thing this surface must not do. There is a
// source-level test (no-copied-strings.test.ts) that fails if any definition
// string is pasted into these files as a literal.

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Eyebrow>{label}</Eyebrow>
      {children}
    </div>
  )
}

export function DefinitionsList() {
  return (
    <div className="flex flex-col">
      {INTENTION_DEFINITIONS.map((def, i) => {
        const last = i === INTENTION_DEFINITIONS.length - 1
        return (
          <article
            key={def.key}
            className={`flex flex-col gap-5 py-6 ${i === 0 ? 'pt-0' : ''} ${
              last ? 'pb-0' : 'border-b border-stone-light/60'
            }`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <code className="text-sm text-ink font-medium">{def.key}</code>
              <span className="text-xs text-ink-faint tabular-nums">
                priority {def.priority} · open for {formatExpiryWindow(def.expiresAfterMs)} after it
                becomes eligible
              </span>
            </div>

            {/* The literal string the model reads. Set apart from the
                surrounding description so it never reads as a paraphrase. */}
            <Field label="Prompt line">
              <p className="text-sm text-ink leading-relaxed bg-parchment border border-stone-light/60 rounded-[2px] px-3 py-2">
                {def.promptLine}
              </p>
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Becomes eligible on">
                <p className="text-sm text-ink-soft leading-snug">{formatArmsOn(def.armsOn)}</p>
              </Field>
              <Field label="Gate">
                <p className="text-sm text-ink-soft leading-snug">{formatGate(def.gate)}</p>
              </Field>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Closes when">
                <p className="text-sm text-ink-soft leading-snug">{def.satisfactionLabel}</p>
              </Field>
              <Field label="Post-send classifier looks for">
                <p className="text-sm text-ink-soft leading-snug">{def.classifierDescription}</p>
              </Field>
            </div>
          </article>
        )
      })}
    </div>
  )
}
