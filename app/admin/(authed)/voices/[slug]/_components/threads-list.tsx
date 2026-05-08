'use client'

import { useMemo, useState } from 'react'
import { guestDisplayName } from '../../../_lib/guest-name'
import { Eyebrow } from '@/lib/ui'
import type { VoicePageThread } from '../_lib/load-voice-page'

// Threads column — venue-scoped recent guests list with state pill +
// 90-day visit count. Matches the mockup's 280px first column. Search
// runs in-memory over the prefetched 50-row window — no server round trip.

interface ThreadsListProps {
  threads: VoicePageThread[]
  selectedGuestId: string | null
  onSelectGuest: (guestId: string) => void
  venueName: string
  voiceName: string | null
}

const STATE_LABEL: Record<NonNullable<VoicePageThread['state']>, string> = {
  new: 'New',
  returning: 'Returning',
  regular: 'Regular',
  raving_fan: 'Raving fan',
}

function formatThreadTime(when: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - when.getTime()
  if (diffMs < 60_000) return 'now'
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

export function ThreadsList({
  threads,
  selectedGuestId,
  onSelectGuest,
  venueName,
  voiceName,
}: ThreadsListProps) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return threads
    return threads.filter((t) => {
      const name = guestDisplayName(t).toLowerCase()
      const preview = t.lastMessagePreview.toLowerCase()
      return (
        name.includes(q) ||
        preview.includes(q) ||
        t.phoneNumber.includes(q)
      )
    })
  }, [threads, query])

  // Eyebrow above search per delta #2 — makes it explicit these threads
  // belong to the venue this voice is deployed at, not a global guest list.
  const eyebrowLabel = voiceName
    ? `Guests where ${voiceName} is in use`
    : `Guests · ${venueName}`

  return (
    <div className="flex flex-col min-h-0 border-r border-stone-light/60 bg-paper">
      <div className="px-4 pt-4 pb-3 border-b border-stone-light/60 flex flex-col gap-2">
        <Eyebrow>{eyebrowLabel}</Eyebrow>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search guests, messages..."
          className="w-full bg-highlight border border-stone-light/60 rounded-[3px] px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-faint focus:outline-none focus:border-clay focus:bg-paper"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-4 py-6 text-xs text-ink-faint">
            {threads.length === 0
              ? 'No guests yet at this venue.'
              : 'No threads match your search.'}
          </div>
        ) : (
          filtered.map((t) => {
            const isActive = t.guestId === selectedGuestId
            const isRegular =
              t.state === 'regular' || t.state === 'raving_fan'
            return (
              <button
                key={t.guestId}
                onClick={() => onSelectGuest(t.guestId)}
                className={`relative w-full text-left px-4 py-3 border-b border-stone-light/60 flex flex-col gap-1 transition-colors ${
                  isActive ? 'bg-parchment' : 'hover:bg-highlight'
                }`}
              >
                {isActive && (
                  <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-clay" />
                )}
                <div className="flex items-baseline justify-between">
                  <span className="text-[12.5px] font-medium text-ink truncate pr-2">
                    {guestDisplayName(t)}
                  </span>
                  <span className="text-[10.5px] text-ink-faint tabular-nums">
                    {formatThreadTime(t.lastMessageAt)}
                  </span>
                </div>
                <div className="text-[11.5px] text-ink-faint truncate">
                  {t.lastMessagePreview}
                </div>
                <div
                  className={`text-[9.5px] uppercase font-semibold tracking-eyebrow ${
                    isRegular ? 'text-clay' : 'text-ink-faint'
                  }`}
                >
                  {t.state ? STATE_LABEL[t.state] : 'Unknown'}
                  {t.visitCount90d > 0 ? ` · ${t.visitCount90d} visits` : ''}
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
