'use client'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { GuestListItem, TimelineMessage } from '../_lib/types'

// Replay mode's source material: the guest picker and the real message
// timeline. Clicking an inbound message is "replay from here" - the parent
// builds the transcript-only context and runs the turn; results render in
// the shared ChatPane below this.

const NONE_VALUE = '__none__'

export function ReplayPane({
  guests,
  guestsError,
  activityDegraded,
  selectedGuestId,
  timeline,
  timelineError,
  timelineHasMore,
  timelineLoading,
  busy,
  onSelectGuest,
  onReplayFrom,
}: {
  guests: GuestListItem[]
  guestsError: string | null
  activityDegraded: boolean
  selectedGuestId: string | null
  timeline: TimelineMessage[]
  timelineError: string | null
  timelineHasMore: boolean
  timelineLoading: boolean
  busy: boolean
  onSelectGuest: (guestId: string | null) => void
  onReplayFrom: (messageId: string) => void
}) {
  return (
    <div className="flex min-h-0 flex-col border-b border-stone-light/60">
      <div className="flex shrink-0 items-center gap-3 border-b border-stone-light/60 px-4 py-2">
        <span className="text-xs uppercase tracking-wider text-ink-soft">
          Guest
        </span>
        <Select
          value={selectedGuestId ?? NONE_VALUE}
          onValueChange={(v) => onSelectGuest(v === NONE_VALUE ? null : v)}
          disabled={busy}
        >
          <SelectTrigger className="min-w-[16rem]" size="sm">
            <SelectValue placeholder="pick guest" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>pick guest</SelectItem>
            {guests.map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {g.displayName}
                {g.lastMessageAt
                  ? ` · last message ${g.lastMessageAt.slice(0, 10)}`
                  : ' · no messages'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {activityDegraded && (
          <span className="text-[11px] italic text-ink-faint">
            activity read failed; ordered by enrollment
          </span>
        )}
      </div>

      {guestsError && (
        <p className="px-4 py-2 text-xs text-destructive">
          guest list failed: {guestsError}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {selectedGuestId === null ? (
          <p className="text-sm italic text-ink-faint">
            Pick a guest to load their real timeline. Click an inbound message
            to replay it through v2.
          </p>
        ) : timelineLoading ? (
          <p className="text-sm italic text-ink-faint">loading timeline</p>
        ) : timelineError ? (
          <p className="text-xs text-destructive">
            timeline failed: {timelineError}
          </p>
        ) : timeline.length === 0 ? (
          <p className="text-sm italic text-ink-faint">
            No messages for this guest.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {timelineHasMore && (
              <p className="pb-1 text-[11px] italic text-ink-faint">
                Showing the newest 50 messages. Older ones exist and are not
                listed.
              </p>
            )}
            {timeline.map((m) => (
              <TimelineRow
                key={m.id}
                message={m}
                busy={busy}
                onReplayFrom={onReplayFrom}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function TimelineRow({
  message,
  busy,
  onReplayFrom,
}: {
  message: TimelineMessage
  busy: boolean
  onReplayFrom: (messageId: string) => void
}) {
  const isInbound = message.direction === 'inbound'
  const when = message.createdAt.slice(0, 16).replace('T', ' ')
  const body = message.body.length > 0 ? message.body : '(no body)'

  if (!isInbound) {
    return (
      <div className="flex items-baseline gap-2 py-0.5 text-xs">
        <span className="w-28 shrink-0 tabular-nums text-ink-faint">
          {when}
        </span>
        <span className="w-12 shrink-0 text-ink-faint">out</span>
        <span className="min-w-0 break-words text-ink-soft">
          {body}
          {message.status ? (
            <span className="text-ink-faint"> · {message.status}</span>
          ) : null}
        </span>
      </div>
    )
  }

  return (
    <div className="flex items-baseline gap-2 py-0.5 text-xs">
      <span className="w-28 shrink-0 tabular-nums text-ink-faint">{when}</span>
      <span className="w-12 shrink-0 text-ink">in</span>
      <button
        type="button"
        onClick={() => onReplayFrom(message.id)}
        disabled={busy || message.body.length === 0}
        title="Replay from here: run this inbound through v2 with the transcript up to this point"
        className="min-w-0 cursor-pointer break-words text-left text-ink underline decoration-clay/50 decoration-dotted underline-offset-2 hover:decoration-clay disabled:cursor-not-allowed disabled:opacity-50"
      >
        {body}
      </button>
    </div>
  )
}
