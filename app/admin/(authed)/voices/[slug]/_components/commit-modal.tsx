'use client'

import { useEffect, useState } from 'react'

// Commit modal. Opens when the operator clicks "Commit" on a selected
// regen attempt. Three async stages stack:
//   1. on mount: POST /classify-critique → render the auto-classified
//      kind + ruleText as advisory
//   2. operator overrides kind / ruleText / saveToCorpus inline
//   3. on confirm: parent fires POST /commit; modal calls onCommitted
//      (or onError) and closes
//
// All AI inference is opt-in here — the modal renders cleanly even
// before classification returns.

export interface CommitPayload {
  kind: 'edit_only' | 'edit_and_rule'
  ruleTextOverride?: string
  saveToCorpus: boolean
}

interface CommitModalProps {
  inboundBody: string
  flaggedResponse: string
  selectedResponse: string
  critique: string
  onConfirm: (payload: CommitPayload) => Promise<void>
  onCancel: () => void
}

interface ClassifyResponse {
  success: boolean
  kind?: 'edit_only' | 'edit_and_rule'
  ruleText?: string
  error?: string
  detail?: string
}

export function CommitModal({
  inboundBody,
  flaggedResponse,
  selectedResponse,
  critique,
  onConfirm,
  onCancel,
}: CommitModalProps) {
  const [classifyState, setClassifyState] = useState<
    | { status: 'pending' }
    | { status: 'ready'; suggestion: { kind: 'edit_only' | 'edit_and_rule'; ruleText: string | null } }
    | { status: 'error'; message: string }
  >({ status: 'pending' })

  const [kind, setKind] = useState<'edit_only' | 'edit_and_rule'>('edit_only')
  const [ruleText, setRuleText] = useState('')
  const [saveToCorpus, setSaveToCorpus] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function run() {
      try {
        const res = await fetch('/admin/voices/api/classify-critique', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            critique,
            badResponse: flaggedResponse,
            goodResponse: selectedResponse,
          }),
        })
        const json = (await res.json()) as ClassifyResponse
        if (cancelled) return
        if (!res.ok || !json.success || !json.kind) {
          setClassifyState({
            status: 'error',
            message: json.detail ?? json.error ?? 'classify failed',
          })
          return
        }
        setClassifyState({
          status: 'ready',
          suggestion: { kind: json.kind, ruleText: json.ruleText ?? null },
        })
        setKind(json.kind)
        if (json.ruleText) setRuleText(json.ruleText)
      } catch (e) {
        if (cancelled) return
        setClassifyState({
          status: 'error',
          message: e instanceof Error ? e.message : 'classify failed',
        })
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [critique, flaggedResponse, selectedResponse])

  async function confirm() {
    setError(null)
    setBusy(true)
    try {
      await onConfirm({
        kind,
        ruleTextOverride:
          kind === 'edit_and_rule' ? ruleText.trim() : undefined,
        saveToCorpus,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'commit failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-ink/40 flex items-center justify-center px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel()
      }}
    >
      <div className="bg-paper border border-stone-light/60 rounded-[6px] max-w-xl w-full max-h-[85vh] overflow-y-auto p-6 flex flex-col gap-4">
        <header className="flex items-baseline justify-between pb-3 border-b border-stone-light/60">
          <h2
            className="font-fraunces font-fraunces-display italic text-2xl text-ink leading-none"
          >
            Commit to voice
          </h2>
          <button
            onClick={onCancel}
            disabled={busy}
            className="text-[11px] text-ink-faint hover:text-clay disabled:opacity-50"
          >
            Cancel
          </button>
        </header>

        <div className="flex flex-col gap-1 text-[12.5px] leading-snug">
          <span className="text-[9.5px] uppercase font-semibold tracking-eyebrow text-ink-faint">
            Inbound
          </span>
          <p className="text-ink-soft pb-1.5">{inboundBody}</p>
          <span className="text-[9.5px] uppercase font-semibold tracking-eyebrow text-clay">
            Selected response
          </span>
          <p className="text-ink">{selectedResponse}</p>
        </div>

        <div className="flex flex-col gap-2 px-3 py-2.5 bg-parchment rounded-[3px]">
          <div className="flex items-baseline gap-2 flex-wrap text-[12px]">
            <span className="text-[9.5px] uppercase font-semibold tracking-eyebrow text-ink-faint">
              Auto-classified
            </span>
            {classifyState.status === 'pending' && (
              <span className="text-ink-faint italic">classifying…</span>
            )}
            {classifyState.status === 'ready' && (
              <span className="text-clay-deep font-semibold">
                {classifyState.suggestion.kind === 'edit_and_rule'
                  ? 'Edit + rule'
                  : 'Edit only'}
              </span>
            )}
            {classifyState.status === 'error' && (
              <span className="text-clay-deep">
                classify failed; choose manually
              </span>
            )}
          </div>

          <div className="flex gap-3 text-[12px]">
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="commit-kind"
                checked={kind === 'edit_only'}
                onChange={() => setKind('edit_only')}
              />
              edit only
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="commit-kind"
                checked={kind === 'edit_and_rule'}
                onChange={() => setKind('edit_and_rule')}
              />
              edit + rule
            </label>
          </div>

          {kind === 'edit_and_rule' && (
            <textarea
              value={ruleText}
              onChange={(e) => setRuleText(e.target.value)}
              placeholder="Synthesized rule — operator can override..."
              className="w-full bg-paper border-l-2 border-clay rounded-r-[3px] px-2.5 py-2 text-[13px] leading-snug text-ink italic font-fraunces font-fraunces-text resize-vertical min-h-[60px] focus:outline-none focus:bg-paper"
            />
          )}
        </div>

        <div className="flex gap-4 text-[12px] text-ink-soft flex-wrap pt-1">
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={saveToCorpus}
              onChange={(e) => setSaveToCorpus(e.target.checked)}
            />
            Add corrected response to corpus
          </label>
        </div>

        {error && (
          <p className="text-[11px] text-clay-deep border-l-2 border-clay px-2 py-1 bg-clay-soft/15">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-3 pt-2 border-t border-stone-light/60">
          <button
            onClick={onCancel}
            disabled={busy}
            className="text-[11px] text-ink-faint hover:text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={
              busy ||
              (kind === 'edit_and_rule' && ruleText.trim().length === 0)
            }
            className="bg-clay text-white px-4 py-1.5 rounded-[3px] uppercase font-semibold text-[10.5px] tracking-wider hover:bg-clay-deep disabled:opacity-50"
          >
            {busy ? 'Committing…' : 'Commit'}
          </button>
        </div>
      </div>
    </div>
  )
}
