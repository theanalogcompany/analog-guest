'use client'

import { useState } from 'react'
import type { VoicePageMessage } from '../_lib/load-voice-page'
import { AttemptsStack, type PlaygroundAttempt } from './attempts-stack'
import { CommitModal, type CommitPayload } from './commit-modal'

// Live regen flow. Operator types a critique, fires Regenerate, picks the
// best attempt, commits via the modal. Multi-attempt state lives entirely
// here in React — no DB writes until commit. Refresh discards.
//
// On commit-success the parent's onCommitted callback fires which in
// voices-client triggers router.refresh() (rail counts, last-refined,
// pattern banner all reload from the server). The modal closes and the
// playground clears.

interface PlaygroundShellProps {
  venueId: string
  flaggedPair: {
    inbound: VoicePageMessage
    outbound: VoicePageMessage
  } | null
  /**
   * Called after a successful commit so the parent can router.refresh()
   * + clear the bubble selection. Receives an optional patternCluster
   * payload when the just-committed critique formed a verified cluster.
   */
  onCommitted: (info: {
    patternClusterDetected: boolean
  }) => void
}

interface RegenerateResponse {
  success: boolean
  body?: string
  voiceFidelity?: number
  attempts?: number
  attemptScores?: number[]
  generatedAt?: string
  error?: string
  detail?: string
}

interface CommitResponse {
  success: boolean
  patternCluster?: {
    critiqueIds: string[]
    members: Array<{ id: string; text: string; messageId: string }>
    proposedRuleText: string
  } | null
  error?: string
  detail?: string
}

function makeAttemptId(): string {
  // Cheap unique id — multi-attempt state is local React, never serialized.
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function PlaygroundShell({
  venueId,
  flaggedPair,
  onCommitted,
}: PlaygroundShellProps) {
  const [critique, setCritique] = useState('')
  const [attempts, setAttempts] = useState<PlaygroundAttempt[]>([])
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(null)
  const [regenBusy, setRegenBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [committing, setCommitting] = useState(false)
  const [showCommitModal, setShowCommitModal] = useState(false)

  // Reset everything when the flagged pair changes (new bubble clicked).
  // The voices-client's `key={...}` already remounts on guest change, so
  // this only fires within the same conversation when the operator picks
  // a different outbound. We don't useEffect — derive from the pair id.
  const pairKey = flaggedPair ? flaggedPair.outbound.id : null
  const [activePairKey, setActivePairKey] = useState<string | null>(pairKey)
  if (pairKey !== activePairKey) {
    setActivePairKey(pairKey)
    setCritique('')
    setAttempts([])
    setSelectedAttemptId(null)
    setError(null)
    setShowCommitModal(false)
  }

  async function regenerate() {
    if (!flaggedPair) return
    const trimmed = critique.trim()
    if (trimmed.length === 0) {
      setError('Add a critique before regenerating.')
      return
    }
    setRegenBusy(true)
    setError(null)
    try {
      const res = await fetch('/admin/voices/api/regenerate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          venueId,
          originalMessageId: flaggedPair.outbound.id,
          critique: trimmed,
        }),
      })
      const json = (await res.json()) as RegenerateResponse
      if (!res.ok || !json.success || !json.body) {
        setError(json.detail ?? json.error ?? 'regenerate failed')
        return
      }
      const newAttempt: PlaygroundAttempt = {
        attemptId: makeAttemptId(),
        body: json.body,
        voiceFidelity: json.voiceFidelity ?? 0,
        generatedAt: new Date(json.generatedAt ?? Date.now()),
      }
      setAttempts((prev) => [...prev, newAttempt])
      setSelectedAttemptId(newAttempt.attemptId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'regenerate failed')
    } finally {
      setRegenBusy(false)
    }
  }

  function startCommit() {
    if (!flaggedPair) return
    const selected = attempts.find((a) => a.attemptId === selectedAttemptId)
    if (!selected) {
      setError('Select an attempt before committing.')
      return
    }
    setShowCommitModal(true)
  }

  async function performCommit(payload: CommitPayload) {
    if (!flaggedPair) return
    const selected = attempts.find((a) => a.attemptId === selectedAttemptId)
    if (!selected) {
      throw new Error('No attempt selected')
    }
    setCommitting(true)
    try {
      const res = await fetch('/admin/voices/api/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          venueId,
          originalMessageId: flaggedPair.outbound.id,
          selectedResponse: selected.body,
          critique: critique.trim(),
          kind: payload.kind,
          ruleTextOverride: payload.ruleTextOverride,
          saveToCorpus: payload.saveToCorpus,
        }),
      })
      const json = (await res.json()) as CommitResponse
      if (!res.ok || !json.success) {
        throw new Error(json.detail ?? json.error ?? 'commit failed')
      }
      // Success: clear playground, close modal, ping parent.
      setCritique('')
      setAttempts([])
      setSelectedAttemptId(null)
      setShowCommitModal(false)
      onCommitted({
        patternClusterDetected:
          json.patternCluster !== null && json.patternCluster !== undefined,
      })
    } finally {
      setCommitting(false)
    }
  }

  return (
    <div className="overflow-y-auto px-8 pt-4 pb-6 bg-highlight flex flex-col gap-3">
      <div className="flex items-baseline justify-between pb-2 border-b border-stone-light/60">
        <span className="text-[10px] uppercase font-semibold text-clay tracking-eyebrow">
          ▸ Refining response
        </span>
        <span className="text-[11px] text-ink-faint">
          {flaggedPair
            ? `${attempts.length} ${attempts.length === 1 ? 'attempt' : 'attempts'} · using current rules + corpus`
            : 'Click an agent message above to flag it'}
        </span>
      </div>

      {flaggedPair ? (
        <>
          <div className="bg-paper border-l-2 border-clay rounded-r-[4px] px-3.5 py-3">
            <div className="text-[9.5px] uppercase font-semibold text-ink-faint tracking-eyebrow mb-1">
              Inbound
            </div>
            <div className="text-[13px] text-ink-soft leading-relaxed mb-2.5">
              {flaggedPair.inbound.body}
            </div>
            <div className="text-[9.5px] uppercase font-semibold text-clay tracking-eyebrow mb-1">
              Original response · flagged
            </div>
            <div className="text-[13px] text-ink leading-relaxed">
              {flaggedPair.outbound.body}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[9.5px] uppercase font-semibold text-ink tracking-eyebrow">
              Why this is wrong
            </label>
            <textarea
              value={critique}
              onChange={(e) => setCritique(e.target.value)}
              placeholder="What's bad about this? Be specific."
              className="bg-paper border border-stone-light/60 rounded-[3px] px-3 py-2.5 text-[13px] leading-snug text-ink resize-vertical min-h-[64px] focus:outline-none focus:border-clay focus:shadow-[0_0_0_1px_var(--clay-soft)]"
            />
          </div>

          <div className="flex justify-between items-center">
            <span
              className="text-[11px] text-ink-faint italic font-fraunces font-fraunces-text"
            >
              {attempts.length === 0
                ? 'Type the critique, then regenerate'
                : `${attempts.length} ${attempts.length === 1 ? 'attempt' : 'attempts'} · using current rules + corpus`}
            </span>
            <button
              onClick={regenerate}
              disabled={regenBusy || critique.trim().length === 0}
              className="bg-ink text-paper px-3.5 py-1.5 rounded-[3px] uppercase font-semibold text-[10.5px] tracking-wider hover:bg-clay-deep disabled:opacity-50"
            >
              {regenBusy ? 'Regenerating…' : '↻ Regenerate'}
            </button>
          </div>

          <AttemptsStack
            attempts={attempts}
            selectedAttemptId={selectedAttemptId}
            onSelect={setSelectedAttemptId}
          />

          {error && (
            <p className="text-[11px] text-clay-deep border-l-2 border-clay px-2 py-1 bg-clay-soft/15">
              {error}
            </p>
          )}

          {attempts.length > 0 && selectedAttemptId && (
            <div className="flex justify-end pt-2 border-t border-stone-light/60">
              <button
                onClick={startCommit}
                disabled={committing}
                className="bg-clay text-white px-4 py-1.5 rounded-[3px] uppercase font-semibold text-[10.5px] tracking-wider hover:bg-clay-deep disabled:opacity-50"
              >
                Commit to voice
              </button>
            </div>
          )}

          {showCommitModal && (
            <CommitModal
              inboundBody={flaggedPair.inbound.body}
              flaggedResponse={flaggedPair.outbound.body}
              selectedResponse={
                attempts.find((a) => a.attemptId === selectedAttemptId)?.body ?? ''
              }
              critique={critique.trim()}
              onConfirm={performCommit}
              onCancel={() => setShowCommitModal(false)}
            />
          )}
        </>
      ) : (
        <div className="bg-paper/60 border border-stone-light/60 rounded-[4px] px-4 py-6 text-center text-[12px] text-ink-faint italic font-fraunces font-fraunces-text">
          No outbound flagged. Click an agent message in the thread to see
          its inbound + flagged response here.
        </div>
      )}
    </div>
  )
}
