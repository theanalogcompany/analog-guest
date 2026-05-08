'use client'

import { useState } from 'react'
import type { BrandPersona } from '@/lib/schemas'
import { UNIVERSAL_RULES_DISPLAY } from '../_lib/universal-rules'
import { SourcePill } from './source-pill'

interface RailRulesProps {
  venueId: string
  persona: BrandPersona
  onMutate: () => void
}

function formatAddedAt(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return '—'
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return '—'
  const diffMs = now.getTime() - t.getTime()
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 8) return `${weeks}w`
  const months = Math.floor(days / 30)
  return `${months}mo`
}

export function RailRules({ venueId, persona, onMutate }: RailRulesProps) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    const trimmed = draft.trim()
    if (trimmed.length === 0) {
      setError('Rule cannot be empty')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/admin/voices/api/venues/${venueId}/rules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ruleText: trimmed }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) || (j.error as string) || 'Add failed')
        return
      }
      setDraft('')
      setAdding(false)
      onMutate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Add failed')
    } finally {
      setBusy(false)
    }
  }

  async function remove(ruleText: string) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/admin/voices/api/venues/${venueId}/rules`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ruleText }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) || (j.error as string) || 'Remove failed')
        return
      }
      onMutate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Remove failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Venue rules section */}
      <section>
        <header className="flex items-baseline justify-between pb-1.5 mb-2 border-b border-stone-light/60">
          <h3 className="text-[10.5px] uppercase font-semibold tracking-eyebrow text-ink">
            Venue rules · {persona.voiceAntiPatterns.length}
          </h3>
          {!adding && (
            <button
              onClick={() => setAdding(true)}
              className="text-[11px] text-clay font-medium hover:text-clay-deep"
            >
              + Add rule
            </button>
          )}
        </header>

        {adding && (
          <div className="flex flex-col gap-2 py-3 border-b border-stone-light/60">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Concrete rule, in the operator's voice..."
              className="bg-highlight border border-stone-light/60 rounded-[3px] px-2.5 py-2 text-[12.5px] leading-snug text-ink focus:outline-none focus:border-clay focus:bg-paper resize-vertical min-h-[60px]"
              autoFocus
            />
            <div className="flex justify-end gap-3 text-[11px]">
              <button
                onClick={() => {
                  setAdding(false)
                  setDraft('')
                  setError(null)
                }}
                className="text-ink-faint hover:text-ink"
                disabled={busy}
              >
                Cancel
              </button>
              <button
                onClick={submit}
                className="bg-ink text-paper px-3 py-1 rounded-[3px] uppercase font-semibold text-[10.5px] tracking-wider hover:bg-clay-deep disabled:opacity-50"
                disabled={busy}
              >
                {busy ? 'Adding…' : 'Add'}
              </button>
            </div>
          </div>
        )}

        {persona.voiceAntiPatterns.length === 0 && !adding && (
          <p className="text-[12px] text-ink-faint italic">
            No venue rules yet.
          </p>
        )}

        {persona.voiceAntiPatterns.map((rule, idx) => (
          <div
            key={`${rule.text}-${idx}`}
            className="flex flex-col gap-1.5 py-3 border-b border-stone-light/60 last:border-b-0"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="text-[12.5px] text-ink leading-snug flex-1">
                {rule.text}
              </p>
              <button
                onClick={() => remove(rule.text)}
                disabled={busy}
                className="text-[10.5px] text-ink-faint hover:text-clay disabled:opacity-50 shrink-0"
                aria-label="Remove rule"
              >
                ×
              </button>
            </div>
            <div className="flex items-center gap-2 text-[9.5px] uppercase font-semibold tracking-wider text-ink-faint">
              <SourcePill variant={rule.source}>
                {rule.source === 'auto' ? 'Auto' : 'Manual'}
                {rule.addedAt ? ` · ${formatAddedAt(rule.addedAt)}` : ''}
              </SourcePill>
              {rule.source === 'auto' && <span>From critique</span>}
              {rule.source === 'manual' && rule.authorOperatorId && (
                <span title={rule.authorOperatorId}>
                  {rule.authorOperatorId.slice(0, 6)}…
                </span>
              )}
            </div>
          </div>
        ))}
      </section>

      {/* Universal rules — locked */}
      <section>
        <header className="pb-1.5 mb-2 border-b border-stone-light/60">
          <h3 className="text-[10.5px] uppercase font-semibold tracking-eyebrow text-ink">
            Universal · {UNIVERSAL_RULES_DISPLAY.length} (locked)
          </h3>
        </header>
        {UNIVERSAL_RULES_DISPLAY.map((r) => (
          <div
            key={r.id}
            className="flex flex-col gap-1.5 py-3 border-b border-stone-light/60 last:border-b-0"
          >
            <p className="text-[12.5px] text-ink leading-snug">{r.summary}</p>
            <div className="flex items-center gap-2">
              <SourcePill variant="universal">{r.id}</SourcePill>
              <span className="text-[9.5px] uppercase font-semibold tracking-wider text-ink-faint">
                Universal
              </span>
            </div>
          </div>
        ))}
      </section>

      {error && (
        <p className="text-[11px] text-clay-deep border-l-2 border-clay px-2 py-1 bg-clay-soft/15">
          {error}
        </p>
      )}
    </div>
  )
}
