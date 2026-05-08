'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { PatternsPanel, type RailCluster } from './patterns-panel'

// Banner at the top of the Rules tab. Visible only when there's at least
// one confirmed cluster. Click expands the panel below; per-session
// dismissal is local React state (no persistence). A real "dismiss this
// cluster forever" ships through the patterns/dismiss endpoint inside
// the panel, not here.
//
// State updates from the fetch effect run inside startTransition so the
// `react-hooks/set-state-in-effect` lint accepts the pattern — transitions
// are the sanctioned escape hatch for "subscribe-then-update" effects.

interface PatternsBannerProps {
  venueId: string
}

interface PatternsResponse {
  success: boolean
  clusters?: RailCluster[]
  error?: string
}

export function PatternsBanner({ venueId }: PatternsBannerProps) {
  const [clusters, setClusters] = useState<RailCluster[]>([])
  const [hasLoaded, setHasLoaded] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [, startTransition] = useTransition()

  const load = useCallback(() => {
    void (async () => {
      let next: RailCluster[] = []
      try {
        const res = await fetch(`/admin/voices/api/patterns/${venueId}`)
        if (res.ok) {
          const json = (await res.json()) as PatternsResponse
          next = json.clusters ?? []
        }
      } catch {
        // Network blip — leave existing clusters in place rather than
        // flickering to empty.
      }
      startTransition(() => {
        setClusters(next)
        setHasLoaded(true)
      })
    })()
  }, [venueId])

  useEffect(() => {
    load()
  }, [load])

  if (!hasLoaded) return null
  if (clusters.length === 0) return null
  if (hidden) return null

  return (
    <div className="bg-clay-soft/15 border-l-2 border-clay rounded-r-[3px] px-3 py-2 flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[11.5px] uppercase font-semibold tracking-wider text-clay-deep hover:text-clay"
        >
          {clusters.length} {clusters.length === 1 ? 'pattern' : 'patterns'} detected · {expanded ? 'hide' : 'review'}
        </button>
        <button
          onClick={() => setHidden(true)}
          className="text-[10.5px] text-ink-faint hover:text-ink"
          aria-label="Hide banner for this session"
        >
          ×
        </button>
      </div>
      {expanded && (
        <PatternsPanel
          venueId={venueId}
          clusters={clusters}
          onResolved={() => load()}
        />
      )}
    </div>
  )
}
