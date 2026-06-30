'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'

// Commit modal. Opens when the operator clicks "Commit" on a selected
// regen attempt. Three async stages stack:
//   1. on mount: POST /classify-critique → render the auto-classified
//      kind + ruleText as advisory
//   2. operator overrides kind / ruleText / saveToCorpus inline
//   3. on confirm: parent fires POST /commit; modal calls onCommitted
//      (or onError) and closes
//
// Built on shadcn Dialog (TAC-306). The parent (PlaygroundShell) mounts this
// only while open, so `open` is fixed true; every dismissal (X / Escape /
// outside-click) routes to onCancel — and is suppressed while `busy` so a
// commit can't be torn down mid-flight. The classify-critique + commit fetch
// paths are unchanged.

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
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onCancel()
      }}
    >
      <DialogContent
        className="max-w-xl max-h-[85vh] overflow-y-auto gap-4"
        onInteractOutside={(e) => {
          if (busy) e.preventDefault()
        }}
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="font-fraunces font-fraunces-display italic text-2xl text-ink leading-none">
            Commit to voice
          </DialogTitle>
          <DialogDescription className="sr-only">
            Review the selected response, choose whether to add a rule, and commit it to this venue&apos;s voice.
          </DialogDescription>
        </DialogHeader>

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

          <RadioGroup
            value={kind}
            onValueChange={(v) => setKind(v as 'edit_only' | 'edit_and_rule')}
            className="flex gap-3 text-[12px]"
          >
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <RadioGroupItem value="edit_only" />
              edit only
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <RadioGroupItem value="edit_and_rule" />
              edit + rule
            </label>
          </RadioGroup>

          {kind === 'edit_and_rule' && (
            <Textarea
              value={ruleText}
              onChange={(e) => setRuleText(e.target.value)}
              placeholder="Synthesized rule — operator can override..."
              className="bg-paper border-0 border-l-2 border-clay rounded-r-[3px] rounded-l-none px-2.5 py-2 text-[13px] leading-snug text-ink italic font-fraunces font-fraunces-text resize-vertical min-h-[60px]"
            />
          )}
        </div>

        <div className="flex gap-4 text-[12px] text-ink-soft flex-wrap pt-1">
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <Checkbox
              checked={saveToCorpus}
              onCheckedChange={(c) => setSaveToCorpus(c === true)}
            />
            Add corrected response to corpus
          </label>
        </div>

        {error && (
          <p className="text-[11px] text-clay-deep border-l-2 border-clay px-2 py-1 bg-clay-soft/15">
            {error}
          </p>
        )}

        <DialogFooter className="border-t border-stone-light/60 pt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={busy}
            className="text-ink-faint hover:text-ink"
          >
            Cancel
          </Button>
          <Button
            onClick={confirm}
            disabled={
              busy ||
              (kind === 'edit_and_rule' && ruleText.trim().length === 0)
            }
            size="sm"
            className="hover:bg-clay-deep uppercase text-[10.5px] tracking-wider"
          >
            {busy ? 'Committing…' : 'Commit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
