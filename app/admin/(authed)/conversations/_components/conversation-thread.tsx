'use client'

import { formatInTimeZone } from 'date-fns-tz'
import { useEffect, useRef } from 'react'
import { deriveResponseState, type ThreadResponse } from '../lib/project-thread'
import { type BubblePosition, MessageBubble } from './message-bubble'

// iMessage-style thread layout. Bubbles are clickable; the parent owns the
// selection state and trace-panel coordination. Sequence collapsing: when
// the previous bubble is same-direction and within SEQUENCE_GAP_MS, render
// without a tail so the chain reads as one block. When the gap exceeds
// SEQUENCE_GAP_MS *or* direction flips, render a centered timestamp row
// above the next bubble.
//
// TAC-316: the thread consumes response-grained ThreadResponse entries.
// A split response renders its fragments as separate chained bubbles (visual
// fidelity to what the guest's phone showed) that share ONE selection /
// trace / review identity — clicking any fragment selects the response.
// Never-sent, pending, failed, and unknown-state responses render muted with
// a caption under the last fragment; blank bodies render a placeholder.
//
// Auto-scroll: on mount and on new-message append, scroll to bottom — but
// only if the user is already near the bottom. Don't yank them if they've
// scrolled up to read history.

const SEQUENCE_GAP_MS = 60 * 1000
const TIMESTAMP_GAP_MS = 5 * 60 * 1000  // Show centered timestamp row when gap exceeds 5 min
const NEAR_BOTTOM_PX = 120

interface ConversationThreadProps {
  messages: ThreadResponse[]
  venueTimezone: string
  selectedMessageId: string | null
  onSelectMessage: (id: string) => void
}

export function ConversationThread({
  messages,
  venueTimezone,
  selectedMessageId,
  onSelectMessage,
}: ConversationThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastMessageIdRef = useRef<string | null>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const last = messages[messages.length - 1]
    if (!last) return
    // Key on the last response's last bubble so a live-arriving second bubble
    // of a split still triggers the scroll.
    const lastBubbleId = last.bubbles[last.bubbles.length - 1]?.id ?? last.id
    if (lastBubbleId === lastMessageIdRef.current) return
    // Only auto-scroll if user is near the bottom — don't yank mid-read.
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const isInitialMount = lastMessageIdRef.current === null
    if (isInitialMount || distanceFromBottom < NEAR_BOTTOM_PX) {
      el.scrollTop = el.scrollHeight
    }
    lastMessageIdRef.current = lastBubbleId
  }, [messages])

  // Pre-compute positions + timestamp insertions in a single pass to keep the
  // render loop straightforward.
  const items = computeItems(messages)

  return (
    <div
      ref={scrollRef}
      // 400px column caps thread width to iPhone-realistic dimensions; the
      // surrounding grid leaves the rest of the page for the trace panel.
      // gap-0.5 (2px) between bubbles matches iMessage chain density. py-3
      // saves vertical space vs py-4 without making the top bubble feel
      // glued to the filter bar.
      className="w-full max-w-[400px] h-full overflow-y-auto bg-paper py-3 flex flex-col gap-0.5"
    >
      {messages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-ink-soft">
          No messages yet for this guest at this venue.
        </div>
      ) : null}
      {items.map((item) => {
        if (item.kind === 'timestamp') {
          return (
            <div
              key={`ts-${item.atIso}`}
              className="text-center text-xs text-ink-soft py-2"
            >
              {formatClusterTimestamp(item.atIso, venueTimezone)}
            </div>
          )
        }
        return (
          <MessageBubble
            key={item.bubbleId}
            body={item.placeholder ?? item.body}
            isPlaceholder={item.placeholder !== null}
            direction={item.response.direction}
            createdAt={item.createdAt}
            venueTimezone={venueTimezone}
            position={item.position}
            selected={item.response.id === selectedMessageId}
            reviewed={item.isLastBubble && item.response.responseReview !== null}
            muted={item.state.kind === 'annotated'}
            stateLabel={item.isLastBubble && item.state.kind === 'annotated' ? item.state.label : null}
            onSelect={() => onSelectMessage(item.response.id)}
          />
        )
      })}
    </div>
  )
}

type ThreadItem =
  | { kind: 'timestamp'; atIso: string }
  | {
      kind: 'bubble'
      response: ThreadResponse
      bubbleId: string
      body: string
      placeholder: string | null
      createdAt: Date
      isLastBubble: boolean
      state: ReturnType<typeof deriveResponseState>
      position: BubblePosition
    }

// Format a cluster timestamp as "EEE MMM d · period" in the venue's local
// timezone. Period buckets the local hour into morning/afternoon/evening/
// night so two clusters on the same day with different time-of-day still
// read distinctly. iMessage shows time-of-day on first message of the day +
// at long gaps; we adopt the same intent at cluster granularity.
function formatClusterTimestamp(iso: string, tz: string): string {
  const date = new Date(iso)
  const dayLabel = formatInTimeZone(date, tz, 'EEE MMM d')
  const hourStr = formatInTimeZone(date, tz, 'H')
  const hour = Number.parseInt(hourStr, 10)
  if (!Number.isFinite(hour)) return dayLabel
  const period =
    hour >= 5 && hour < 12
      ? 'morning'
      : hour >= 12 && hour < 17
        ? 'afternoon'
        : hour >= 17 && hour < 21
          ? 'evening'
          : 'night'
  return `${dayLabel} · ${period}`
}

// Flatten responses to per-bubble render entries. The chain/timestamp logic
// runs over the flattened bubble sequence exactly as it did over rows —
// fragments of a split share a direction and sit within seconds of each
// other, so they chain naturally without special-casing.
//
// Display-order caveat (accepted cost of keyed grouping): an inbound that
// lands INSIDE the 1.5s inter-bubble gap of a split renders after both
// bubbles even though it arrived between them — the flatten is response-by-
// response, not globally chronological. Same posture as the queue's
// recent_context merge (migration 032).
function computeItems(messages: ThreadResponse[]): ThreadItem[] {
  const flat: Array<{
    response: ThreadResponse
    bubbleId: string
    body: string
    placeholder: string | null
    createdAt: Date
    isLastBubble: boolean
  }> = []
  for (const response of messages) {
    response.bubbles.forEach((bubble, i) => {
      flat.push({
        response,
        bubbleId: bubble.id,
        body: bubble.body,
        placeholder: bubble.placeholder,
        createdAt: bubble.createdAt,
        isLastBubble: i === response.bubbles.length - 1,
      })
    })
  }

  const items: ThreadItem[] = []
  for (let i = 0; i < flat.length; i++) {
    const m = flat[i]
    const prev = flat[i - 1]
    const next = flat[i + 1]

    // Insert centered timestamp row when there's a sustained gap or direction flip
    // with notable elapsed time. First bubble always gets a timestamp row above.
    if (
      !prev ||
      m.createdAt.getTime() - prev.createdAt.getTime() > TIMESTAMP_GAP_MS
    ) {
      items.push({ kind: 'timestamp', atIso: m.createdAt.toISOString() })
    }

    const samePrev =
      prev &&
      prev.response.direction === m.response.direction &&
      m.createdAt.getTime() - prev.createdAt.getTime() <= SEQUENCE_GAP_MS
    const sameNext =
      next &&
      next.response.direction === m.response.direction &&
      next.createdAt.getTime() - m.createdAt.getTime() <= SEQUENCE_GAP_MS

    let position: BubblePosition
    if (!samePrev && !sameNext) position = 'only'
    else if (!samePrev && sameNext) position = 'first'
    else if (samePrev && sameNext) position = 'middle'
    else position = 'last'

    items.push({
      kind: 'bubble',
      response: m.response,
      bubbleId: m.bubbleId,
      body: m.body,
      placeholder: m.placeholder,
      createdAt: m.createdAt,
      isLastBubble: m.isLastBubble,
      state: deriveResponseState(m.response),
      position,
    })
  }
  return items
}
