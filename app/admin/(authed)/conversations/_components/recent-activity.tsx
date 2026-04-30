'use client'

import { formatDistanceToNowStrict } from 'date-fns'
import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { Card, Eyebrow, HairlineRow } from '@/lib/ui'

// Five-row list of the most recently-active (venue, guest) pairs. Click a row
// → applies filters (?venue=&guest=) so the conversation loads. Server pre-
// computes this from messages.created_at; the client just renders + routes.

export interface RecentActivityRow {
  venueId: string
  venueName: string
  guestId: string
  guestLabel: string  // "First Last · +1..." or just phone
  lastActivityAt: Date
}

interface RecentActivityProps {
  rows: RecentActivityRow[]
  emptyMessage: string
}

export function RecentActivity({ rows, emptyMessage }: RecentActivityProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  if (rows.length === 0) {
    return (
      <div className="text-sm text-ink-soft italic px-1">{emptyMessage}</div>
    )
  }

  return (
    <Card>
      <div className="flex flex-col">
        <div className="px-4 py-3 border-b border-stone-light/60">
          <Eyebrow>Recent activity</Eyebrow>
        </div>
        {rows.map((r, i) => (
          <HairlineRow key={`${r.venueId}-${r.guestId}`} last={i === rows.length - 1}>
            <button
              type="button"
              disabled={isPending}
              onClick={() => {
                startTransition(() => {
                  router.replace(
                    `/admin/conversations?venue=${encodeURIComponent(r.venueId)}&guest=${encodeURIComponent(r.guestId)}`,
                  )
                })
              }}
              className="w-full px-4 flex items-baseline justify-between gap-4 text-left cursor-pointer hover:text-clay disabled:opacity-50"
            >
              <span className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm text-ink truncate">{r.venueName}</span>
                <span className="text-xs text-ink-soft truncate">{r.guestLabel}</span>
              </span>
              <span className="text-xs text-ink-soft tabular-nums shrink-0">
                {formatDistanceToNowStrict(r.lastActivityAt, { addSuffix: true })}
              </span>
            </button>
          </HairlineRow>
        ))}
      </div>
    </Card>
  )
}
