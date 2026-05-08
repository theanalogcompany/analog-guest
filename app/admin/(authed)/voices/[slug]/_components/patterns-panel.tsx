'use client'

import { useState } from 'react'

// Patterns panel — expanded body of the rail-rules banner. One row per
// confirmed cluster, with promote / dismiss buttons that hit the patterns
// API endpoints and ping the parent's onResolved callback so the banner
// re-fetches.

export interface ClusterMember {
  id: string
  text: string
  messageId: string
}

export interface RailCluster {
  critiqueIds: string[]
  members: ClusterMember[]
  proposedRuleText: string
}

interface PatternsPanelProps {
  venueId: string
  clusters: ReadonlyArray<RailCluster>
  onResolved: () => void
}

export function PatternsPanel({
  venueId,
  clusters,
  onResolved,
}: PatternsPanelProps) {
  const [busyClusterIdx, setBusyClusterIdx] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editedRuleByIdx, setEditedRuleByIdx] = useState<Record<number, string>>(
    {},
  )

  function ruleTextFor(idx: number, original: string): string {
    return editedRuleByIdx[idx] ?? original
  }

  async function promote(idx: number, cluster: RailCluster) {
    setError(null)
    setBusyClusterIdx(idx)
    try {
      const res = await fetch(
        `/admin/voices/api/patterns/${venueId}/promote`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            critiqueIds: cluster.critiqueIds,
            ruleText: ruleTextFor(idx, cluster.proposedRuleText).trim(),
          }),
        },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) ?? (j.error as string) ?? 'promote failed')
        return
      }
      onResolved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'promote failed')
    } finally {
      setBusyClusterIdx(null)
    }
  }

  async function dismiss(idx: number, cluster: RailCluster) {
    setError(null)
    setBusyClusterIdx(idx)
    try {
      const res = await fetch(
        `/admin/voices/api/patterns/${venueId}/dismiss`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ critiqueIds: cluster.critiqueIds }),
        },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError((j.detail as string) ?? (j.error as string) ?? 'dismiss failed')
        return
      }
      onResolved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'dismiss failed')
    } finally {
      setBusyClusterIdx(null)
    }
  }

  return (
    <div className="flex flex-col gap-3 mt-2">
      {clusters.map((cluster, idx) => {
        const busy = busyClusterIdx === idx
        return (
          <div
            key={cluster.critiqueIds.join(',')}
            className="bg-paper border border-stone-light/60 rounded-[4px] px-3 py-2.5 flex flex-col gap-2"
          >
            <div className="flex flex-col gap-1">
              <span className="text-[9.5px] uppercase font-semibold text-ink-faint tracking-eyebrow">
                {cluster.members.length} similar critiques
              </span>
              {cluster.members.map((m) => (
                <p
                  key={m.id}
                  className="text-[11.5px] text-ink-faint leading-snug"
                >
                  · {m.text}
                </p>
              ))}
            </div>
            <textarea
              value={ruleTextFor(idx, cluster.proposedRuleText)}
              onChange={(e) =>
                setEditedRuleByIdx((prev) => ({ ...prev, [idx]: e.target.value }))
              }
              className="bg-paper border-l-2 border-clay rounded-r-[3px] px-2.5 py-1.5 text-[12.5px] leading-snug italic font-fraunces font-fraunces-text text-ink resize-vertical min-h-[44px] focus:outline-none"
            />
            <div className="flex justify-end gap-3 text-[11px]">
              <button
                onClick={() => dismiss(idx, cluster)}
                disabled={busy}
                className="text-ink-faint hover:text-ink disabled:opacity-50"
              >
                Dismiss
              </button>
              <button
                onClick={() => promote(idx, cluster)}
                disabled={busy}
                className="bg-clay text-white px-3 py-1 rounded-[3px] uppercase font-semibold text-[10.5px] tracking-wider hover:bg-clay-deep disabled:opacity-50"
              >
                {busy ? 'Working…' : 'Promote'}
              </button>
            </div>
          </div>
        )
      })}
      {error && (
        <p className="text-[11px] text-clay-deep border-l-2 border-clay px-2 py-1 bg-clay-soft/15">
          {error}
        </p>
      )}
    </div>
  )
}
